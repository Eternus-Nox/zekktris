package com.zekktris.voice

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.zekktris.MainActivity
import com.zekktris.R
import com.zekktris.push.NotificationHelper
import com.zekktris.ui.theme.ZkThemePrefs

/**
 * Foreground service (type = microphone) that keeps mic capture alive while a
 * call is connected and the app is backgrounded — the Android analog of iOS's
 * `UIBackgroundModes: audio`. It does NOT own the LiveKit Room (that lives in
 * [VoiceManager] on the app scope); it only holds the ongoing notification.
 */
class CallService : Service() {

    /** When this call's notification first went up. A re-post keeps it, so a
     *  theme switch doesn't reset the notification's time to "now". */
    private var startedAt = 0L

    // The notification is built in onStartCommand, so without this a theme
    // switch mid-call would leave it in the accent the call started under.
    // Held in a field: SharedPreferences keeps its listeners in a
    // WeakHashMap, so a listener nothing else references is collected and
    // never fires.
    private val themeListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == ZkThemePrefs.KEY) repostForTheme()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ZkThemePrefs.prefs(this).registerOnSharedPreferenceChangeListener(themeListener)
    }

    override fun onDestroy() {
        ZkThemePrefs.prefs(this).unregisterOnSharedPreferenceChangeListener(themeListener)
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startedAt = System.currentTimeMillis()
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        return START_STICKY
    }

    /** Re-post the ongoing notification in the new theme's accent. It has the
     *  same id as startForeground's, so it replaces the notification in place;
     *  the channel is silent and the notification alerts only once. */
    private fun repostForTheme() {
        if (startedAt == 0L) return  // not in the foreground yet
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        runCatching { mgr.notify(NOTIF_ID, buildNotification()) }
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
            // The viewer's theme accent, read on every build so a re-post picks
            // up a switch. Accent only, not setColorized: a full accent card is
            // louder than anything iOS shows for a call in progress.
            .setColor(ZkThemePrefs.accentArgb(this))
            .setWhen(startedAt)
            .setOnlyAlertOnce(true)
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
