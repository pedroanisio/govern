package dev.supertools.govern.remote.protocol

import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

class PinTrustTest {
    /** openssl x509 -fingerprint -sha256 of fixtures/server-cert.pem, computed outside this code. */
    private val opensslPin = "7a965ae6d516012a7a24482c80108a632256676" + "80f668762c9b77c62c2216582"

    private val cert: X509Certificate = javaClass.classLoader!!.getResourceAsStream("fixtures/server-cert.pem")!!.use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }

    @Test
    fun thePinnedCertificateIsTrusted() {
        GovernClient.pinTrust(opensslPin).checkServerTrusted(arrayOf(cert), "ECDHE_ECDSA")
    }

    @Test
    fun anyOtherCertificateIsRefused() {
        val other = opensslPin.replaceRange(0, 1, "0")
        assertThrows(CertificateException::class.java) { GovernClient.pinTrust(other).checkServerTrusted(arrayOf(cert), "ECDHE_ECDSA") }
        assertThrows(CertificateException::class.java) { GovernClient.pinTrust(opensslPin).checkServerTrusted(arrayOf(), "ECDHE_ECDSA") }
    }
}
