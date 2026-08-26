package com.zekktris.push

import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.MainActivity
import com.zekktris.ZekApp
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/**
 * Full-screen incoming-call ring, raised over the lock screen by the ring
 * notification's full-screen intent. Answer joins the call; Decline REST-
 * declines. Mirrors the iOS CallKit ring the native Android app previously
 * lacked (calls only showed as a plain notification).
 */
class IncomingCallActivity : ComponentActivity() {

    private val timeoutHandler = Handler(Looper.getMainLooper())
    private var ringTimeout: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Show over the keyguard and wake the screen so the ring is seen even on
        // a locked phone.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            )
        }

        val channelId = intent?.getStringExtra(NotificationHelper.EXTRA_CHANNEL_ID)
        val callerName = intent?.getStringExtra("callerName") ?: "Incoming call"
        val store = (application as? ZekApp)?.store

        if (channelId == null) { finish(); return }

        // The ring NOTIFICATION self-cancels after 45s (setTimeoutAfter), but on a
        // locked/dozing device its full-screen intent has already launched THIS
        // activity — and nothing times that out. Without a matching deadline the
        // notification vanishes while the ring stays on screen indefinitely,
        // offering to Answer a call that ended long ago. iOS bounds both halves
        // for the same reason (CallManager's 45s ring timeout).
        scheduleRingTimeout(channelId)

        setContent {
            val prefs = getSharedPreferences("zk_prefs", MODE_PRIVATE)
            val themeId = prefs.getString("zk.theme", "default") ?: "default"
            ZkTheme(themeId) {
                RingScreen(
                    callerName = callerName,
                    onAnswer = {
                        // Cancel BEFORE the hand-off: requestDismissKeyguard can
                        // sit on the bouncer for a while, and a timeout firing
                        // mid-answer would finish us out from under it.
                        cancelRingTimeout()
                        store?.answerCallChannel(channelId)
                        NotificationHelper.cancelIncomingCall(this, channelId)
                        handOffToApp()
                    },
                    onDecline = {
                        cancelRingTimeout()
                        store?.declineCallChannel(channelId)
                        NotificationHelper.cancelIncomingCall(this, channelId)
                        finish()
                    },
                )
            }
        }
    }

    override fun onDestroy() {
        cancelRingTimeout()
        super.onDestroy()
    }

    private fun scheduleRingTimeout(channelId: String) {
        val task = Runnable {
            ringTimeout = null
            NotificationHelper.cancelIncomingCall(this, channelId)
            finish()
        }
        ringTimeout = task
        timeoutHandler.postDelayed(task, RING_TIMEOUT_MS)
    }

    private fun cancelRingTimeout() {
        ringTimeout?.let { timeoutHandler.removeCallbacks(it) }
        ringTimeout = null
    }

    /**
     * Hand the answered call over to the app. THIS activity is showWhenLocked but
     * MainActivity is not, so on a locked phone a straight hand-off drops the user
     * back on the keyguard with the call already joined invisibly behind it — ask
     * for the unlock while we're still the visible activity, then switch.
     */
    private fun handOffToApp() {
        val km = getSystemService(KeyguardManager::class.java)
        if (km == null || !km.isKeyguardLocked) { openApp(); return }
        km.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = openApp()
                // Unlock refused/failed: hand off anyway rather than stranding the
                // user on this ring screen with the call already connected.
                override fun onDismissCancelled() = openApp()
                override fun onDismissError() = openApp()
            },
        )
    }

    private fun openApp() {
        startActivity(
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
        )
        finish()
    }

    private companion object {
        /** Matches NotificationHelper's setTimeoutAfter and the iOS ring timeout. */
        const val RING_TIMEOUT_MS = 45_000L
    }
}

@Composable
private fun RingScreen(callerName: String, onAnswer: () -> Unit, onDecline: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(bottom = 72.dp)) {
        Column(
            Modifier.fillMaxWidth().align(Alignment.TopCenter).padding(top = 120.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                callerName,
                color = ZkInk.ink1,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text("Incoming call…", color = ZkInk.ink2, fontSize = 16.sp)
        }
        Row(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            RingButton(Icons.Filled.CallEnd, ZkStatus.danger, "Decline", onDecline)
            RingButton(Icons.Filled.Call, ZkStatus.online, "Answer", onAnswer)
        }
    }
}

@Composable
private fun RingButton(icon: androidx.compose.ui.graphics.vector.ImageVector, bg: Color, label: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(68.dp)
                .clip(CircleShape)
                .background(bg)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(30.dp))
        }
        Spacer(Modifier.height(8.dp))
        Text(label, color = ZkInk.ink2, fontSize = 13.sp)
    }
}
