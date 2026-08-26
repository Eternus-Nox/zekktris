package com.zekktris.voice

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zekktris.MainActivity
import com.zekktris.R
import com.zekktris.push.NotificationHelper

/**
 * Foreground service (type = microphone) that keeps mic capture alive while a
 * call is connected and the app is backgrounded — the Android analog of iOS's
 * `UIBackgroundModes: audio`. It does NOT own the LiveKit Room (that lives in
 * [VoiceManager] on the app scope); it only holds the ongoing notification.
 */
class CallService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        NotificationHelper.ensureCallChannel(this)
        val pending = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, NotificationHelper.CALL_CHANNEL_ID)
            .setContentTitle("Zekktris")
            .setContentText("Voice call in progress")
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
    }

    companion object {
        private const val NOTIF_ID = 4201
        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, CallService::class.java))
        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, CallService::class.java))
    }
}
