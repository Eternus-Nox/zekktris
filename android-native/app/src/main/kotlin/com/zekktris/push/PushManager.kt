package com.zekktris.push

import android.os.Build
import com.google.firebase.messaging.FirebaseMessaging
import com.zekktris.data.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Owns this device's FCM registration-token lifecycle against the server's
 * `/users/@me/device-tokens` endpoint (platform `android`; the token shares a
 * table with iOS/APNs but the server never cross-ships).
 *
 * Registration is best-effort and needs a valid session, so we (re)register
 * right after auth ([com.zekktris.AppStore] `enterReady`) and whenever FCM
 * rotates the token ([ZekMessagingService.onNewToken]). Until the server has
 * its `FCM_*` env vars set, the register call 503s and is silently ignored.
 */
class PushManager(
    private val api: ApiClient,
    private val scope: CoroutineScope,
) {
    private val deviceLabel = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    /** Fetch the current FCM token and register it. Call once authenticated. */
    fun registerCurrentToken() {
        scope.launch {
            val token = currentToken() ?: return@launch
            runCatching { api.registerDeviceToken(token, deviceLabel) }
        }
    }

    /** FCM rotated the token — register the new one (best-effort; needs a session). */
    fun onNewToken(token: String) {
        scope.launch { runCatching { api.registerDeviceToken(token, deviceLabel) } }
    }

    /**
     * Remove this device's token server-side. Call while the session is STILL
     * valid (i.e. before logout revokes it) so a signed-out device can't keep
     * receiving this account's pushes.
     */
    suspend fun deleteCurrentToken() {
        val token = currentToken() ?: return
        runCatching { api.deleteDeviceToken(token) }
    }

    private suspend fun currentToken(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { cont.resume(it) }
            .addOnFailureListener { cont.resume(null) }
    }
}
