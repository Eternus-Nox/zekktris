package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.data.model.PublicUser
import com.zekktris.data.model.StageParticipant
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.StarfieldBackground
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.delay

/**
 * Stage channel UI: speakers grid + audience + raised-hands (for mods), with
 * audience raise-hand / speaker mute controls. Mirrors the iOS
 * StageChannelView (Voice.swift:1745-1930). The LiveKit publish grant is gated
 * server-side by speaker status; promotion/demotion triggers a token re-fetch
 * + reconnect (see AppStore.applyStageParticipants).
 */

private fun activeStageChannel(state: AppState): Channel? {
    val id = state.activeStageChannelId ?: return null
    return state.channelsByGuild.values.flatten().firstOrNull { it.id == id }
}

/** Resolve a userId to a public user from any loaded source (self, members, DMs). */
private fun resolveStageUser(state: AppState, userId: String): PublicUser? {
    state.me?.let { if (it.id == userId) return PublicUser(id = it.id, username = it.username, displayName = it.displayName, avatarUrl = it.avatarUrl) }
    state.membersByGuild.values.forEach { list -> list.firstOrNull { it.userId == userId }?.let { return it.user } }
    state.dms.forEach { dm -> dm.recipients?.firstOrNull { it.id == userId }?.let { return it } }
    return null
}

/** Full-screen stage view: header, speakers grid, raised hands (mods), audience
 *  grid, bottom controls. */
@Composable
fun StageCallScreen(store: AppStore, state: AppState, onMinimize: () -> Unit) {
    val p = ZkTheme.palette
    BackHandler(onBack = onMinimize)
    val channel = activeStageChannel(state)
    val title = channel?.name ?: "stage"
    val speakers = state.stageParticipants.filter { it.isSpeaker }
    val audience = state.stageParticipants.filterNot { it.isSpeaker }
    val raisedHands = audience.filter { it.handRaised }
    val guildId = channel?.guildId
    val isMod = guildId != null && state.canManageChannels(guildId)
    val amSpeaker = state.myStageSpeaker
    val myHandRaised = state.stageParticipants.firstOrNull { it.userId == state.me?.id }?.handRaised == true
    var actionTarget by remember { mutableStateOf<StageParticipant?>(null) }

    // Roster poll every 4s (iOS StageChannelView.task). The gateway
    // STAGE_PARTICIPANTS_UPDATE push is the fast path; this is the safety net.
    LaunchedEffect(state.activeStageChannelId) {
        while (true) {
            store.refreshStage()
            delay(4_000)
        }
    }

    StarfieldBackground {
      Column(Modifier.fillMaxSize().statusBarsPadding()) {
        // Header: minimize chevron + stage icon + name (VoiceCallScreen pattern).
        Box(Modifier.fillMaxWidth().height(56.dp)) {
            Box(
                Modifier.align(Alignment.CenterStart).padding(start = 12.dp).size(width = 52.dp, height = 40.dp)
                    .clip(RoundedCornerShape(16.dp)).background(p.bg2).clickable(onClick = onMinimize),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.ChevronLeft, "Minimize", tint = ZkInk.ink2, modifier = Modifier.size(24.dp)) }
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Podcasts, null, tint = p.accent, modifier = Modifier.size(15.dp))
                    Text(
                        title, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold,
                        fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
                Text("Stage", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            }
        }

        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            if (state.stageConnecting && state.stageParticipants.isEmpty()) {
                Box(Modifier.fillMaxWidth().padding(top = 20.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = p.accent, modifier = Modifier.size(28.dp))
                }
            }
            if (state.stageTokenMissing) {
                Text(
                    "Voice isn't available for this stage right now.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                )
            }

            StageSectionLabel("SPEAKERS · ${speakers.size}")
            if (speakers.isEmpty()) {
                Text("No speakers yet.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp)
            } else {
                StageTileGrid(state, speakers, speaker = true) { actionTarget = it }
            }

            if (isMod && raisedHands.isNotEmpty()) {
                StageSectionLabel("RAISED HANDS · ${raisedHands.size}")
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    raisedHands.forEach { participant ->
                        RaisedHandRow(store, state, participant)
                    }
                }
            }

            StageSectionLabel("AUDIENCE · ${audience.size}")
            if (audience.isEmpty()) {
                Text("No one in the audience.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp)
            } else {
                StageTileGrid(state, audience, speaker = false) { actionTarget = it }
            }
        }

        // Controls: speakers get mute; audience gets raise/lower hand; everyone
        // gets Leave (iOS StageChannelView.controls).
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (amSpeaker) {
                Box(
                    Modifier.size(width = 52.dp, height = 44.dp).clip(RoundedCornerShape(12.dp))
                        .background(p.bg3).clickable { store.toggleStageMute() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        if (state.selfMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                        if (state.selfMuted) "Unmute" else "Mute",
                        tint = if (state.selfMuted) ZkStatus.danger else ZkInk.ink1,
                        modifier = Modifier.size(20.dp),
                    )
                }
            } else {
                Row(
                    Modifier.clip(RoundedCornerShape(22.dp))
                        .background(if (myHandRaised) p.accent else p.bg3)
                        .clickable { if (myHandRaised) store.lowerStageHand() else store.raiseStageHand() }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("✋", fontSize = 14.sp)
                    Text(
                        if (myHandRaised) "Lower hand" else "Raise hand",
                        color = if (myHandRaised) Color.White else ZkInk.ink1,
                        fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                }
            }
            Spacer(Modifier.width(12.dp))
            Row(
                Modifier.clip(RoundedCornerShape(22.dp)).background(ZkStatus.danger)
                    .clickable { store.leaveStage() }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.CallEnd, "Leave", tint = Color.White, modifier = Modifier.size(16.dp))
                Text(
                    "Leave", color = Color.White, fontFamily = ZkSans,
                    fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
        }
      }
    }

    // Tap a tile → profile / moderator promote-demote (iOS contextMenu analog).
    actionTarget?.let { participant ->
        val user = resolveStageUser(state, participant.userId)
        AlertDialog(
            onDismissRequest = { actionTarget = null },
            containerColor = p.bg2,
            title = { Text(user?.bestName ?: "User", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = {
                Column {
                    if (isMod) {
                        Text(
                            if (participant.isSpeaker) "Move to audience" else "Make speaker",
                            color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                            modifier = Modifier.padding(bottom = 12.dp).clickable {
                                store.setStageSpeaker(participant.userId, !participant.isSpeaker)
                                actionTarget = null
                            },
                        )
                    }
                    user?.let { u ->
                        Text(
                            "View profile", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                            // Minimize first so the profile sheet (under the
                            // full-screen stage) is actually visible.
                            modifier = Modifier.clickable { actionTarget = null; onMinimize(); store.openProfile(u) },
                        )
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { actionTarget = null }) {
                    Text("Cancel", color = ZkInk.ink3, fontFamily = ZkSans)
                }
            },
        )
    }
}

@Composable
private fun StageSectionLabel(text: String) {
    Text(text, color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
}

/** Non-lazy 4-per-row tile grid (lives inside the screen's vertical scroll —
 *  a LazyVerticalGrid would fight the outer scroller). */
@Composable
private fun StageTileGrid(
    state: AppState,
    participants: List<StageParticipant>,
    speaker: Boolean,
    onTap: (StageParticipant) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        participants.chunked(4).forEach { rowItems ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                rowItems.forEach { participant ->
                    Box(Modifier.weight(1f)) { StageTile(state, participant, speaker, onTap) }
                }
                repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** One participant tile: avatar (speaking pulse for live speakers) + a mic
 *  badge (speakers) or ✋ badge (raised hand) + name. */
@Composable
private fun StageTile(
    state: AppState,
    participant: StageParticipant,
    speaker: Boolean,
    onTap: (StageParticipant) -> Unit,
) {
    val p = ZkTheme.palette
    val user = resolveStageUser(state, participant.userId)
    val name = user?.bestName ?: "User"
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onTap(participant) }.padding(2.dp),
    ) {
        Box {
            SpeakingAvatar(
                url = user?.avatarUrl, name = name, size = 56.dp,
                toneId = participant.userId,
                speaking = speaker && participant.userId in state.speakingUserIds,
            )
            if (speaker) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(20.dp).clip(CircleShape).background(p.accent),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Mic, null, tint = Color.White, modifier = Modifier.size(11.dp)) }
            } else if (participant.handRaised) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(20.dp).clip(CircleShape).background(p.bg3),
                    contentAlignment = Alignment.Center,
                ) { Text("✋", fontSize = 10.sp) }
            }
        }
        Text(
            name, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

/** Moderator queue row: avatar + name + accent Invite capsule (promote). */
@Composable
private fun RaisedHandRow(store: AppStore, state: AppState, participant: StageParticipant) {
    val p = ZkTheme.palette
    val user = resolveStageUser(state, participant.userId)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg3.copy(alpha = 0.5f)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(url = user?.avatarUrl, name = user?.bestName ?: "User", size = 30.dp, toneId = participant.userId)
        Text(
            user?.bestName ?: "User", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 10.dp).weight(1f),
        )
        Box(
            Modifier.clip(RoundedCornerShape(14.dp)).background(p.accent)
                .clickable { store.setStageSpeaker(participant.userId, true) }
                .padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Text("Invite", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
        }
    }
}

/** Slim "On Stage" strip shown while connected but not viewing the stage —
 *  tap to return; mute (speakers only) and leave stay reachable (iOS
 *  MinimizedCallBar's stage variant). */
@Composable
fun StageMiniBar(store: AppStore, state: AppState, onExpand: () -> Unit, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    val title = activeStageChannel(state)?.name ?: "Stage"
    Column(modifier.fillMaxWidth().navigationBarsPadding()) {
      Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
      Row(
        Modifier.fillMaxWidth().background(p.bg2)
            .clickable(onClick = onExpand).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(Icons.Filled.Podcasts, null, tint = ZkStatus.online, modifier = Modifier.size(18.dp))
        Column(Modifier.padding(start = 10.dp).weight(1f)) {
            Text("On Stage", color = ZkStatus.online, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
            Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (state.myStageSpeaker) {
            Icon(
                if (state.selfMuted) Icons.Filled.MicOff else Icons.Filled.Mic, "Mute",
                tint = if (state.selfMuted) ZkStatus.dangerSoft else ZkInk.ink2,
                modifier = Modifier.clip(CircleShape).clickable { store.toggleStageMute() }.padding(6.dp).size(18.dp),
            )
        }
        Box(
            Modifier.clip(RoundedCornerShape(9.dp)).background(ZkStatus.danger)
                .clickable { store.leaveStage() }.padding(horizontal = 10.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.CallEnd, "Leave", tint = Color.White, modifier = Modifier.size(16.dp)) }
      }
      Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
    }
}
