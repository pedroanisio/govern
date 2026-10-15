package dev.supertools.govern.remote.protocol

import java.net.URI
import java.net.URLDecoder

/** A code link uses the original pairing flow; an absent code requests pairing, optionally for one lane. */
data class PairingLink(val url: String, val code: String, val pin: String?, val lane: String? = null) {
    val requestPairing: Boolean get() = code.isEmpty()
}

/** What a pairing link opened from outside the app (a scanned QR code) does: it fills the pairing form, which the person
 *  still reads and submits; it never pairs on its own. Refused while this device is paired, and when it does not parse. */
sealed interface LinkOffer {
    data class Fill(val link: PairingLink) : LinkOffer
    data class Refused(val reason: String) : LinkOffer
}

object PairingLinks {
    private val PIN = Regex("^[0-9a-f]{64}$")

    /** The server address a person typed or a link carried: http(s), a host, no query or fragment; trailing slashes dropped. */
    fun serverUrl(raw: String): String {
        val text = raw.trim().trimEnd('/')
        val uri = try { URI(text) } catch (e: Exception) { throw IllegalArgumentException("not an address: $raw") }
        require(uri.scheme == "https" || uri.scheme == "http") { "the address must start with https:// (or http:// for this device or an emulator host)" }
        require(!uri.host.isNullOrEmpty()) { "the address has no host: $raw" }
        require(uri.rawQuery == null && uri.rawFragment == null) { "the address must not carry a query or fragment" }
        return text
    }

    /** A certificate pin: the SHA-256 of the server's certificate, 64 hex digits (colons and case folded). */
    fun pin(raw: String): String {
        val p = raw.replace(":", "").trim().lowercase()
        require(PIN.matches(p)) { "a certificate pin is 64 hex digits (the SHA-256 that govern remote serve prints)" }
        return p
    }

    fun offer(link: String, pairedWith: String?): LinkOffer =
        if (pairedWith != null) LinkOffer.Refused("already paired with $pairedWith: unpair it (Device, then Unpair) before pairing again")
        else try { LinkOffer.Fill(parse(link)) } catch (e: IllegalArgumentException) { LinkOffer.Refused("not a usable pairing link: ${e.message}") }

    fun parse(link: String): PairingLink {
        val uri = try { URI(link.trim()) } catch (e: Exception) { throw IllegalArgumentException("not a pairing link") }
        require(uri.scheme == "govern-remote" && uri.host == "pair") { "a pairing link starts with govern-remote://pair?" }
        val q = (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            val k = if (i < 0) it else it.substring(0, i)
            val v = if (i < 0) "" else URLDecoder.decode(it.substring(i + 1), Charsets.UTF_8)
            k to v
        }
        val url = q["url"] ?: throw IllegalArgumentException("the pairing link has no url")
        val code = q["code"]
        require(code == null || code.isNotBlank()) { "the pairing link has an empty code" }
        val lane = q["lane"]?.let { raw ->
            val parts = raw.split('/').filter { it != "." }
            require(!raw.startsWith('/') && parts.isNotEmpty() && parts.none { it.isEmpty() || it == ".." }) { "the pairing link has an invalid lane" }
            parts.joinToString("/")
        }
        return PairingLink(serverUrl(url), code ?: "", q["pin"]?.let(::pin), lane)
    }
}
