package dev.supertools.govern.remote.security

import android.content.Context
import dev.supertools.govern.remote.protocol.Endpoint
import java.time.Instant
import java.util.UUID

/** Preferences contain metadata and individually sealed tokens, never bearer plaintext. */
class HostStore(context: Context) {
    private val prefs = context.getSharedPreferences("govern-remote-hosts", Context.MODE_PRIVATE)
    private val legacy = context.getSharedPreferences("govern-remote", Context.MODE_PRIVATE)
    private val seal = TokenSeal()

    init {
        val url = legacy.getString("url", null)
        val device = legacy.getString("device", null)
        val person = legacy.getString("person", null)
        val token = legacy.getString("token", null)
        if (url != null && device != null && person != null && token != null) {
            val host = Host(UUID.randomUUID().toString(), java.net.URI(url).host ?: url, url, device, person,
                legacy.getString("pin", null), null, Instant.now().toString(), token, DeviceKey.LEGACY_ALIAS)
            persist(HostList(all()).migrate(host))
            check(legacy.edit().clear().commit()) { "could not finish pairing migration" }
        }
    }

    @Synchronized fun all(): List<Host> = prefs.getString("hosts", null)?.let { HostList.parse(it).hosts } ?: emptyList()
    fun selected(): String? = prefs.getString("selected", null)?.takeIf { id -> all().any { it.id == id } } ?: all().firstOrNull()?.id
    fun select(id: String) {
        require(all().any { it.id == id })
        check(prefs.edit().putString("selected", id).commit()) { "could not select host" }
    }
    fun endpoint(host: Host): Endpoint = Endpoint(host.baseUrl, seal.open(host.sealedToken), host.pin)

    @Synchronized fun save(host: Host, token: String): Host {
        val next = HostList(all()).add(host.copy(sealedToken = seal.seal(token)))
        persist(next)
        return next.hosts.first { it.baseUrl == host.baseUrl }
    }

    @Synchronized fun forget(id: String) {
        val host = all().firstOrNull { it.id == id } ?: return
        persist(HostList(all()).remove(id))
        DeviceKey.delete(host.keyAlias)
    }

    private fun persist(list: HostList) {
        check(prefs.edit().putString("hosts", list.serialize()).commit()) { "could not save hosts" }
    }
}
