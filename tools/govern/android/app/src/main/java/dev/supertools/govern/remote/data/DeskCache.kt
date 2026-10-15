package dev.supertools.govern.remote.data

import dev.supertools.govern.remote.protocol.Desk
import dev.supertools.govern.remote.protocol.LaneDetail
import dev.supertools.govern.remote.protocol.WireJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.StandardCopyOption

@Serializable
data class CachedLane(val at: String, val detail: LaneDetail)

/** Atomic snapshots under noBackupFilesDir/cache; the caller supplies the root for JVM tests. */
class DeskCache(private val root: File) {
    private fun safe(value: String): String {
        require(value.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]*"))) { "unsafe cache name" }
        return value
    }

    private fun laneName(slug: String): String {
        require(slug.isNotEmpty() && !slug.startsWith("/") && slug.split('/').none { it.isEmpty() || it == ".." || it == "." }) { "unsafe lane name" }
        val digest = MessageDigest.getInstance("SHA-256").digest(slug.toByteArray(Charsets.UTF_8))
        return "lane-" + digest.joinToString("") { "%02x".format(it) } + ".json"
    }

    private fun file(host: String, name: String): File = File(File(root, safe(host)), name)

    @Synchronized fun desk(host: String): Desk? = file(host, "desk.json").let {
        if (it.exists()) WireJson.decodeFromString<Desk>(it.readText()) else null
    }

    @Synchronized fun lane(host: String, slug: String): CachedLane? = file(host, laneName(slug)).let {
        if (it.exists()) WireJson.decodeFromString<CachedLane>(it.readText()) else null
    }

    @Synchronized fun lanes(host: String): List<CachedLane> = File(root, safe(host)).listFiles()
        .orEmpty().filter { it.name.startsWith("lane-") && it.name.endsWith(".json") }
        .map { WireJson.decodeFromString<CachedLane>(it.readText()) }

    @Synchronized fun saveDesk(host: String, desk: Desk) = write(file(host, "desk.json"), WireJson.encodeToString(desk))
    @Synchronized fun saveLane(host: String, lane: LaneDetail, at: String) =
        write(file(host, laneName(lane.slug)), WireJson.encodeToString(CachedLane(at, lane)))

    @Synchronized fun forget(host: String) {
        val dir = File(root, safe(host))
        check(!dir.exists() || dir.deleteRecursively()) { "could not remove cached host" }
    }

    private fun write(target: File, text: String) {
        check(target.parentFile!!.isDirectory || target.parentFile!!.mkdirs()) { "could not create cache directory" }
        val temp = File(target.parentFile, target.name + ".tmp")
        try {
            FileOutputStream(temp).use { out -> out.write(text.toByteArray(Charsets.UTF_8)); out.fd.sync() }
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            temp.delete()
        }
    }
}
