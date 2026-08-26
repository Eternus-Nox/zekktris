package com.zekktris.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.zekktris.ZekApp

/**
 * FCM entry point. The server sends Android pushes DATA-ONLY, so this runs for
 * every message in every app state (foreground, background, killed) — the OS no
 * longer draws banners itself. We render the notification here, which is what
 * makes inline quick-reply, the full-screen call ring, and on-device E2EE
 * preview decryption possible.
 */
class ZekMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        (applicationContext as? ZekApp)?.push?.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val store = (applicationContext as? ZekApp)?.store
        // Settings' "Messages & mentions" / "Incoming calls" switches. Data-only
        // pushes mean the OS draws nothing on its own, so this is the ONLY place
        // those toggles can be honoured — without the read they're write-only.
        val prefs = applicationContext.getSharedPreferences("zk_prefs", MODE_PRIVATE)

        // Incoming call → ring full-screen (Answer / Decline). Skip when the app
        // is already foregrounded: the gateway rings a connected client in-app,
        // and a second full-screen ring on top would double up.
        if (data["kind"] == "call") {
            val channelId = data["channelId"] ?: return
            if (store?.isForeground == true) return
            if (!prefs.getBoolean("zk.notifyCalls", true)) return
            val callerName = data["callerName"] ?: data["title"] ?: "Incoming call"
            NotificationHelper.showIncomingCall(applicationContext, channelId, callerName)
            return
        }

        val channelId = data["channelId"]
        // A push for the conversation the user is LOOKING AT: sync it into the
        // open view and skip the banner — the message paints in place instead.
        if (channelId != null && store?.onPushForChannel(channelId) == true) return

        // Gated AFTER the open-channel sync above: muting banners must not also
        // stop the conversation the user is reading from updating live.
        //
        // Scoped to kind=="message" (DMs, mentions, streak warnings, event
        // reminders) because that is what the "Messages & mentions" switch says
        // it controls. As a catch-all for "not a call" it also silenced pokes and
        // friend requests, which the server sends with no `kind` at all.
        if (data["kind"] == "message" && !prefs.getBoolean("zk.notifyMessages", true)) return

        val title = message.notification?.title ?: data["title"] ?: "Zekktris"
        // E2EE preview: if the push carried ciphertext and we hold the channel
        // key, decrypt on-device so the banner shows the real text instead of
        // "Encrypted message"; otherwise fall back to the server-sent body.
        val decrypted = data["e2ee"]?.let { cipher ->
            if (channelId != null) store?.decryptPushPreview(channelId, cipher) else null
        }
        val body = decrypted ?: message.notification?.body ?: data["body"].orEmpty()
        val isE2EE = data["isE2EE"] == "true"

        // messageId (when the server push carries it, same field iOS reads from
        // userInfo) lets a tap deep-link to the exact message.
        NotificationHelper.showMessage(applicationContext, channelId, title, body, isE2EE, data["messageId"])
    }
}
