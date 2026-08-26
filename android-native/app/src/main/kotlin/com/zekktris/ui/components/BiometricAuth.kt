package com.zekktris.ui.components

import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Thin wrapper over androidx.biometric for the app lock. Deliberately
 * FAIL-OPEN: [resolveAuthenticators] returns 0 when the device can't
 * authenticate at all, so callers escape the lock instead of trapping the
 * user. Combining BIOMETRIC_STRONG with DEVICE_CREDENTIAL is only supported
 * without a CryptoObject on API 30+, so we pick the strongest set that the
 * device actually reports as usable.
 */
object AppLockAuth {

    /** The best authenticator set the device can currently satisfy, or 0. */
    private fun resolveAuthenticators(activity: FragmentActivity): Int {
        val bm = BiometricManager.from(activity)
        fun ok(auth: Int) = bm.canAuthenticate(auth) == BiometricManager.BIOMETRIC_SUCCESS
        return when {
            Build.VERSION.SDK_INT >= 30 && ok(BIOMETRIC_STRONG or DEVICE_CREDENTIAL) -> BIOMETRIC_STRONG or DEVICE_CREDENTIAL
            Build.VERSION.SDK_INT >= 30 && ok(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
            ok(BIOMETRIC_STRONG) -> BIOMETRIC_STRONG
            ok(BIOMETRIC_WEAK) -> BIOMETRIC_WEAK
            Build.VERSION.SDK_INT >= 30 && ok(DEVICE_CREDENTIAL) -> DEVICE_CREDENTIAL
            else -> 0
        }
    }

    /** True when the device can authenticate (biometric or device credential). */
    fun canAuthenticate(activity: FragmentActivity): Boolean = resolveAuthenticators(activity) != 0

    /** Show the system biometric / device-credential prompt. onResult(true) on
     *  success, false on error/cancel/unavailable. */
    fun authenticate(activity: FragmentActivity, title: String, subtitle: String?, onResult: (Boolean) -> Unit) {
        val auth = resolveAuthenticators(activity)
        if (auth == 0) { onResult(false); return }
        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onResult(true)
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false)
                // onAuthenticationFailed = one bad attempt; the prompt stays open, no callback.
            },
        )
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(auth)
        if (subtitle != null) builder.setSubtitle(subtitle)
        // A negative "Cancel" button is required (and only allowed) when the
        // device credential isn't part of the prompt.
        if (auth and DEVICE_CREDENTIAL == 0) builder.setNegativeButtonText("Cancel")
        runCatching { prompt.authenticate(builder.build()) }.onFailure { onResult(false) }
    }
}
