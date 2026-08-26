package com.zekktris.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.BookmarkRemove
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Message
import com.zekktris.data.model.PublicUser
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.dayLabel
import com.zekktris.ui.components.presenceCaption
import com.zekktris.ui.components.shortTime
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

// ── Friends ──────────────────────────────────────────────────────────────────

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FriendsScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var username by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { store.loadRelationships() }

    val friends = state.relationships.filter { it.type == "friend" }
    val incoming = state.relationships.filter { it.type == "incoming_request" }
    val outgoing = state.relationships.filter { it.type == "outgoing_request" }
    val blocked = state.relationships.filter { it.type == "blocked" }

    ScreenScaffold("Friends", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("ADD A FRIEND")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FilledTextField(username, { username = it }, "Username", Modifier.weight(1f))
                    Spacer(Modifier.width(8.dp))
                    val enabled = username.isNotBlank()
                    Text(
                        "Add",
                        color = Color.White,
                        fontFamily = ZkSans,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (enabled) p.accent else p.bg3)
                            .then(
                                if (enabled) Modifier.clickable {
                                    store.addFriend(username) { err ->
                                        status = err ?: "Request sent."
                                        if (err == null) username = ""
                                    }
                                } else Modifier,
                            )
                            .padding(horizontal = 14.dp, vertical = 11.dp),
                    )
                }
                status?.let {
                    Text(it, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp)
                }
            }

            if (incoming.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("REQUESTS")
                    incoming.forEach { r ->
                        FriendRow(r.user, presence = null) {
                            Icon(
                                Icons.Filled.CheckCircle, "Accept", tint = ZkStatus.online,
                                modifier = Modifier.clip(CircleShape).clickable { store.acceptFriend(r.user.id) }.padding(2.dp).size(24.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Icon(
                                Icons.Filled.Cancel, "Decline", tint = ZkInk.ink3,
                                modifier = Modifier.clip(CircleShape).clickable { store.removeFriend(r.user.id) }.padding(2.dp).size(24.dp),
                            )
                        }
                    }
                }
            }

            if (outgoing.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("PENDING")
                    outgoing.forEach { r ->
                        FriendRow(r.user, presence = null) {
                            Text(
                                "Cancel", color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                                modifier = Modifier.clickable { store.removeFriend(r.user.id) },
                            )
                        }
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("FRIENDS")
                if (friends.isEmpty()) {
                    Text("No friends yet", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                }
                friends.forEach { r ->
                    // Long-press → Remove friend / Block (iOS MainView.swift:1756-1767).
                    var friendMenu by remember(r.user.id) { mutableStateOf(false) }
                    Box {
                        val presence = state.presenceOf(r.user.id)
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .combinedClickable(
                                    onClick = {
                                        store.openDM(r.user.id)
                                        onBack()
                                    },
                                    onLongClick = { friendMenu = true },
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            FriendRowInner(
                                r.user,
                                presence = presence,
                                // Online needs no timestamp; Away/DND carry both;
                                // offline (and Invisible, masked to offline by the
                                // server) shows only "Last online …".
                                subtitle = presenceCaption(presence, r.user.lastSeenAt),
                            )
                            Icon(Icons.AutoMirrored.Filled.Message, "Message", tint = ZkInk.ink3, modifier = Modifier.size(14.dp))
                            // Call: the same path the DM header's call button uses
                            // (open/create the 1:1 DM, then requestVoice on it) —
                            // MainScreen picks the pending id up and does the mic
                            // permission + join.
                            Icon(
                                Icons.Filled.Call, "Call", tint = ZkInk.ink3,
                                modifier = Modifier
                                    .padding(start = 8.dp)
                                    .clip(CircleShape)
                                    .clickable { store.openDM(r.user.id, thenCall = true); onBack() }
                                    .padding(6.dp)
                                    .size(18.dp),
                            )
                        }
                        DropdownMenu(expanded = friendMenu, onDismissRequest = { friendMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Remove friend", color = ZkInk.ink1, fontFamily = ZkSans) },
                                onClick = { friendMenu = false; store.removeFriend(r.user.id) },
                            )
                            DropdownMenuItem(
                                text = { Text("Block", color = ZkStatus.dangerSoft, fontFamily = ZkSans) },
                                onClick = { friendMenu = false; store.blockUser(r.user.id) },
                            )
                        }
                    }
                }
            }

            if (blocked.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("BLOCKED")
                    blocked.forEach { r ->
                        FriendRow(r.user, presence = null, dim = true) {
                            Text(
                                "Unblock", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                                modifier = Modifier.clickable { store.unblockUser(r.user.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FriendRow(
    user: PublicUser,
    presence: String?,
    dim: Boolean = false,
    trailing: @Composable () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        FriendRowInner(user, presence, dim)
        trailing()
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.FriendRowInner(
    user: PublicUser,
    presence: String?,
    dim: Boolean = false,
    subtitle: String? = null,
) {
    val p = ZkTheme.palette
    Box {
        Avatar(url = user.avatarUrl, name = user.bestName, size = 36.dp, decoration = user.avatarDecoration, toneId = user.id)
        presence?.let {
            val color = when (it) {
                "online" -> ZkStatus.online
                "idle" -> ZkStatus.idle
                "dnd" -> ZkStatus.dnd
                else -> null
            }
            if (color != null) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(12.dp).clip(CircleShape).background(p.bg1),
                    contentAlignment = Alignment.Center,
                ) { Box(Modifier.size(8.dp).clip(CircleShape).background(color)) }
            }
        }
    }
    Column(Modifier.padding(start = 10.dp).weight(1f)) {
        Text(
            user.bestName,
            color = if (dim) ZkInk.ink2 else ZkInk.ink1,
            fontFamily = ZkSans,
            fontSize = 15.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        subtitle?.let {
            Text(
                it,
                color = ZkInk.ink3,
                fontFamily = ZkSans,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ── Saved messages ───────────────────────────────────────────────────────────

@Composable
fun SavedScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    LaunchedEffect(Unit) { store.loadSaved() }
    ScreenScaffold("Saved Messages", onBack = onBack) {
        if (state.saved.isEmpty()) {
            EmptyNote(Icons.Filled.BookmarkRemove, "No saved messages")
            return@ScreenScaffold
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(state.saved, key = { it.message.id }) { item ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Avatar(url = item.message.author?.avatarUrl, name = item.message.author?.bestName ?: "?", size = 32.dp)
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                        Row(verticalAlignment = Alignment.Bottom) {
                            Text(item.message.author?.bestName ?: "Unknown", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                            item.channel?.name?.let {
                                Text("#$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, maxLines = 1, modifier = Modifier.padding(start = 6.dp))
                            }
                            Text(shortTime(item.message.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                        }
                        Text(
                            savedPreview(store, item.channel?.id ?: item.message.channelId, item.message),
                            color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp,
                            maxLines = 5, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    Icon(
                        Icons.Filled.BookmarkRemove, "Unsave", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable { store.unsave(item.message.id) }.padding(4.dp).size(18.dp),
                    )
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
            }
        }
    }
}

/** Mirrors iOS savedText (MessageViews.swift:4744-4755): decrypt (or tombstone)
 *  E2EE content, then sticker / voice / attachment / poll / forward fallbacks. */
private fun savedPreview(store: AppStore, channelId: String, m: Message): String = when {
    m.content.isNotBlank() -> store.renderContent(channelId, m.content)
    m.sticker != null -> "🏷️ Sticker"
    m.attachments.any { it.isVoiceMessage == true } -> "🎤 Voice message"
    m.attachments.isNotEmpty() -> "📎 Attachment"
    m.poll != null -> "📊 Poll"
    m.forwardedFrom != null -> "↪︎ ${m.forwardedFrom!!.content.ifBlank { "Forwarded message" }}"
    else -> "Message"
}

// ── Scheduled messages ───────────────────────────────────────────────────────

@Composable
fun ScheduledScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    LaunchedEffect(Unit) { store.loadScheduled() }
    ScreenScaffold("Scheduled", onBack = onBack) {
        if (state.scheduled.isEmpty()) {
            EmptyNote(Icons.Filled.Schedule, "No scheduled messages")
            return@ScreenScaffold
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.scheduled, key = { it.id }) { sm ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(p.bg2)
                        .padding(12.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Schedule, null, tint = p.accent, modifier = Modifier.size(13.dp))
                        Text(
                            "${dayLabel(sm.scheduledFor)} · ${shortTime(sm.scheduledFor)}",
                            color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 12.sp,
                            modifier = Modifier.padding(start = 6.dp).weight(1f),
                        )
                        Icon(
                            Icons.Filled.Delete, "Cancel", tint = ZkStatus.dangerSoft,
                            modifier = Modifier.clip(CircleShape).clickable { store.cancelScheduled(sm.id) }.padding(2.dp).size(16.dp),
                        )
                    }
                    Text(
                        sm.content?.let { store.renderContent(sm.channelId ?: "", it) } ?: "🔒 Encrypted message",
                        color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp,
                        maxLines = 3, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

// ── Cross-DM search ──────────────────────────────────────────────────────────

@Composable
fun DmSearchScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Message>?>(null) }
    var searching by remember { mutableStateOf(false) }

    fun search() {
        val q = query.trim()
        if (q.isEmpty()) return
        searching = true
        scope.launch {
            results = store.searchDms(q)
            searching = false
        }
    }

    ScreenScaffold("Search DMs", onBack = onBack) {
        Row(
            Modifier
                .padding(start = 16.dp, end = 16.dp, top = 10.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(p.bg2)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, tint = ZkInk.ink3, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            androidx.compose.foundation.text.BasicTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp),
                cursorBrush = SolidColor(p.accent),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { search() }),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    if (query.isEmpty()) Text("Search all DMs", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 15.sp)
                    inner()
                },
            )
        }
        val r = results
        when {
            searching -> EmptyNote(Icons.Filled.Search, "Searching…")
            r == null -> EmptyNote(Icons.Filled.Search, "Search your direct messages")
            r.isEmpty() -> EmptyNote(Icons.Filled.Search, "No results")
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
                items(r, key = { it.id }) { m ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable {
                                store.selectChannel(m.channelId)
                                onBack()
                            }
                            .padding(horizontal = 16.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Avatar(url = m.author?.avatarUrl, name = m.author?.bestName ?: "?", size = 32.dp)
                        Column(Modifier.padding(start = 10.dp)) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                Text(m.author?.bestName ?: "Unknown", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                                Text("${dayLabel(m.createdAt)} ${shortTime(m.createdAt)}", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                            }
                            Text(m.content.ifBlank { "📎 Attachment" }, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                }
            }
        }
    }
}

// ── Your events ──────────────────────────────────────────────────────────────

@Composable
fun MyEventsScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    LaunchedEffect(Unit) { store.loadMyEvents() }
    ScreenScaffold("Your Events", onBack = onBack) {
        if (state.myEvents.isEmpty()) {
            EmptyNote(Icons.Filled.Schedule, "No upcoming events")
            return@ScreenScaffold
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.myEvents, key = { it.event.id }) { item ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(12.dp),
                ) {
                    Text(item.event.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                    Text(
                        "${dayLabel(item.event.startAt)} · ${shortTime(item.event.startAt)}" +
                            (item.guildName?.let { "  ·  $it" } ?: ""),
                        color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                        modifier = Modifier.padding(top = 3.dp),
                    )
                    item.event.description?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
        }
    }
}

// ── Shared ───────────────────────────────────────────────────────────────────

@Composable
private fun EmptyNote(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, null, tint = ZkInk.ink3, modifier = Modifier.size(30.dp))
            Text(label, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}
