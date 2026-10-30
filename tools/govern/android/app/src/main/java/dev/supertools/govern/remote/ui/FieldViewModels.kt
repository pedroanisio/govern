package dev.supertools.govern.remote.ui

import dev.supertools.govern.remote.protocol.*
import dev.supertools.govern.remote.security.Host
import dev.supertools.govern.remote.data.CachedLane
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Locale

enum class StageState { DONE, CURRENT, NEXT }
data class StageStep(val name: String, val state: StageState)
enum class SessionState { OFFLINE, DECISION, RUNNING, QUEUED, FAILED, CLOSED, IDLE }
data class EvidenceRow(val name: String, val stage: String, val passed: Boolean, val job: String?)

fun awaitsDecision(gate: GateView, stage: String, state: LaneState, person: String): Boolean =
    state != LaneState.FINISHED && !gate.approved && !gate.policy && gate.owner == person && (gate.stage == null || gate.stage == stage)

fun stageSteps(lane: LaneDetail): List<StageStep> = lane.stages.mapIndexed { index, name ->
    StageStep(name, when {
        lane.state == LaneState.FINISHED -> StageState.DONE
        name in lane.active || (lane.active.isEmpty() && name == lane.stage) -> StageState.CURRENT
        index < lane.stageIndex -> StageState.DONE
        else -> StageState.NEXT
    })
}

fun sessionState(session: SessionSummary, live: Boolean): SessionState = when {
    !live -> SessionState.OFFLINE
    session.needsDecision -> SessionState.DECISION
    else -> when (session.state) {
        "running" -> SessionState.RUNNING
        "queued" -> SessionState.QUEUED
        "failed" -> SessionState.FAILED
        "closed" -> SessionState.CLOSED
        else -> SessionState.IDLE
    }
}

fun evidenceRows(lane: LaneDetail): List<EvidenceRow> = lane.checks.map { EvidenceRow(it.name, it.stage, it.ok, it.job) }
fun latestArtifact(artifacts: List<ArtifactView>): ArtifactView? = artifacts.maxByOrNull { Instant.parse(it.modifiedAt) }
fun canDecide(lane: LaneDetail, gateName: String, person: String, scope: List<String>?, live: Boolean, busy: Boolean, quote: String): Boolean {
    val gate = lane.gates.firstOrNull { it.name == gateName } ?: return false
    return live && !busy && lane.frozen == null && canControl(scope, lane.slug) && validQuote(quote) &&
        awaitsDecision(gate, lane.stage, lane.state, person) &&
        gate.needs.all { need -> lane.gates.any { it.name == need && it.approved } }
}
fun reviewedBy(artifact: ArtifactView, person: String): Boolean = artifact.reviews.any { it.person == person }
fun shortDigest(digest: String): String = digest.take(4) + "…" + digest.takeLast(4)
fun unverified(message: MessageView): Boolean = message.role == "assistant" && message.verification != "checked"
fun validQuote(quote: String): Boolean = quote.trim().length >= 2 && quote.length <= 2000
fun canControl(scope: List<String>?, lane: String?): Boolean = scope == null || lane in scope
fun ageMinutes(at: String, now: Instant): Long = Duration.between(Instant.parse(at), now).toMinutes().coerceAtLeast(0)
fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return (if (words.size > 1) "${words.first().first()}${words.last().first()}" else words.firstOrNull().orEmpty().take(2)).uppercase(Locale.ROOT)
}

/** The same deadline controls both the display and whether another poll may begin. */
class PairCountdown(expires: String, private val clock: Clock = Clock.systemUTC()) {
    private val deadline = Instant.parse(expires)
    fun waiting(): Boolean = clock.instant().isBefore(deadline)
    fun text(): String {
        val seconds = ((Duration.between(clock.instant(), deadline).toMillis().coerceAtLeast(0) + 999) / 1000)
        return String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60)
    }
}

sealed interface Link {
    data object Connecting : Link
    data object Live : Link
    data class Retrying(val seconds: Long, val reason: String) : Link
    data class Stopped(val reason: String) : Link
}

data class HostState(val host: Host, val desk: Desk? = null, val link: Link = Link.Connecting, val cachedLanes: Map<String, CachedLane> = emptyMap())
data class ActivityEntry(val lane: String, val at: String, val kind: String, val text: String, val summary: String? = null, val tone: String? = null)

data class PendingDecision(val host: Host, val lane: LaneSummary, val gate: GateView)

fun pendingDecisions(hosts: List<HostState>): List<PendingDecision> = hosts.flatMap { state ->
    state.desk?.lanes.orEmpty().filter { it.state != LaneState.FINISHED }.flatMap { lane ->
        lane.gates.filter { awaitsDecision(it, lane.stage, lane.state, state.host.person) }
            .map { PendingDecision(state.host, lane, it) }
    }
}


data class Overview(val sessions: Int, val decisions: Int, val online: Int, val offline: Int)
data class SessionRow(val host: HostState, val session: SessionSummary)
fun overview(hosts: List<HostState>): Overview = Overview(hosts.sumOf { it.desk?.sessions?.size ?: 0 },
    pendingDecisions(hosts).size, hosts.count { it.link == Link.Live }, hosts.count { it.link != Link.Live })
fun sessionRows(hosts: List<HostState>): List<SessionRow> = hosts.flatMap { host -> host.desk?.sessions.orEmpty().map { SessionRow(host, it) } }
    .sortedByDescending { it.session.updatedAt }

fun countPill(count: Int): String = count.toString().padStart(2, '0')
fun showDecisionBadge(count: Int): Boolean = count > 0
enum class ChecksLine { NONE, ALL, FAILED, PARTIAL }
fun checksLine(passed: Int, total: Int, failed: Int): ChecksLine = when {
    total == 0 -> ChecksLine.NONE
    failed > 0 -> ChecksLine.FAILED
    passed == total -> ChecksLine.ALL
    else -> ChecksLine.PARTIAL
}
fun gateSubtitle(gate: String, stage: String, format: String): String = String.format(format, gate, stage)
fun shortJobId(id: String): String = id.take(8)
enum class ActivityTone { OK, FAILED, RUNNING, INFO }
fun activityTone(tone: String?): ActivityTone = when (tone) {
    "ok" -> ActivityTone.OK
    "failed" -> ActivityTone.FAILED
    "running" -> ActivityTone.RUNNING
    else -> ActivityTone.INFO
}
fun activitySummary(entry: ActivityEntry, commandSet: String, job: String = "Job", check: String = "Check"): String = entry.summary ?: when (entry.kind) {
    "job" -> job
    "check" -> check
    "cmd-set" -> commandSet
    else -> entry.kind.replace('-', ' ').replaceFirstChar { it.titlecase() }
}
enum class ActivityDay { TODAY, YESTERDAY, DATE, UNDATED }
/** date is null only for the UNDATED group: entries whose time the server sent malformed. */
data class ActivityGroup(val date: java.time.LocalDate?, val day: ActivityDay, val entries: List<ActivityEntry>)
private fun instantOrNull(at: String): Instant? = try { Instant.parse(at) } catch (_: java.time.format.DateTimeParseException) { null }
fun activityGroups(entries: List<ActivityEntry>, now: Instant, zone: java.time.ZoneId): List<ActivityGroup> {
    val today = now.atZone(zone).toLocalDate()
    return entries.map { it to instantOrNull(it.at) }.sortedByDescending { it.second }
        .groupBy { it.second?.atZone(zone)?.toLocalDate() }
        .map { (date, rows) -> ActivityGroup(date, when (date) {
            null -> ActivityDay.UNDATED
            today -> ActivityDay.TODAY
            today.minusDays(1) -> ActivityDay.YESTERDAY
            else -> ActivityDay.DATE
        }, rows.map { it.first }) }
}
fun activityTime(at: String, zone: java.time.ZoneId): String =
    instantOrNull(at)?.let { java.time.format.DateTimeFormatter.ofPattern("HH:mm").format(it.atZone(zone)) } ?: "--:--"
enum class LinkBanner { NONE, CACHED, CONNECTING, RETRYING, OFFLINE }
fun linkBanner(link: Link, cached: Boolean): LinkBanner = when {
    link == Link.Live -> LinkBanner.NONE
    cached -> LinkBanner.CACHED
    link == Link.Connecting -> LinkBanner.CONNECTING
    link is Link.Retrying -> LinkBanner.RETRYING
    else -> LinkBanner.OFFLINE
}

fun showLiveControl(link: Link, control: Boolean): Boolean = link == Link.Live && control
fun jobStatus(status: String): String = status.uppercase(Locale.ROOT)

fun pairCode(code: String): String = code.filterNot(Char::isWhitespace).chunked(3).joinToString(" ")
enum class PairTone { WAITING, SUCCESS, ERROR }
data class PairPill(val text: Int, val tone: PairTone)
fun pairPill(state: PairState): PairPill = when (state) {
    PairState.WAITING -> PairPill(dev.supertools.govern.remote.R.string.awaiting_confirmation, PairTone.WAITING)
    PairState.CONFIRMED -> PairPill(dev.supertools.govern.remote.R.string.host_confirmed, PairTone.SUCCESS)
    PairState.REFUSED -> PairPill(dev.supertools.govern.remote.R.string.pair_refused, PairTone.ERROR)
    PairState.EXPIRED -> PairPill(dev.supertools.govern.remote.R.string.pair_expired, PairTone.ERROR)
    PairState.CANCELLED -> PairPill(dev.supertools.govern.remote.R.string.pair_cancelled, PairTone.ERROR)
}
enum class PairCheck { DONE, WAITING, ERROR }
fun pairChecklist(state: PairState): List<PairCheck> = listOf(PairCheck.DONE, PairCheck.DONE, when (state) {
    PairState.WAITING -> PairCheck.WAITING
    PairState.CONFIRMED -> PairCheck.DONE
    else -> PairCheck.ERROR
})
fun pairScope(lanes: List<String>?, all: String, one: String, many: String): String =
    lanes?.let { String.format(Locale.getDefault(), if (it.size == 1) one else many, it.size) } ?: all
enum class PairMode { FORM, SCANNED_LINK, SCANNED_INVALID }
fun pairMode(prefill: PairingLink?, input: String?): PairMode = when {
    prefill != null -> PairMode.SCANNED_LINK
    input != null -> PairMode.SCANNED_INVALID
    else -> PairMode.FORM
}
