package dev.supertools.govern.remote.data

import dev.supertools.govern.remote.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DeskCacheTest {
    @get:Rule val folder = TemporaryFolder()
    private inline fun <reified T> fixture(name: String): T = WireJson.decodeFromString(javaClass.getResource("/fixtures/$name.json")!!.readText())

    @Test fun snapshotsSurviveRestartAndStayIsolated() {
        val cache = DeskCache(folder.root)
        val desk = fixture<Desk>("desk")
        val lane = fixture<LaneDetail>("lane")
        cache.saveDesk("a", desk)
        cache.saveLane("a", lane, desk.at)
        cache.saveDesk("b", desk.copy(at = "2026-10-14T12:00:00Z"))
        val reopened = DeskCache(folder.root)
        assertEquals(desk, reopened.desk("a"))
        assertEquals(lane, reopened.lane("a", lane.slug)?.detail)
        assertEquals(desk.at, reopened.lane("a", lane.slug)?.at)
        assertNotEquals(reopened.desk("a")?.at, reopened.desk("b")?.at)
        assertNull(reopened.lane("b", lane.slug))
        cache.forget("a")
        assertNull(cache.desk("a"))
        assertNotNull(cache.desk("b"))
        assertTrue(folder.root.walk().none { it.name.endsWith(".tmp") })
    }

    @Test fun nestedLaneNamesAreEncodedWithoutCollisionsAndReplaceAtomically() {
        val cache = DeskCache(folder.root)
        val nested = fixture<LaneDetail>("lane").copy(slug = "ops/build")
        val flat = nested.copy(slug = "ops-build")
        cache.saveLane("a", nested, "2026-10-14T00:00:00Z")
        cache.saveLane("a", flat, "2026-10-14T00:00:00Z")
        val changed = nested.copy(title = "New title")
        cache.saveLane("a", changed, "2026-10-14T01:00:00Z")
        assertEquals(changed, cache.lane("a", nested.slug)?.detail)
        assertEquals(flat, cache.lane("a", flat.slug)?.detail)
        assertEquals(2, cache.lanes("a").size)
        assertTrue(File(folder.root, "a").listFiles()!!.all { it.isFile && it.extension == "json" })
    }

    @Test fun corruptSnapshotsAndUnsafePathsAreRejected() {
        val cache = DeskCache(folder.root)
        File(folder.root, "a").mkdir()
        File(folder.root, "a/desk.json").writeText("{bad")
        assertThrows(Exception::class.java) { cache.desk("a") }
        assertThrows(IllegalArgumentException::class.java) { cache.desk("../escape") }
        assertThrows(IllegalArgumentException::class.java) { cache.lane("a", "../escape") }
    }
}
