package dev.supertools.govern.remote.ui

import dev.supertools.govern.remote.protocol.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class FieldViewModelsTest {
    private val lane = WireJson.decodeFromString<LaneDetail>(javaClass.getResource("/fixtures/lane.json")!!.readText())
    private val session = WireJson.decodeFromString<SessionDetail>(javaClass.getResource("/fixtures/session.json")!!.readText())

    @Test fun currentGateExcludesFuturePolicyAndOtherOwners() {
        val gate = lane.gates.first()
        assertTrue(awaitsDecision(gate, lane.stage, lane.state, "owner"))
        assertFalse(awaitsDecision(lane.gates.last(), lane.stage, lane.state, "owner"))
        assertFalse(awaitsDecision(gate.copy(policy = true), lane.stage, lane.state, "owner"))
        assertFalse(awaitsDecision(gate, lane.stage, LaneState.FINISHED, "owner"))
        assertFalse(awaitsDecision(gate, lane.stage, lane.state, "someone"))
        assertFalse(awaitsDecision(gate.copy(approved = true), lane.stage, lane.state, "owner"))
        assertTrue(awaitsDecision(gate.copy(stage = null), lane.stage, lane.state, "owner"))
    }

    @Test fun stepperUsesActiveStagesAndFinishedState() {
        assertEquals(listOf(StageState.CURRENT, StageState.NEXT), stageSteps(lane).map { it.state })
        assertEquals(listOf(StageState.DONE, StageState.CURRENT), stageSteps(lane.copy(stage = "ship", stageIndex = 1, active = emptyList())).map { it.state })
        assertTrue(stageSteps(lane.copy(state = LaneState.FINISHED)).all { it.state == StageState.DONE })
        assertTrue(stageSteps(lane.copy(active = lane.stages)).all { it.state == StageState.CURRENT })
    }

    @Test fun offlineAndDecisionTakePrecedenceOverRunState() {
        assertEquals(SessionState.OFFLINE, sessionState(session.session, false))
        assertEquals(SessionState.DECISION, sessionState(session.session, true))
        for ((wire, expected) in mapOf("running" to SessionState.RUNNING, "queued" to SessionState.QUEUED,
            "failed" to SessionState.FAILED, "closed" to SessionState.CLOSED, "idle" to SessionState.IDLE))
            assertEquals(expected, sessionState(session.session.copy(needsDecision = false, state = wire), true))
    }

    @Test fun evidenceKeepsJobLinksAndReviewIsPersonSpecific() {
        val evidence = evidenceRows(lane)
        assertEquals(lane.checks.first().job, evidence.first().job)
        assertTrue(evidence.first().passed)
        assertTrue(reviewedBy(lane.artifacts.first(), "owner"))
        assertFalse(reviewedBy(lane.artifacts.first(), "other"))
        assertEquals("ee82…0a8e", shortDigest(lane.artifacts.first().sha256))
        assertTrue(unverified(session.messages.last()))
        assertFalse(unverified(session.messages.first()))
        assertFalse(unverified(session.messages.last().copy(verification = "checked")))
    }

    @Test fun countdownStopsExactlyAtExpiryWithInjectedClock() {
        val expires = "2026-10-14T12:05:00Z"
        fun timer(at: String) = PairCountdown(expires, Clock.fixed(Instant.parse(at), ZoneOffset.UTC))
        assertEquals("05:00", timer("2026-10-14T12:00:00Z").text())
        assertEquals("00:01", timer("2026-10-14T12:04:59.500Z").text())
        assertTrue(timer("2026-10-14T12:04:59.999Z").waiting())
        assertFalse(timer(expires).waiting())
        assertEquals("00:00", timer("2026-10-14T13:00:00Z").text())
    }

    @Test fun initialsBoundsScopeAndRelativeTime() {
        assertEquals("AD", initials("  Ana   Dias "))
        assertEquals("RE", initials("Review"))
        assertEquals("", initials("  "))
        assertTrue(validQuote("ok")); assertFalse(validQuote(" x ")); assertFalse(validQuote("x".repeat(2001)))
        assertTrue(canControl(null, "r1")); assertFalse(canControl(emptyList(), "r1")); assertFalse(canControl(listOf("r1"), null))
        assertEquals(2L, ageMinutes("2026-10-14T12:00:00Z", Instant.parse("2026-10-14T12:02:59Z")))
        assertEquals(0L, ageMinutes("2026-10-14T12:03:00Z", Instant.parse("2026-10-14T12:02:00Z")))
    }
    @Test fun overviewCountsAcrossLiveAndCachedHosts() {
        val desk = WireJson.decodeFromString<Desk>(javaClass.getResource("/fixtures/desk.json")!!.readText())
        val host = dev.supertools.govern.remote.security.Host("a", "host", "https://a.test", "d", "owner", null, null, desk.at, "sealed")
        val live = HostState(host, desk, Link.Live)
        val cached = live.copy(host = host.copy(id = "b"), link = Link.Stopped("offline"))
        val counts = overview(listOf(live, cached))
        assertEquals(desk.sessions.size * 2, counts.sessions)
        assertEquals(1, counts.online); assertEquals(1, counts.offline)
        assertEquals(pendingDecisions(listOf(live)).size * 2, counts.decisions)
        assertEquals(0, overview(emptyList()).sessions)
        assertEquals(desk.sessions.size * 2, sessionRows(listOf(live, cached)).size)
    }

    @Test fun artifactHeroUsesMostRecentlyModifiedEvidence() {
        val old = lane.artifacts.first().copy(name = "a-old.png", modifiedAt = "2026-10-13T12:00:00Z")
        val latest = old.copy(name = "z-new.png", modifiedAt = "2026-10-14T12:00:00Z")
        assertEquals(latest, latestArtifact(listOf(old, latest)))
        assertEquals(latest, latestArtifact(listOf(latest, old)))
        assertNull(latestArtifact(emptyList()))
    }

    @Test fun decisionEligibilityRequiresLiveScopeOwnerDependenciesAndOwnWords() {
        val gate = lane.gates.first().copy(needs = emptyList())
        val detail = lane.copy(gates = listOf(gate))
        assertTrue(canDecide(detail, gate.name, "owner", null, true, false, "Looks good"))
        assertFalse(canDecide(detail, gate.name, "owner", null, false, false, "Looks good"))
        assertFalse(canDecide(detail, gate.name, "owner", null, true, true, "Looks good"))
        assertFalse(canDecide(detail, gate.name, "owner", emptyList(), true, false, "Looks good"))
        assertFalse(canDecide(detail, gate.name, "other", null, true, false, "Looks good"))
        assertFalse(canDecide(detail, gate.name, "owner", null, true, false, " "))
        assertFalse(canDecide(detail, "missing", "owner", null, true, false, "Looks good"))
        assertFalse(canDecide(detail.copy(gates = listOf(gate.copy(needs = listOf("missing")))), gate.name,
            "owner", null, true, false, "Looks good"))
    }

    @Test fun localePluralResourcesHaveMatchingQuantitiesAndArguments() {
        fun plurals(locale: String): Map<String, Map<String, String>> {
            val file = java.io.File("src/main/res/$locale/strings.xml")
            val doc = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val nodes = doc.getElementsByTagName("plurals")
            return (0 until nodes.length).associate { i ->
                val node = nodes.item(i) as org.w3c.dom.Element
                val items = node.getElementsByTagName("item")
                node.getAttribute("name") to (0 until items.length).associate { j ->
                    val item = items.item(j) as org.w3c.dom.Element
                    item.getAttribute("quantity") to Regex("%[ds]").findAll(item.textContent).joinToString { it.value }
                }
            }
        }
        val english = plurals("values")
        assertEquals(setOf("session_count", "decision_count", "cached_count"), english.keys)
        assertTrue(english.values.all { it.keys == setOf("one", "other") })
        assertEquals(english, plurals("values-pt-rBR"))
    }
}
