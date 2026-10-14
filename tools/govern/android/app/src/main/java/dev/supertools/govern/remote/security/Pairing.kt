package dev.supertools.govern.remote.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.util.Base64

/** Seals each bearer token with the existing Keystore AES-GCM key. */
internal class TokenSeal {
    private fun sealKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(SEAL, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(SEAL, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    fun seal(token: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, sealKey()) }
        val b64 = Base64.getEncoder()
        return b64.encodeToString(c.iv) + "." + b64.encodeToString(c.doFinal(token.toByteArray(Charsets.UTF_8)))
    }

    fun open(sealed: String): String {
        val (iv, data) = sealed.split('.').also { require(it.size == 2) { "the stored token is damaged: pair again" } }
        val b64 = Base64.getDecoder()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, b64.decode(iv))) }
        return c.doFinal(b64.decode(data)).toString(Charsets.UTF_8)
    }

    private companion object { const val SEAL = "govern-remote-token-seal" }
}
