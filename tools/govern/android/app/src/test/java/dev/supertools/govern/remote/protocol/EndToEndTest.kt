package dev.supertools.govern.remote.protocol

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
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
        // remote and conversation are extensions a workspace enables; govern.config.json is the owner's file, so it names them.
        File(root, "govern.config.json").writeText("""{"projects":"projects","queue":"queue","processes":"processes","packages":"packages","tuningLog":"tuning.jsonl","extensions":["remote","conversation"]}""")
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
        assertTrue(result.lane!!.gates.single().approved)
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
    fun sessionJobAndArtifactReads() {
        val fake = File(governTs.parentFile, "test/fake-conversation.ts")
        val config = File(root, "govern.config.json")
        val original = WireJson.parseToJsonElement(config.readText()) as kotlinx.serialization.json.JsonObject
        config.writeText(kotlinx.serialization.json.JsonObject(original + ("conversationAdapters" to kotlinx.serialization.json.buildJsonObject {
            put("echo", kotlinx.serialization.json.buildJsonObject {
                put("argv", kotlinx.serialization.json.JsonArray(listOf(node, fake.path, "echo").map { kotlinx.serialization.json.JsonPrimitive(it) }))
            })
        })).toString())
        govern("conversation", "create", "chat", "--adapter", "echo", "--lane", "r1")
        govern("conversation", "send", "chat", "--message", "hello")
        govern("conversation", "run", "chat", "--once")
        govern("cmd", "r1", "test", "--", "printf", "first\nsecond\n")
        govern("run", "r1", "test")
        val proof = File(root, "proof.txt").apply { writeText("evidence") }
        govern("artifact", "add", "r1", proof.path)
        val printed = govern("remote", "pair", "--url", "http://127.0.0.1:$port")
        val link = PairingLinks.parse(Regex("govern-remote://\\S+").find(printed)!!.value)
        serve()
        val kp = keyPair()
        val pair = GovernClient(Endpoint(link.url, null, null)).pair(link.code, "reads", Base64.getEncoder().encodeToString(kp.public.encoded))
        val client = GovernClient(Endpoint(link.url, pair.token, null))
        val session = client.session("chat", 2)
        assertEquals("idle", session.session.state)
        assertEquals("transport-only", session.messages.last().verification)
        assertEquals(2, session.messages.size)
        val lane = client.lane("r1")
        val job = client.job("r1", lane.jobs.single().id, 1)
        assertEquals(listOf("second"), job.log)
        val sink = ByteArrayOutputStream()
        val download = client.artifact("r1", "proof.txt", sink)
        assertEquals("evidence", sink.toString("UTF-8"))
        assertEquals(GovernClient.sha256Hex(sink.toByteArray()), download.sha256)
        assertEquals(lane.artifacts.single().sha256, download.sha256)
        assertEquals(8L, download.bytes)
        assertEquals(404, assertThrows(ServerException::class.java) { client.session("missing") }.status)
        assertEquals(400, assertThrows(ServerException::class.java) { client.job("r1", job.job.id, 0) }.status)
    }

    @Test
    fun signedFieldActionsReturnLaneAndSession() {
        val fake = File(governTs.parentFile, "test/fake-conversation.ts")
        val config = File(root, "govern.config.json")
        val original = WireJson.parseToJsonElement(config.readText()) as kotlinx.serialization.json.JsonObject
        config.writeText(kotlinx.serialization.json.JsonObject(original + ("conversationAdapters" to kotlinx.serialization.json.buildJsonObject {
            put("echo", kotlinx.serialization.json.buildJsonObject {
                put("argv", kotlinx.serialization.json.JsonArray(listOf(node, fake.path, "echo").map { kotlinx.serialization.json.JsonPrimitive(it) }))
            })
        })).toString())
        val proof = File(root, "proof.txt").apply { writeText("evidence") }
        govern("artifact", "add", "r1", proof.path)
        govern("conversation", "create", "chat", "--adapter", "echo", "--lane", "r1")
        val printed = govern("remote", "pair", "--url", "http://127.0.0.1:$port")
        val link = PairingLinks.parse(Regex("govern-remote://\\S+").find(printed)!!.value)
        serve()
        val kp = keyPair()
        val pair = GovernClient(Endpoint(link.url, null, null)).pair(link.code, "actions", Base64.getEncoder().encodeToString(kp.public.encoded))
        val client = GovernClient(Endpoint(link.url, pair.token, null))
        fun act(body: ByteArray): ActionResult = client.act(signed(kp, body)).also { assertTrue(it.ok) }
        fun settled(id: String) {
            val file = File(root, "govern-state/conversations/$id/session.json")
            repeat(600) {
                val state = WireJson.parseToJsonElement(file.readText()) as kotlinx.serialization.json.JsonObject
                val runs = state["runs"] as kotlinx.serialization.json.JsonArray
                if (runs.isNotEmpty() && runs.all { (it as kotlinx.serialization.json.JsonObject)["state"].toString() == "\"completed\"" }) return
                Thread.sleep(25)
            }
            error("background runs did not complete: ${file.readText()}")
        }
        assertTrue(client.desk().engines.contains("echo"))
        val ref = client.lane("r1").artifacts.single().let { ArtifactRef(it.name, it.sha256) }
        val reviewed = act(Actions.reviewed("r1", ref))
        assertEquals(null, reviewed.session)
        assertEquals(pair.deviceId, reviewed.lane!!.artifacts.single().reviews.single().device)
        val changes = act(Actions.changes("r1", "final", "adjust the heading", ref))
        assertFalse(changes.lane!!.gates.single().approved)
        assertEquals(ref, changes.lane.decisions.first().artifact)
        assertEquals(null, changes.session)
        settled("chat")
        for (mode in listOf("queue", "interrupt")) {
            val instructed = act(Actions.instruct("chat", "continue", mode))
            assertEquals("r1", instructed.lane!!.slug)
            assertEquals("chat", instructed.session!!.session.id)
            settled("chat")
        }
        val opened = act(Actions.session("r1", "echo", "New review", "hello"))
        assertEquals("r1", opened.lane!!.slug)
        assertEquals("echo", opened.session!!.session.engine)
        settled(opened.session.session.id)
        val approved = act(Actions.approve("r1", "final", "I approve this evidence", ref))
        assertEquals(null, approved.session)
        assertTrue(approved.lane!!.gates.single().approved)
        assertEquals(ref, approved.lane.gates.single().artifact)
        govern("conversation", "create", "loose", "--adapter", "echo")
        val loose = act(Actions.instruct("loose", "hello", "queue"))
        assertEquals(null, loose.lane)
        assertEquals("loose", loose.session!!.session.id)
        settled("loose")
    }

    @Test
    fun artifactDigestMismatchIsRefused() {
        // A one-request HTTP server on a plain socket: the artifact route answering with a digest its body does not have.
        java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
            val stub = Thread {
                server.accept().use { socket ->
                    val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                    while (!reader.readLine().isNullOrEmpty()) Unit
                    socket.getOutputStream().apply {
                        write(("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n" +
                            "Govern-Artifact-Sha256: ${"0".repeat(64)}\r\nConnection: close\r\n\r\nbad").toByteArray(Charsets.US_ASCII))
                        flush()
                    }
                }
            }.apply { isDaemon = true; start() }
            val client = GovernClient(Endpoint("http://127.0.0.1:${server.localPort}", "test", null))
            assertThrows(ProtocolException::class.java) { client.artifact("r1", "proof.txt", ByteArrayOutputStream()) }
            stub.join(5000)
        }
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
