package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Headset
import androidx.compose.material.icons.filled.HeadsetOff
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.ScreenShare
import androidx.compose.material.icons.filled.StopScreenShare
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.data.model.PublicUser
import com.zekktris.data.model.VoiceState
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.StarfieldBackground
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/** Resolve a userId to a public user from any loaded source (self, DM recipients, members). */
private fun resolveUser(state: AppState, userId: String): PublicUser? {
    state.me?.let { if (it.id == userId) return PublicUser(id = it.id, username = it.username, displayName = it.displayName, avatarUrl = it.avatarUrl) }
    state.dms.forEach { dm -> dm.recipients?.firstOrNull { it.id == userId }?.let { return it } }
    state.membersByGuild.values.forEach { list -> list.firstOrNull { it.userId == userId }?.let { return it.user } }
    return null
}

private fun activeVoiceChannel(state: AppState): Channel? {
    val id = state.activeVoiceChannelId ?: return null
    return state.channelsByGuild.values.flatten().firstOrNull { it.id == id }
        ?: state.dms.firstOrNull { it.id == id }
}

/** Full-screen in-call view: participant tiles + mute / speaker / leave bar. */
@Composable
fun VoiceCallScreen(store: AppStore, state: AppState, onMinimize: () -> Unit) {
    val p = ZkTheme.palette
    BackHandler(onBack = onMinimize)
    val channel = activeVoiceChannel(state)
    val title = when {
        channel == null -> "Voice"
        channel.isDM -> channel.recipients?.firstOrNull()?.bestName ?: "Call"
        else -> channel.name ?: "voice"
    }
    val roster = state.voiceStates.values.filter { it.channelId == state.activeVoiceChannelId }
    // Outgoing 1:1 call: it's a DM and the peer hasn't joined voice yet → show a
    // dedicated "Calling…" screen instead of a lone self-tile grid (iOS parity).
    val peerJoined = roster.any { it.userId != state.me?.id }
    val outgoing = channel?.isDM == true && !peerJoined && !state.voiceTokenMissing &&
        state.voiceConn != com.zekktris.voice.VoiceManager.ConnState.Failed
    val conn = state.voiceConn
    val connecting = conn == com.zekktris.voice.VoiceManager.ConnState.Connecting
    val reconnecting = conn == com.zekktris.voice.VoiceManager.ConnState.Reconnecting
    val failed = conn == com.zekktris.voice.VoiceManager.ConnState.Failed
    var speakerOn by remember { mutableStateOf(true) }
    var muteTarget by remember { mutableStateOf<VoiceState?>(null) }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    // Camera needs the CAMERA permission — request it on first toggle-on.
    val camLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) store.toggleVoiceCamera()
        // Permanently-denied returns immediately with no dialog — tell the user
        // where to fix it instead of the button silently doing nothing.
        else android.widget.Toast.makeText(ctx, "Camera permission is off — enable it in Settings to use video.", android.widget.Toast.LENGTH_LONG).show()
    }
    fun onCameraClick() {
        if (state.cameraOn) { store.toggleVoiceCamera(); return }
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.CAMERA) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) store.toggleVoiceCamera() else camLauncher.launch(android.Manifest.permission.CAMERA)
    }
    // Screen share: the system MediaProjection consent dialog returns an Intent
    // we hand to LiveKit (which runs its own mediaProjection foreground service).
    val screenLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == android.app.Activity.RESULT_OK && data != null) store.startVoiceScreenShare(data)
    }
    fun onScreenShareClick() {
        if (state.screenOn) { store.stopVoiceScreenShare(); return }
        val mpm = ctx.getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
        runCatching { screenLauncher.launch(mpm.createScreenCaptureIntent()) }
    }

    StarfieldBackground {
      Column(Modifier.fillMaxSize().statusBarsPadding()) {
        // Header: minimize chevron + title.
        Box(Modifier.fillMaxWidth().height(56.dp)) {
            // Bare leading chevron — the app-wide back-button rule (ink2 / 20 /
            // 14 inset), matching iOS Voice.swift:1425-1431. No chip behind it.
            Box(
                Modifier.align(Alignment.CenterStart).padding(start = 14.dp).size(width = 52.dp, height = 40.dp)
                    .clickable(onClick = onMinimize),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.ChevronLeft, "Minimize", tint = ZkInk.ink2, modifier = Modifier.size(20.dp)) }
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    when {
                        failed -> "Connection failed"
                        reconnecting -> "Reconnecting…"
                        connecting -> "Connecting…"
                        state.voiceTokenMissing -> "Voice not available"
                        channel?.isDM == true && roster.size <= 1 -> "Calling…"
                        else -> "${roster.size} in voice"
                    },
                    color = if (failed) ZkStatus.dangerSoft else if (reconnecting) ZkStatus.idle else ZkInk.ink3,
                    fontFamily = ZkSans, fontSize = 12.sp,
                )
            }
        }

        if (outgoing) {
            // Dedicated outgoing "Calling…" view: big peer avatar. The control
            // bar below still renders (so we never lose mute/deafen/leave even if
            // the peer's join frame is dropped and this state sticks).
            val peer = channel?.recipients?.firstOrNull()
            Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.weight(1f))
                Avatar(url = peer?.avatarUrl, name = peer?.bestName ?: title, size = 96.dp)
                Text(peer?.bestName ?: title, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 24.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 16.dp))
                Text(if (connecting) "Connecting…" else "Calling…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp))
                Spacer(Modifier.weight(1f))
            }
        } else {
        // Live feeds — screens FIRST, then cameras, cap 8 (iOS Voice.swift:1056-1091).
        // Any live feed replaces the arena with a full stage; otherwise the
        // audio-only galaxy arena renders.
        val meId = state.me?.id ?: "me"
        val feeds = buildList {
            state.localScreen?.let { add(StageFeed(meId, it, isScreen = true)) }
            state.remoteScreen.forEach { (uid, t) -> add(StageFeed(uid, t, isScreen = true)) }
            state.localVideo?.let { add(StageFeed(meId, it, isScreen = false)) }
            state.remoteVideo.forEach { (uid, t) -> add(StageFeed(uid, t, isScreen = false)) }
        }.take(8)
        if (feeds.isEmpty()) {
            VoiceArena(
                state = state,
                roster = roster,
                onTapParticipant = { vs -> if (vs.userId != state.me?.id) muteTarget = vs },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        } else {
            VideoStage(store, state, feeds, Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp))
            // Feed-less participants collapse to a compact strip below the stage.
            val feedUsers = feeds.mapTo(HashSet()) { it.userId }
            val audioOnly = roster.filter { it.userId !in feedUsers }
            if (audioOnly.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().height(76.dp).horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    audioOnly.forEach { vs ->
                        val u = resolveUser(state, vs.userId)
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable(enabled = vs.userId != state.me?.id) { muteTarget = vs }.padding(4.dp),
                        ) {
                            SpeakingAvatar(
                                url = u?.avatarUrl, name = u?.bestName ?: "?", size = 40.dp,
                                toneId = vs.userId,
                                speaking = vs.userId in state.speakingUserIds,
                            )
                            Text(u?.bestName ?: "Unknown", color = Color.White.copy(alpha = 0.85f), fontFamily = ZkSans, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                }
            }
        }
        } // end else (not-outgoing)

        // Push-to-talk toggle pill.
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center) {
            val on = state.pttEnabled
            Row(
                Modifier.clip(RoundedCornerShape(18.dp)).background(if (on) p.accent.copy(alpha = 0.2f) else p.bg2)
                    .clickable { store.toggleVoicePtt() }.padding(horizontal = 14.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.RecordVoiceOver, null, tint = if (on) p.accent else ZkInk.ink3, modifier = Modifier.size(16.dp))
                Text("Push to talk${if (on) " · ON" else ""}", color = if (on) p.accent else ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
            }
        }

        // Control bar — iOS order (Voice.swift:1459-1517): mic, deafen, camera,
        // [flip], then the Android-only screenshare, speaker, leave.
        // The bar itself is chrome: a translucent bg2 panel with a lineSoft
        // hairline along the top (iOS Voice.swift:1612-1615).
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.lineSoft))
        Row(
            Modifier.fillMaxWidth().background(p.bg2.copy(alpha = 0.85f))
                .navigationBarsPadding().padding(top = 10.dp, bottom = 18.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.pttEnabled) {
                // Press-and-hold Talk button (opens the mic only while held).
                // iOS MicControlButton keeps the flat bg3 disc and reddens the
                // glyph while the mic is closed (Voice.swift:1758-1766).
                val held = !state.selfMuted
                Box(
                    Modifier.size(54.dp).clip(CircleShape).background(p.bg3)
                        .pointerInput(Unit) {
                            detectTapGestures(onPress = {
                                store.setVoicePttHeld(true)
                                tryAwaitRelease()
                                store.setVoicePttHeld(false)
                            })
                        },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Mic, "Hold to talk", tint = if (held) ZkInk.ink1 else ZkStatus.danger, modifier = Modifier.size(20.dp)) }
            } else {
                CallButton(
                    if (state.selfMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                    bg = p.bg3,
                    tint = if (state.selfMuted) ZkStatus.danger else ZkInk.ink1,
                ) { store.toggleVoiceMute() }
            }
            Spacer(Modifier.size(16.dp))
            CallButton(
                if (state.selfDeafened) Icons.Filled.HeadsetOff else Icons.Filled.Headset,
                bg = p.bg3,
                tint = if (state.selfDeafened) ZkStatus.danger else ZkInk.ink1,
                // iOS Voice.swift:1559 — deafen is 20pt (camera/speaker are 19, flip 18).
                iconSize = 20.dp,
            ) { store.toggleVoiceDeafen() }
            Spacer(Modifier.size(16.dp))
            CallButton(
                if (state.cameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                bg = p.bg3,
                tint = if (state.cameraOn) p.accent else ZkInk.ink1,
                iconSize = 19.dp,
            ) { onCameraClick() }
            if (state.cameraOn) {
                Spacer(Modifier.size(16.dp))
                CallButton(Icons.Filled.Cameraswitch, bg = p.bg3, tint = ZkInk.ink1, iconSize = 18.dp) { store.flipVoiceCamera() }
            }
            Spacer(Modifier.size(16.dp))
            CallButton(
                if (state.screenOn) Icons.Filled.StopScreenShare else Icons.Filled.ScreenShare,
                bg = p.bg3,
                tint = if (state.screenOn) p.accent else ZkInk.ink1,
            ) { onScreenShareClick() }
            Spacer(Modifier.size(16.dp))
            CallButton(
                if (speakerOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
                bg = p.bg3, tint = if (speakerOn) p.accent else ZkInk.ink1,
                iconSize = 19.dp,
            ) { speakerOn = !speakerOn; store.setVoiceSpeaker(speakerOn) }
            Spacer(Modifier.size(16.dp))
            // After an unexpected drop (Failed), offer a one-tap Rejoin to the same
            // channel — joinVoice tears down the dead room and reconnects cleanly.
            if (failed && state.activeVoiceChannelId != null) {
                CallButton(Icons.Filled.Call, bg = ZkStatus.online, tint = Color.White) {
                    state.activeVoiceChannelId?.let { store.joinVoice(it) }
                }
                Spacer(Modifier.size(16.dp))
            }
            CallButton(Icons.Filled.CallEnd, bg = ZkStatus.danger, tint = Color.White) { store.leaveCurrentVoice() }
        }
      }
    }

    // Mute-for-me confirm sheet.
    muteTarget?.let { vs ->
        val u = resolveUser(state, vs.userId)
        val already = vs.userId in state.mutedForMeIds
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { muteTarget = null },
            containerColor = p.bg2,
            title = { Text(u?.bestName ?: "User", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = {
                Column {
                    Text(if (already) "Unmute this person for you?" else "Mute this person just for you? Others can still hear them.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                    // View-profile from the call (iOS parity).
                    u?.let { user ->
                        Text(
                            "View profile", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                            // Minimize the call first so the profile sheet (rendered under
                            // the full-screen call) is actually visible.
                            modifier = Modifier.padding(top = 14.dp).clickable { muteTarget = null; onMinimize(); store.openProfile(user) },
                        )
                    }
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { store.toggleMutedForMe(vs.userId); muteTarget = null }) {
                    Text(if (already) "Unmute for me" else "Mute for me", color = p.accent, fontFamily = ZkSans)
                }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { muteTarget = null }) { Text("Cancel", color = ZkInk.ink3, fontFamily = ZkSans) } },
        )
    }
}

/** One live feed on the stage (screen share or camera). */
private data class StageFeed(
    val userId: String,
    val track: io.livekit.android.room.track.VideoTrack,
    val isScreen: Boolean,
)

/**
 * Full-screen stage grid for live feeds (iOS Voice.swift:1056-1091): 1 feed
 * fills the stage, 2 stack, 3-4 go 2x2 (up to 8). Screens are letterboxed with
 * an accent2 border + name capsule; cameras crop-fill with a speaking accent
 * stroke.
 */
@Composable
private fun VideoStage(store: AppStore, state: AppState, feeds: List<StageFeed>, modifier: Modifier) {
    val p = ZkTheme.palette
    val cols = if (feeds.size <= 2) 1 else 2
    val rows = feeds.chunked(cols)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        rows.forEach { row ->
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { feed ->
                    val name = if (feed.userId == state.me?.id) "You" else resolveUser(state, feed.userId)?.bestName ?: "Someone"
                    val speaking = feed.userId in state.speakingUserIds
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color.Black)
                            .then(
                                when {
                                    feed.isScreen -> Modifier.border(1.5.dp, p.accent2.copy(alpha = 0.6f), RoundedCornerShape(12.dp))
                                    speaking -> Modifier.border(2.dp, p.accent.copy(alpha = 0.8f), RoundedCornerShape(12.dp))
                                    else -> Modifier
                                },
                            ),
                    ) {
                        VideoTile(store, feed.track, Modifier.fillMaxSize())
                        // Name capsule on black-0.55.
                        Text(
                            if (feed.isScreen) "$name's screen" else name,
                            color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .align(Alignment.BottomStart)
                                .padding(6.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color.Black.copy(alpha = 0.55f))
                                .padding(horizontal = 7.dp, vertical = 3.dp),
                        )
                    }
                }
                if (row.size < cols) Box(Modifier.weight((cols - row.size).toFloat()))
            }
        }
    }
}

/**
 * The audio-only "galaxy" arena (iOS Voice.swift:1213-1331): three
 * counter-rotating rings, a radial accent glow, a spinning black-hole core,
 * and participants on golden-angle orbital seats rotating as one body
 * (90s/rev; tiles stay upright). Leaver swallow animation is not ported.
 */
@Composable
private fun VoiceArena(
    state: AppState,
    roster: List<VoiceState>,
    onTapParticipant: (VoiceState) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = ZkTheme.palette
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "arena")
    val orbit by transition.animateFloat(
        0f, 360f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(90_000, easing = androidx.compose.animation.core.LinearEasing)),
        label = "orbit",
    )
    val ringSpin by transition.animateFloat(
        0f, 360f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(60_000, easing = androidx.compose.animation.core.LinearEasing)),
        label = "rings",
    )
    val holeSpin by transition.animateFloat(
        0f, 360f,
        androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(6_000, easing = androidx.compose.animation.core.LinearEasing)),
        label = "hole",
    )
    androidx.compose.foundation.layout.BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        val arena = if (maxWidth < maxHeight) maxWidth else maxHeight
        // Rings + radial glow.
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            val c = center
            val minDim = kotlin.math.min(size.width, size.height)
            drawCircle(
                brush = androidx.compose.ui.graphics.Brush.radialGradient(
                    listOf(p.accent.copy(alpha = 0.14f), Color.Transparent),
                    center = c, radius = minDim * 0.5f,
                ),
                radius = minDim * 0.5f, center = c,
            )
            // iOS ringsView (Voice.swift:1387-1401): diameters side × 0.78 /
            // 0.55 / 0.32 — the DASHED ring is the middle one — all at 0.32
            // opacity and all on the same 60s spin.
            // NOTE: Compose's copy(alpha=) REPLACES alpha, it does not multiply.
            // lineSoft already carries α0.18 (Color.kt:41), and iOS applies
            // .opacity(0.32) on top of it — so the effective value is 0.18×0.32,
            // not 0.32. Passing 0.32f here renders the rings ~5.6× too bright.
            val ring = p.lineSoft.copy(alpha = 0.18f * 0.32f)
            rotate(ringSpin, pivot = c) {
                drawCircle(ring, radius = minDim * 0.39f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            }
            rotate(-ringSpin, pivot = c) {
                drawCircle(
                    ring, radius = minDim * 0.275f, center = c,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(
                        1.dp.toPx(),
                        pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(6f, 9f)),
                    ),
                )
            }
            rotate(ringSpin, pivot = c) {
                drawCircle(ring, radius = minDim * 0.16f, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            }
        }
        // Black hole: conic accretion disk + black event horizon, 6s spin.
        Box(
            Modifier
                .size(22.dp)
                .graphicsLayer { rotationZ = holeSpin }
                .clip(CircleShape)
                .background(
                    // iOS BlackHoleView (Voice.swift:2117-2124) uses six stops so
                    // accent2/accent hold a wedge each before rolling to accent3.
                    androidx.compose.ui.graphics.Brush.sweepGradient(
                        listOf(p.accent2, p.accent2, p.accent, p.accent, p.accent3, p.accent2),
                    ),
                ),
            contentAlignment = Alignment.Center,
        ) { Box(Modifier.size(14.dp).clip(CircleShape).background(Color.Black)) }
        // Golden-angle orbital seats rotating as one body; tiles stay upright.
        roster.forEachIndexed { i, vs ->
            val u = resolveUser(state, vs.userId)
            val rPct = kotlin.math.min(16f + 13f * kotlin.math.sqrt(i.toFloat()), 46f)
            val angle = Math.toRadians((i * 137.5 + orbit))
            val dx = (arena.value * rPct / 100f * kotlin.math.cos(angle)).dp
            val dy = (arena.value * rPct / 100f * kotlin.math.sin(angle)).dp
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .offset(x = dx, y = dy)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable { onTapParticipant(vs) }
                    .padding(4.dp),
            ) {
                Box {
                    SpeakingAvatar(
                        url = u?.avatarUrl, name = u?.bestName ?: "?", size = 54.dp,
                        toneId = vs.userId,
                        speaking = vs.userId in state.speakingUserIds,
                    )
                    if (vs.selfMute == true || vs.selfDeaf == true || vs.userId in state.mutedForMeIds) {
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(16.dp).clip(CircleShape).background(Color.Black),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (vs.userId in state.mutedForMeIds) Icons.AutoMirrored.Filled.VolumeOff else Icons.Filled.MicOff,
                                "Muted", tint = Color.White, modifier = Modifier.size(8.dp),
                            )
                        }
                    }
                }
                // Name capsule on black-0.55 (iOS seat label).
                Text(
                    u?.bestName ?: "Unknown",
                    color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 11.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
    }
}

/**
 * Speaking cue: the iOS "alien pulse" (Components.swift:766-792) — three
 * expanding rings in accent/accent2/accent3 repeating over 1.4s, plus a
 * resting accent-0.7 edge. Silent avatars render bare.
 */
@Composable
internal fun SpeakingAvatar(url: String?, name: String, size: androidx.compose.ui.unit.Dp, toneId: String?, speaking: Boolean) {
    val p = ZkTheme.palette
    Box(contentAlignment = Alignment.Center) {
        if (speaking) {
            val pulse = androidx.compose.animation.core.rememberInfiniteTransition(label = "alienPulse")
            val phase by pulse.animateFloat(
                0f, 1f,
                androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.tween(1400, easing = androidx.compose.animation.core.LinearEasing)),
                label = "phase",
            )
            androidx.compose.foundation.Canvas(Modifier.size(size * 1.7f)) {
                val c = center
                val base = size.toPx() / 2f
                listOf(p.accent, p.accent2, p.accent3).forEachIndexed { i, col ->
                    val t = ((phase + i / 3f) % 1f)
                    val r = base + t * base * 0.7f
                    drawCircle(col.copy(alpha = (1f - t) * 0.65f), radius = r, center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
                }
            }
        }
        Box(
            Modifier.clip(CircleShape)
                .then(if (speaking) Modifier.border(2.dp, p.accent.copy(alpha = 0.7f), CircleShape) else Modifier)
                .padding(2.dp),
        ) { Avatar(url = url, name = name, size = size, toneId = toneId) }
    }
}

/** Renders a LiveKit VideoTrack via a TextureViewRenderer. Keyed on the track so
 *  a changed/removed track releases the old renderer cleanly. */
@Composable
private fun VideoTile(store: AppStore, track: io.livekit.android.room.track.VideoTrack, modifier: Modifier) {
    androidx.compose.runtime.key(track) {
        androidx.compose.ui.viewinterop.AndroidView(
            modifier = modifier,
            factory = { ctx ->
                io.livekit.android.renderer.TextureViewRenderer(ctx).apply {
                    store.voiceInitRenderer(this)
                    runCatching { track.addRenderer(this) }
                }
            },
            onRelease = { view ->
                runCatching { track.removeRenderer(view) }
                runCatching { view.release() }
            },
        )
    }
}

@Composable
private fun ParticipantTile(
    store: AppStore,
    name: String,
    avatarUrl: String?,
    speaking: Boolean,
    muted: Boolean,
    mutedForMe: Boolean = false,
    videoTrack: io.livekit.android.room.track.VideoTrack? = null,
    onClick: (() -> Unit)? = null,
) {
    val p = ZkTheme.palette
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = if (onClick != null) Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(4.dp) else Modifier,
    ) {
        Box {
            if (videoTrack != null) {
                // Camera tile: 16:9-ish rounded video with a speaking ring.
                Box(
                    Modifier.size(width = 96.dp, height = 72.dp).clip(RoundedCornerShape(12.dp))
                        .then(if (speaking) Modifier.border(3.dp, ZkStatus.online, RoundedCornerShape(12.dp)) else Modifier)
                        .background(Color.Black),
                ) { VideoTile(store, videoTrack, Modifier.fillMaxSize()) }
            } else
            Box(
                Modifier.clip(CircleShape).then(
                    if (speaking) Modifier.border(3.dp, ZkStatus.online, CircleShape) else Modifier,
                ).padding(3.dp),
            ) { Avatar(url = avatarUrl, name = name, size = 54.dp) }
            if (muted || mutedForMe) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(20.dp).clip(CircleShape).background(p.bg0),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(16.dp).clip(CircleShape).background(ZkStatus.danger), contentAlignment = Alignment.Center) {
                        // Speaker-off when I've muted THEM for me; mic-off when they muted themselves.
                        Icon(
                            if (mutedForMe) Icons.AutoMirrored.Filled.VolumeOff else Icons.Filled.MicOff,
                            "Muted", tint = Color.White, modifier = Modifier.size(10.dp),
                        )
                    }
                }
            }
        }
        Text(name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
    }
}

/**
 * In-call control button. iOS (Voice.swift:1553-1610) keeps every control on a
 * flat 54pt `Theme.bg3` circle and expresses state with the GLYPH tint only —
 * flooding the whole button with colour was explicitly rejected there
 * (Voice.swift:1979-1982). Only Leave is a filled danger circle.
 */
@Composable
private fun CallButton(
    icon: ImageVector,
    bg: Color,
    tint: Color,
    iconSize: Dp = 20.dp,
    // The in-call row is 54pt, but the INCOMING-CALL screen's Accept/Decline are
    // 66pt with a 26pt glyph on iOS (Voice.swift:1656-1675). Same composable,
    // two sizes — don't collapse them.
    size: Dp = 54.dp,
    onClick: () -> Unit,
) {
    Box(
        Modifier.size(size).clip(CircleShape).background(bg).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = tint, modifier = Modifier.size(iconSize)) }
}

/** Minimized in-call bar (stays in the call while using the rest of the app). */
@Composable
fun VoiceMiniBar(store: AppStore, state: AppState, onExpand: () -> Unit, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    val channel = activeVoiceChannel(state)
    val title = when {
        channel == null -> "Voice"
        channel.isDM -> channel.recipients?.firstOrNull()?.bestName ?: "Call"
        else -> channel.name ?: "voice"
    }
    // Full-width bg2 strip with hairlines + the two-line green "Voice
    // Connected" / title stack (iOS MinimizedCallBar, Voice.swift:1983-2014).
    Column(modifier.fillMaxWidth().navigationBarsPadding()) {
      Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
      Row(
        Modifier.fillMaxWidth().background(p.bg2)
            .clickable(onClick = onExpand).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(Icons.AutoMirrored.Filled.VolumeUp, null, tint = ZkStatus.online, modifier = Modifier.size(13.dp))
        Column(Modifier.padding(start = 10.dp).weight(1f)) {
            Text("Voice Connected", color = ZkStatus.online, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
            Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // Under PTT the mic is hold-to-talk, so a plain mute toggle here is
        // meaningless — hide it (expand the call to use the Talk button).
        if (!state.pttEnabled) {
            Icon(
                if (state.selfMuted) Icons.Filled.MicOff else Icons.Filled.Mic, "Mute",
                tint = if (state.selfMuted) ZkStatus.dangerSoft else ZkInk.ink2,
                modifier = Modifier.clip(CircleShape).clickable { store.toggleVoiceMute() }.padding(6.dp).size(15.dp),
            )
        }
        // Danger rounded-rect hangup (iOS MinimizedCallBar).
        Box(
            Modifier.clip(RoundedCornerShape(8.dp)).background(ZkStatus.danger)
                .clickable { store.leaveCurrentVoice() }.padding(horizontal = 10.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.CallEnd, "Leave", tint = Color.White, modifier = Modifier.size(14.dp)) }
      }
      Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
    }
}

/** Ringing incoming 1:1 call: caller + Accept / Decline. */
@Composable
fun IncomingCallScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val call = state.incomingCall ?: return
    val user = resolveUser(state, call.callerId)
    val ctx = androidx.compose.ui.platform.LocalContext.current
    // Ring + vibrate while the incoming screen is up (respecting the ringer
    // mode), stopping the instant it's dismissed. Mirrors the iOS Ringtone loop.
    androidx.compose.runtime.DisposableEffect(call.channelId) {
        val am = ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
        val mode = am?.ringerMode ?: android.media.AudioManager.RINGER_MODE_NORMAL
        val ringtone = if (mode == android.media.AudioManager.RINGER_MODE_NORMAL) {
            runCatching {
                android.media.RingtoneManager.getRingtone(
                    ctx,
                    android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
                )?.apply {
                    if (android.os.Build.VERSION.SDK_INT >= 28) isLooping = true
                    play()
                }
            }.getOrNull()
        } else null
        val vibrator = androidx.core.content.ContextCompat.getSystemService(ctx, android.os.Vibrator::class.java)
        if (mode != android.media.AudioManager.RINGER_MODE_SILENT) {
            runCatching {
                vibrator?.vibrate(android.os.VibrationEffect.createWaveform(longArrayOf(0, 700, 1000), 0))
            }
        }
        onDispose {
            runCatching { ringtone?.stop() }
            runCatching { vibrator?.cancel() }
        }
    }
    StarfieldBackground {
      Column(
        Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.weight(1f))
        Avatar(url = user?.avatarUrl, name = call.callerName, size = 96.dp)
        Text(call.callerName, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 24.sp, modifier = Modifier.padding(top = 16.dp))
        Text("Incoming call…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(top = 4.dp))
        Spacer(Modifier.weight(1f))
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 40.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CallButton(Icons.Filled.CallEnd, bg = ZkStatus.danger, tint = Color.White, iconSize = 26.dp, size = 66.dp) { store.declineCall() }
                Text("Decline", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CallButton(Icons.Filled.Call, bg = ZkStatus.online, tint = Color.White, iconSize = 26.dp, size = 66.dp) { store.acceptCall() }
                Text("Accept", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
            }
        }
      }
    }
}
