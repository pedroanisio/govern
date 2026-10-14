package dev.supertools.govern.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingLinkTest {
    private val pin = "7a965ae6d516012a7a24482c80108a632256676 80f668762c9b77c62c2216582".replace(" ", "")

    @Test
    fun theLinkGovernPrintsParses() {
        // as `govern remote pair --url https://govern.example.ts.net --tls-cert cert.pem` prints it (URLSearchParams encoding)
        val l = PairingLinks.parse("govern-remote://pair?url=https%3A%2F%2Fgovern.example.ts.net%3A5002&code=ABCD-EFGH-JKMN&pin=$pin")
        assertEquals(PairingLink("https://govern.example.ts.net:5002", "ABCD-EFGH-JKMN", pin), l)
        assertNull(PairingLinks.parse("govern-remote://pair?url=https%3A%2F%2Fh&code=X").pin)
    }

    @Test
    fun badLinksAreRefused() {
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.parse("https://pair?url=x&code=y") }
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.parse("govern-remote://pair?code=y") }
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.parse("govern-remote://pair?url=https%3A%2F%2Fh") }
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.parse("govern-remote://pair?url=ftp%3A%2F%2Fh&code=y") }
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.parse("govern-remote://pair?url=https%3A%2F%2Fh&code=y&pin=abc") }
    }

    @Test
    fun serverAddresses() {
        assertEquals("https://h.ts.net", PairingLinks.serverUrl(" https://h.ts.net/ "))
        assertEquals("http://10.0.2.2:5002", PairingLinks.serverUrl("http://10.0.2.2:5002"))
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.serverUrl("h.ts.net") }
        assertThrows(IllegalArgumentException::class.java) { PairingLinks.serverUrl("https://h.ts.net/?x=1") }
    }

    @Test
    fun pinsFoldColonsAndCase() {
        assertEquals(pin, PairingLinks.pin("7A:96:5A:E6:D5:16:01:2A:7A:24:48:2C:80:10:8A:63:22:56:67:68:0F:66:87:62:C9:B7:7C:62:C2:21:65:82"))
    }
}
