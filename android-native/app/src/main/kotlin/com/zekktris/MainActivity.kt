package com.zekktris

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.zekktris.ui.RootScreen
import com.zekktris.ui.theme.ZkTheme

/**
 * Single-Activity host (Compose owns navigation), mirroring the iOS app's
 * single-scene structure. The [AppStore] lives on the [ZekApp] Application so it
 * survives configuration changes and backgrounding.
 */
class MainActivity : ComponentActivity() {

    // Result is ignored: if the user declines, pushes simply won't show — the
    // app is fully usable either way. We only ask once per the OS policy.
    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = (application as ZekApp).store
        maybeRequestNotificationPermission()
        handleNotificationIntent(intent, store)
        setContent {
            ZkTheme {
                RootScreen(store)
            }
        }
    }

    // The app is single-top; a notification tap while already running arrives here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationIntent(intent, (application as ZekApp).store)
    }

    private fun handleNotificationIntent(intent: Intent?, store: AppStore) {
        val channelId = intent?.getStringExtra("channelId") ?: return
        store.openFromNotification(channelId)
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
