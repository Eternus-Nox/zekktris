package com.zekktris.ui.components

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.data.CleartextPolicy
import com.zekktris.data.Config
import com.zekktris.data.model.Attachment
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.delay

/** A voice-message attachment: play/pause + waveform + elapsed/duration.
 *  Mirrors iOS VoiceMessageView (E2EE .zke clips are deferred — those need
 *  the crypto layer, so they fall back to a file chip via the caller). */
@Composable
fun VoiceMessageView(att: Attachment) {
    val p = ZkTheme.palette
    // MediaPlayer fetches outside the OkHttp guard: plain http:// only to a
    // local-network host (CleartextPolicy).
    val url = Config.absoluteUrl(att.url)?.takeIf { CleartextPolicy.allows(it) } ?: return
    val levels = remember(att.waveform) { decodeWaveform(att.waveform) }
    var playing by remember { mutableStateOf(false) }
    var prepared by remember { mutableStateOf(false) }
    var positionMs by remember { mutableIntStateOf(0) }
    var durationMs by remember { mutableIntStateOf((att.durationSeconds ?: 0) * 1000) }
    val player = remember { MediaPlayer() }

    DisposableEffect(url) {
        runCatching {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(url)
            player.setOnPreparedListener { prepared = true; if (it.duration > 0) durationMs = it.duration }
            player.setOnCompletionListener { playing = false; positionMs = 0; runCatching { player.seekTo(0) } }
            player.prepareAsync()
        }
        onDispose { runCatching { player.release() } }
    }
    LaunchedEffect(playing) {
        while (playing && prepared) {
            positionMs = runCatching { player.currentPosition }.getOrDefault(0)
            delay(80)
        }
    }

    val progress = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    Row(
        Modifier
            .padding(top = 4.dp).widthIn(max = 260.dp)
            .clip(RoundedCornerShape(12.dp)).background(p.bg2)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(30.dp).clip(CircleShape)
                .clickable(enabled = prepared) {
                    if (playing) { runCatching { player.pause() }; playing = false }
                    else { runCatching { player.start() }; playing = true }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                if (playing) "Pause" else "Play",
                tint = if (prepared) p.accent else ZkInk.ink4,
                modifier = Modifier.size(30.dp),
            )
        }
        WaveformBars(levels, progress, p.accent, Modifier.weight(1f).height(28.dp))
        Text(formatMs(if (playing || positionMs > 0) positionMs else durationMs), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
    }
}

@Composable
private fun WaveformBars(levels: List<Float>, progress: Float, accent: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        val n = levels.size
        levels.forEachIndexed { i, lvl ->
            val played = n > 1 && i.toFloat() / (n - 1) <= progress
            Box(
                Modifier.weight(1f)
                    .height((3f + lvl * 25f).dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(if (played) accent else ZkInk.ink4),
            )
        }
    }
}

private fun decodeWaveform(b64: String?): List<Float> {
    if (b64.isNullOrBlank()) return List(32) { 0.3f }
    return runCatching {
        Base64.decode(b64, Base64.DEFAULT).map { (it.toInt() and 0xFF) / 255f }
    }.getOrNull()?.takeIf { it.isNotEmpty() } ?: List(32) { 0.3f }
}

private fun formatMs(ms: Int): String {
    val total = ms / 1000
    return "%d:%02d".format(total / 60, total % 60)
}
