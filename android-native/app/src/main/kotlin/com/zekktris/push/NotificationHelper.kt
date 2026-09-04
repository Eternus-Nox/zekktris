package com.zekktris.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.zekktris.MainActivity
import com.zekktris.R
import com.zekktris.share.ShareShortcuts
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Owns the notification channels and posts notifications.
 *
 * Since the server sends Android pushes DATA-ONLY (no `notification` block), the
 * OS never draws a banner itself — [ZekMessagingService.onMessageReceived] runs
 * in every app state and calls into here to build the visible notification. That
 * is what lets a message notification carry an inline Reply action and an
 * incoming call ring full-screen with Answer / Decline.
 */
object NotificationHelper {

    private const val NOTIFICATION_ID = 1
    private const val CALL_NOTIFICATION_ID = 4300

    /** Low-importance channel for the ongoing-call foreground-service notification. */
    const val CALL_CHANNEL_ID = "zk_call"

    /** High-importance channel for an INCOMING call ring (loud, heads-up, ringtone). */
    const val RING_CHANNEL_ID = "zk_ring"

    // Inline quick-reply plumbing (read back in QuickReplyReceiver).
    const val KEY_REPLY_TEXT = "zk_reply_text"
    const val ACTION_REPLY = "com.zekktris.action.REPLY"
    const val ACTION_DECLINE_CALL = "com.zekktris.action.DECLINE_CALL"
    const val EXTRA_CHANNEL_ID = "zk_channel_id"
    const val EXTRA_IS_E2EE = "zk_is_e2ee"
    const val EXTRA_ANSWER_CALL_CHANNEL_ID = "answerCallChannelId"

    fun notificationChannelId(context: Context): String =
        context.getString(R.string.default_notification_channel_id)

    /** Idempotent — the persistent "in a call" notification channel. */
    fun ensureCallChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CALL_CHANNEL_ID) != null) return
        val channel = NotificationChannel(CALL_CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Ongoing voice calls"
            setSound(null, null)
        }
        mgr.createNotificationChannel(channel)
    }

    /** Idempotent — the incoming-call RING channel (max importance so it heads-up
     *  and can raise a full-screen intent, with the system ringtone). */
    fun ensureRingChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(RING_CHANNEL_ID) != null) return
        val channel = NotificationChannel(RING_CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Ringing voice and video calls"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400)
            val ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            setSound(ring, attrs)
        }
        mgr.createNotificationChannel(channel)
    }

    /** Idempotent — safe to call on every app start and before every post. */
    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        val id = notificationChannelId(context)
        if (mgr.getNotificationChannel(id) != null) return
        val channel = NotificationChannel(id, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Direct messages, mentions, and replies"
        }
        mgr.createNotificationChannel(channel)
    }

    /**
     * Post a message notification with an inline Reply action. [channelId] routes
     * a tap (and the reply) back to the right conversation; [isE2EE] tells the
     * reply handler to encrypt on-device before sending.
     */
    /**
     * MUST be called off the main thread — it blocks briefly on the sender's
     * avatar. [ZekMessagingService.onMessageReceived] already runs on a worker.
     */
    fun showMessage(
        context: Context,
        channelId: String?,
        title: String,
        body: String,
        isE2EE: Boolean,
        messageId: String? = null,
        senderId: String? = null,
        senderName: String? = null,
        senderAvatarUrl: String? = null,
        groupName: String? = null,
    ) {
        if (!canPost(context)) return
        ensureChannel(context)

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            channelId?.let { putExtra("channelId", it) }
            // Deep-link target: tap scrolls to this message (iOS parity).
            messageId?.let { putExtra("messageId", it) }
        }
        val pending = PendingIntent.getActivity(
            context,
            (channelId ?: "").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(context, notificationChannelId(context))
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)

        // MessagingStyle — the Android counterpart to the iOS communication
        // notification. It is what makes the system treat this as a message
        // FROM A PERSON rather than an app alert: the sender's face on the
        // notification, correct grouping of a back-and-forth, and eligibility
        // for the Conversations section and bubbles.
        //
        // The conversation treatment additionally requires a matching LONG-LIVED
        // dynamic shortcut, which ShareShortcuts already publishes for recent
        // 1:1 DMs keyed by channel id — so setShortcutId lines the notification
        // up with one when it exists. When it does not (an older conversation
        // that fell out of the published set, or a guild channel), the styling
        // still applies and only the Conversations placement is lost.
        val displayName = senderName?.takeIf { it.isNotBlank() } ?: title
        val sender = Person.Builder()
            .setKey(senderId ?: displayName)   // stable across a rename
            .setName(displayName)
            .apply {
                // Blocking, bounded: this runs on the FCM worker thread, and a
                // notification nobody can see yet is worth a moment's wait. A
                // timeout costs the face, never the notification.
                val icon = senderId?.let { id ->
                    runBlocking {
                        withTimeoutOrNull(3_000) {
                            ShareShortcuts.personIcon(context, id, displayName, senderAvatarUrl)
                        }
                    }
                }
                if (icon != null) setIcon(icon)
            }
            .build()
        val style = NotificationCompat.MessagingStyle(
            // "You" is the local participant. Only ever rendered for messages
            // attributed to us, which this notification never carries.
            Person.Builder().setName("You").build(),
        ).addMessage(body, System.currentTimeMillis(), sender)
        // A guild channel (or group DM) names itself; a 1:1 is named by its
        // sender, so it gets no conversation title at all.
        if (!groupName.isNullOrBlank()) {
            style.conversationTitle = groupName
            style.isGroupConversation = true
        }
        builder.setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        channelId?.let { builder.setShortcutId(it) }

        // Inline Reply — only for a real conversation. The PendingIntent MUST be
        // mutable so the system can attach the typed RemoteInput results.
        if (channelId != null) {
            val remoteInput = RemoteInput.Builder(KEY_REPLY_TEXT).setLabel("Reply").build()
            val replyIntent = Intent(context, QuickReplyReceiver::class.java).apply {
                action = ACTION_REPLY
                putExtra(EXTRA_CHANNEL_ID, channelId)
                putExtra(EXTRA_IS_E2EE, isE2EE)
            }
            val replyPending = PendingIntent.getBroadcast(
                context,
                channelId.hashCode(),
                replyIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            builder.addAction(
                NotificationCompat.Action.Builder(R.drawable.ic_stat_notify, "Reply", replyPending)
                    .addRemoteInput(remoteInput)
                    .setAllowGeneratedReplies(true)
                    .build(),
            )
        }

        NotificationManagerCompat.from(context)
            .notify(channelId ?: "zekktris", NOTIFICATION_ID, builder.build())
    }

    /**
     * Ring an incoming call: a high-priority, ongoing notification that raises a
     * full-screen [IncomingCallActivity] (over the lock screen) and offers
     * Answer / Decline actions.
     */
    fun showIncomingCall(context: Context, channelId: String, callerName: String) {
        if (!canPost(context)) return
        ensureRingChannel(context)

        val fullScreen = Intent(context, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_CHANNEL_ID, channelId)
            putExtra("callerName", callerName)
        }
        val fullScreenPending = PendingIntent.getActivity(
            context,
            ("ringfs-$channelId").hashCode(),
            fullScreen,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Answer → open the call screen (same as the full-screen intent).
        val answerPending = PendingIntent.getActivity(
            context,
            ("ringans-$channelId").hashCode(),
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_ANSWER_CALL_CHANNEL_ID, channelId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Decline → REST decline in the background, no UI.
        val declinePending = PendingIntent.getBroadcast(
            context,
            ("ringdec-$channelId").hashCode(),
            Intent(context, CallActionReceiver::class.java).apply {
                action = ACTION_DECLINE_CALL
                putExtra(EXTRA_CHANNEL_ID, channelId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, RING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(callerName)
            .setContentText("Incoming call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(false)
            // An ongoing ring has no self-cancel path, so a call nobody answers
            // (caller hung up, process killed before the gateway said so) would
            // pin the notification forever. 45s matches the iOS ring timeout.
            .setTimeoutAfter(45_000)
            .setFullScreenIntent(fullScreenPending, true)
            .addAction(R.drawable.ic_stat_notify, "Decline", declinePending)
            .addAction(R.drawable.ic_stat_notify, "Answer", answerPending)
            .build()

        NotificationManagerCompat.from(context).notify("call-$channelId", CALL_NOTIFICATION_ID, notification)
    }

    /** Dismiss the incoming-call ring for [channelId] (answered / declined / ended). */
    fun cancelIncomingCall(context: Context, channelId: String) {
        NotificationManagerCompat.from(context).cancel("call-$channelId", CALL_NOTIFICATION_ID)
    }

    /**
     * Dismiss any delivered notifications for [channelId] once the user has read
     * the conversation. Notifications are tagged with the channel id, so we sweep
     * the active set and cancel every notification carrying that tag (plus our
     * own known (tag,id) as a fallback if the tag was stripped).
     */
    fun clearForChannel(context: Context, channelId: String) {
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        runCatching {
            mgr.activeNotifications.forEach { sbn ->
                if (sbn.tag == channelId) mgr.cancel(sbn.tag, sbn.id)
            }
        }
        NotificationManagerCompat.from(context).cancel(channelId, NOTIFICATION_ID)
    }

    private fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
}
