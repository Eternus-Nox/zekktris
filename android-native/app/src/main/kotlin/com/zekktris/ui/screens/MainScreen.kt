package com.zekktris.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.RailPage
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/** Authenticated root: settings overlay, a full-screen rail page, chat view, or the home shell. */
@Composable
fun MainScreen(store: AppStore, state: AppState) {
    Box(Modifier.fillMaxSize()) {
        when {
            state.showSettings -> {
                BackHandler { store.closeSettings() }
                SettingsScreen(store, state)
            }
            state.railPage != null -> {
                BackHandler { store.closeRailPage() }
                when (state.railPage) {
                    RailPage.Discover -> DiscoverScreen(store, state)
                    RailPage.CreateServer -> CreateServerScreen(store, state)
                    RailPage.JoinInvite -> JoinServerScreen(store, state)
                    RailPage.Admin -> AdminScreen(store, state)
                    RailPage.Family -> ParentalControlsScreen(store, state)
                }
            }
            state.guildSettingsFor != null -> {
                BackHandler { store.closeGuildSettings() }
                GuildSettingsScreen(store, state, state.guildSettingsFor!!) { store.closeGuildSettings() }
            }
            state.channelPermsFor != null -> {
                BackHandler { store.closeChannelPerms() }
                val ch = state.channelsByGuild.values.asSequence().flatten().firstOrNull { it.id == state.channelPermsFor }
                val gid = ch?.guildId
                if (ch != null && gid != null) {
                    ChannelPermissionsScreen(store, state, ch, gid) { store.closeChannelPerms() }
                } else {
                    store.closeChannelPerms()
                }
            }
            state.selectedChannelId != null -> {
                BackHandler { store.closeChannel() }
                ChatScreen(store, state)
            }
            else -> HomeShell(store, state)
        }

        // Voice call: a full-screen view (expanded) or a floating "in voice"
        // bar (minimized) while still connected.
        var voiceExpanded by remember(state.activeVoiceChannelId) { mutableStateOf(true) }
        if (state.activeVoiceChannelId != null) {
            if (voiceExpanded) {
                VoiceCallScreen(store, state, onMinimize = { voiceExpanded = false })
            } else {
                VoiceMiniBar(store, state, onExpand = { voiceExpanded = true }, modifier = Modifier.align(Alignment.BottomCenter))
            }
        }

        // Stage channel: same expanded/minimized pattern (mutually exclusive with
        // plain voice — AppStore enforces one LiveKit room at a time).
        var stageExpanded by remember(state.activeStageChannelId) { mutableStateOf(true) }
        if (state.activeStageChannelId != null) {
            if (stageExpanded) {
                StageCallScreen(store, state, onMinimize = { stageExpanded = false })
            } else {
                StageMiniBar(store, state, onExpand = { stageExpanded = true }, modifier = Modifier.align(Alignment.BottomCenter))
            }
        }

        // Ringing incoming call sits on top of everything.
        if (state.incomingCall != null) IncomingCallScreen(store, state)

        // User profile card (opened from avatars, member rows, etc.).
        state.profileUser?.let { ProfileSheet(store, state, it, onDismiss = { store.closeProfile() }) }

        // Mic permission gate for a pending voice join.
        val ctx = LocalContext.current
        val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) store.confirmPendingVoice() else store.cancelPendingVoice()
        }
        LaunchedEffect(state.pendingVoiceChannelId) {
            if (state.pendingVoiceChannelId == null) return@LaunchedEffect
            val granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (granted) store.confirmPendingVoice() else micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }

        // Transient incoming-poke banner, floating above everything.
        state.pokeBanner?.let { banner ->
            PokeBannerView(
                banner = banner,
                onOpen = { store.openPokeSender() },
                onPokeBack = { store.pokeBack() },
                modifier = Modifier.align(Alignment.TopCenter),
            )
        }
        // Transient achievement-unlock celebration banner.
        state.achievementBanner?.let { banner ->
            AchievementBannerView(banner = banner, onDismiss = { store.dismissAchievementBanner() }, modifier = Modifier.align(Alignment.TopCenter))
        }
    }
}

/**
 * The card both in-app banners (poke, achievement) sit on: the bg2 card with a
 * 1dp accent→accent2 stroke at 60%, left to right, and an accent glow where a
 * plain card would cast a black shadow (iOS PokeBannerView /
 * AchievementBannerView; the web banners match). It reads [ZkTheme.palette]
 * while composing, so a theme switch repaints a banner already on screen.
 * Coloured shadows need Android 9, so Android 8 draws the glow as a plain
 * dark shadow.
 */
@Composable
private fun ThemedBanner(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier
            .statusBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .fillMaxWidth()
            .shadow(elevation = 12.dp, shape = shape, clip = false, ambientColor = p.accent, spotColor = p.accent)
            .clip(shape)
            .background(p.bg2)
            .border(1.dp, Brush.horizontalGradient(listOf(p.accent.copy(alpha = 0.6f), p.accent2.copy(alpha = 0.6f))), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

/** Top banner celebrating a just-unlocked achievement. Tap to dismiss. */
@Composable
private fun AchievementBannerView(
    banner: com.zekktris.AchievementBanner,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = ZkTheme.palette
    ThemedBanner(onClick = onDismiss, modifier = modifier) {
        AchievementMarkerBadge(banner.marker)
        Column(Modifier.weight(1f)) {
            Text("Achievement unlocked!", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Text(banner.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (banner.detail.isNotBlank()) Text(banner.detail, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The achievement's marker in the circle its shelf badge uses (ProfileSheet
 * AchievementBadge): accent at 35% to accent2 at 25%, top left to bottom
 * right. iOS draws a symbol it resolves from the achievement id here; Android
 * has no such map, so the glyph is the server's marker, as on the shelf. A
 * text marker (a tier like "1k", a year count) draws in the accent. A colour
 * emoji keeps its own colours, since no text colour reaches it.
 */
@Composable
private fun AchievementMarkerBadge(marker: String) {
    val p = ZkTheme.palette
    // Tier markers run to four characters ("100k"). Step them down so they
    // stay on one line inside the circle; emoji keep the shelf's 18sp.
    val isText = marker.isNotEmpty() && marker.all { it.isLetterOrDigit() }
    val glyphSize = when {
        !isText || marker.length <= 2 -> 18.sp
        marker.length == 3 -> 15.sp
        else -> 12.sp
    }
    Box(
        Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(Brush.linearGradient(listOf(p.accent.copy(alpha = 0.35f), p.accent2.copy(alpha = 0.25f)))),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            marker, color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = glyphSize,
            maxLines = 1, softWrap = false,
        )
    }
}

/** Top banner for an incoming poke — tap the body to open the DM, tap the emoji to poke back. */
@Composable
private fun PokeBannerView(
    banner: com.zekktris.PokeBanner,
    onOpen: () -> Unit,
    onPokeBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = ZkTheme.palette
    ThemedBanner(onClick = onOpen, modifier = modifier) {
        Column(Modifier.weight(1f)) {
            Text(
                "${banner.name} ${pokeBannerVerb(banner.pokeType)}",
                color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
            )
            Text(
                "Tap to open · tap the emoji to poke back",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
            )
        }
        // Emoji chip — poke the same variant back without opening the DM.
        // Accent-tinted (18% fill, 45% stroke), like the DM-row E2EE lock.
        Text(
            banner.emoji,
            fontSize = 26.sp,
            modifier = Modifier
                .clip(CircleShape)
                .background(p.accent.copy(alpha = 0.18f))
                .border(1.dp, p.accent.copy(alpha = 0.45f), CircleShape)
                .clickable(onClick = onPokeBack)
                .padding(8.dp),
        )
    }
}

private fun pokeBannerVerb(t: String) = when (t) {
    "heart" -> "sent you a heart"
    "wave" -> "waved at you"
    "like" -> "liked you"
    "fire" -> "sent you fire"
    else -> "poked you"
}
