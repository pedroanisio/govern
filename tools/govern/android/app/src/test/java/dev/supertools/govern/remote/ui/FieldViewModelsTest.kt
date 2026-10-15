package dev.supertools.govern.remote.ui

import dev.supertools.govern.remote.protocol.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class FieldViewModelsTest {
    @Test fun pairingCodesGroupDigitsAndNormalizeExistingSpaces() {
        assertEquals("482 719", pairCode("482719"))
        assertEquals("482 719", pairCode(" 482  719 "))
        assertEquals("123 45", pairCode("12345"))
        assertEquals("12", pairCode("12")); assertEquals("", pairCode(""))
    }
    @Test fun pairingPillsMapEveryTerminalStateAndTone() {
        val expected = listOf(
            PairPill(dev.supertools.govern.remote.R.string.awaiting_confirmation, PairTone.WAITING),
            PairPill(dev.supertools.govern.remote.R.string.host_confirmed, PairTone.SUCCESS),
            PairPill(dev.supertools.govern.remote.R.string.pair_refused, PairTone.ERROR),
            PairPill(dev.supertools.govern.remote.R.string.pair_expired, PairTone.ERROR),
            PairPill(dev.supertools.govern.remote.R.string.pair_cancelled, PairTone.ERROR))
        assertEquals(expected, PairState.entries.map(::pairPill))
    }
    @Test fun pairingChecklistKeepsReadAndIdentifiedDoneForEveryState() {
        for (state in PairState.entries) {
            val last = when (state) {
                PairState.WAITING -> PairCheck.WAITING
                PairState.CONFIRMED -> PairCheck.DONE
                else -> PairCheck.ERROR
            }
            assertEquals(listOf(PairCheck.DONE, PairCheck.DONE, last), pairChecklist(state))
        }
    }
    @Test fun pairingScopeChipSupportsAllOneAndMany() {
        assertEquals("All lanes", pairScope(null, "All lanes", "%d lane", "%d lanes"))
        assertEquals("1 lane", pairScope(listOf("a"), "All lanes", "%d lane", "%d lanes"))
        assertEquals("2 lanes", pairScope(listOf("a", "b"), "All lanes", "%d lane", "%d lanes"))
        assertEquals("0 lanes", pairScope(emptyList(), "All lanes", "%d lane", "%d lanes"))
    }
    @Test fun pairingModeDistinguishesFormValidAndInvalidOffers() {
        val link = PairingLink("https://host.test", "482719", null)
        assertEquals(PairMode.FORM, pairMode(null, null))
        assertEquals(PairMode.SCANNED_INVALID, pairMode(null, "bad QR"))
        assertEquals(PairMode.SCANNED_LINK, pairMode(link, "valid QR"))
        assertEquals(PairMode.SCANNED_LINK, pairMode(link, null))
    }

    @Test fun countPillsAndBadges() {
        assertEquals("00", countPill(0)); assertEquals("02", countPill(2)); assertEquals("100", countPill(100))
        assertFalse(showDecisionBadge(0)); assertTrue(showDecisionBadge(2))
    }
    @Test fun checksChooseAllFailedOrNone() {
        assertEquals(ChecksLine.NONE, checksLine(0, 0, 0))
        assertEquals(ChecksLine.ALL, checksLine(3, 3, 0))
        assertEquals(ChecksLine.FAILED, checksLine(2, 3, 1))
        assertEquals(ChecksLine.PARTIAL, checksLine(2, 3, 0))
    }
    @Test fun gateSubtitleAndShortJobId() {
        assertEquals("publish gate · review", gateSubtitle("publish", "review", "%1\$s gate · %2\$s"))
        assertEquals("abcdefgh", shortJobId("abcdefghijkl")); assertEquals("12", shortJobId("12"))
    }
    @Test fun activityFallbackHidesJsonAndMapsTone() {
        assertEquals("Job", activitySummary(ActivityEntry("a", "", "job", "{secret}"), "Command set"))
        assertEquals("Check", activitySummary(ActivityEntry("a", "", "check", "{}"), "Command set"))
        assertEquals("Command set", activitySummary(ActivityEntry("a", "", "cmd-set", "{}"), "Command set"))
        assertEquals("Started", activitySummary(ActivityEntry("a", "", "job", "{}", "Started"), "Command set"))
        assertEquals(ActivityTone.INFO, activityTone("unknown")); assertEquals(ActivityTone.INFO, activityTone(null))
        assertEquals(ActivityTone.OK, activityTone("ok")); assertEquals(ActivityTone.FAILED, activityTone("failed"))
        assertEquals(ActivityTone.RUNNING, activityTone("running"))
    }
    @Test fun activityFallbackCanBeLocalizedAndLiveControlRequiresBoth() {
        assertEquals("Verificação", activitySummary(ActivityEntry("a", "", "check", "{}"), "Comando", "Job", "Verificação"))
        assertEquals("Job", activitySummary(ActivityEntry("a", "", "job", "{}"), "Comando", "Job", "Verificação"))
        assertTrue(showLiveControl(Link.Live, true))
        assertFalse(showLiveControl(Link.Live, false))
        assertFalse(showLiveControl(Link.Connecting, true))
        assertEquals("OK", jobStatus("ok"))
    }

    @Test fun activityDaysAndTimesUseInjectedZoneAndNow() {
        val now = Instant.parse("2026-10-14T02:30:00Z")
        val zone = java.time.ZoneId.of("America/Sao_Paulo")
        val entry = ActivityEntry("a", "2026-10-14T02:00:00Z", "job", "{}")
        assertEquals("23:00", activityTime(entry.at, zone))
        val groups = activityGroups(listOf(entry.copy(at = "2026-10-12T03:00:00Z"), entry), now, zone)
        assertEquals(listOf(ActivityDay.TODAY, ActivityDay.YESTERDAY), groups.map { it.day })
        assertEquals(ActivityDay.DATE, activityGroups(listOf(entry.copy(at = "2026-10-01T03:00:00Z")), now, zone).single().day)
    }
    @Test fun malformedActivityTimesAreGroupedLastInsteadOfCrashing() {
        val now = Instant.parse("2026-10-14T12:00:00Z")
        val good = ActivityEntry("a", "2026-10-14T11:00:00Z", "job", "{}")
        val groups = activityGroups(listOf(good.copy(at = "undefined"), good, good.copy(at = "")), now, ZoneOffset.UTC)
        assertEquals(listOf(ActivityDay.TODAY, ActivityDay.UNDATED), groups.map { it.day })
        assertNull(groups.last().date)
        assertEquals(2, groups.last().entries.size)
        assertEquals("--:--", activityTime("undefined", ZoneOffset.UTC))
        assertEquals("11:00", activityTime(good.at, ZoneOffset.UTC))
    }
    @Test fun bannersHideLiveAndPreserveCachedStates() {
        assertEquals(LinkBanner.NONE, linkBanner(Link.Live, true))
        assertEquals(LinkBanner.CONNECTING, linkBanner(Link.Connecting, false))
        assertEquals(LinkBanner.RETRYING, linkBanner(Link.Retrying(2, "reason"), false))
        assertEquals(LinkBanner.OFFLINE, linkBanner(Link.Stopped("reason"), false))
        for (link in listOf(Link.Connecting, Link.Retrying(2, "reason"), Link.Stopped("reason")))
            assertEquals(LinkBanner.CACHED, linkBanner(link, true))
    }

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
