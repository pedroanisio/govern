package dev.supertools.govern.remote.protocol

// A reader of text/event-stream (WHATWG HTML, "Server-sent events"): lines are fed in order, and an event is dispatched at
// each blank line. Only `event` and `data` are used by govern-remote/2; comments (lines starting with ':') are heartbeats.

data class SseEvent(val event: String, val data: String)

class SseParser {
    private var event = ""
    private val data = StringBuilder()
    private var hasData = false

    /** Feeds one line (without its line terminator); returns the event the line completes, if any. */
    fun line(line: String): SseEvent? {
        if (line.isEmpty()) {
            val done = if (hasData) SseEvent(event.ifEmpty { "message" }, data.toString()) else null
            event = ""
            data.setLength(0)
            hasData = false
            return done
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> event = value
            "data" -> {
                if (hasData) data.append('\n')
                data.append(value)
                hasData = true
            }
        }
        return null
    }
}
