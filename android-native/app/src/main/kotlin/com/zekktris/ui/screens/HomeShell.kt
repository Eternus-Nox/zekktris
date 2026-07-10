package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.GuildIcon
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/** The Discord-style home: a server rail on the left, a channel/DM list on the right. */
@Composable
fun HomeShell(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    Row(Modifier.fillMaxSize()) {
        ServerRail(store, state)
        Box(
            Modifier
                .fillMaxSize()
                .background(p.bg1),
        ) { ListColumn(store, state) }
    }
}

@Composable
private fun ServerRail(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    Box(
        Modifier
            .fillMaxHeight()
            .width(72.dp)
            .background(p.bg0),
    ) {
        Column(
            Modifier
                .fillMaxHeight()
                .statusBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RailItem(selected = state.selectedGuildId == null, onClick = { store.selectGuild(null) }) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (state.selectedGuildId == null) p.accent else p.bg2),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Z",
                        color = if (state.selectedGuildId == null) p.bg0 else p.accent,
                        fontWeight = FontWeight.Bold,
                        fontSize = 22.sp,
                    )
                }
            }

            Box(
                Modifier
                    .padding(vertical = 2.dp)
                    .width(28.dp)
                    .height(1.dp)
                    .background(p.line),
            )

            state.guilds.forEach { g ->
                RailItem(selected = state.selectedGuildId == g.id, onClick = { store.selectGuild(g.id) }) {
                    GuildIcon(url = g.iconUrl, name = g.name, size = 48.dp)
                }
            }
        }
    }
}

@Composable
private fun RailItem(selected: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    val p = ZkTheme.palette
    Row(verticalAlignment = Alignment.CenterVertically) {
        // selection pill on the left edge
        Box(
            Modifier
                .width(4.dp)
                .height(if (selected) 34.dp else 0.dp)
                .clip(RoundedCornerShape(topEnd = 4.dp, bottomEnd = 4.dp))
                .background(p.accent),
        )
        Spacer(Modifier.width(8.dp))
        Box(Modifier.clip(RoundedCornerShape(16.dp)).clickable(onClick = onClick)) { content() }
        Spacer(Modifier.width(12.dp))
    }
}

@Composable
private fun ListColumn(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val guild = state.selectedGuildId?.let { id -> state.guilds.firstOrNull { it.id == id } }
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding(),
    ) {
        // header
        Text(
            text = guild?.name ?: "Direct Messages",
            color = ZkInk.ink1,
            fontWeight = FontWeight.Bold,
            fontSize = 18.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
        )
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(vertical = 8.dp),
        ) {
            if (guild == null) DmList(store, state) else ChannelList(store, state, guild.id)
        }

        UserFooter(store, state)
    }
}

@Composable
private fun ChannelList(store: AppStore, state: AppState, guildId: String) {
    val channels = state.channelsByGuild[guildId] ?: emptyList()
    val categories = channels.filter { it.isCategory }.sortedBy { it.position ?: 0 }
    val byParent = channels.filterNot { it.isCategory }.groupBy { it.parentId }

    fun rowsFor(parentId: String?) = (byParent[parentId] ?: emptyList()).sortedBy { it.position ?: 0 }

    rowsFor(null).forEach { ChannelRow(store, state, it) }
    categories.forEach { cat ->
        Text(
            text = (cat.name ?: "").uppercase(),
            color = ZkInk.ink3,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp),
        )
        rowsFor(cat.id).forEach { ChannelRow(store, state, it) }
    }
}

@Composable
private fun ChannelRow(store: AppStore, state: AppState, ch: Channel) {
    val unread = ch.lastMessageId != null && state.readStates[ch.id]?.lastMessageId != ch.lastMessageId
    val icon = if (ch.isVoice) Icons.Filled.VolumeUp else Icons.Filled.Tag
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { store.selectChannel(ch.id) }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (unread) ZkInk.ink1 else ZkInk.ink3, modifier = Modifier.size(18.dp))
        Text(
            text = ch.name ?: "channel",
            color = if (unread) ZkInk.ink1 else ZkInk.ink2,
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            fontSize = 15.sp,
            modifier = Modifier.padding(start = 8.dp).weight(1f),
        )
        if (unread) Box(Modifier.size(8.dp).clip(CircleShape).background(ZkInk.ink1))
    }
}

@Composable
private fun DmList(store: AppStore, state: AppState) {
    if (state.dms.isEmpty()) {
        Text(
            "No direct messages yet.",
            color = ZkInk.ink3,
            fontSize = 14.sp,
            modifier = Modifier.padding(16.dp),
        )
        return
    }
    state.dms.forEach { dm ->
        val other = dm.recipients?.firstOrNull()
        val name = other?.bestName ?: dm.name ?: "Direct Message"
        val presence = other?.id?.let { state.presence[it] } ?: other?.status
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { store.selectChannel(dm.id) }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                Avatar(url = other?.avatarUrl, name = name, size = 40.dp)
                PresenceDot(presence, Modifier.align(Alignment.BottomEnd))
            }
            Text(
                text = name,
                color = ZkInk.ink1,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
    }
}

@Composable
private fun PresenceDot(status: String?, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    val color = when (status) {
        "online" -> ZkStatus.online
        "idle" -> ZkStatus.idle
        "dnd" -> ZkStatus.dnd
        else -> return
    }
    Box(
        modifier
            .size(13.dp)
            .clip(CircleShape)
            .background(p.bg1),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(color))
    }
}

@Composable
private fun UserFooter(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val me = state.me
    Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bg2)
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(url = me?.avatarUrl, name = me?.bestName ?: "?", size = 34.dp)
        Column(Modifier.padding(start = 10.dp).weight(1f)) {
            Text(me?.bestName ?: "", color = ZkInk.ink1, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "gateway ${state.gatewayState}".lowercase(),
                color = ZkInk.ink3,
                fontSize = 11.sp,
            )
        }
        Icon(
            Icons.Filled.Settings,
            contentDescription = "Settings",
            tint = ZkInk.ink3,
            modifier = Modifier
                .clip(CircleShape)
                .clickable { store.openSettings() }
                .padding(6.dp)
                .size(20.dp),
        )
    }
}
