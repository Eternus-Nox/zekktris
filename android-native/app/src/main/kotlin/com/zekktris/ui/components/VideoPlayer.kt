package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.zekktris.data.CleartextPolicy

/**
 * Full-screen in-app video player for a message attachment, mirroring iOS's
 * AVPlayer fullScreenCover. Auto-plays; the ExoPlayer is released on dismiss.
 */
@androidx.annotation.OptIn(UnstableApi::class)
@Composable
fun VideoPlayerDialog(url: String, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    val player = remember(url) {
        ExoPlayer.Builder(ctx).build().apply {
            // Media3 fetches on its own HTTP stack, outside the OkHttp guard:
            // plain http:// only to a local-network host (CleartextPolicy).
            // (Its default data source already refuses https→http redirects.)
            if (CleartextPolicy.allows(url)) {
                setMediaItem(MediaItem.fromUri(url))
                prepare()
                playWhenReady = true
            }
        }
    }
    // Pause when the app is backgrounded / screen locks — otherwise audio keeps
    // playing behind the lock screen (the dialog stays in composition, so
    // onDispose alone wouldn't stop it). Release on leave.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(url, lifecycleOwner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_STOP || e == Lifecycle.Event.ON_PAUSE) player.pause()
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(obs)
            player.release()
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                factory = { PlayerView(it).apply { this.player = player; useController = true } },
                modifier = Modifier.fillMaxSize(),
            )
            Icon(
                Icons.Filled.Close, "Close", tint = Color.White,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(8.dp)
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.4f))
                    .clickable(onClick = onDismiss)
                    .padding(8.dp),
            )
        }
    }
}
