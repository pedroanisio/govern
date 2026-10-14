package dev.supertools.govern.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The wire types against the contract fixtures (also checked against the real server by tools/govern/test/remote.test.ts). */
class ModelTest {
    private fun fixture(name: String): String =
        javaClass.classLoader!!.getResource("fixtures/$name")!!.readText()

    @Test
    fun deskFixtureParses() {
        val d = parseWire<Desk>("desk", fixture("desk.json"))
        assertTrue(speaks(d.protocol))
        val lane = d.lanes.single()
        assertEquals("r1", lane.slug)
        assertEquals(LaneState.OPEN, lane.state)
        assertEquals(listOf("final", "publish"), lane.gates.map { it.name })
        assertTrue(lane.gates[0].approved)
        assertNull(lane.gates[1].approvedAt)
        assertEquals(41000L, d.telemetry.tokens.single().input)
        assertEquals(0.12, d.telemetry.tokens.single().usd, 1e-9)
        assertEquals("broken", d.unreadable.single().slug)
        assertEquals(4242, d.telemetry.dispatcher!!.pid)
    }

    @Test
    fun laneFixtureParses() {
        val l = parseWire<LaneDetail>("lane", fixture("lane.json"))
        assertEquals(listOf("draft", "ship"), l.stages)
        assertNull(l.working)
        assertEquals(3, l.data.size)
        assertEquals("alice", l.humanTasks.single().assignee)
        assertEquals("a-1", l.alerts.single().id)
    }

    @Test
    fun unknownFieldsAreRefused() {
        val text = fixture("desk.json").replaceFirst("\"protocol\"", "\"surprise\": 1, \"protocol\"")
        val e = assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", text) }
        assertTrue(e.message!!, e.message!!.contains("surprise"))
    }

    @Test
    fun missingFieldsAndWrongTypesAreRefused() {
        assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", fixture("desk.json").replace("\"stageCount\": 2,", "")) }
        assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", fixture("desk.json").replace("\"stageCount\": 2", "\"stageCount\": \"two\"")) }
        assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", fixture("desk.json").replace("\"state\": \"open\"", "\"state\": \"paused\"")) }
        assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", "{") }
        assertThrows(ProtocolException::class.java) { parseWire<Desk>("desk", "") }
    }

    @Test
    fun versions() {
        assertTrue(speaks("govern-remote/1"))
        assertTrue(speaks("govern-remote/1.2"))
        assertFalse(speaks("govern-remote/2"))
        assertFalse(speaks("govern-remote/10"))
        assertFalse(speaks("other/1"))
    }
}
