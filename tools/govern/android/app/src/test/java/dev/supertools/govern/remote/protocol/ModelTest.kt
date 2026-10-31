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

    @Test fun ledgerSummaryAndToneAreOptional() {
        val old = WireJson.decodeFromString<LedgerView>("""{"t":"now","kind":"job","text":"{}"}""")
        assertNull(old.summary); assertNull(old.tone)
        val human = WireJson.decodeFromString<LedgerView>("""{"t":"now","kind":"job","text":"{}","summary":"Job started","tone":"running"}""")
        assertEquals("Job started", human.summary); assertEquals("running", human.tone)
    }

    @Test
    fun deskFixtureParses() {
        val d = parseWire<Desk>("desk", fixture("desk.json"))
        assertTrue(speaks(d.protocol))
        val lane = d.lanes.single()
        assertEquals("r1", lane.slug)
        assertEquals(1, lane.checkSummary.passed)
        assertEquals("owner", d.viewer.person)
        assertNull(d.viewer.lanes)
        assertTrue(d.host.isNotEmpty())
        assertEquals("chat", d.sessions.single().id)
        assertTrue(d.engines.contains("codex-read"))
        assertEquals(LaneState.OPEN, lane.state)
        assertEquals(listOf("final", "publish"), lane.gates.map { it.name })
        assertTrue(lane.gates[0].approved)
        assertNull(lane.gates[1].approvedAt)
        assertEquals(41000L, d.telemetry.tokens.single().input)
        assertEquals(0.12, d.telemetry.tokens.single().usd, 1e-9)
        assertEquals("broken", d.unreadable.single().slug)
        assertEquals("broken-chat", d.unreadableSessions.single().id)
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
        assertEquals(2, l.artifacts.single().version)
        assertEquals("owner", l.artifacts.single().reviews.single().person)
        assertEquals(1, l.checks.size)
        assertEquals("ok", l.jobs.single().status)
        assertEquals("chat", l.sessions.single().id)
    }

    @Test
    fun frozenAndImportedFieldsParse() {
        val d = parseWire<Desk>("desk", fixture("desk.json"))
        val lane = d.lanes.single()
        assertEquals(FrozenView("2026-10-20T09:00:00.000Z", "pausing for the contract fixture", null), lane.frozen)
        assertEquals(ImportedFromView("source-lane", "2026-10-19T09:00:00.000Z", "full"), lane.importedFrom)

        val l = parseWire<LaneDetail>("lane", fixture("lane.json"))
        assertEquals(lane.frozen, l.frozen)
        assertEquals(lane.importedFrom, l.importedFrom)
        assertEquals(listOf(ImportedApprovalView("final", "2026-10-18T09:00:00.000Z", "owner", "approved before the move")), l.importedApprovals)

        // a lane neither frozen nor imported carries both fields as explicit null, not absent
        val laneObject = (WireJson.parseToJsonElement(fixture("desk.json")) as kotlinx.serialization.json.JsonObject)["lanes"]!!
            .let { it as kotlinx.serialization.json.JsonArray }[0] as kotlinx.serialization.json.JsonObject
        val unfrozen = kotlinx.serialization.json.JsonObject(laneObject + mapOf(
            "frozen" to kotlinx.serialization.json.JsonNull, "importedFrom" to kotlinx.serialization.json.JsonNull))
        val unfrozenLane = parseWire<LaneSummary>("lane summary", unfrozen.toString())
        assertNull(unfrozenLane.frozen)
        assertNull(unfrozenLane.importedFrom)
    }

    @Test
    fun sessionAndJobFixturesParse() {
        val s = parseWire<SessionDetail>("session", fixture("session.json"))
        assertEquals("chat", s.session.id)
        assertEquals("transport-only", s.messages.last().verification)
        assertNull(s.messages.first().verification)
        assertEquals("completed", s.runs.last().state)
        val j = parseWire<JobDetail>("job", fixture("job.json"))
        assertEquals("r1", j.lane)
        assertEquals("ok", j.job.status)
        assertEquals(listOf("second"), j.log.takeLast(1))
        assertThrows(ProtocolException::class.java) {
            parseWire<SessionDetail>("session", fixture("session.json").replaceFirst("\"runs\"", "\"extra\": true, \"runs\""))
        }
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
        assertTrue(speaks("govern-remote/2"))
        assertTrue(speaks("govern-remote/2.2"))
        assertFalse(speaks("govern-remote/3"))
        assertFalse(speaks("govern-remote/20"))
        assertFalse(speaks("other/1"))
    }
}
