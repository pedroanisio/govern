package dev.supertools.govern.remote.protocol

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.security.MessageDigest

/** A phone's request; absent lanes asks for access to every lane. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PairRequestBody(
    val name: String,
    val publicKey: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val lanes: List<String>? = null,
)

@Serializable
data class PairRequestCreated(val protocol: String, val id: String, val secret: String, val expires: String, val host: String)

@Serializable
enum class PairState {
    @SerialName("waiting") WAITING,
    @SerialName("confirmed") CONFIRMED,
    @SerialName("refused") REFUSED,
    @SerialName("expired") EXPIRED,
    @SerialName("cancelled") CANCELLED,
}

@Serializable
data class PairRequestStatus(
    val protocol: String,
    val state: PairState,
    val expires: String,
    val person: String?,
    val deviceId: String?,
    val token: String?,
    val lanes: List<String>?,
    val host: String,
)

@Serializable
data class PairCancel(val id: String, val secret: String)

@Serializable
data class PairCancelled(val protocol: String, val state: String) {
    init { require(state == "cancelled") { "pairing cancellation must be cancelled" } }
}

/** The six digits independently computed on the phone and shown at the owner's terminal. */
object ComparisonCode {
    fun of(id: String, publicKeyBase64: String, pin: String?): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest("govern-pair/2\n$id\n$publicKeyBase64\n${pin ?: ""}".toByteArray(Charsets.UTF_8))
        val value = bytes.take(4).fold(0L) { n, b -> (n shl 8) or (b.toLong() and 255L) }
        return (value % 1_000_000).toString().padStart(6, '0')
    }
}
