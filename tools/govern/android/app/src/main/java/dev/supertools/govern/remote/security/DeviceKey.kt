package dev.supertools.govern.remote.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The device's signing key: P-256 in the Android Keystore, never exportable, and usable for one signature per strong
 * biometric or device-credential confirmation (timeout 0). The server stores only its public half, from pairing.
 */
object DeviceKey {
    private const val STORE = "AndroidKeyStore"
    const val LEGACY_ALIAS = "govern-remote-device"

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    /** Creates a fresh key (any earlier one is deleted: pairing again replaces the device's identity). StrongBox when present. */
    fun create(alias: String = LEGACY_ALIAS): String {
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        try {
            generate(alias, strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            generate(alias, strongBox = false)
        }
        return publicKeyBase64(alias)
    }

    private fun generate(alias: String, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(false)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec) }.generateKeyPair()
    }

    /** The public key as base64 DER SubjectPublicKeyInfo, the form the server's pairing endpoint takes. */
    fun publicKeyBase64(alias: String = LEGACY_ALIAS): String {
        val cert = keyStore().getCertificate(alias) ?: throw IllegalStateException("no device key: pair this device first")
        return Base64.getEncoder().encodeToString(cert.publicKey.encoded)
    }

    fun exists(alias: String = LEGACY_ALIAS): Boolean = keyStore().containsAlias(alias)

    /** A Signature ready for one ECDSA-SHA256 signature; it works only after the person confirms it in BiometricPrompt. */
    fun signature(alias: String = LEGACY_ALIAS): Signature {
        val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw IllegalStateException("no device key: pair this device first")
        return Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
    }

    fun delete(alias: String = LEGACY_ALIAS) {
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    }
}
