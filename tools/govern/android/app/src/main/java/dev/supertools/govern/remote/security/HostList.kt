package dev.supertools.govern.remote.security

import dev.supertools.govern.remote.protocol.WireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class Host(
    val id: String,
    val name: String,
    val baseUrl: String,
    val deviceId: String,
    val person: String,
    val pin: String?,
    val lanes: List<String>?,
    val pairedAt: String,
    val sealedToken: String,
    val keyAlias: String = "govern-remote-device-$id",
)

/** Pure list operations; credentials here are already sealed by HostStore. */
data class HostList(val hosts: List<Host> = emptyList()) {
    init {
        require(hosts.all { it.id.matches(Regex("[A-Za-z0-9-]+")) })
        require(hosts.map { it.id }.distinct().size == hosts.size)
        require(hosts.map { it.baseUrl }.distinct().size == hosts.size)
        require(hosts.map { it.keyAlias }.distinct().size == hosts.size)
    }

    fun add(host: Host): HostList {
        val old = hosts.firstOrNull { it.baseUrl == host.baseUrl }
        return if (old == null) HostList(hosts + host)
        else HostList(hosts.map { if (it.id == old.id) host.copy(id = old.id, keyAlias = old.keyAlias) else it })
    }

    fun remove(id: String): HostList = HostList(hosts.filterNot { it.id == id })
    fun migrate(legacy: Host): HostList = if (hosts.any { it.baseUrl == legacy.baseUrl }) this else add(legacy)
    fun serialize(): String = WireJson.encodeToString(hosts)

    companion object {
        fun parse(text: String): HostList = HostList(WireJson.decodeFromString<List<Host>>(text))
    }
}
