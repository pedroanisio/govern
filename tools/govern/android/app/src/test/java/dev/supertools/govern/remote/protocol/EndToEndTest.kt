package dev.supertools.govern.remote.protocol

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * The app's client against the real server: `govern remote pair` and `govern remote serve` run under Node in a throwaway
 * workspace, and the device key is a software P-256 key (the Keystore is not available off-device; the bytes it signs are
 * the same). Covers pairing, the desk, a lane, a signed approval, a replay and the stream.
 */
class EndToEndTest {
    private val governTs = File(System.getProperty("govern.ts") ?: error("system property govern.ts is not set (app/build.gradle.kts sets it)"))
    private val node = System.getenv("GOVERN_NODE") ?: "node"
    private lateinit var root: File
    private var server: Process? = null
    private val port = ServerSocket(0).use { it.localPort }

    private fun env(pb: ProcessBuilder): ProcessBuilder {
        val e = pb.environment()
        e.keys.filter { it.startsWith("GOVERN_") || it.startsWith("CLAUDE_CODE_") || it == "CLAUDECODE" || it.startsWith("CODEX_") || it.startsWith("GROK_") }.forEach { e.remove(it) }
        e["GOVERN_REPO"] = root.path
        e["HOME"] = File(root, "home").path
        e["GOVERN_SESSIONS_DIR"] = File(root, "sessions").path
        e["GOVERN_CLAUDE_PROJECTS"] = File(root, "claude").path
        return pb.directory(root).redirectErrorStream(true)
    }

    private fun govern(vararg args: String): String {
        val p = env(ProcessBuilder(listOf(node, "--disable-warning=ExperimentalWarning", governTs.path) + args)).start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue("govern ${args.joinToString(" ")} timed out", p.waitFor(60, TimeUnit.SECONDS))
        assertEquals("govern ${args.joinToString(" ")}: $out", 0, p.exitValue())
        return out
    }

    @Before
    fun workspace() {
        assertTrue("no govern.ts at $governTs", governTs.isFile)
        root = Files.createTempDirectory("govern-remote-e2e").toFile()
        File(root, "home").mkdirs()
        File(root, "govern.config.json").writeText("""{"projects":"projects","queue":"queue","processes":"processes","packages":"packages","tuningLog":"tuning.jsonl"}""")
        File(root, "processes").mkdirs()
        File(root, "processes/release.json").writeText(
            """{"version":1,"name":"release","stages":[{"name":"draft"},{"name":"ship"}],"gates":[{"name":"final","stage":"draft"}]}""")
        govern("new", "r1", "--process", "release", "--title", "Release one")
    }

    @After
    fun stop() {
        server?.destroy()
        server?.waitFor(10, TimeUnit.SECONDS)
        root.deleteRecursively()
    }

    private fun serve(vararg extra: String) {
        val p = env(ProcessBuilder(listOf(node, "--disable-warning=ExperimentalWarning", governTs.path, "remote", "serve", "--port", port.toString()) + extra)).start()
        server = p
        val first = p.inputStream.bufferedReader().readLine() ?: error("the server exited before it listened")
        assertTrue(first, first.startsWith("govern remote"))
    }

    private fun keyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private fun signed(kp: KeyPair, body: ByteArray) =
        SignedAction(body, Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(body) }.sign())

    @Test
    fun pairReadApproveAndStream() {
        val printed = govern("remote", "pair", "--url", "http://127.0.0.1:$port")
        val link = PairingLinks.parse(Regex("govern-remote://\\S+").find(printed)!!.value)
        serve()
        val anonymous = GovernClient(Endpoint(link.url, null, link.pin))
        assertTrue(speaks(anonymous.health().protocol))
        val kp = keyPair()
        val pairing = anonymous.pair(link.code, "jvm test", Base64.getEncoder().encodeToString(kp.public.encoded))
        assertEquals("owner", pairing.person)

        val client = GovernClient(Endpoint(link.url, pairing.token, link.pin))
        val desk = client.desk()
        assertEquals(listOf("r1"), desk.lanes.map { it.slug })
        assertFalse(desk.lanes[0].gates.single().approved)
        assertEquals(listOf("draft", "ship"), client.lane("r1").stages)
        assertEquals(404, assertThrows(ServerException::class.java) { client.lane("nope") }.status)

        val approval = signed(kp, Actions.approve("r1", "final", "approved from the JVM test"))
        val result = client.act(approval)
        assertTrue(result.lane.gates.single().approved)
        assertEquals(403, assertThrows(ServerException::class.java) { client.act(approval) }.status)
        val other = signed(keyPair(), Actions.approve("r1", "final", "forged"))
        assertEquals(403, assertThrows(ServerException::class.java) { client.act(other) }.status)

        var streamed: Desk? = null
        client.stream({ streamed == null }) { streamed = it }
        assertTrue(streamed!!.lanes.single().gates.single().approved)

        govern("remote", "revoke", pairing.deviceId)
        assertEquals(401, assertThrows(ServerException::class.java) { client.desk() }.status)
        assertTrue(File(root, "projects/r1/govern.json").readText().contains("\"kind\": \"device\""))
    }

    @Test
    fun phoneRequestsHostConfirmsAndPollDeliversTokenOnce() {
        serve()
        val url = "http://127.0.0.1:$port"
        val client = GovernClient(Endpoint(url, null, null))
        val publicKey = Base64.getEncoder().encodeToString(keyPair().public.encoded)
        val request = client.requestPairing("JVM phone", publicKey, listOf("r1"))
        val code = ComparisonCode.of(request.id, publicKey, null)
        val printed = govern("remote", "requests")
        assertTrue(printed, printed.contains(code))
        assertEquals(PairState.WAITING, client.pollPairing(request.id, request.secret).state)
        govern("remote", "confirm", request.id, "--code", code)
        val confirmed = client.pollPairing(request.id, request.secret)
        assertEquals(PairState.CONFIRMED, confirmed.state)
        assertEquals(request.host, confirmed.host)
        assertEquals("owner", confirmed.person)
        assertEquals(listOf("r1"), confirmed.lanes)
        assertEquals(null, client.pollPairing(request.id, request.secret).token)
        val paired = GovernClient(Endpoint(url, confirmed.token!!, null))
        assertEquals(listOf("r1"), paired.desk().lanes.map { it.slug })
        assertEquals(403, assertThrows(ServerException::class.java) { paired.lane("other") }.status)
        val cancelled = client.requestPairing("cancelled", publicKey, null)
        assertEquals("cancelled", client.cancelPairing(cancelled.id, cancelled.secret).state)
        assertEquals(PairState.CANCELLED, client.pollPairing(cancelled.id, cancelled.secret).state)
    }

    /** A self-signed certificate made with openssl for this run: (certificate file, key file). */
    private fun selfSigned(): Pair<File, File> {
        val cert = File(root, "cert.pem")
        val key = File(root, "key.pem")
        val p = ProcessBuilder("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", key.path, "-out", cert.path, "-days", "1", "-subj", "/CN=govern-e2e").redirectErrorStream(true).start()
        val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
        assertTrue("openssl timed out", p.waitFor(60, TimeUnit.SECONDS))
        assertEquals("openssl: $out", 0, p.exitValue())
        return cert to key
    }

    @Test
    fun tlsWithAPinnedSelfSignedCertificate() {
        val (cert, key) = selfSigned()
        val printed = govern("remote", "pair", "--url", "https://127.0.0.1:$port", "--tls-cert", cert.path)
        val link = PairingLinks.parse(Regex("govern-remote://\\S+").find(printed)!!.value)
        serve("--tls-cert", cert.path, "--tls-key", key.path)
        val pinned = GovernClient(Endpoint(link.url, null, link.pin!!))
        assertTrue(speaks(pinned.health().protocol))
        val wrongPin = GovernClient(Endpoint(link.url, null, "0".repeat(64)))
        assertThrows(javax.net.ssl.SSLException::class.java) { wrongPin.health() }
        val unpinned = GovernClient(Endpoint(link.url, null, null))
        assertThrows(javax.net.ssl.SSLException::class.java) { unpinned.health() }
        val kp = keyPair()
        val pairing = pinned.pair(link.code, "jvm tls", Base64.getEncoder().encodeToString(kp.public.encoded))
        assertEquals(listOf("r1"), GovernClient(Endpoint(link.url, pairing.token, link.pin)).desk().lanes.map { it.slug })
    }
}
