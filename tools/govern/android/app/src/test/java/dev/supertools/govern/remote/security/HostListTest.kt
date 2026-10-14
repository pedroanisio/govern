package dev.supertools.govern.remote.security

import org.junit.Assert.*
import org.junit.Test

class HostListTest {
    private fun host(id: String, url: String = "https://$id.test") = Host(id, id, url, "device-$id", "owner", null, null, "2026-10-14T00:00:00Z", "sealed-$id")

    @Test fun addReplaceRemoveAndSerialize() {
        val a = host("a")
        val b = host("b")
        val list = HostList().add(a).add(b)
        assertEquals(list, HostList.parse(list.serialize()))
        val replacement = host("new", a.baseUrl)
        val replaced = list.add(replacement)
        assertEquals(2, replaced.hosts.size)
        assertEquals("a", replaced.hosts.first().id)
        assertEquals("sealed-new", replaced.hosts.first().sealedToken)
        assertEquals(a.keyAlias, replaced.hosts.first().keyAlias)
        assertEquals(listOf(b), replaced.remove("a").hosts)
        assertEquals("govern-remote-device-a", a.keyAlias)
    }

    @Test fun migrationIsIdempotentAndKeepsLegacyKey() {
        val legacy = host("legacy").copy(keyAlias = "govern-remote-device")
        val list = HostList().migrate(legacy)
        assertEquals(list, list.migrate(host("again", legacy.baseUrl)))
        assertEquals("govern-remote-device", HostList.parse(list.serialize()).hosts.single().keyAlias)
        assertEquals(listOf(host("b"), legacy), HostList().add(host("b")).migrate(legacy).hosts)
    }

    @Test fun invalidAndDuplicateIdentitiesAreRejected() {
        for (json in listOf("{}", "[{}]")) {
            assertThrows(IllegalArgumentException::class.java) { HostList.parse(json) }
        }
        assertThrows(IllegalArgumentException::class.java) { HostList(listOf(host("a"), host("a"))) }
        assertThrows(IllegalArgumentException::class.java) { HostList().add(host("../escape")) }
    }
}
