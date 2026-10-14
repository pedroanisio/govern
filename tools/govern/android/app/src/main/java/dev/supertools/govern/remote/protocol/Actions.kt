package dev.supertools.govern.remote.protocol

import kotlinx.serialization.Serializable
import java.security.SecureRandom
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Base64

// The signed actions of govern-remote/1. The body is encoded once, and those exact bytes are both signed and sent, so the
// server verifies what the person confirmed, with no canonicalisation on either side.

@Serializable
data class ApproveAction(
    val action: String = "approve",
    val lane: String,
    val gate: String,
    val quote: String,
    val nonce: String,
    val at: String,
)

@Serializable
data class AckAction(
    val action: String = "ack",
    val lane: String,
    val alert: String,
    val nonce: String,
    val at: String,
)

/** An action ready to send: the body bytes and what they say, for the confirmation the person signs. */
class SignedAction(val body: ByteArray, val signature: ByteArray) {
    val signatureBase64: String get() = Base64.getEncoder().encodeToString(signature)
}

object Actions {
    private val random = SecureRandom()

    /** 128 random bits as base64url: inside the server's 16..128 character nonce alphabet. */
    fun nonce(): String {
        val b = ByteArray(16)
        random.nextBytes(b)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }

    fun approve(lane: String, gate: String, quote: String, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray {
        val q = quote.trim()
        require(q.length in 2..2000) { "the approval needs your own words (2 to 2000 characters)" }
        return WireJson.encodeToString(ApproveAction.serializer(), ApproveAction(lane = lane, gate = gate, quote = q, nonce = nonce, at = now.truncatedTo(ChronoUnit.MILLIS).toString()))
            .toByteArray(Charsets.UTF_8)
    }

    fun ack(lane: String, alert: String, now: Instant = Instant.now(), nonce: String = nonce()): ByteArray =
        WireJson.encodeToString(AckAction.serializer(), AckAction(lane = lane, alert = alert, nonce = nonce, at = now.truncatedTo(ChronoUnit.MILLIS).toString()))
            .toByteArray(Charsets.UTF_8)
}
