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
    private const val ALIAS = "govern-remote-device"

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    /** Creates a fresh key (any earlier one is deleted: pairing again replaces the device's identity). StrongBox when present. */
    fun create(): String {
        val ks = keyStore()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
        try {
            generate(strongBox = true)
        } catch (e: StrongBoxUnavailableException) {
            generate(strongBox = false)
        }
        return publicKeyBase64()
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
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
    fun publicKeyBase64(): String {
        val cert = keyStore().getCertificate(ALIAS) ?: throw IllegalStateException("no device key: pair this device first")
        return Base64.getEncoder().encodeToString(cert.publicKey.encoded)
    }

    fun exists(): Boolean = keyStore().containsAlias(ALIAS)

    /** A Signature ready for one ECDSA-SHA256 signature; it works only after the person confirms it in BiometricPrompt. */
    fun signature(): Signature {
        val key = keyStore().getKey(ALIAS, null) as? PrivateKey ?: throw IllegalStateException("no device key: pair this device first")
        return Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
    }

    fun delete() {
        val ks = keyStore()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    }
}
