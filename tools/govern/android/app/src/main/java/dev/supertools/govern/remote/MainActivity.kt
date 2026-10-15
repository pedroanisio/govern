package dev.supertools.govern.remote

import android.content.Intent
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.supertools.govern.remote.protocol.SignedAction
import dev.supertools.govern.remote.security.DeviceKey
import dev.supertools.govern.remote.ui.App
import dev.supertools.govern.remote.ui.AppModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { App(model, ::confirm) }
        // A recreated activity (rotation) still holds the intent it was opened with: offer it once, not on every recreate.
        if (savedInstanceState == null) offer(intent)
        // The stream runs while the app is on screen; it is not a background service.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                if (model.paired.value != null) model.startStream()
                try { kotlinx.coroutines.awaitCancellation() } finally { model.stopStream() }
            }
        }
    }

    /** A scan while the app is already open (singleTop) arrives here instead of starting a second copy. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        offer(intent)
    }

    /** A govern-remote://pair link the phone opened in this app (the manifest's VIEW filter) fills the pairing form. */
    private fun offer(intent: Intent?) {
        if (intent?.action == Intent.ACTION_VIEW) intent.dataString?.let(model::offerLink)
    }

    /**
     * Shows `body`'s meaning (`title`, `summary`) in the system confirmation, and signs `body` with the device key once the
     * person confirms with a strong biometric or the device credential. Nothing is signed or sent on cancel.
     */
    private fun confirm(title: String, summary: String, body: ByteArray, done: String) {
        val signature = try { DeviceKey.signature() } catch (e: Exception) { model.report(AppModel.describe(e)); return }
        val prompt = BiometricPrompt.Builder(this)
            .setTitle(title)
            .setDescription(summary)
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        prompt.authenticate(BiometricPrompt.CryptoObject(signature), CancellationSignal(), mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val s = result.cryptoObject?.signature ?: return model.report("the confirmation returned no signature")
                    try {
                        s.update(body)
                        model.send(SignedAction(body, s.sign()), done)
                    } catch (e: Exception) {
                        model.report(AppModel.describe(e))
                    }
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    model.report("not sent: $errString")
                }
            })
    }
}
