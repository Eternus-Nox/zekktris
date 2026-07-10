package com.zekktris.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.zekktris.MainActivity
import com.zekktris.R

/**
 * Owns the notification channel and posts FOREGROUND notifications.
 *
 * When the app is backgrounded, FCM messages carry a `notification` block that
 * the system draws itself (using the default icon + channel wired in the
 * manifest meta-data) — this class is not involved there. It's used only from
 * [ZekMessagingService.onMessageReceived], which fires while the app is in the
 * foreground, so the user still sees a heads-up for a new message.
 */
object NotificationHelper {

    private const val NOTIFICATION_ID = 1

    fun notificationChannelId(context: Context): String =
        context.getString(R.string.default_notification_channel_id)

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

    fun show(context: Context, title: String, body: String, data: Map<String, String>) {
        if (!canPost(context)) return
        ensureChannel(context)

        // Route back to the tapped conversation, if the push carried one. Keyed
        // on the same `channelId` the server ships and the iOS app reads.
        val routeChannelId = data["channelId"]
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            routeChannelId?.let { putExtra("channelId", it) }
        }
        val pending = PendingIntent.getActivity(
            context,
            (routeChannelId ?: "").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, notificationChannelId(context))
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()

        // Tag by conversation so rapid repeats from one channel collapse into a
        // single, updating notification (mirrors the server's FCM `tag`).
        NotificationManagerCompat.from(context)
            .notify(routeChannelId ?: "zekktris", NOTIFICATION_ID, notification)
    }

    private fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
}
