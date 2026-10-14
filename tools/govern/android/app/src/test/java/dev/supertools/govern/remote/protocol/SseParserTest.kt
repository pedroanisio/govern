package dev.supertools.govern.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SseParserTest {
    private fun feed(vararg lines: String): List<SseEvent> {
        val p = SseParser()
        return lines.mapNotNull(p::line)
    }

    @Test
    fun eventsEndAtBlankLines() {
        assertEquals(listOf(SseEvent("desk", "{\"a\":1}"), SseEvent("desk", "{}")),
            feed("event: desk", "data: {\"a\":1}", "", "event: desk", "data: {}", ""))
    }

    @Test
    fun commentsAreHeartbeatsAndDispatchNothing() {
        assertEquals(emptyList<SseEvent>(), feed(": ping", "", ": ping", ""))
    }

    @Test
    fun multiLineDataIsJoinedAndTheDefaultEventIsMessage() {
        assertEquals(listOf(SseEvent("message", "a\nb")), feed("data: a", "data:b", ""))
    }

    @Test
    fun anEventWithoutDataIsDropped() {
        val p = SseParser()
        assertNull(p.line("event: desk"))
        assertNull(p.line(""))
        assertEquals(SseEvent("message", "x"), listOf("data: x", "").mapNotNull(p::line).single())
    }
}
