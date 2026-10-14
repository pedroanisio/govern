package dev.supertools.govern.remote.ui

import dev.supertools.govern.remote.protocol.*
import dev.supertools.govern.remote.security.Host
import org.junit.Assert.*
import org.junit.Test

class DecisionsTest {
    @Test fun onlyPersonsUnapprovedNonPolicyGatesOfUnfinishedLanes() {
        val desk = WireJson.decodeFromString<Desk>(javaClass.getResource("/fixtures/desk.json")!!.readText())
        val host = Host("a", "host", "https://a.test", "d", "owner", null, null, desk.at, "sealed")
        val gate = GateView("review", null, "owner", false, false, null, emptyList())
        val lane = desk.lanes.first().copy(state = LaneState.OPEN, gates = listOf(gate,
            gate.copy(name = "approved", approved = true), gate.copy(name = "policy", policy = true), gate.copy(name = "other", owner = "other")))
        val state = HostState(host, desk.copy(lanes = listOf(lane, lane.copy(slug = "done", state = LaneState.FINISHED))))
        assertEquals(listOf("review"), pendingDecisions(listOf(state)).map { it.gate.name })
        assertEquals(2, pendingDecisions(listOf(state, state.copy(host = host.copy(id = "b")))).size)
        assertTrue(pendingDecisions(listOf(state.copy(desk = null))).isEmpty())
    }
}
