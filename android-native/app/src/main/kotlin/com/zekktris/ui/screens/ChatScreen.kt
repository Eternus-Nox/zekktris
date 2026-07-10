package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.Attachment
import com.zekktris.data.model.Channel
import com.zekktris.data.model.Message
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.shortTime
import com.zekktris.ui.components.withinMinutes
import com.zekktris.ui.components.zkFieldColors
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkTheme

private const val AVATAR_LANE = 52 // avatar area width so grouped lines align

@Composable
fun ChatScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val channel = state.currentChannel
    val channelId = state.selectedChannelId
    val messages = channelId?.let { state.messagesByChannel[it] } ?: emptyList()
    BackHandler { store.closeChannel() }

    Column(Modifier.fillMaxSize().background(p.bg1)) {
        ChatHeader(channel, onBack = { store.closeChannel() })
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
        MessageList(messages, Modifier.weight(1f).fillMaxWidth())
        if (channelId != null) Composer(onSend = { store.sendMessage(channelId, it) })
    }
}

@Composable
private fun ChatHeader(channel: Channel?, onBack: () -> Unit) {
    val title = when {
        channel == null -> ""
        channel.isDM -> channel.recipients?.firstOrNull()?.bestName ?: (channel.name ?: "Direct Message")
        else -> channel.name ?: "channel"
    }
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 6.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "Back",
            tint = ZkInk.ink2,
            modifier = Modifier
                .clip(CircleShape)
                .clickable(onClick = onBack)
                .padding(8.dp)
                .size(20.dp),
        )
        if (channel != null && !channel.isDM) {
            Text("#", color = ZkInk.ink3, fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.padding(start = 4.dp))
        }
        Text(
            text = title,
            color = ZkInk.ink1,
            fontWeight = FontWeight.SemiBold,
            fontSize = 17.sp,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

@Composable
private fun MessageList(messages: List<Message>, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    val listState = rememberLazyListState()
    // Only auto-scroll to a new message when the user is already at/near the
    // bottom — don't yank them away while they're reading history.
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || last.index >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty() && atBottom) listState.animateScrollToItem(messages.lastIndex)
    }
    if (messages.isEmpty()) {
        Box(modifier.background(p.bg1), contentAlignment = Alignment.Center) {
            Text("No messages yet — say hi 👋", color = ZkInk.ink3, fontSize = 14.sp)
        }
        return
    }
    LazyColumn(
        state = listState,
        modifier = modifier.background(p.bg1),
        contentPadding = PaddingValues(vertical = 10.dp),
    ) {
        itemsIndexed(messages, key = { _, m -> m.id }) { i, m ->
            val prev = messages.getOrNull(i - 1)
            val grouped = prev != null &&
                m.type == "default" &&
                prev.type == "default" &&
                prev.authorId != null &&
                prev.authorId == m.authorId &&
                withinMinutes(prev.createdAt, m.createdAt)
            MessageRow(m, grouped)
        }
    }
}

@Composable
private fun MessageRow(msg: Message, grouped: Boolean) {
    val name = msg.authorOverrideName ?: msg.author?.bestName ?: "Unknown"
    val avatarUrl = msg.authorOverrideAvatar ?: msg.author?.avatarUrl
    val pending = msg.id.startsWith("pending-")

    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = if (grouped) 1.dp else 8.dp, bottom = 1.dp)
            .alpha(if (pending) 0.55f else 1f),
    ) {
        Box(Modifier.width(AVATAR_LANE.dp), contentAlignment = Alignment.TopCenter) {
            if (!grouped) Avatar(url = avatarUrl, name = name, size = 40.dp)
        }
        Column(Modifier.weight(1f).padding(end = 14.dp)) {
            if (!grouped) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(name, color = ZkInk.ink1, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    Text(
                        shortTime(msg.createdAt),
                        color = ZkInk.ink4,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(start = 8.dp, bottom = 1.dp),
                    )
                }
            }
            if (msg.content.isNotBlank()) {
                Text(msg.content, color = ZkInk.ink1, fontSize = 15.sp, modifier = Modifier.padding(top = 1.dp))
            }
            msg.attachments.forEach { AttachmentView(it) }
        }
    }
}

@Composable
private fun AttachmentView(att: Attachment) {
    val p = ZkTheme.palette
    val url = Config.absoluteUrl(att.url)
    if (att.isImage && url != null) {
        AsyncImage(
            model = url,
            contentDescription = att.filename,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .padding(top = 4.dp)
                .widthIn(max = 260.dp)
                .heightIn(max = 320.dp)
                .clip(RoundedCornerShape(10.dp)),
        )
    } else {
        Row(
            Modifier
                .padding(top = 4.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(p.bg2)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null, tint = p.accent, modifier = Modifier.size(20.dp))
            Text(
                att.filename ?: "attachment",
                color = ZkInk.ink2,
                fontSize = 13.sp,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    val p = ZkTheme.palette
    var text by remember { mutableStateOf("") }

    fun submit() {
        val t = text.trim()
        if (t.isNotEmpty()) {
            onSend(t)
            text = ""
        }
    }

    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bg1)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("Message", color = ZkInk.ink4) },
            maxLines = 5,
            shape = RoundedCornerShape(22.dp),
            colors = zkFieldColors(),
            keyboardActions = KeyboardActions(onSend = { submit() }),
        )
        Box(
            Modifier
                .size(46.dp)
                .clip(CircleShape)
                .background(if (text.isBlank()) p.bg3 else p.accent)
                .clickable(enabled = text.isNotBlank()) { submit() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.Send,
                contentDescription = "Send",
                tint = if (text.isBlank()) ZkInk.ink4 else p.bg0,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
