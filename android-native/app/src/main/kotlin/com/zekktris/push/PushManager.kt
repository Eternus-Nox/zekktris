package com.zekktris.push

import android.content.Context
import android.os.Build
import android.util.Log
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
    private val appContext: Context,
    private val api: ApiClient,
    private val scope: CoroutineScope,
) {
    private val deviceLabel = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    // Attempts remaining on the current registration. Dropping a failed register
    // on the floor — offline at sign-in, Play Services not ready, no session yet
    // — is how a device ends up with ZERO push for the life of the install, with
    // nothing to trigger another try. Bounded so a server that simply has no FCM
    // config isn't hammered on every foreground.
    // Written from the FCM binder thread (onNewToken) and read/written on
    // Dispatchers.Main.immediate, so it needs a happens-before edge.
    @Volatile
    private var attemptsLeft = 0

    /** Dismiss delivered notifications for a conversation once it's been read. */
    fun clearChannelNotifications(channelId: String) {
        runCatching { NotificationHelper.clearForChannel(appContext, channelId) }
    }

    /**
     * Dismiss the incoming-call ring. The ring is posted `setOngoing(true)`, so
     * without this the caller hanging up (or the call being answered on another
     * device) leaves a notification the user cannot swipe away.
     */
    fun cancelIncomingCall(channelId: String) {
        runCatching { NotificationHelper.cancelIncomingCall(appContext, channelId) }
    }

    /** Fetch the current FCM token and register it. Call once authenticated. */
    fun registerCurrentToken() {
        attemptsLeft = MAX_REGISTER_ATTEMPTS
        scope.launch { attemptRegister() }
    }

    /** FCM rotated the token — register the new one (best-effort; needs a session). */
    fun onNewToken(token: String) {
        attemptsLeft = MAX_REGISTER_ATTEMPTS
        scope.launch { attemptRegister(token) }
    }

    /** Retry a registration that failed earlier. Called on every foreground —
     *  the return to foreground IS the backoff, and it's the point at which the
     *  radio and the session are most likely to be back. */
    fun onAppForeground() {
        if (attemptsLeft > 0) scope.launch { attemptRegister() }
    }

    /**
     * Remove this device's token server-side. Call while the session is STILL
     * valid (i.e. before logout revokes it) so a signed-out device can't keep
     * receiving this account's pushes.
     */
    suspend fun deleteCurrentToken() {
        // Drop any pending retry too, or a foreground right after sign-out could
        // re-register the token we just deleted.
        attemptsLeft = 0
        val token = currentToken() ?: return
        runCatching { api.deleteDeviceToken(token) }
    }

    /** One registration attempt. [known] is the token FCM just handed us; on a
     *  retry we re-read the CURRENT one, since it may have rotated meanwhile. */
    private suspend fun attemptRegister(known: String? = null) {
        if (attemptsLeft <= 0) return
        // Registering without a session 401s and is silently discarded — that's a
        // retryable "not yet", not a success.
        if (api.ensureAccessToken() == null) {
            Log.w(TAG, "register skipped: no access token yet")
            return
        }
        // Every bail here used to be silent, which made "Android notifications
        // don't work" indistinguishable from "the app never even asked". If
        // Play Services can't mint a token — no Play Services, a
        // google-services.json whose package doesn't match applicationId, no
        // network at sign-in — the device stays pushless with nothing to see.
        // Say so, on the one tag worth grepping for.
        val token = known ?: currentToken()
        if (token == null) {
            Log.e(TAG, "register aborted: FirebaseMessaging returned no token")
            return
        }
        // Spend the budget only once we have BOTH a session and a token, i.e. on
        // a real network attempt. Charging the bails above let three foregrounds
        // in a signed-out window exhaust it and leave the device pushless.
        attemptsLeft--
        // Retire the budget on a 2xx ONLY. The client is built with
        // expectSuccess=false, so a 401 (revoked session) or the 503 the server
        // returns until its FCM_* env vars are set both come back as ordinary
        // responses — treating those as success retired the retry on exactly the
        // failures it exists to survive, leaving the device pushless for good.
        val result = runCatching { api.registerDeviceToken(token, deviceLabel) }
        if (result.getOrDefault(false)) {
            attemptsLeft = 0
            Log.i(TAG, "device token registered with the server")
        } else {
            // A non-2xx (the 503 the server returns until its FCM_* env vars
            // are set, or a 401) or a thrown request. Both are retryable, and
            // both were previously invisible.
            Log.w(
                TAG,
                "register failed, $attemptsLeft attempt(s) left: " +
                    (result.exceptionOrNull()?.toString() ?: "server rejected the token"),
            )
        }
    }

    private suspend fun currentToken(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { cont.resume(it) }
            .addOnFailureListener { err ->
                // The reason matters and used to be discarded: MISSING_INSTANCEID_SERVICE
                // means no Play Services, SERVICE_NOT_AVAILABLE is transient,
                // and an auth error usually means google-services.json does not
                // match this build's applicationId.
                Log.e(TAG, "FirebaseMessaging could not mint a token", err)
                cont.resume(null)
            }
    }

    private companion object {
        const val MAX_REGISTER_ATTEMPTS = 3
        const val TAG = "ZekPush"
    }
}
