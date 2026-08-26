package com.zekktris.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.zekktris.ZekApp

/**
 * Handles the inline "Reply" action on a message notification. Reads the typed
 * text out of the RemoteInput and sends it through the store — which encrypts
 * on-device first when the push flagged the DM as E2EE, so a quick-reply is
 * never sent in plaintext to an encrypted conversation. Uses goAsync() to keep
 * the process alive across the network send even if the app was just woken from
 * a killed state.
 */
class QuickReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != NotificationHelper.ACTION_REPLY) return
        val channelId = intent.getStringExtra(NotificationHelper.EXTRA_CHANNEL_ID) ?: return
        val isE2EE = intent.getBooleanExtra(NotificationHelper.EXTRA_IS_E2EE, false)
        val text = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(NotificationHelper.KEY_REPLY_TEXT)
            ?.toString()
            ?.trim()
            .orEmpty()

        val store = (context.applicationContext as? ZekApp)?.store
        if (text.isEmpty() || store == null) {
            NotificationHelper.clearForChannel(context, channelId)
            return
        }

        val pending = goAsync()
        store.sendQuickReply(channelId, text, isE2EE) {
            // The reply landed (or failed) — dismiss the notification either way;
            // a failed send stays queued optimistically and surfaces in-app.
            NotificationHelper.clearForChannel(context, channelId)
            pending.finish()
        }
    }
}
