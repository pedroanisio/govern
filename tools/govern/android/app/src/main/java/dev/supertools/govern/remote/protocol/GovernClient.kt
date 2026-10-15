package dev.supertools.govern.remote.protocol

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/** A refusal by the server: its HTTP status and the error text it sent. */
class ServerException(val status: Int, message: String) : Exception(message)

data class ArtifactDownload(val bytes: Long, val sha256: String, val mediaType: String)

/** Where the server is and how this device proves itself: the bearer token (absent before pairing) and an optional pin. */
data class Endpoint(val baseUrl: String, val token: String?, val pin: String?)

/**
 * The HTTP client of govern-remote/2 (REMOTE.md). Blocking calls: run them off the main thread.
 * With a pin, the server's certificate must hash (SHA-256) to it, and the system trust store is not consulted: that is what
 * makes a self-signed certificate safe to use. Without one, the system trust store and hostname checks apply.
 */
class GovernClient(private val endpoint: Endpoint, private val connectTimeoutMs: Int = 10_000, private val readTimeoutMs: Int = 20_000) {

    fun health(): Health = parseWire<Health>("health", call("GET", "/v1/health", auth = false)).also {
        if (!speaks(it.protocol)) throw ProtocolException("the server speaks ${it.protocol}; this app speaks govern-remote/2")
    }

    fun pair(code: String, name: String, publicKeyBase64: String): PairResponse {
        val body = WireJson.encodeToString(PairRequest.serializer(), PairRequest(code, name, publicKeyBase64)).toByteArray(Charsets.UTF_8)
        return parseWire("pairing reply", call("POST", "/v1/pair", body = body, auth = false))
    }

    fun requestPairing(name: String, publicKey: String, lanes: List<String>? = null): PairRequestCreated {
        val body = WireJson.encodeToString(PairRequestBody.serializer(), PairRequestBody(name, publicKey, lanes)).toByteArray(Charsets.UTF_8)
        return parseWire("pairing request", call("POST", "/v1/pair/request", body = body, auth = false))
    }

    fun pollPairing(id: String, secret: String): PairRequestStatus = parseWire("pairing status",
        call("GET", "/v1/pair/request?id=" + URLEncoder.encode(id, Charsets.UTF_8), auth = false,
            headers = mapOf("Govern-Pair-Secret" to secret)))

    fun cancelPairing(id: String, secret: String): PairCancelled {
        val body = WireJson.encodeToString(PairCancel.serializer(), PairCancel(id, secret)).toByteArray(Charsets.UTF_8)
        return parseWire("pairing cancellation", call("POST", "/v1/pair/cancel", body = body, auth = false))
    }

    fun desk(): Desk = parseWire("desk", call("GET", "/v1/desk"))

    fun lane(slug: String): LaneDetail = parseWire("lane", call("GET", "/v1/lane?slug=" + URLEncoder.encode(slug, Charsets.UTF_8)))

    fun session(id: String, messages: Int = 20): SessionDetail =
        parseWire("session", call("GET", "/v1/session?id=${URLEncoder.encode(id, Charsets.UTF_8)}&messages=$messages"))

    fun job(lane: String, id: String, lines: Int = 100): JobDetail =
        parseWire("job", call("GET", "/v1/job?lane=${URLEncoder.encode(lane, Charsets.UTF_8)}&id=${URLEncoder.encode(id, Charsets.UTF_8)}&lines=$lines"))

    /** Streams into the caller's sink without closing it. Use the bytes only after digest verification succeeds. */
    fun artifact(lane: String, name: String, sink: OutputStream): ArtifactDownload {
        val c = open("GET", "/v1/artifact?lane=${URLEncoder.encode(lane, Charsets.UTF_8)}&name=${URLEncoder.encode(name, Charsets.UTF_8)}", true, readTimeoutMs)
        try {
            val status = c.responseCode
            if (status != 200) throw failure(c, status)
            val expected = c.getHeaderField("Govern-Artifact-Sha256")
            if (expected == null || !Regex("[0-9a-f]{64}").matches(expected)) throw ProtocolException("artifact has no valid SHA-256 header")
            val hash = MessageDigest.getInstance("SHA-256")
            var bytes = 0L
            c.inputStream.use { input ->
                val buffer = ByteArray(65536)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    sink.write(buffer, 0, n)
                    hash.update(buffer, 0, n)
                    bytes += n
                }
            }
            val actual = hash.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) throw ProtocolException("artifact SHA-256 differs from the server header")
            if (c.contentLengthLong >= 0 && bytes != c.contentLengthLong) throw ProtocolException("artifact length differs from the server header")
            return ArtifactDownload(bytes, actual, c.contentType ?: "application/octet-stream")
        } finally { c.disconnect() }
    }

    fun act(action: SignedAction): ActionResult =
        parseWire("action reply", call("POST", "/v1/actions", body = action.body, headers = mapOf("Govern-Signature" to action.signatureBase64)))

    /**
     * Reads the desk stream until it ends or `keepGoing` turns false; `onDesk` gets each desk. Returns normally when the
     * server ends the stream (it does every hour, and when the device is revoked); the caller decides whether to reconnect.
     */
    fun stream(keepGoing: () -> Boolean, onDesk: (Desk) -> Unit) {
        val c = open("GET", "/v1/stream", auth = true, readTimeoutMs = STREAM_READ_TIMEOUT_MS)
        try {
            val status = c.responseCode
            if (status != 200) throw failure(c, status)
            val parser = SseParser()
            BufferedReader(InputStreamReader(c.inputStream, Charsets.UTF_8)).use { reader ->
                while (keepGoing()) {
                    val line = reader.readLine() ?: return
                    val ev = parser.line(line) ?: continue
                    when (ev.event) {
                        "desk" -> onDesk(parseWire("desk", ev.data))
                        "error" -> throw ServerException(200, parseWire<ErrorBody>("stream error", ev.data).error)
                    }
                }
            }
        } finally {
            c.disconnect()
        }
    }

    private fun call(method: String, path: String, body: ByteArray? = null, auth: Boolean = true, headers: Map<String, String> = emptyMap()): String {
        val c = open(method, path, auth, readTimeoutMs)
        try {
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val status = c.responseCode
            if (status !in 200..299) throw failure(c, status)
            return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        } finally {
            c.disconnect()
        }
    }

    private fun failure(c: HttpURLConnection, status: Int): ServerException {
        val text = (c.errorStream ?: return ServerException(status, "HTTP $status")).use { it.readBytes().toString(Charsets.UTF_8) }
        val message = try { parseWire<ErrorBody>("error", text).error } catch (e: ProtocolException) { "HTTP $status" }
        return ServerException(status, message)
    }

    private fun open(method: String, path: String, auth: Boolean, readTimeoutMs: Int): HttpURLConnection {
        val c = URL(endpoint.baseUrl + path).openConnection() as HttpURLConnection
        if (c is HttpsURLConnection && endpoint.pin != null) {
            c.sslSocketFactory = pinnedFactory(endpoint.pin)
            c.hostnameVerifier = HostnameVerifier { _, _ -> true } // the pin, checked in the handshake, names the server
        }
        c.requestMethod = method
        c.connectTimeout = connectTimeoutMs
        c.readTimeout = readTimeoutMs
        c.useCaches = false
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json, text/event-stream")
        if (auth) c.setRequestProperty("Authorization", "Bearer " + (endpoint.token ?: throw IOException("this device is not paired")))
        return c
    }

    companion object {
        /** Longer than the server's 15 s heartbeat, so a silent stream is noticed as dead. */
        const val STREAM_READ_TIMEOUT_MS = 45_000

        fun sha256Hex(der: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

        /** A trust manager that accepts exactly the leaf certificate whose SHA-256 is `pin`. */
        fun pinTrust(pin: String): X509TrustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("not a server")
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull() ?: throw CertificateException("the server sent no certificate")
                val got = sha256Hex(leaf.encoded)
                if (!MessageDigest.isEqual(got.toByteArray(), pin.toByteArray()))
                    throw CertificateException("the server's certificate ($got) is not the pinned one ($pin)")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        private fun pinnedFactory(pin: String): SSLSocketFactory =
            SSLContext.getInstance("TLS").apply { init(null, arrayOf(pinTrust(pin)), null) }.socketFactory
    }
}
