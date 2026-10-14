package dev.supertools.govern.remote.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.supertools.govern.remote.R
import dev.supertools.govern.remote.data.DeskCache
import dev.supertools.govern.remote.data.CachedLane
import dev.supertools.govern.remote.protocol.*
import dev.supertools.govern.remote.security.DeviceKey
import dev.supertools.govern.remote.security.Host
import dev.supertools.govern.remote.security.HostStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import java.time.Instant
import java.util.UUID

class AppModel @JvmOverloads constructor(app: Application, private val clock: java.time.Clock = java.time.Clock.systemUTC()) : AndroidViewModel(app) {
    private val store = HostStore(app)
    private val cache = DeskCache(File(app.noBackupFilesDir, "cache"))
    private val _hosts = MutableStateFlow(store.all().map { HostState(it) })
    val hosts: StateFlow<List<HostState>> = _hosts
    private val selected = MutableStateFlow(store.selected())
    private val _lane = MutableStateFlow<LaneDetail?>(null)
    val lane: StateFlow<LaneDetail?> = _lane
    private val _laneAt = MutableStateFlow<String?>(null)
    val laneAt: StateFlow<String?> = _laneAt
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    private val _prefill = MutableStateFlow<PairingLink?>(null)
    val prefill: StateFlow<PairingLink?> = _prefill
    private val _pairing = MutableStateFlow(false)
    val pairing: StateFlow<Boolean> = _pairing
    val current = combine(hosts, selected) { list, id -> list.firstOrNull { it.host.id == id } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, _hosts.value.firstOrNull { it.host.id == selected.value })
    private val streams = mutableMapOf<String, Job>()
    private var foreground = false
    private val removing = mutableSetOf<String>()
    private var laneRequest: Job? = null
    private val _activity = MutableStateFlow<List<ActivityEntry>>(emptyList())
    val activity: StateFlow<List<ActivityEntry>> = _activity
    private var activityJob: Job? = null
    private var laneSlug: String? = null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            for (host in store.all()) {
                try { val desk = cache.desk(host.id); update(host.id) { if (it.desk == null && it.host.deviceId == host.deviceId) it.copy(desk = desk) else it } }
                catch (e: Exception) { report(text(R.string.cache_error, host.name, describe(e))) }
                try {
                    val lanes = cache.lanes(host.id).associateBy { it.detail.slug }
                    update(host.id) { if (it.host.deviceId == host.deviceId) it.copy(cachedLanes = lanes + it.cachedLanes) else it }
                } catch (e: Exception) { report(text(R.string.cache_error, host.name, describe(e))) }
            }
        }
    }

    fun text(id: Int, vararg args: Any): String = getApplication<Application>().getString(id, *args)
    private fun update(id: String, change: (HostState) -> HostState) { _hosts.update { list -> list.map { if (it.host.id == id) change(it) else it } } }
    private fun state(id: String?): HostState? = _hosts.value.firstOrNull { it.host.id == id }
    private fun client(host: Host): GovernClient = GovernClient(store.endpoint(host))
    fun selectedHost(): Host? = state(selected.value)?.host
    fun isLive(id: String): Boolean = state(id)?.link == Link.Live
    fun consumeMessage() { _message.value = null }
    fun consumePrefill() { _prefill.value = null }
    fun beginPairing() { closeSession(); _pairing.value = true; closeLane(); activityJob?.cancel() }
    fun cancelPairing() { if (pairJob?.isActive == true) { cancelRequest(); return }; if (!_busy.value) { _pairing.value = false; _prefill.value = null } }

    fun selectHost(id: String) {
        closeSession()
        store.select(id)
        closeLane()
        selected.value = id
        activityJob?.cancel()
        _activity.value = emptyList()
    }

    fun offerLink(link: String) {
        when (val offer = PairingLinks.offer(link, null)) {
            is LinkOffer.Fill -> {
                _prefill.value = offer.link
                beginPairing()
                if (offer.link.requestPairing) requestPair(offer.link, android.os.Build.MODEL.orEmpty())
                else report(text(R.string.check_host, offer.link.url))
            }
            is LinkOffer.Refused -> report(offer.reason)
        }
    }

    fun pair(addressOrLink: String, codeField: String, pinField: String, deviceName: String) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            var pairingHostId: String? = null
            var createdAlias: String? = null
            var saved = false
            try {
                val address = addressOrLink.trim()
                val (url, code, pin) = if (address.startsWith("govern-remote:")) {
                    val link = PairingLinks.parse(address)
                    Triple(link.url, link.code, link.pin)
                } else Triple(PairingLinks.serverUrl(address), codeField.trim(), pinField.trim().ifEmpty { null }?.let(PairingLinks::pin))
                if (code.isEmpty()) {
                    _busy.value = false
                    requestPair(PairingLink(url, "", pin, if (address.startsWith("govern-remote:")) PairingLinks.parse(address).lane else null), deviceName)
                    return@launch
                }
                val previous = _hosts.value.firstOrNull { it.host.baseUrl == url }?.host
                val id = previous?.id ?: UUID.randomUUID().toString()
                val alias = previous?.keyAlias ?: "govern-remote-device-$id"
                pairingHostId = id
                removing.add(id)
                streams[id]?.cancelAndJoin()
                if (selected.value == id) { laneRequest?.cancelAndJoin(); activityJob?.cancelAndJoin() }
                val host = withContext(Dispatchers.IO) {
                    val c = GovernClient(Endpoint(url, null, pin))
                    c.health()
                    val publicKey = if (DeviceKey.exists(alias)) DeviceKey.publicKeyBase64(alias) else {
                        createdAlias = alias
                        DeviceKey.create(alias)
                    }
                    val reply = c.pair(code, deviceName.trim().ifEmpty { text(R.string.android_device) }, publicKey)
                    cache.forget(id)
                    store.save(Host(id, reply.host, url, reply.deviceId, reply.person, pin, null,
                        clock.instant().toString(), "", alias), reply.token)
                }
                saved = true
                _hosts.update { old -> store.all().map { h -> if (h.id == host.id) HostState(h) else old.firstOrNull { it.host.id == h.id } ?: HostState(h) } }
                selectHost(host.id)
                _pairing.value = false
                report(text(R.string.paired_as, host.person, host.deviceId))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
            finally {
                if (!saved) createdAlias?.let { alias -> withContext(NonCancellable + Dispatchers.IO) { DeviceKey.delete(alias) } }
                _busy.value = false
                pairingHostId?.let { id ->
                    removing.remove(id)
                    state(id)?.host?.let(::start)
                }
            }
        }
    }

    fun forget(id: String) {
        if (_busy.value) return
        _busy.value = true
        removing.add(id)
        streams[id]?.cancel()
        viewModelScope.launch {
            try {
                streams[id]?.cancelAndJoin()
                if (selected.value == id) { laneRequest?.cancelAndJoin(); activityJob?.cancelAndJoin() }
                withContext(Dispatchers.IO) { store.forget(id) }
                sessionCache.keys.removeAll { it.first == id }
                closeSession()
                _hosts.update { it.filterNot { h -> h.host.id == id } }
                if (selected.value == id) {
                    closeLane(); activityJob?.cancel(); _activity.value = emptyList(); selected.value = store.selected()
                }
                withContext(Dispatchers.IO) { cache.forget(id) }
            } catch (e: Exception) { report(describe(e)) }
            finally { removing.remove(id); _busy.value = false }
        }
    }

    /** One stream per host, including while switching tabs. A cancelled socket must close before its replacement starts. */
    fun startStream() {
        foreground = true
        for (host in _hosts.value.map { it.host }) start(host)
    }

    private fun start(host: Host) {
        if (!foreground || host.id in removing || streams[host.id]?.isCompleted == false) return
        val job = viewModelScope.launch(Dispatchers.IO) {
            var backoff = 2L
            while (isActive) {
                update(host.id) { it.copy(link = Link.Connecting) }
                try {
                    client(host).stream({ isActive }) { desk ->
                        ensureActive()
                        update(host.id) { it.copy(desk = desk, link = Link.Live) }
                        try { cache.saveDesk(host.id, desk) }
                        catch (e: Exception) { report(text(R.string.cache_error, host.name, describe(e))) }
                        backoff = 2L
                    }
                    ensureActive()
                    update(host.id) { it.copy(link = Link.Retrying(backoff, text(R.string.stream_ended))) }
                } catch (e: CancellationException) { throw e }
                catch (e: ServerException) {
                    if (e.status == 401) {
                        update(host.id) { it.copy(link = Link.Stopped(text(R.string.revoked))) }
                        return@launch
                    }
                    update(host.id) { it.copy(link = Link.Retrying(backoff, describe(e))) }
                } catch (e: Exception) {
                    ensureActive()
                    update(host.id) { it.copy(link = Link.Retrying(backoff, describe(e))) }
                }
                delay(backoff * 1000)
                backoff = minOf(backoff * 2, 60L)
            }
        }
        streams[host.id] = job
        job.invokeOnCompletion {
            viewModelScope.launch {
                if (streams[host.id] === job) {
                    streams.remove(host.id)
                    val next = state(host.id)
                    if (foreground && next != null && (next.link !is Link.Stopped || job.isCancelled)) start(next.host)
                }
            }
        }
    }

    fun stopStream() {
        foreground = false
        streams.values.forEach { it.cancel() }
        _hosts.update { list -> list.map { it.copy(link = Link.Stopped(text(R.string.offline))) } }
    }

    fun openLane(slug: String) {
        val host = selectedHost() ?: return
        laneRequest?.cancel()
        laneSlug = slug
        _lane.value = null
        _laneAt.value = null
        laneRequest = viewModelScope.launch {
            try {
                val cached = state(host.id)?.cachedLanes?.get(slug) ?: try { withContext(Dispatchers.IO) { cache.lane(host.id, slug) } }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { report(text(R.string.cache_error, host.name, describe(e))); null }
                if (cached != null) { _lane.value = cached.detail; _laneAt.value = cached.at }
                if (isLive(host.id)) {
                    val detail = withContext(Dispatchers.IO) { client(host).lane(slug) }
                    _lane.value = detail
                    val at = clock.instant().toString()
                    _laneAt.value = at
                    withContext(Dispatchers.IO) { saveLane(host, detail, at) }
                } else if (cached == null) report(text(R.string.no_cached_lane))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
        }
    }

    fun loadActivity() {
        val host = selectedHost() ?: return
        activityJob?.cancel()
        activityJob = viewModelScope.launch {
            try {
                val details = try { withContext(Dispatchers.IO) { cache.lanes(host.id).map { it.detail } }.toMutableList() }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { report(text(R.string.cache_error, host.name, describe(e))); mutableListOf<LaneDetail>() }
                fun publish() {
                    if (selected.value != host.id) return
                    val entries = details.flatMap { lane ->
                        lane.decisions.map { ActivityEntry(lane.slug, it.t, it.kind, "${it.by}: ${it.quote}") } +
                        lane.ledger.map { ActivityEntry(lane.slug, it.t, it.kind, it.text) } +
                            lane.notes.map { ActivityEntry(lane.slug, it.at, "", it.text) }
                    } + state(host.id)?.desk?.lanes.orEmpty().mapNotNull { lane ->
                        lane.lastNote?.let { ActivityEntry(lane.slug, it.at, "", it.text) }
                    }
                    _activity.value = entries.distinct().sortedByDescending { it.at }.take(200)
                }
                publish()
                if (isLive(host.id)) for (lane in state(host.id)?.desk?.lanes.orEmpty()) {
                    ensureActive()
                    val detail = withContext(Dispatchers.IO) { client(host).lane(lane.slug) }
                    withContext(Dispatchers.IO) { saveLane(host, detail, clock.instant().toString()) }
                    details.removeAll { it.slug == detail.slug }
                    details.add(detail)
                    publish()
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
        }
    }

    private fun saveLane(host: Host, detail: LaneDetail, at: String) = synchronized(cache) {
        if (state(host.id)?.host?.deviceId != host.deviceId) return@synchronized
        cache.saveLane(host.id, detail, at)
        update(host.id) { if (it.host.deviceId == host.deviceId) it.copy(cachedLanes = it.cachedLanes + (detail.slug to CachedLane(at, detail))) else it }
    }

    fun closeLane() { laneRequest?.cancel(); laneSlug = null; _lane.value = null; _laneAt.value = null }
    fun refreshLane() { laneSlug?.let(::openLane) }

    /** The host is captured before biometric confirmation; changing selection cannot redirect a signed action. */
    fun send(host: Host, action: SignedAction, done: String) {
        if (_busy.value || !isLive(host.id) || state(host.id)?.host?.deviceId != host.deviceId) {
            report(text(R.string.live_required)); return
        }
        _busy.value = true
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { client(host).act(action) }
                val detail: LaneDetail? = result.lane
                if (detail != null) {
                    val at = clock.instant().toString()
                    withContext(Dispatchers.IO) { saveLane(host, detail, at) }
                    if (selected.value == host.id && laneSlug == detail.slug) { _lane.value = detail; _laneAt.value = at }
                }
                result.session?.let { session ->
                    if (selected.value == host.id) {
                        _session.value = session
                        sessionId = session.session.id
                        _newSession.value = false
                        session.session.lane?.let(::openLane)
                    }
                }
                val body = WireJson.parseToJsonElement(action.body.toString(Charsets.UTF_8)) as kotlinx.serialization.json.JsonObject
                if ((body["action"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "reviewed") {
                    pendingOpen?.takeIf { it.first.contentEquals(action.body) }?.let { (_, file, mediaType) ->
                        pendingOpen = null
                        launchArtifact(file, mediaType)
                    }
                }
                report(done)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (e is ServerException && e.status == 409) {
                    if (selected.value == host.id) refreshLane()
                    report(text(R.string.evidence_changed))
                } else report(describe(e))
            }
            finally { _busy.value = false }
        }
    }

    private val _session = MutableStateFlow<SessionDetail?>(null)
    val session: StateFlow<SessionDetail?> = _session
    private var sessionId: String? = null
    private var sessionRequest: Job? = null
    private val sessionCache = mutableMapOf<Pair<String, String>, SessionDetail>()
    private val _newSession = MutableStateFlow(false)
    val newSession: StateFlow<Boolean> = _newSession
    private val _log = MutableStateFlow<JobDetail?>(null)
    val log: StateFlow<JobDetail?> = _log
    private var logRequest: Job? = null
    private val _decision = MutableStateFlow<String?>(null)
    val decision: StateFlow<String?> = _decision
    private val _artifacts = MutableStateFlow(false)
    val artifacts: StateFlow<Boolean> = _artifacts

    fun beginSession() { closeSession(); closeLane(); _newSession.value = true }
    fun closeSession() {
        sessionRequest?.cancel(); logRequest?.cancel(); sessionId = null; _session.value = null
        _log.value = null; _decision.value = null; _newSession.value = false; _artifacts.value = false
    }
    fun openSession(host: Host, summary: SessionSummary) {
        if (selected.value != host.id) selectHost(host.id)
        closeSession(); closeLane(); sessionId = summary.id
        _session.value = sessionCache[host.id to summary.id] ?: SessionDetail(PROTOCOL_MAJOR, summary, listOfNotNull(summary.lastMessage), emptyList())
        summary.lane?.let(::openLane)
        refreshSession()
    }
    fun refreshSession() {
        val host = selectedHost() ?: return
        val id = sessionId ?: return
        if (!isLive(host.id)) return
        sessionRequest?.cancel()
        sessionRequest = viewModelScope.launch {
            try {
                val detail = withContext(Dispatchers.IO) { client(host).session(id) }
                sessionCache[host.id to id] = detail
                if (selected.value == host.id && sessionId == id) _session.value = detail
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
        }
    }
    fun openDecision(gate: String) { _decision.value = gate }
    fun closeDecision() { _decision.value = null }
    fun showArtifacts(show: Boolean) { _artifacts.value = show }
    fun closeLog() { logRequest?.cancel(); _log.value = null }
    fun openLog(slug: String, id: String) {
        val host = selectedHost() ?: return
        if (!isLive(host.id)) { report(text(R.string.live_required)); return }
        logRequest?.cancel()
        logRequest = viewModelScope.launch {
            try { _log.value = withContext(Dispatchers.IO) { client(host).job(slug, id, 1000) } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
        }
    }
    fun now(): Instant = clock.instant()

    suspend fun loadDecisionEvidence() {
        for (decision in pendingDecisions(_hosts.value).distinctBy { it.host.id to it.lane.slug }) {
            if (!isLive(decision.host.id)) continue
            try {
                withContext(Dispatchers.IO) {
                    val detail = client(decision.host).lane(decision.lane.slug)
                    saveLane(decision.host, detail, clock.instant().toString())
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(describe(e)) }
        }
    }

    private var pendingOpen: Triple<ByteArray, File, String>? = null
    suspend fun download(host: Host, slug: String, artifact: ArtifactView): File = withContext(Dispatchers.IO) {
        require(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}").matches(artifact.name))
        require(Regex("[0-9a-f]{64}").matches(artifact.sha256))
        val dir = File(getApplication<Application>().cacheDir, "artifacts/${host.id}/${artifact.sha256}")
        check(dir.isDirectory || dir.mkdirs())
        val target = File(dir, artifact.name)
        val temp = File.createTempFile("download-", ".part", dir)
        try {
            val got = temp.outputStream().use { client(host).artifact(slug, artifact.name, it) }
            if (got.sha256 != artifact.sha256) throw ServerException(409, text(R.string.evidence_changed))
            java.nio.file.Files.move(temp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            target
        } finally { temp.delete() }
    }
    private fun launchArtifact(file: File, mediaType: String) {
        val app = getApplication<Application>()
        val uri = androidx.core.content.FileProvider.getUriForFile(app, "${app.packageName}.artifacts", file)
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri, mediaType)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
    }
    fun openArtifact(slug: String, artifact: ArtifactView, review: Boolean, confirm: Confirm) {
        val host = selectedHost() ?: return
        if (_busy.value || !isLive(host.id)) { report(text(R.string.live_required)); return }
        _busy.value = true
        viewModelScope.launch {
            try {
                val file = download(host, slug, artifact)
                if (selected.value != host.id) return@launch
                if (review) {
                    val body = Actions.reviewed(slug, ArtifactRef(artifact.name, artifact.sha256))
                    pendingOpen = Triple(body, file, artifact.mediaType)
                    confirm(text(R.string.open_file), text(R.string.review_digest, shortDigest(artifact.sha256)), body, text(R.string.reviewed_you))
                } else launchArtifact(file, artifact.mediaType)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (e is ServerException && e.status == 409) { refreshLane(); report(text(R.string.evidence_changed)) }
                else report(describe(e))
            } finally { _busy.value = false }
        }
    }

    private val _pairRequest = MutableStateFlow<PairingProgress?>(null)
    val pairRequest: StateFlow<PairingProgress?> = _pairRequest
    private var pairJob: Job? = null
    private var pairCancel = false
    fun dismissPairRequest() { if (pairJob?.isActive != true) { _pairRequest.value = null; _prefill.value = null } }
    fun cancelRequest() { pairCancel = true }

    private fun requestPair(link: PairingLink, name: String) {
        if (pairJob?.isActive == true) return
        pairCancel = false
        _busy.value = true
        pairJob = viewModelScope.launch {
            val previous = _hosts.value.firstOrNull { it.host.baseUrl == link.url }?.host
            val id = previous?.id ?: UUID.randomUUID().toString()
            val alias = previous?.keyAlias ?: "govern-remote-device-$id"
            var created = false
            var saved = false
            try {
                val c = GovernClient(Endpoint(link.url, null, link.pin))
                val key = withContext(Dispatchers.IO) {
                    c.health()
                    if (DeviceKey.exists(alias)) DeviceKey.publicKeyBase64(alias) else { created = true; DeviceKey.create(alias) }
                }
                val request = withContext(Dispatchers.IO) { c.requestPairing(name.ifBlank { text(R.string.android_device) }, key, link.lane?.let(::listOf)) }
                val countdown = PairCountdown(request.expires, clock)
                val code = ComparisonCode.of(request.id, key, link.pin).chunked(3).joinToString(" ")
                _pairRequest.value = PairingProgress(request.host, link.lane?.let(::listOf), code, request.expires, PairState.WAITING)
                _busy.value = false
                while (countdown.waiting()) {
                    if (pairCancel) {
                        withContext(Dispatchers.IO) { c.cancelPairing(request.id, request.secret) }
                        _pairRequest.update { it?.copy(state = PairState.CANCELLED) }
                        return@launch
                    }
                    val status = withContext(Dispatchers.IO) { c.pollPairing(request.id, request.secret) }
                    _pairRequest.update { it?.copy(state = status.state) }
                    if (status.state == PairState.CONFIRMED) {
                        val token = requireNotNull(status.token) { text(R.string.pair_token_missing) }
                        removing.add(id)
                        streams.remove(id)?.cancelAndJoin()
                        sessionCache.keys.removeAll { it.first == id }
                        val host = withContext(Dispatchers.IO) {
                            cache.forget(id)
                            store.save(Host(id, status.host, link.url, requireNotNull(status.deviceId), requireNotNull(status.person), link.pin,
                                status.lanes, clock.instant().toString(), "", alias), token)
                        }
                        saved = true
                        streams.remove(id)?.cancelAndJoin()
                        _hosts.update { old -> store.all().map { h -> if (h.id == host.id) HostState(h) else old.firstOrNull { it.host.id == h.id } ?: HostState(h) } }
                        selectHost(host.id); closeLane(); _pairing.value = false; _pairRequest.value = null; _prefill.value = null
                        removing.remove(id)
                        start(host)
                        return@launch
                    }
                    if (status.state != PairState.WAITING) return@launch
                    delay(1000)
                }
                _pairRequest.update { it?.copy(state = PairState.EXPIRED) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                _pairRequest.update { it?.copy(error = describe(e)) }
                report(describe(e))
            } finally {
                if (created && !saved) withContext(NonCancellable + Dispatchers.IO) { DeviceKey.delete(alias) }
                removing.remove(id)
                state(id)?.host?.let(::start)
                _busy.value = false
            }
        }
    }

    fun approveBody(lane: String, gate: String, quote: String): ByteArray = Actions.approve(lane, gate, quote)
    fun ackBody(lane: String, alert: String): ByteArray = Actions.ack(lane, alert)
    fun report(text: String) { _message.value = text }
    fun describe(e: Exception): String = when (e) {
        is ServerException -> if (e.status == 401) text(R.string.revoked) else e.message ?: text(R.string.http_error, e.status)
        is javax.net.ssl.SSLException -> text(R.string.tls_error, e.message.orEmpty())
        is java.net.ConnectException -> text(R.string.connection_error, e.message.orEmpty())
        is java.net.SocketTimeoutException -> text(R.string.timeout)
        else -> e.message ?: text(R.string.request_failed)
    }
}

data class PairingProgress(val host: String, val lanes: List<String>?, val code: String, val expires: String, val state: PairState, val error: String? = null)
