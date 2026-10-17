package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.AdminGuild
import com.zekktris.data.model.AdminStorage
import androidx.activity.compose.BackHandler
import com.zekktris.data.model.AdminUser
import com.zekktris.data.model.Channel
import com.zekktris.data.model.PeekGuildResult
import com.zekktris.data.model.PeekMessage
import com.zekktris.data.model.StorageItem
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.PeekMessageRow
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import kotlinx.coroutines.launch
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

private val MOD_SKY = Color(0xFF38BDF8)
private val TIER_SCOUT = Color(0xFF3D9BFF)
private val TIER_GUARDIAN = Color(0xFF9D7BFF)
private val TIER_LEGEND = Color(0xFFF4C95B)

private fun tierColor(tier: String): Color = when (tier.lowercase()) {
    "guardian" -> TIER_GUARDIAN
    "legend" -> TIER_LEGEND
    else -> TIER_SCOUT
}

@Composable
fun AdminScreen(store: AppStore, state: AppState) {
    val isAdmin = state.me?.isAdmin == true
    var tab by remember { mutableIntStateOf(if (isAdmin) 0 else 1) }
    LaunchedEffect(Unit) { store.loadAdminOverview() }
    // The account whose Account Info page is open. It takes the whole screen
    // (its own back chevron returns here, to the same tab).
    var openAccountId by remember { mutableStateOf<String?>(null) }
    openAccountId?.let { id ->
        AdminAccountScreen(store, state, id) { openAccountId = null }
        return
    }

    // (index, label), gated: Overview/Storage/Perks are admin-only. "Perks"
    // matches the web and iOS tab name for the monetization settings.
    val tabs = buildList {
        if (isAdmin) add(0 to "Overview")
        add(1 to "Users"); add(2 to "Servers")
        if (isAdmin) add(3 to "Storage")
        add(4 to "Security")
        if (isAdmin) add(5 to "Perks")
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalAdminStore provides store) {
        ScreenScaffold("Admin Instance", onBack = { store.closeRailPage() }) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                tabs.forEach { (i, label) -> TabChip(label, selected = tab == i) { tab = i } }
            }
            when (tab) {
                0 -> OverviewTab(state)
                1 -> UsersTab(store, state) { openAccountId = it }
                2 -> ServersTab(store, state, isAdmin)
                3 -> StorageTab(store, state)
                4 -> AdminSecurityTab(store, isAdmin)
                else -> AdminMonetizationTab(store)
            }
        }
    }
}

@Composable
private fun TabChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) Color.White else ZkInk.ink2,
        fontFamily = ZkSans,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        fontSize = 13.sp,
        modifier = Modifier.clip(CircleShape).background(if (selected) p.accent else p.bg2).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

// ── Overview ─────────────────────────────────────────────────────────────────

@Composable
private fun OverviewTab(state: AppState) {
    val p = ZkTheme.palette
    val s = state.adminStats
    if (state.loadingAdmin && s == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (s != null) {
            StatCard("Users", "${s.users.total}", "${s.users.banned} banned")
            StatCard("Servers", "${s.guilds}")
            StatCard("Channels", "${s.channels}")
            StatCard("Messages", "${s.messages.total}", "${s.messages.last24h} in last 24h")
            StatCard("Active sessions", "${s.activeSessions}")
        }
        state.adminMetrics?.let { m ->
            SectionLabel("OPERATIONAL", Modifier.padding(top = 6.dp))
            StatCard("Gateway connections", "${m.gateway.connections}", "${m.gateway.onlineUsers} online")
            StatCard("In voice", "${m.voice.participants}", "${m.voice.rooms} room${if (m.voice.rooms == 1) "" else "s"}")
            StatCard("Scheduled", "${m.scheduledMessages.pending}", "${m.scheduledMessages.due} due")
            StatCard("Uptime", fmtUptime(m.process.uptimeSeconds), "worker ${m.process.workerId}")
            StatCard("Database", if (m.db.ok) "Healthy" else "Down", "${m.db.latencyMs}ms")
            StatCard(
                "Redis",
                if (!m.redis.configured) "Not configured" else if (m.redis.healthy != false) "Healthy" else "Unreachable",
                if (m.redis.configured) "bus + blacklist" else "in-memory",
            )
        }
        ActivityFeedSection()
    }
}

/** RECENT SIGNUPS + NEW SERVERS lists (iOS activitySection). */
@Composable
private fun ActivityFeedSection() {
    val p = ZkTheme.palette
    var activity by remember { mutableStateOf<com.zekktris.data.model.AdminActivity?>(null) }
    val store = LocalAdminStore.current
    LaunchedEffect(store) { store?.let { activity = it.adminActivity() } }
    val a = activity ?: return
    if (a.recentUsers.isNotEmpty()) {
        SectionLabel("RECENT SIGNUPS", Modifier.padding(top = 6.dp))
        a.recentUsers.take(8).forEach { u ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Avatar(url = u.avatarUrl, name = u.displayName.ifBlank { u.username }, size = 28.dp, toneId = u.id)
                Column(Modifier.padding(start = 10.dp).weight(1f)) {
                    Text(u.displayName.ifBlank { u.username }, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("@${u.username}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                }
                Text(relativeAge(u.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp)
            }
        }
    }
    if (a.recentGuilds.isNotEmpty()) {
        SectionLabel("NEW SERVERS", Modifier.padding(top = 6.dp))
        a.recentGuilds.take(8).forEach { g ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Avatar(url = g.iconUrl, name = g.name, size = 28.dp, toneId = g.id)
                Text(g.name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f))
                Text(relativeAge(g.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp)
            }
        }
    }
}

private fun relativeAge(iso: String): String {
    val then = runCatching { java.time.Instant.parse(iso) }.getOrNull() ?: return ""
    val s = java.time.Duration.between(then, java.time.Instant.now()).seconds
    return when {
        s < 3600 -> "${maxOf(1L, s / 60)}m"
        s < 86400 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}

/** The admin surface's store, provided by AdminScreen so leaf cards can call
 *  the on-demand endpoints without threading params through every level. */
private val LocalAdminStore = androidx.compose.runtime.staticCompositionLocalOf<AppStore?> { null }

@Composable
private fun StatCard(label: String, value: String, detail: String? = null) {
    // Plain borderless row (label/detail left, big value right), matching iOS statRow.
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            if (detail != null) Text(detail, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
        }
        Text(value, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 22.sp)
    }
}

// ── Users ────────────────────────────────────────────────────────────────────

@Composable
private fun UsersTab(store: AppStore, state: AppState, onOpen: (String) -> Unit) {
    val p = ZkTheme.palette
    var q by remember { mutableStateOf("") }
    var bannedOnly by remember { mutableStateOf(false) }
    val reload = { store.loadAdminUsers(q.ifBlank { null }, bannedOnly) }
    LaunchedEffect(bannedOnly) { reload() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            // Moderators can't search by email (the server ignores it for them).
            SearchField(q, { q = it }, if (state.me?.isAdmin == true) "Search name or email" else "Search users", Modifier.weight(1f)) { reload() }
            Spacer(Modifier.width(8.dp))
            Icon(
                Icons.Filled.PersonOff, "Banned only",
                tint = if (bannedOnly) ZkStatus.danger else ZkInk.ink3,
                modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (bannedOnly) ZkStatus.danger.copy(alpha = 0.15f) else p.bg2).clickable { bannedOnly = !bannedOnly }.padding(10.dp).size(20.dp),
            )
        }
        if (state.adminUsers.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No users found.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(state.adminUsers, key = { it.id }) { u ->
                    UserRow(u, isSelf = state.me?.id == u.id) { onOpen(u.id) }
                    RowDivider()
                }
            }
        }
    }
}

@Composable
private fun RowDivider() {
    Box(Modifier.fillMaxWidth().padding(start = 16.dp).height(1.dp).background(ZkTheme.palette.line))
}

/** One account in the list. Tapping opens its Account Info page — every action
 *  on an account lives there; this list is only for finding one. */
@Composable
private fun UserRow(u: AdminUser, isSelf: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(url = u.avatarUrl, name = u.name, size = 36.dp)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(u.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (isSelf) Text(" you", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                if (u.isAdmin) Badge("ADMINISTRATOR", ZkTheme.palette.accent)
                else if (u.isModerator) Badge("MODERATOR", MOD_SKY)
                if (u.isBanned) Badge(if (u.bannedUntil != null) "BANNED · TIMED" else "BANNED", ZkStatus.danger)
                if (u.isMuted) Badge("MUTED", Color(0xFFF59E0B))
                u.subscriptionTier?.let { tier -> Badge(tier.uppercase(), tierColor(tier)) }
            }
            // Moderators get no email (the server sends null) — just the handle.
            Text(
                u.email?.let { "@${u.username} · $it" } ?: "@${u.username}",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

// ── Servers ──────────────────────────────────────────────────────────────────

@Composable
private fun ServersTab(store: AppStore, state: AppState, isAdmin: Boolean) {
    var q by remember { mutableStateOf("") }
    val reload = { store.loadAdminGuilds(q.ifBlank { null }) }
    LaunchedEffect(Unit) { reload() }
    Column(Modifier.fillMaxSize()) {
        SearchField(q, { q = it }, "Search servers", Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) { reload() }
        if (state.adminGuilds.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No servers found.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(state.adminGuilds, key = { it.id }) { g ->
                    ServerRow(store, g, isAdmin, reload)
                    RowDivider()
                }
            }
        }
    }
}

@Composable
private fun ServerRow(store: AppStore, g: AdminGuild, isAdmin: Boolean, reload: () -> Unit) {
    var observing by remember { mutableStateOf(false) }
    // Destructive confirm before force-delete (iOS "Delete this server?").
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this server?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("This force-deletes ${g.name} and all of its data. This can't be undone.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = { confirmDelete = false; store.adminDeleteGuild(g.id, reload) }) {
                    Text("Delete", color = ZkStatus.danger, fontFamily = ZkSans)
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmDelete = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) }
            },
            containerColor = ZkTheme.palette.bg2,
        )
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        Avatar(url = g.iconUrl, name = g.name, size = 36.dp)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(g.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (g.discoverable == true) Badge("PUBLIC", ZkTheme.palette.accent2)
            }
            Text("${g.memberCount ?: 0} members", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
        }
        Text("Server ID: ${g.id}", color = ZkInk.ink3, fontFamily = ZkMono, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 110.dp).padding(end = 8.dp))
        // Ghost-mode observe: read the server without joining.
        Icon(Icons.Filled.Visibility, "Observe", tint = ZkTheme.palette.accent, modifier = Modifier.clip(CircleShape).clickable { observing = true }.padding(6.dp).size(20.dp))
        if (isAdmin) {
            Icon(Icons.Filled.Delete, "Delete", tint = ZkStatus.danger, modifier = Modifier.clip(CircleShape).clickable { confirmDelete = true }.padding(6.dp).size(20.dp))
        }
    }
    if (observing) AdminObserveSheet(store, g.id, g.name) { observing = false }
}

/// Read-only ghost-mode observe of a guild: browse its channel tree and read
/// any text channel's messages, without joining. Mirrors iOS AdminObserveView.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AdminObserveSheet(store: AppStore, guildId: String, guildName: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var peek by remember(guildId) { mutableStateOf<PeekGuildResult?>(null) }
    var loaded by remember(guildId) { mutableStateOf(false) }
    var channel by remember(guildId) { mutableStateOf<Channel?>(null) }
    LaunchedEffect(guildId) { peek = store.adminPeekGuild(guildId); loaded = true }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        val ch = channel
        if (ch != null) {
            // Selected-channel message peek.
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("‹ Channels", color = p.accent, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { channel = null }.padding(horizontal = 8.dp, vertical = 4.dp))
                Text("#${ch.name ?: "channel"}", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
            }
            ObservedChannelMessages(store, ch.id)
        } else {
            Text("Observing: $guildName", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
            Text(
                "Read-only ghost mode — you are not a member and nothing is marked read.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).clip(RoundedCornerShape(8.dp)).background(p.accent.copy(alpha = 0.08f)).padding(10.dp),
            )
            val pk = peek
            when {
                !loaded -> Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
                pk == null -> Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { Text("Couldn't load this server.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp) }
                else -> {
                    val sorted = pk.channels.sortedBy { it.position ?: 0 }
                    val categories = sorted.filter { it.isCategory }
                    val root = sorted.filter { !it.isCategory && it.parentId == null }
                    LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(0.78f).padding(horizontal = 12.dp, vertical = 8.dp)) {
                        items(root, key = { it.id }) { ObservedChannelRow(it) { channel = it } }
                        categories.forEach { cat ->
                            item(key = "cat-${cat.id}") {
                                Text((cat.name ?: "").uppercase(), color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, modifier = Modifier.padding(top = 12.dp, bottom = 2.dp, start = 4.dp))
                            }
                            items(sorted.filter { it.parentId == cat.id && !it.isCategory }, key = { it.id }) { ObservedChannelRow(it) { channel = it } }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ObservedChannelRow(ch: Channel, onOpen: () -> Unit) {
    val observable = !ch.isVoice && !ch.isCategory
    Row(
        Modifier.fillMaxWidth().let { if (observable) it.clickable(onClick = onOpen) else it }.padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (ch.isVoice) "🔊" else "#", color = ZkTheme.palette.accent, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(end = 8.dp))
        Text(ch.name ?: "channel", color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (observable) Icon(Icons.Filled.Visibility, null, tint = ZkInk.ink4, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun ObservedChannelMessages(store: AppStore, channelId: String) {
    val p = ZkTheme.palette
    var messages by remember(channelId) { mutableStateOf<List<PeekMessage>?>(null) }
    LaunchedEffect(channelId) { messages = store.adminPeekMessages(channelId) }
    val m = messages
    when {
        m == null -> Box(Modifier.fillMaxWidth().fillMaxHeight(0.78f), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
        m.isEmpty() -> Box(Modifier.fillMaxWidth().fillMaxHeight(0.78f), contentAlignment = Alignment.Center) { Text("No messages.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp) }
        else -> LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(0.78f).padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(m.reversed(), key = { it.id }) { PeekMessageRow(it) }
        }
    }
}

// ── Storage ──────────────────────────────────────────────────────────────────

@Composable
private fun StorageTab(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    LaunchedEffect(Unit) { store.loadAdminStorage() }
    val st: AdminStorage? = state.adminStorage
    var showFiles by remember { mutableStateOf(false) }
    if (st == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard("On-disk total", byteStr(st.onDisk.totalBytes), "${st.onDisk.totalCount} files")
        StatCard("Unused", byteStr(st.onDisk.unusedBytes), "${st.onDisk.unusedCount} files")
        StatCard("Attachments", byteStr(st.attachments.totalBytes ?: 0), "${st.attachments.count} files")
        StatCard("Avatars", "${st.avatars.count}")
        StatCard("Banners", "${st.banners.count}")
        StatCard("Emojis", "${st.emojis.count}")
        StatCard("Stickers", "${st.stickers.count}")
        PrimaryButton("Run garbage collection") { store.runStorageGc() }
        SecondaryButton("Browse files") { showFiles = true }
    }
    if (showFiles) StorageFilesSheet(store) { showFiles = false }
}

/// Paged on-disk file browser: sort by size/recent, per-item compress +
/// delete. Mirrors iOS's StorageItemsView. Paging state is local.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StorageFilesSheet(store: AppStore, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var sort by remember { mutableStateOf("size") }
    val items = remember { mutableStateListOf<StorageItem>() }
    var page by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var hasMore by remember { mutableStateOf(true) }
    // Monotonic request token: a reset (sort change) supersedes any in-flight
    // load so a stale load-more response can't append onto freshly-reset data.
    // Runs on Main between suspension points, so the ++/compare are serialized.
    var loadSeq by remember { mutableIntStateOf(0) }

    suspend fun load(reset: Boolean) {
        // Only guard duplicate load-more; a reset must never be dropped or the
        // sort segment desyncs from the data.
        if (!reset && (loading || !hasMore)) return
        loadSeq += 1
        val token = loadSeq
        loading = true
        // The server storage list is 1-indexed (page 0 clamps to 1); walk 1,2,3…
        val nextPage = if (reset) 1 else page + 1
        val listing = store.adminStorageItems(nextPage, sort)
        if (token != loadSeq) return // superseded by a newer request; drop this response (loading owned by the winner)
        if (reset) { items.clear(); page = 0 }
        val have = items.mapTo(HashSet()) { it.id }
        items.addAll(listing.items.filter { it.id !in have })
        page = nextPage
        hasMore = listing.items.size >= 50
        loading = false
    }
    LaunchedEffect(sort) { load(reset = true) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Text("Files", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        // Sort segmented control.
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SortSeg("Largest", sort == "size") { sort = "size" }
            SortSeg("Recent", sort == "recent") { sort = "recent" }
        }
        LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(0.82f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (items.isEmpty() && loading) {
                item { Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) } }
            } else if (items.isEmpty()) {
                item { Text("No files.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 40.dp)) }
            } else {
                items(items, key = { it.id }) { item ->
                    StorageFileRow(
                        item,
                        onCompress = { scope.launch { if (store.adminCompressStorageItem(item.id)) load(reset = true) } },
                        onDelete = { scope.launch { if (store.adminDeleteStorageItem(item.id)) { items.remove(item) } } },
                    )
                }
                if (hasMore) {
                    item {
                        Text(
                            if (loading) "Loading…" else "Load more",
                            color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp,
                            modifier = Modifier.fillMaxWidth().clickable(enabled = !loading) { scope.launch { load(reset = false) } }.padding(vertical = 10.dp),
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StorageFileRow(item: StorageItem, onCompress: () -> Unit, onDelete: () -> Unit) {
    val p = ZkTheme.palette
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(item.filename ?: "(unnamed)", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.category, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp)
                Text(byteStr(item.sizeBytes), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                if (!item.referenced) {
                    Text(
                        "UNUSED", color = ZkStatus.danger, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp,
                        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(ZkStatus.danger.copy(alpha = 0.15f)).padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
        }
        if (item.compressed == false) {
            Text("Compress", color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(p.bg3).clickable(onClick = onCompress).padding(horizontal = 10.dp, vertical = 5.dp))
        }
        Icon(Icons.Filled.Delete, "Delete", tint = ZkStatus.danger, modifier = Modifier.padding(start = 8.dp).clip(CircleShape).clickable(onClick = onDelete).padding(4.dp).size(18.dp))
    }
}

@Composable
private fun SortSeg(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (selected) p.accent else p.bg2).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 6.dp),
    )
}

// ── Shared ───────────────────────────────────────────────────────────────────

@Composable
private fun Placeholder(what: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text("$what — coming soon", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 15.sp)
    }
}

@Composable
private fun SecondaryButton(label: String, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).clickable(onClick = onClick).padding(vertical = 13.dp),
    )
}

@Composable
private fun Badge(label: String, color: Color) {
    Text(
        label,
        color = color,
        fontFamily = ZkSans,
        fontWeight = FontWeight.Bold,
        fontSize = 9.sp,
        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = 0.2f)).padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

@Composable
private fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, onSubmit: () -> Unit) {
    val p = ZkTheme.palette
    Row(
        modifier.clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Search, null, tint = ZkInk.ink3, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp),
            cursorBrush = SolidColor(p.accent),
            // IME Search submits the query (iOS .onSubmit reload parity —
            // without this the onSubmit callback was dead code).
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { onSubmit() }),
            modifier = Modifier.weight(1f),
            decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 15.sp); inner() },
        )
    }
}

private fun fmtUptime(seconds: Int): String {
    val d = seconds / 86400
    val h = (seconds % 86400) / 3600
    val m = (seconds % 3600) / 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> "${h}h ${m}m"
        else -> "${m}m"
    }
}

private fun byteStr(bytes: Long): String {
    val gb = 1024.0 * 1024 * 1024
    val mb = 1024.0 * 1024
    val kb = 1024.0
    return when {
        bytes >= gb -> String.format("%.1f GB", bytes / gb)
        bytes >= mb -> String.format("%.1f MB", bytes / mb)
        bytes >= kb -> String.format("%.0f KB", bytes / kb)
        else -> "$bytes B"
    }
}
