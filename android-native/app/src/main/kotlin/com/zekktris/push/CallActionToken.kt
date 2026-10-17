package com.zekktris.push

import android.content.Context
import android.content.Intent
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Proof that an "answer this call" launch came from OUR ring notification.
 *
 * MainActivity has to be exported (launcher + share sheet), so any installed
 * app can start it with any extras it likes. The ring's Answer action still has
 * to land there (it owns the lock-screen hand-off), and a bare
 * [NotificationHelper.EXTRA_ANSWER_CALL_CHANNEL_ID] used to be trusted as is:
 * a zero-permission app could make Zekktris join a voice channel of its choosing
 * with the mic open.
 *
 * The Answer PendingIntent therefore also carries a per-install random secret.
 * It lives only in this app's private storage, and a PendingIntent's extras are
 * never readable by the apps it is handed to (the system UI firing it can send
 * it, which is exactly the user tapping Answer). MainActivity additionally
 * requires the ring for that channel to still be posted
 * ([NotificationHelper.isRinging]), so even a matching token can't join a call
 * that isn't ringing.
 *
 * The other call surfaces don't need this: IncomingCallActivity,
 * CallActionReceiver and QuickReplyReceiver are not exported, so only our own
 * PendingIntents can reach them.
 */
internal object CallActionToken {
    const val EXTRA = "zk_call_action_token"

    private const val PREFS = "zk_call_actions"
    private const val KEY_SECRET = "secret"

    /** The install's secret, created on first use. Called when posting a ring
     *  (off the main thread — FCM's worker), so the synchronous commit is fine. */
    @Synchronized
    fun get(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_SECRET, null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = Base64.encodeToString(bytes, Base64.NO_WRAP)
        prefs.edit().putString(KEY_SECRET, secret).commit()
        return secret
    }

    /** Attach the secret to an intent our ring notification will fire. */
    fun attach(context: Context, intent: Intent): Intent = intent.putExtra(EXTRA, get(context))

    /** True only when [presented] is this install's secret. Never creates one:
     *  with no ring ever posted there is nothing a launch could be answering. */
    fun matches(context: Context, presented: String?): Boolean {
        if (presented.isNullOrEmpty()) return false
        val secret = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SECRET, null) ?: return false
        return MessageDigest.isEqual(secret.toByteArray(), presented.toByteArray())
    }
}
