package dev.supertools.govern.remote.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// The wire types of govern-remote/1 (tools/govern/REMOTE.md), mirrored from tools/govern/lib/remote-view.ts.
// The parser refuses unknown fields: the field set of a protocol major version is closed, and a server that sends more
// speaks another version.

const val PROTOCOL_MAJOR = "govern-remote/1"

/** The JSON codec of the protocol: strict (unknown keys and lenient syntax refused), explicit nulls kept. */
val WireJson: Json = Json {
    ignoreUnknownKeys = false
    isLenient = false
    explicitNulls = true
    encodeDefaults = true
}

class ProtocolException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Whether `protocol` is a version this app speaks. */
fun speaks(protocol: String): Boolean = protocol == PROTOCOL_MAJOR || protocol.startsWith("$PROTOCOL_MAJOR.")

@Serializable
data class Health(val protocol: String, val at: String)

@Serializable
data class PairRequest(val code: String, val name: String, val publicKey: String)

@Serializable
data class PairResponse(val protocol: String, val deviceId: String, val person: String, val token: String, val host: String)

@Serializable
data class ErrorBody(val error: String)

@Serializable
data class GateView(
    val name: String,
    val stage: String?,
    val owner: String,
    val policy: Boolean,
    val approved: Boolean,
    val approvedAt: String?,
    val needs: List<String>,
)

@Serializable
data class Working(val engine: String, val since: String)

@Serializable
data class LastNote(val at: String, val text: String)

@Serializable
data class LastJob(val name: String, val status: String, val at: String)

@Serializable
data class LaneSummary(
    val slug: String,
    val title: String,
    val process: String,
    val kind: String,
    val stage: String,
    val stageIndex: Int,
    val stageCount: Int,
    val active: List<String>,
    val state: LaneState,
    val blockedBy: List<String>,
    val gates: List<GateView>,
    val openAlerts: Int,
    val working: Working?,
    val lastNote: LastNote?,
    val lastJob: LastJob?,
)

@Serializable
enum class LaneState {
    @SerialName("finished") FINISHED,
    @SerialName("blocked") BLOCKED,
    @SerialName("ready") READY,
    @SerialName("open") OPEN,
}

@Serializable
data class LaneError(val slug: String, val error: String)

@Serializable
data class AlertView(
    val id: String,
    val stage: String,
    val kind: String,
    val at: String,
    val message: String,
    val acknowledgedAt: String?,
)

@Serializable
data class NoteView(val at: String, val stage: String, val text: String)

@Serializable
data class LedgerView(val t: String, val kind: String, val text: String)

@Serializable
data class HumanTaskView(val stage: String, val assignee: String?, val completedBy: String?)

@Serializable
data class LaneDetail(
    val slug: String,
    val title: String,
    val process: String,
    val kind: String,
    val stage: String,
    val stageIndex: Int,
    val stageCount: Int,
    val active: List<String>,
    val state: LaneState,
    val blockedBy: List<String>,
    val gates: List<GateView>,
    val openAlerts: Int,
    val working: Working?,
    val lastNote: LastNote?,
    val lastJob: LastJob?,
    val stages: List<String>,
    val exit: String?,
    val check: String?,
    val finished: String?,
    val data: Map<String, JsonElement>,
    val humanTasks: List<HumanTaskView>,
    val alerts: List<AlertView>,
    val notes: List<NoteView>,
    val ledger: List<LedgerView>,
)

@Serializable
data class TokenRow(val lane: String, val calls: Int, val input: Long, val output: Long, val usd: Double)

@Serializable
data class MachineRow(val lane: String, val time: String, val money: String?)

@Serializable
data class RunnerRow(val runner: String, val waiting: Int, val running: Int)

@Serializable
data class QueueView(val runners: List<RunnerRow>, val failed: Int, val unverified: Int)

@Serializable
data class Dispatcher(val running: Boolean, val pid: Int, val started: String, val interval: Int)

@Serializable
data class InboxRow(val id: String, val kind: String, val from: String, val project: String, val summary: String, val created: String)

@Serializable
data class Telemetry(
    val day: String,
    val tokens: List<TokenRow>,
    val machines: List<MachineRow>,
    val queue: QueueView,
    val dispatcher: Dispatcher?,
    val inbox: List<InboxRow>,
    val allowances: List<String>,
)

@Serializable
data class Desk(
    val protocol: String,
    val at: String,
    val lanes: List<LaneSummary>,
    val unreadable: List<LaneError>,
    val telemetry: Telemetry,
)

@Serializable
data class ActionResult(val ok: Boolean, val lane: LaneDetail)

/** Parses `text` as a `T`, or throws ProtocolException naming what was being read. */
inline fun <reified T> parseWire(what: String, text: String): T =
    try {
        WireJson.decodeFromString<T>(text)
    } catch (e: IllegalArgumentException) {
        throw ProtocolException("the server's $what is not govern-remote/1: ${e.message}", e)
    }
