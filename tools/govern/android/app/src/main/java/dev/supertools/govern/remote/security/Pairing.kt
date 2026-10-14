package dev.supertools.govern.remote.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.supertools.govern.remote.protocol.Endpoint
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.util.Base64

/** What pairing left on this device: the server, the device id, the person it approves as, and its pin. */
data class PairedServer(val baseUrl: String, val deviceId: String, val person: String, val pin: String?)

/**
 * The paired server and the bearer token. The token is sealed with an AES-GCM key kept in the Android Keystore, so the
 * preferences file alone (a backup, a copied data folder) does not carry a usable token.
 */
class PairingStore(context: Context) {
    private val prefs = context.getSharedPreferences("govern-remote", Context.MODE_PRIVATE)

    fun paired(): PairedServer? {
        val url = prefs.getString(URL, null) ?: return null
        val id = prefs.getString(DEVICE, null) ?: return null
        val person = prefs.getString(PERSON, null) ?: return null
        return PairedServer(url, id, person, prefs.getString(PIN, null))
    }

    fun endpoint(): Endpoint? {
        val p = paired() ?: return null
        val sealed = prefs.getString(TOKEN, null) ?: return null
        return Endpoint(p.baseUrl, open(sealed), p.pin)
    }

    fun save(server: PairedServer, token: String) {
        prefs.edit()
            .putString(URL, server.baseUrl).putString(DEVICE, server.deviceId).putString(PERSON, server.person)
            .putString(PIN, server.pin).putString(TOKEN, seal(token))
            .apply()
    }

    fun forget() {
        prefs.edit().clear().apply()
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (ks.containsAlias(SEAL)) ks.deleteEntry(SEAL)
        DeviceKey.delete()
    }

    private fun sealKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(SEAL, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(SEAL, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    private fun seal(token: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, sealKey()) }
        val b64 = Base64.getEncoder()
        return b64.encodeToString(c.iv) + "." + b64.encodeToString(c.doFinal(token.toByteArray(Charsets.UTF_8)))
    }

    private fun open(sealed: String): String {
        val (iv, data) = sealed.split('.').also { require(it.size == 2) { "the stored token is damaged: pair again" } }
        val b64 = Base64.getDecoder()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, b64.decode(iv))) }
        return c.doFinal(b64.decode(data)).toString(Charsets.UTF_8)
    }

    private companion object {
        const val URL = "url"
        const val DEVICE = "device"
        const val PERSON = "person"
        const val PIN = "pin"
        const val TOKEN = "token"
        const val SEAL = "govern-remote-token-seal"
    }
}
