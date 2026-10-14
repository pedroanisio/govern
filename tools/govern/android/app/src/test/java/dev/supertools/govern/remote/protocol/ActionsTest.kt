package dev.supertools.govern.remote.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant

class ActionsTest {
    private val now = Instant.parse("2026-10-14T12:00:00.123456Z")

    private fun fields(body: ByteArray): Map<String, String> =
        (Json.parseToJsonElement(body.toString(Charsets.UTF_8)) as JsonObject).mapValues { it.value.jsonPrimitive.content }

    @Test
    fun approveCarriesExactlyTheServerFields() {
        val f = fields(Actions.approve("ops/govern", "final", "  ship it, approved  ", now = now, nonce = "n".repeat(22)))
        assertEquals(setOf("action", "lane", "gate", "quote", "nonce", "at"), f.keys)
        assertEquals("approve", f["action"])
        assertEquals("ops/govern", f["lane"])
        assertEquals("ship it, approved", f["quote"])
        assertEquals("2026-10-14T12:00:00.123Z", f["at"])
    }

    @Test
    fun ackCarriesExactlyTheServerFields() {
        val f = fields(Actions.ack("r1", "a-1", now = now, nonce = "n".repeat(22)))
        assertEquals(setOf("action", "lane", "alert", "nonce", "at"), f.keys)
        assertEquals("ack", f["action"])
    }

    @Test
    fun quotesOutsideTheServerBoundsAreRefusedBeforeSigning() {
        assertThrows(IllegalArgumentException::class.java) { Actions.approve("r1", "final", " y ", now = now) }
        assertThrows(IllegalArgumentException::class.java) { Actions.approve("r1", "final", "x".repeat(2001), now = now) }
    }

    @Test
    fun noncesAreFreshAndInTheServerAlphabet() {
        val a = Actions.nonce()
        val b = Actions.nonce()
        assertNotEquals(a, b)
        assertTrue(Regex("^[A-Za-z0-9_-]{16,128}$").matches(a))
    }

    @Test
    fun theSignedBytesAreTheSentBytes() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val body = Actions.approve("r1", "final", "approved by me", now = now)
        val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(body) }.sign()
        val action = SignedAction(body, sig)
        val verify = { b: ByteArray -> Signature.getInstance("SHA256withECDSA").apply { initVerify(kp.public); update(b) }.verify(java.util.Base64.getDecoder().decode(action.signatureBase64)) }
        assertTrue(verify(action.body))
        assertFalse(verify(action.body.toString(Charsets.UTF_8).replace("final", "board").toByteArray()))
    }
    @Test
    fun fieldEncodersCarryExactJsonAndOmitAbsentArtifacts() {
        val n = "n".repeat(22)
        val at = "2026-10-14T12:00:00.123Z"
        val ref = ArtifactRef("proof.txt", "a".repeat(64))
        val artifact = "\"artifact\":{\"name\":\"proof.txt\",\"sha256\":\"${ref.sha256}\"}"
        fun exact(expected: String, body: ByteArray) = assertEquals(expected, body.toString(Charsets.UTF_8))
        exact("""{"action":"approve","lane":"r1","gate":"final","quote":"yes","nonce":"$n","at":"$at",$artifact}""",
            Actions.approve("r1", "final", " yes ", ref, now, n))
        exact("""{"action":"changes","lane":"r1","gate":"final","quote":"fix it","nonce":"$n","at":"$at",$artifact}""",
            Actions.changes("r1", "final", " fix it ", ref, now, n))
        exact("""{"action":"changes","lane":"r1","gate":"final","quote":"fix it","nonce":"$n","at":"$at"}""",
            Actions.changes("r1", "final", "fix it", now = now, nonce = n))
        exact("""{"action":"reviewed","lane":"r1",$artifact,"nonce":"$n","at":"$at"}""",
            Actions.reviewed("r1", ref, now, n))
        for (mode in listOf("queue", "interrupt")) exact(
            """{"action":"instruct","session":"chat","text":"hello","mode":"$mode","nonce":"$n","at":"$at"}""",
            Actions.instruct("chat", " hello ", mode, now, n))
        exact("""{"action":"session","lane":"r1","engine":"echo","title":"Title","text":"hello","nonce":"$n","at":"$at"}""",
            Actions.session("r1", "echo", " Title ", " hello ", now, n))
        assertFalse(Actions.approve("r1", "final", "yes", now = now).toString(Charsets.UTF_8).contains("artifact"))
    }

    @Test
    fun fieldBoundsAreCheckedBeforeSigning() {
        for (q in listOf(" ", "x", "x".repeat(2001))) {
            assertThrows(IllegalArgumentException::class.java) { Actions.changes("r1", "final", q) }
        }
        for (text in listOf(" ", "x".repeat(8001))) {
            assertThrows(IllegalArgumentException::class.java) { Actions.instruct("chat", text, "queue") }
            assertThrows(IllegalArgumentException::class.java) { Actions.session("r1", "echo", "Title", text) }
        }
        for (title in listOf(" ", "x".repeat(121))) {
            assertThrows(IllegalArgumentException::class.java) { Actions.session("r1", "echo", title, "hello") }
        }
        assertThrows(IllegalArgumentException::class.java) { Actions.instruct("chat", "hello", "other") }
        for (ref in listOf(ArtifactRef("../proof", "a".repeat(64)), ArtifactRef("x", "short"), ArtifactRef("x", "A".repeat(64)), ArtifactRef("x".repeat(129), "a".repeat(64)))) {
            assertThrows(IllegalArgumentException::class.java) { Actions.reviewed("r1", ref) }
            assertThrows(IllegalArgumentException::class.java) { Actions.approve("r1", "final", "yes", ref) }
            assertThrows(IllegalArgumentException::class.java) { Actions.changes("r1", "final", "fix it", ref) }
        }
        Actions.changes("r1", "final", "x".repeat(2000))
        Actions.instruct("chat", "x".repeat(8000), "interrupt")
        Actions.session("r1", "echo", "x".repeat(120), "x".repeat(8000))
    }

    @Test
    fun actionResultFixturesKeepNullableLaneAndSessionAndClosedFields() {
        val text = javaClass.classLoader!!.getResource("fixtures/action-results.json")!!.readText()
        val results = parseWire<List<ActionResult>>("action results", text)
        assertEquals(3, results.size)
        assertEquals(null, results[0].session)
        assertTrue(results[0].lane != null)
        assertTrue(results[1].lane != null && results[1].session != null)
        assertEquals(null, results[2].lane)
        assertTrue(results[2].session != null)
        assertThrows(ProtocolException::class.java) {
            parseWire<ActionResult>("action result", """{"ok":true,"lane":null,"session":null,"extra":1}""")
        }
    }

    @Test
    fun everyEncoderRefusesInvalidNonces() {
        val ref = ArtifactRef("proof", "a".repeat(64))
        for (n in listOf("x".repeat(15), "x".repeat(129), "!".repeat(16))) {
            val encoders = listOf<() -> ByteArray>(
                { Actions.approve("r1", "final", "yes", now = now, nonce = n) },
                { Actions.ack("r1", "alert", now = now, nonce = n) },
                { Actions.changes("r1", "final", "fix it", now = now, nonce = n) },
                { Actions.reviewed("r1", ref, now = now, nonce = n) },
                { Actions.instruct("chat", "hi", "queue", now = now, nonce = n) },
                { Actions.session("r1", "echo", "Title", "hi", now = now, nonce = n) },
            )
            for (encode in encoders) assertThrows(IllegalArgumentException::class.java) { encode() }
        }
        for (size in listOf(16, 128)) Actions.reviewed("r1", ref, now = now, nonce = "n".repeat(size))
    }

}
