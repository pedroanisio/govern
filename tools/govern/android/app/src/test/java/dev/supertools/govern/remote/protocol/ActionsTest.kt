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
        val f = fields(Actions.approve("ops/govern", "final", "  ship it, approved  ", now, nonce = "n".repeat(22)))
        assertEquals(setOf("action", "lane", "gate", "quote", "nonce", "at"), f.keys)
        assertEquals("approve", f["action"])
        assertEquals("ops/govern", f["lane"])
        assertEquals("ship it, approved", f["quote"])
        assertEquals("2026-10-14T12:00:00.123Z", f["at"])
    }

    @Test
    fun ackCarriesExactlyTheServerFields() {
        val f = fields(Actions.ack("r1", "a-1", now, nonce = "n".repeat(22)))
        assertEquals(setOf("action", "lane", "alert", "nonce", "at"), f.keys)
        assertEquals("ack", f["action"])
    }

    @Test
    fun quotesOutsideTheServerBoundsAreRefusedBeforeSigning() {
        assertThrows(IllegalArgumentException::class.java) { Actions.approve("r1", "final", " y ", now) }
        assertThrows(IllegalArgumentException::class.java) { Actions.approve("r1", "final", "x".repeat(2001), now) }
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
        val body = Actions.approve("r1", "final", "approved by me", now)
        val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(body) }.sign()
        val action = SignedAction(body, sig)
        val verify = { b: ByteArray -> Signature.getInstance("SHA256withECDSA").apply { initVerify(kp.public); update(b) }.verify(java.util.Base64.getDecoder().decode(action.signatureBase64)) }
        assertTrue(verify(action.body))
        assertFalse(verify(action.body.toString(Charsets.UTF_8).replace("final", "board").toByteArray()))
    }
}
