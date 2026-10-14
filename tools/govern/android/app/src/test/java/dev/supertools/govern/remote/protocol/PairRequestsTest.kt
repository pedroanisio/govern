package dev.supertools.govern.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairRequestsTest {
    @Test
    fun comparisonCodeVectorsMatchServer() {
        assertEquals("121684", ComparisonCode.of("r-0123456789ab", "public-key", null))
        assertEquals("862710", ComparisonCode.of("r-ffffffffffff", "BMFvYQ==", "0123456789abcdef".repeat(4)))
        assertEquals("128897", ComparisonCode.of("r-000000000000", "", ""))
    }

    @Test
    fun absentScopeIsOmittedAndEmptyScopeIsPreserved() {
        assertEquals("{\"name\":\"phone\",\"publicKey\":\"key\"}",
            WireJson.encodeToString(PairRequestBody.serializer(), PairRequestBody("phone", "key")))
        assertEquals("{\"name\":\"phone\",\"publicKey\":\"key\",\"lanes\":[]}",
            WireJson.encodeToString(PairRequestBody.serializer(), PairRequestBody("phone", "key", emptyList())))
    }

    private fun fixture(name: String) = javaClass.getResource("/fixtures/$name.json")!!.readText()

    @Test
    fun pairingFixturesHaveClosedFields() {
        assertEquals("host-test", parseWire<PairResponse>("pair", fixture("pair")).host)
        assertEquals("r-0123456789ab", parseWire<PairRequestCreated>("created", fixture("pair-request")).id)
        val status = parseWire<PairRequestStatus>("status", fixture("pair-status"))
        assertEquals(PairState.CONFIRMED, status.state)
        assertEquals(listOf("r1"), status.lanes)
        assertThrows(ProtocolException::class.java) {
            parseWire<PairRequestStatus>("status", fixture("pair-status").replace("confirmed", "other"))
        }
        assertThrows(ProtocolException::class.java) {
            parseWire<PairRequestCreated>("created", fixture("pair-request").replace("\"host\":", "\"extra\":1,\"host\":"))
        }
    }
}
