package com.zekktris

import android.Manifest
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.content.Context
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.zekktris.ui.components.AppLockAuth
import com.zekktris.ui.screens.LockScreen
import com.zekktris.ui.theme.AppLockController
import com.zekktris.ui.theme.LocalAppLock
import com.zekktris.ui.RootScreen
import com.zekktris.ui.theme.LocalThemeController
import com.zekktris.ui.theme.ThemeController
import com.zekktris.ui.theme.ZkTheme

/**
 * Single-Activity host (Compose owns navigation), mirroring the iOS app's
 * single-scene structure. The [AppStore] lives on the [ZekApp] Application so it
 * survives configuration changes and backgrounding.
 */
class MainActivity : FragmentActivity() {

    // Result is ignored: if the user declines, pushes simply won't show — the
    // app is fully usable either way. We only ask once per the OS policy.
    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // Set when a lock-screen call answer needs the keyguard dismissed; consumed
    // in onResume (see handleNotificationIntent).
    private var pendingKeyguardDismiss = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = (application as ZekApp).store
        maybeRequestNotificationPermission()
        if (!handleShareIntent(intent, store)) handleNotificationIntent(intent, store)
        setContent {
            val prefs = remember { getSharedPreferences("zk_prefs", Context.MODE_PRIVATE) }
            var themeId by remember { mutableStateOf(prefs.getString("zk.theme", "default") ?: "default") }
            val controller = ThemeController(themeId) { next ->
                prefs.edit().putString("zk.theme", next).apply()
                themeId = next
            }
            var hideTags by remember { mutableStateOf(prefs.getBoolean("zk.hideClanTags", false)) }
            val hideTagsController = com.zekktris.ui.theme.HideTagsController(hideTags) { on ->
                prefs.edit().putBoolean("zk.hideClanTags", on).apply()
                hideTags = on
            }

            // ── Biometric app lock ──────────────────────────────────────────
            val activity = this@MainActivity
            var appLockEnabled by remember { mutableStateOf(prefs.getBoolean("zk.appLock", false)) }
            // Cold-launch: locked if the pref was on (unlock() fails open if the
            // device has no biometric/credential, so this never traps the user).
            var locked by remember { mutableStateOf(appLockEnabled) }
            var sawBackground by remember { mutableStateOf(false) }
            // The device-credential (PIN) UI can briefly background us; while a
            // prompt is up, don't treat the ON_STOP as "the user left" — else a
            // successful PIN unlock would immediately re-lock on the ON_START.
            var authInProgress by remember { mutableStateOf(false) }
            val lockSupported = remember { AppLockAuth.canAuthenticate(activity) }
            val lifecycleOwner = LocalLifecycleOwner.current
            DisposableEffect(lifecycleOwner, appLockEnabled) {
                val obs = LifecycleEventObserver { _, event ->
                    when (event) {
                        Lifecycle.Event.ON_STOP -> if (appLockEnabled && !authInProgress) sawBackground = true
                        Lifecycle.Event.ON_START -> { if (appLockEnabled && sawBackground) locked = true; sawBackground = false }
                        else -> {}
                    }
                }
                lifecycleOwner.lifecycle.addObserver(obs)
                onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
            }
            val appLock = AppLockController(
                enabled = appLockEnabled,
                supported = lockSupported,
                setEnabled = { on ->
                    if (on) {
                        // Verify a biometric/credential works BEFORE arming the lock.
                        authInProgress = true
                        AppLockAuth.authenticate(activity, "Enable app lock", "Confirm to turn on the app lock") { ok ->
                            authInProgress = false
                            if (ok) { prefs.edit().putBoolean("zk.appLock", true).apply(); appLockEnabled = true }
                        }
                    } else {
                        prefs.edit().putBoolean("zk.appLock", false).apply(); appLockEnabled = false; locked = false
                    }
                },
                unlock = {
                    when {
                        authInProgress -> {}  // a prompt is already up — ignore re-taps
                        !AppLockAuth.canAuthenticate(activity) -> locked = false  // escape hatch: never trap the user
                        else -> {
                            authInProgress = true
                            AppLockAuth.authenticate(activity, "Unlock Zekktris", null) { ok ->
                                authInProgress = false
                                if (ok) locked = false
                            }
                        }
                    }
                },
            )

            CompositionLocalProvider(
                LocalThemeController provides controller,
                com.zekktris.ui.theme.LocalHideTags provides hideTagsController,
                LocalAppLock provides appLock,
            ) {
                ZkTheme(themeId = themeId) {
                    Box(Modifier.fillMaxSize()) {
                        RootScreen(store)
                        if (locked) LockScreen(onUnlock = { appLock.unlock() })
                    }
                }
            }
        }
    }

    // The app is single-top; a notification tap — or a share from another app —
    // while already running arrives here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val store = (application as ZekApp).store
        if (!handleShareIntent(intent, store)) handleNotificationIntent(intent, store)
    }

    // Foreground/background transitions: force a gateway reconnect + REST
    // re-sync on every return (the background socket is often silently dead),
    // and gate the open-channel poll off while backgrounded.
    override fun onStart() {
        super.onStart()
        (application as ZekApp).store.onAppForeground()
        // Retry a device-token registration that failed earlier (offline at
        // sign-in, Play Services not ready) — otherwise one unlucky attempt
        // leaves this device with zero push for the life of the install.
        (application as ZekApp).push.onAppForeground()
    }

    override fun onStop() {
        super.onStop()
        (application as ZekApp).store.onAppBackground()
    }

    // Every touch / key the activity dispatches: the person is using this
    // device (multi-device presence — AppStore.noteInteraction).
    override fun onUserInteraction() {
        super.onUserInteraction()
        (application as ZekApp).store.noteInteraction()
    }

    override fun onResume() {
        super.onResume()
        if (!pendingKeyguardDismiss) return
        pendingKeyguardDismiss = false
        val km = getSystemService(KeyguardManager::class.java)
        if (km == null) { clearLockScreenVisibility(); return }
        km.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                // EVERY outcome has to drop lock-screen visibility again. Clearing
                // it on success alone left the activity keyguard-visible for its
                // whole lifetime whenever the user backed out of the bouncer, got
                // the PIN wrong, or the request was refused — so re-locking the
                // phone mid-call put every DM on the lock screen.
                override fun onDismissSucceeded() = clearLockScreenVisibility()
                override fun onDismissCancelled() = clearLockScreenVisibility()
                override fun onDismissError() = clearLockScreenVisibility()
            },
        )
    }

    /** Revoke the lock-screen exemption granted for a call hand-off. */
    private fun clearLockScreenVisibility() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false)
            setTurnScreenOn(false)
        }
    }

    /**
     * Something was shared INTO Zekktris from another app's share sheet.
     *
     * When the user picked one of our Sharing Shortcuts (a recent DM) the system
     * tags the intent with [Intent.EXTRA_SHORTCUT_ID] — our DM channel id — and
     * the payload goes straight to that conversation. Picking plain "Zekktris"
     * instead leaves it null, and [AppStore.handleShare] parks the payload for
     * whichever conversation the user opens next rather than discarding it.
     *
     * Returns true when this intent WAS a share, so the caller skips the
     * notification-deep-link path.
     */
    private fun handleShareIntent(intent: Intent?, store: AppStore): Boolean {
        if (intent == null) return false
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return false

        val shortcutId = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID)
        // EXTRA_TEXT is a CharSequence, not necessarily a String — getStringExtra
        // returns null for a styled (Spanned) share, which is most browsers.
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val uris: List<android.net.Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            androidx.core.content.IntentCompat
                .getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, android.net.Uri::class.java)
                ?.filterNotNull()
                ?: emptyList()
        } else {
            listOfNotNull(
                androidx.core.content.IntentCompat
                    .getParcelableExtra(intent, Intent.EXTRA_STREAM, android.net.Uri::class.java),
            )
        }

        // Consume the payload. The launch intent outlives every Activity
        // recreation (rotation, dark-mode flip, split-screen), so leaving these
        // extras in place re-delivers the same share on the next config change —
        // the identical trap the answer-call extra documents below.
        intent.removeExtra(Intent.EXTRA_SHORTCUT_ID)
        intent.removeExtra(Intent.EXTRA_TEXT)
        intent.removeExtra(Intent.EXTRA_STREAM)
        setIntent(intent)

        if (text.isNullOrBlank() && uris.isEmpty()) return true
        store.handleShare(shortcutId, text, uris.map { it.toString() })
        return true
    }

    private fun handleNotificationIntent(intent: Intent?, store: AppStore) {
        if (intent == null) return
        // Answering a call from the ring notification's "Answer" action: join the
        // call (the pending-voice flow requests the mic) and clear the ring.
        intent.getStringExtra(com.zekktris.push.NotificationHelper.EXTRA_ANSWER_CALL_CHANNEL_ID)?.let { cid ->
            val token = intent.getStringExtra(com.zekktris.push.CallActionToken.EXTRA)
            // Consume it. The launch intent outlives every Activity recreation
            // (rotation, dark-mode flip, split-screen), so leaving the extra in
            // place re-joins a call the user already hung up on the next config
            // change.
            intent.removeExtra(com.zekktris.push.NotificationHelper.EXTRA_ANSWER_CALL_CHANNEL_ID)
            intent.removeExtra(com.zekktris.push.CallActionToken.EXTRA)
            setIntent(intent)
            // This activity is exported, so any installed app can send this
            // extra. Only our own ring's Answer action carries the install's
            // token, and only a ring that is still up can be answered — anything
            // else would join a call (mic open) nobody asked to join.
            if (!com.zekktris.push.CallActionToken.matches(this, token) ||
                !com.zekktris.push.NotificationHelper.isRinging(this, cid)
            ) return
            // Answering hands off from the showWhenLocked ring activity to HERE,
            // which is not lock-screen visible: without showing over the keyguard
            // and then asking to dismiss it, the user is left on the lock screen
            // while the call joins invisibly behind it. Scoped to this branch —
            // a permanently showWhenLocked MainActivity would put every DM on the
            // lock screen for anyone who taps a message notification.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            }
            // requestDismissKeyguard needs an already-visible activity, and this
            // runs from onCreate on the cold-start answer path — issuing it here
            // is exactly the case that errors out. Defer to onResume.
            pendingKeyguardDismiss = true
            com.zekktris.push.NotificationHelper.cancelIncomingCall(this, cid)
            store.answerCallChannel(cid)
            return
        }
        val channelId = intent.getStringExtra("channelId") ?: return
        val messageId = intent.getStringExtra("messageId")
        intent.removeExtra("channelId")
        intent.removeExtra("messageId")
        setIntent(intent)
        store.openFromNotification(channelId, messageId)
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
