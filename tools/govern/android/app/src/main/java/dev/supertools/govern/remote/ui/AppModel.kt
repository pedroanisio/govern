package dev.supertools.govern.remote.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.supertools.govern.remote.protocol.Actions
import dev.supertools.govern.remote.protocol.Desk
import dev.supertools.govern.remote.protocol.Endpoint
import dev.supertools.govern.remote.protocol.GovernClient
import dev.supertools.govern.remote.protocol.LaneDetail
import dev.supertools.govern.remote.protocol.PairingLinks
import dev.supertools.govern.remote.protocol.ServerException
import dev.supertools.govern.remote.protocol.SignedAction
import dev.supertools.govern.remote.security.DeviceKey
import dev.supertools.govern.remote.security.PairedServer
import dev.supertools.govern.remote.security.PairingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The live link to the server: streaming, waiting to reconnect (with the reason), or stopped for good (revoked). */
sealed interface Link {
    data object Connecting : Link
    data object Live : Link
    data class Retrying(val seconds: Long, val reason: String) : Link
    data class Stopped(val reason: String) : Link
}

class AppModel(app: Application) : AndroidViewModel(app) {
    private val store = PairingStore(app)

    private val _paired = MutableStateFlow(store.paired())
    val paired: StateFlow<PairedServer?> = _paired
    private val _desk = MutableStateFlow<Desk?>(null)
    val desk: StateFlow<Desk?> = _desk
    private val _link = MutableStateFlow<Link>(Link.Connecting)
    val link: StateFlow<Link> = _link
    private val _lane = MutableStateFlow<LaneDetail?>(null)
    val lane: StateFlow<LaneDetail?> = _lane
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private var streamJob: Job? = null

    private fun client(): GovernClient? = store.endpoint()?.let { GovernClient(it) }

    fun consumeMessage() { _message.value = null }

    /** Pairs this device: a pairing link fills address, code and pin; otherwise they come from the form. */
    fun pair(addressOrLink: String, codeField: String, pinField: String, deviceName: String) {
        viewModelScope.launch {
            _busy.value = true
            try {
                val text = addressOrLink.trim()
                val (url, code, pin) = if (text.startsWith("govern-remote:")) {
                    val l = PairingLinks.parse(text)
                    Triple(l.url, l.code, l.pin)
                } else {
                    Triple(PairingLinks.serverUrl(text), codeField.trim(), pinField.trim().ifEmpty { null }?.let(PairingLinks::pin))
                }
                require(code.isNotEmpty()) { "enter the pairing code that govern remote pair printed" }
                val reply = withContext(Dispatchers.IO) {
                    val c = GovernClient(Endpoint(url, null, pin))
                    c.health()
                    c.pair(code, deviceName.trim().ifEmpty { "Android" }, DeviceKey.create())
                }
                val server = PairedServer(url, reply.deviceId, reply.person, pin)
                store.save(server, reply.token)
                _paired.value = server
                _message.value = "paired as ${reply.person} (${reply.deviceId})"
                startStream()
            } catch (e: Exception) {
                _message.value = describe(e)
            } finally {
                _busy.value = false
            }
        }
    }

    fun unpair() {
        streamJob?.cancel()
        store.forget()
        _paired.value = null
        _desk.value = null
        _lane.value = null
    }

    /** Keeps the desk live: reconnects with a doubling delay (2 s up to 60 s, reset by a received desk), stops on 401. */
    fun startStream() {
        if (streamJob?.isActive == true) return
        streamJob = viewModelScope.launch(Dispatchers.IO) {
            var backoff = 2L
            while (isActive) {
                val c = client() ?: return@launch
                _link.value = Link.Connecting
                try {
                    c.stream({ isActive }) { d ->
                        _desk.value = d
                        _link.value = Link.Live
                        backoff = 2L
                    }
                    _link.value = Link.Retrying(backoff, "the server ended the stream")
                } catch (e: ServerException) {
                    if (e.status == 401) { _link.value = Link.Stopped("this device is no longer paired: ${e.message}"); return@launch }
                    _link.value = Link.Retrying(backoff, describe(e))
                } catch (e: Exception) {
                    _link.value = Link.Retrying(backoff, describe(e))
                }
                delay(backoff * 1000)
                backoff = minOf(backoff * 2, 60L)
            }
        }
    }

    fun stopStream() { streamJob?.cancel(); streamJob = null }

    fun openLane(slug: String) {
        viewModelScope.launch {
            try {
                _lane.value = withContext(Dispatchers.IO) { client()!!.lane(slug) }
            } catch (e: Exception) {
                _message.value = describe(e)
            }
        }
    }

    fun closeLane() { _lane.value = null }

    fun refreshLane() { _lane.value?.slug?.let(::openLane) }

    /** Sends an action whose body the person has just signed; the lane view is replaced by the server's answer. */
    fun send(action: SignedAction, done: String) {
        viewModelScope.launch {
            _busy.value = true
            try {
                val r = withContext(Dispatchers.IO) { client()!!.act(action) }
                _lane.value = r.lane
                _message.value = done
            } catch (e: Exception) {
                _message.value = describe(e)
            } finally {
                _busy.value = false
            }
        }
    }

    fun approveBody(lane: String, gate: String, quote: String): ByteArray = Actions.approve(lane, gate, quote)
    fun ackBody(lane: String, alert: String): ByteArray = Actions.ack(lane, alert)

    fun report(text: String) { _message.value = text }

    companion object {
        fun describe(e: Exception): String = when (e) {
            is ServerException -> if (e.status == 401) "not paired (or revoked): ${e.message}" else e.message ?: "HTTP ${e.status}"
            is javax.net.ssl.SSLException -> "TLS failed: ${e.message}"
            is java.net.ConnectException -> "cannot reach the server: ${e.message}"
            is java.net.SocketTimeoutException -> "the server did not answer in time"
            else -> e.message ?: e.javaClass.simpleName
        }
    }
}
