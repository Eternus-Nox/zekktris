package com.zekktris.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.zekktris.ZekApp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Handles the "Decline" action on an incoming-call ring notification. Dismisses
 * the ring and REST-declines the call in the background (no UI), keyed by the
 * channel id the ring push carried — works even if the app was killed and only
 * this receiver was woken.
 */
class CallActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != NotificationHelper.ACTION_DECLINE_CALL) return
        val channelId = intent.getStringExtra(NotificationHelper.EXTRA_CHANNEL_ID) ?: return
        NotificationHelper.cancelIncomingCall(context, channelId)
        val app = context.applicationContext as? ZekApp ?: return
        val pending = goAsync()
        val settled = CompletableDeferred<Unit>()
        // Hold the process until the decline has actually gone out. Finishing
        // synchronously lets the OS kill this freshly-woken cached process before
        // the request is even issued, and the caller keeps ringing.
        runCatching { app.store.declineCallChannel(channelId) { settled.complete(Unit) } }
            .onFailure { settled.complete(Unit) }
        app.appScope.launch {
            // The HTTP client waits up to 30s, but a foreground broadcast has
            // ~10s before the OS declares it took too long. Stop WAITING well
            // inside that; the decline itself carries on unattended on appScope.
            withTimeoutOrNull(DECLINE_WAIT_MS) { settled.await() }
            pending.finish()
        }
    }

    private companion object {
        const val DECLINE_WAIT_MS = 8_000L
    }
}
