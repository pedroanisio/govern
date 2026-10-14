package dev.supertools.govern.remote.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Base64

// The signed actions of govern-remote/2. The body is encoded once, and those exact bytes are both signed and sent, so the
// server verifies what the person confirmed, with no canonicalisation on either side.

@Serializable
data class ApproveAction(
    val action: String = "approve",
    val lane: String,
    val gate: String,
    val quote: String,
    val nonce: String,
    val at: String,
    val artifact: ArtifactRef? = null,
)

@Serializable
data class AckAction(
    val action: String = "ack",
    val lane: String,
    val alert: String,
    val nonce: String,
    val at: String,
)

@Serializable
data class ChangesAction(
    val action: String = "changes", val lane: String, val gate: String, val quote: String,
    val nonce: String, val at: String, val artifact: ArtifactRef? = null,
)

@Serializable
data class ReviewedAction(
    val action: String = "reviewed", val lane: String, val artifact: ArtifactRef, val nonce: String, val at: String,
)

@Serializable
data class InstructAction(
    val action: String = "instruct", val session: String, val text: String, val mode: String, val nonce: String, val at: String,
)

@Serializable
data class SessionAction(
    val action: String = "session", val lane: String, val engine: String, val title: String, val text: String, val nonce: String, val at: String,
)

/** An action ready to send: the body bytes and what they say, for the confirmation the person signs. */
class SignedAction(val body: ByteArray, val signature: ByteArray) {
    val signatureBase64: String get() = Base64.getEncoder().encodeToString(signature)
}

object Actions {
    private val random = SecureRandom()
    private val json = Json(WireJson) { explicitNulls = false }
    private fun checkedNonce(value: String): String = value.also {
        require(Regex("[A-Za-z0-9_-]{16,128}").matches(it)) { "nonce must be 16 to 128 letters, digits, underscores or dashes" }
    }
    private fun at(now: Instant) = now.truncatedTo(ChronoUnit.MILLIS).toString()
    private fun words(quote: String): String {
        require(quote.trim().length >= 2 && quote.length <= 2000) { "the action needs your own words (2 to 2000 characters)" }
        return quote.trim()
    }
    private fun bounded(value: String, max: Int): String = value.trim().also {
        require(it.length in 1..max) { "must be 1 to $max characters after trim" }
    }
    private fun evidence(ref: ArtifactRef?): ArtifactRef? = ref?.also {
        require(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}").matches(it.name)) { "artifact name must be a plain name" }
        require(Regex("[0-9a-f]{64}").matches(it.sha256)) { "artifact needs a lowercase SHA-256 digest" }
    }

    /** 128 random bits as base64url: inside the server's 16..128 character nonce alphabet. */
    fun nonce(): String {
        val b = ByteArray(16)
        random.nextBytes(b)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }

    fun approve(lane: String, gate: String, quote: String, artifact: ArtifactRef? = null, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        json.encodeToString(ApproveAction.serializer(), ApproveAction(lane = lane, gate = gate, quote = words(quote), nonce = checkedNonce(nonce), at = at(now), artifact = evidence(artifact)))
            .toByteArray(Charsets.UTF_8)

    fun changes(lane: String, gate: String, quote: String, artifact: ArtifactRef? = null, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        json.encodeToString(ChangesAction.serializer(), ChangesAction(lane = lane, gate = gate, quote = words(quote), nonce = checkedNonce(nonce), at = at(now), artifact = evidence(artifact)))
            .toByteArray(Charsets.UTF_8)

    fun reviewed(lane: String, artifact: ArtifactRef, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        json.encodeToString(ReviewedAction.serializer(), ReviewedAction(lane = lane, artifact = evidence(artifact)!!, nonce = checkedNonce(nonce), at = at(now)))
            .toByteArray(Charsets.UTF_8)

    fun instruct(session: String, text: String, mode: String, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray {
        require(mode == "queue" || mode == "interrupt") { "mode must be queue or interrupt" }
        return json.encodeToString(InstructAction.serializer(), InstructAction(session = session, text = bounded(text, 8000), mode = mode, nonce = checkedNonce(nonce), at = at(now)))
            .toByteArray(Charsets.UTF_8)
    }

    fun session(lane: String, engine: String, title: String, text: String, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        json.encodeToString(SessionAction.serializer(), SessionAction(lane = lane, engine = engine, title = bounded(title, 120), text = bounded(text, 8000), nonce = checkedNonce(nonce), at = at(now)))
            .toByteArray(Charsets.UTF_8)

    fun ack(lane: String, alert: String, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        WireJson.encodeToString(AckAction.serializer(), AckAction(lane = lane, alert = alert, nonce = checkedNonce(nonce), at = now.truncatedTo(ChronoUnit.MILLIS).toString()))
            .toByteArray(Charsets.UTF_8)
}
