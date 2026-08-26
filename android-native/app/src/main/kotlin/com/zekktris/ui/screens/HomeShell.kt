package com.zekktris.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ListAlt
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.HomeTab
import com.zekktris.RailPage
import com.zekktris.data.Config
import com.zekktris.data.model.Channel
import com.zekktris.ui.components.AbyssBackground
import androidx.compose.ui.layout.ContentScale
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.NameTag
import com.zekktris.ui.components.StaffName
import com.zekktris.ui.components.StreakPill
import com.zekktris.ui.components.GuildIcon
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/** Full-screen overlays reached from the DM quick-rows (iOS presents sheets). */
private enum class DmOverlay { Friends, Events, Saved, Scheduled, Search }

/** The Discord-style home: a server rail on the left, a channel/DM/mentions pane on the right,
 *  over the shared abyss backdrop (translucent columns let the nebula glow through). */
@Composable
fun HomeShell(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    var overlay by remember { mutableStateOf<DmOverlay?>(null) }
    overlay?.let { o ->
        BackHandler { overlay = null }
        when (o) {
            DmOverlay.Friends -> FriendsScreen(store, state) { overlay = null }
            DmOverlay.Events -> MyEventsScreen(store, state) { overlay = null }
            DmOverlay.Saved -> SavedScreen(store, state) { overlay = null }
            DmOverlay.Scheduled -> ScheduledScreen(store, state) { overlay = null }
            DmOverlay.Search -> DmSearchScreen(store, state) { overlay = null }
        }
        return
    }
    AbyssBackground {
        Row(Modifier.fillMaxSize()) {
            ServerRail(store, state)
            Box(Modifier.fillMaxHeight().width(1.dp).background(p.line))
            Box(
                Modifier
                    .fillMaxSize()
                    .background(p.bg2.copy(alpha = 0.85f)),
            ) { ContentPane(store, state) { overlay = it } }
        }
    }
}

// ── Server rail ──────────────────────────────────────────────────────────────

/** Apply the server-synced guild order (iOS AppStore.orderedGuilds): saved ids
 *  first in saved order, then anything the order doesn't know about. */
private fun orderedGuilds(guilds: List<com.zekktris.data.model.Guild>, order: List<String>?): List<com.zekktris.data.model.Guild> {
    if (order.isNullOrEmpty()) return guilds
    val byId = guilds.associateBy { it.id }
    val known = order.mapNotNull { byId[it] }
    val knownIds = known.mapTo(HashSet()) { it.id }
    return known + guilds.filter { it.id !in knownIds }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun ServerRail(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val me = state.me
    val home = state.selectedGuildId == null && state.railPage == null
    // Long-pressed guild → Mark as Read / Mute sheet (iOS rail context menu).
    var railMenuGuild by remember { mutableStateOf<com.zekktris.data.model.Guild?>(null) }
    // Locally-collapsed folders (read-only folder rendering; editing stays on
    // iOS/web). Folders start collapsed → the 2x2 mini-grid.
    var expandedFolders by remember { mutableStateOf(emptySet<String>()) }
    Column(
        Modifier
            .fillMaxHeight()
            .width(72.dp)
            .background(p.bg0.copy(alpha = 0.85f)),
    ) {
        // Scrolling top: DMs, @, guilds, discover/add/join.
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .statusBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            RailTile(Icons.Filled.QuestionAnswer, active = home && state.homeTab == HomeTab.Dms) { store.showDMs() }
            RailTile(Icons.Filled.AlternateEmail, active = home && state.homeTab == HomeTab.Mentions) { store.showMentions() }
            RailDivider()
            // Saved order + folder entries interleaved with standalone guilds
            // (iOS railEntries, MainView.swift:670-677).
            val ordered = orderedGuilds(state.guilds, me?.guildOrder)
            val folders = me?.guildFolders ?: emptyList()
            val folderByGuild = remember(folders) {
                HashMap<String, com.zekktris.data.model.GuildFolder>().apply {
                    folders.forEach { f -> f.guildIds.forEach { gid -> put(gid, f) } }
                }
            }
            val renderedFolders = HashSet<String>()
            @Composable
            fun guildTile(g: com.zekktris.data.model.Guild) {
                // A guild only reads selected while no rail page is open
                // (iOS MainView.swift:835 — Mentions/Discover/Settings un-light it).
                val selected = state.selectedGuildId == g.id && state.railPage == null
                RailSlot(active = selected) {
                    Box(
                        Modifier
                            .size(48.dp)
                            // Selected guild gets the iOS accentGlow drop shadow.
                            .then(
                                if (selected) Modifier.shadow(
                                    elevation = 14.dp,
                                    shape = RoundedCornerShape(14.dp),
                                    clip = false,
                                    ambientColor = p.accent,
                                    spotColor = p.accent,
                                ) else Modifier,
                            )
                            .clip(RoundedCornerShape(14.dp))
                            .then(
                                if (selected)
                                    Modifier.border(1.dp, p.accent.copy(alpha = 0.45f), RoundedCornerShape(14.dp))
                                else Modifier,
                            )
                            .combinedClickable(
                                onClick = { store.selectGuild(g.id) },
                                onLongClick = { railMenuGuild = g },
                            ),
                    ) { GuildIcon(url = g.iconUrl, name = g.name, size = 48.dp, toneId = g.id, isSelected = selected) }
                }
            }
            ordered.forEach { g ->
                val folder = folderByGuild[g.id]
                if (folder == null) {
                    guildTile(g)
                } else if (renderedFolders.add(folder.id)) {
                    val members = ordered.filter { folderByGuild[it.id]?.id == folder.id }
                    val expanded = expandedFolders.contains(folder.id)
                    FolderTile(
                        folder = folder,
                        members = members,
                        expanded = expanded,
                        onToggle = {
                            expandedFolders =
                                if (expanded) expandedFolders - folder.id else expandedFolders + folder.id
                        },
                    )
                    if (expanded) members.forEach { guildTile(it) }
                }
            }
            RailDivider()
            RailTile(Icons.Filled.Explore, active = state.railPage == RailPage.Discover) { store.openRailPage(RailPage.Discover) }
            RailTile(Icons.Filled.Add, active = state.railPage == RailPage.CreateServer) { store.openRailPage(RailPage.CreateServer) }
            RailTile(Icons.Filled.Link, active = state.railPage == RailPage.JoinInvite) { store.openRailPage(RailPage.JoinInvite) }
        }

        // Fixed bottom cluster: admin (gated), family (opt-in / minors), profile avatar.
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (me?.isAdmin == true || me?.isModerator == true) {
                RailTile(Icons.Filled.Shield, active = state.railPage == RailPage.Admin) { store.openRailPage(RailPage.Admin) }
            }
            // Family renders only when opted in (Settings → FEATURES, default
            // off) OR the user is a supervised minor (iOS MainView.swift:712-724).
            val showFamilyPref = ctx.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE)
                .getBoolean("zk.showFamily", false)
            val isMinor = state.family?.isMinor == true
            if (showFamilyPref || isMinor) {
                Box {
                    RailTile(Icons.Filled.People, active = state.railPage == RailPage.Family) { store.openRailPage(RailPage.Family) }
                    // Heavily-restricted (unlinked) minor: red attention dot with
                    // a bg0 ring at the tile's top-right, hidden while the Family
                    // page is open.
                    if (state.family?.restrictedHeavily == true && state.railPage != RailPage.Family) {
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .padding(top = 2.dp, end = 8.dp)
                                .size(11.dp)
                                .clip(CircleShape)
                                .background(p.bg0)
                                .padding(2.dp)
                                .clip(CircleShape)
                                .background(ZkStatus.danger),
                        )
                    }
                }
            }
            RailSlot(active = state.showSettings) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .clickable { store.openSettings() },
                ) {
                    Avatar(url = me?.avatarUrl, name = me?.bestName ?: "?", size = 48.dp, shape = RoundedCornerShape(14.dp), decoration = me?.avatarDecoration, toneId = me?.id)
                    val myPresence = state.presenceOf(me?.id)
                    PresenceDot(myPresence, Modifier.align(Alignment.BottomEnd), ringColor = p.bg0)
                }
            }
        }
    }

    // Rail guild long-press: Mark as Read / Mute (iOS MainView.swift:844-877).
    railMenuGuild?.let { g ->
        val muted = store.isGuildMuted(g.id)
        androidx.compose.material3.ModalBottomSheet(
            onDismissRequest = { railMenuGuild = null },
            containerColor = p.bg2,
        ) {
            Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                Text(
                    g.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
                Text(
                    "Mark as Read", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                    modifier = Modifier.fillMaxWidth().clickable { store.markGuildRead(g.id); railMenuGuild = null }.padding(horizontal = 20.dp, vertical = 14.dp),
                )
                Text(
                    if (muted) "Unmute Server" else "Mute Server", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                    modifier = Modifier.fillMaxWidth().clickable { store.setGuildMuted(g.id, !muted); railMenuGuild = null }.padding(horizontal = 20.dp, vertical = 14.dp),
                )
            }
        }
    }
}

/** A guild folder on the rail: 48dp squircle tinted the folder color; collapsed
 *  → a 2x2 mini-grid of member icons, expanded → a folder glyph (iOS
 *  MainView.swift:880-912). Tap toggles the local collapse. */
@Composable
private fun FolderTile(
    folder: com.zekktris.data.model.GuildFolder,
    members: List<com.zekktris.data.model.Guild>,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    val p = ZkTheme.palette
    val tint = folder.color?.let { c ->
        runCatching { Color(android.graphics.Color.parseColor(if (c.startsWith("#")) c else "#$c")) }.getOrNull()
    } ?: p.accent
    RailSlot(active = false) {
        Box(
            Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(tint.copy(alpha = 0.22f))
                .clickable(onClick = onToggle),
            contentAlignment = Alignment.Center,
        ) {
            if (expanded) {
                Icon(Icons.Filled.Folder, folder.name ?: "Folder", tint = tint, modifier = Modifier.size(22.dp))
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    members.take(4).chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            row.forEach { g ->
                                GuildIcon(url = g.iconUrl, name = g.name, size = 15.dp, toneId = g.id)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A rail slot: full-rail-width row that centers its tile and draws the left-edge selection pip. */
@Composable
private fun RailSlot(active: Boolean, content: @Composable () -> Unit) {
    val p = ZkTheme.palette
    Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) {
        if (active) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .width(6.dp)
                    .height(32.dp)
                    .clip(RoundedCornerShape(topEnd = 3.dp, bottomEnd = 3.dp))
                    .background(p.accent),
            )
        }
        content()
    }
}

/** Icon rail button: 48dp squircle, accent→accent2 gradient glyph when active. */
@Composable
private fun RailTile(icon: ImageVector, active: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    RailSlot(active) {
        Box(
            Modifier
                .size(48.dp)
                // Active tile gets the iOS accentGlow drop shadow (soft accent halo).
                .then(
                    if (active) Modifier.shadow(
                        elevation = 14.dp,
                        shape = RoundedCornerShape(14.dp),
                        clip = false,
                        ambientColor = p.accent,
                        spotColor = p.accent,
                    ) else Modifier,
                )
                .clip(RoundedCornerShape(14.dp))
                .then(
                    if (active) Modifier.background(Brush.linearGradient(listOf(p.accent, p.accent2)))
                    else Modifier.background(p.bg2),
                )
                .then(if (active) Modifier.border(1.dp, p.accent.copy(alpha = 0.45f), RoundedCornerShape(14.dp)) else Modifier)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = if (active) p.bg0 else ZkInk.ink2, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun RailDivider() {
    val p = ZkTheme.palette
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(Modifier.width(32.dp).height(1.dp).background(p.line))
    }
}

// ── Content pane (guild channels / DMs / mentions) ───────────────────────────

@Composable
private fun ContentPane(store: AppStore, state: AppState, onOverlay: (DmOverlay) -> Unit) {
    val guild = state.selectedGuildId?.let { id -> state.guilds.firstOrNull { it.id == id } }
    when {
        guild != null -> ChannelListPane(store, state, guild.id, guild.name, guild.bannerUrl)
        state.homeTab == HomeTab.Mentions -> MentionsPane(store, state)
        else -> DmListPane(store, state, onOverlay)
    }
}

@Composable
private fun ChannelListPane(store: AppStore, state: AppState, guildId: String, guildName: String, bannerUrl: String?) {
    val p = ZkTheme.palette
    val channels = state.channelsByGuild[guildId] ?: emptyList()
    val categories = channels.filter { it.isCategory }.sortedBy { it.position ?: 0 }
    val byParent = channels.filterNot { it.isCategory }.groupBy { it.parentId }
    fun rowsFor(parentId: String?) = (byParent[parentId] ?: emptyList()).sortedBy { it.position ?: 0 }

    var showMembers by remember(guildId) { mutableStateOf(false) }
    var showInvite by remember(guildId) { mutableStateOf(false) }
    var collapsedCats by remember(guildId) { mutableStateOf(emptySet<String>()) }
    var showGuildMenu by remember(guildId) { mutableStateOf(false) }
    var showCreateChannel by remember(guildId) { mutableStateOf(false) }
    // Per-category '+' pre-scopes creation to that category (iOS createInCategory).
    var createInCategory by remember(guildId) { mutableStateOf<String?>(null) }
    var channelMenuFor by remember(guildId) { mutableStateOf<Channel?>(null) }
    var editChannelFor by remember(guildId) { mutableStateOf<Channel?>(null) }
    // Load the member roster once per guild so non-owner managers' permission
    // bits resolve for the settings/channel-management gates (owner short-circuits).
    LaunchedEffect(guildId) { if (state.membersByGuild[guildId] == null) store.refreshMembers(guildId) }
    val canManageChannels = state.canManageChannels(guildId)
    val canManageGuild = state.canManageGuild(guildId)
    val isOwner = state.isGuildOwner(guildId)

    val banner = Config.absoluteUrl(bannerUrl)
    Column(Modifier.fillMaxSize()) {
        if (banner != null) {
            // Full-bleed under the status bar (like iOS), cropped to fill so the
            // image has no letterbox gaps on the top/bottom.
            Box(Modifier.fillMaxWidth().aspectRatio(1.6f).background(p.bg3)) {
                AsyncImage(model = banner, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
        }
        Row(
            Modifier.fillMaxWidth()
                .then(if (banner == null) Modifier.statusBarsPadding() else Modifier)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Name takes the available width (fill = true) so it isn't cut off at
            // ~half; only the trailing icons are fixed.
            Row(
                Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).clickable { showGuildMenu = true }.padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    guildName,
                    color = ZkInk.ink1,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Icon(Icons.Filled.KeyboardArrowDown, null, tint = ZkInk.ink2, modifier = Modifier.padding(start = 2.dp).size(14.dp))
            }
            Spacer(Modifier.width(8.dp))
            // '+' is manager-only and creates a channel (iOS MainView.swift:981-995);
            // invites live in the guild menu, not the header.
            if (canManageChannels) {
                Icon(Icons.Filled.Add, "Create channel", tint = ZkInk.ink2, modifier = Modifier.clip(CircleShape).clickable { createInCategory = null; showCreateChannel = true }.padding(2.dp).size(20.dp))
                Spacer(Modifier.width(10.dp))
            }
            Icon(Icons.Filled.People, "Members", tint = ZkInk.ink2, modifier = Modifier.clip(CircleShape).clickable { showMembers = true }.padding(2.dp).size(18.dp))
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.lineSoft))

        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            if (channels.isEmpty()) {
                // iOS centres the empty copy in the pane (MainView.swift:1011-1020).
                Text(
                    "No channels", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
                )
            }
            rowsFor(null).forEach { ChannelRow(store, state, it) { channelMenuFor = it } }
            categories.forEach { cat ->
                val isCollapsed = collapsedCats.contains(cat.id)
                CategoryHeader(
                    name = cat.name ?: "",
                    collapsed = isCollapsed,
                    canManage = canManageChannels,
                    onToggle = { collapsedCats = if (isCollapsed) collapsedCats - cat.id else collapsedCats + cat.id },
                    onEditCategory = { editChannelFor = cat },
                    onAddChannel = { createInCategory = cat.id; showCreateChannel = true },
                )
                if (!isCollapsed) rowsFor(cat.id).forEach { ChannelRow(store, state, it) { channelMenuFor = it } }
            }
        }
    }

    if (showMembers) MembersSheet(store, state, guildId, onDismiss = { showMembers = false })
    if (showInvite) InviteSheet(store, state, guildId, onDismiss = { showInvite = false })
    if (showGuildMenu) {
        GuildMenuSheet(
            store, state, guildId, isOwner, canManageChannels, canManageGuild,
            onCreateChannel = { showGuildMenu = false; createInCategory = null; showCreateChannel = true },
            onServerSettings = { showGuildMenu = false; store.openGuildSettings(guildId) },
            onInvite = { showGuildMenu = false; showInvite = true },
            onDismiss = { showGuildMenu = false },
        )
    }
    if (showCreateChannel) CreateChannelSheet(store, state, guildId, initialParentId = createInCategory, onDismiss = { showCreateChannel = false; createInCategory = null })
    channelMenuFor?.let { ch ->
        ChannelMenuSheet(store, state, ch, guildId, canManageChannels, onEdit = { editChannelFor = ch }, onPermissions = { store.openChannelPerms(ch.id) }, onDismiss = { channelMenuFor = null })
    }
    editChannelFor?.let { ch ->
        EditChannelSheet(store, state, ch, guildId, onDismiss = { editChannelFor = null })
    }
}

@Composable
private fun CategoryHeader(
    name: String,
    collapsed: Boolean,
    canManage: Boolean = false,
    onToggle: () -> Unit,
    onEditCategory: () -> Unit = {},
    onAddChannel: () -> Unit = {},
) {
    Row(
        // iOS: the list insets 8 and categoryHeader adds .leading 12 / .trailing 4
        // (MainView.swift:1032, :1137-1138) → 20 / 12 absolute. Android has no
        // list-level inset, so the absolute values go here. Category headers sit
        // 4pt RIGHT of channel rows (16) on iOS — that offset is deliberate.
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(start = 20.dp, end = 12.dp, top = 12.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (collapsed) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Filled.KeyboardArrowDown,
            null, tint = ZkInk.ink3, modifier = Modifier.size(14.dp),
        )
        Text(
            name.uppercase(),
            color = ZkInk.ink3,
            fontFamily = ZkMono,
            fontSize = 10.5.sp,
            letterSpacing = 1.5.sp,
            maxLines = 1,
            modifier = Modifier.padding(start = 4.dp),
        )
        // Managers get an edit-category gear + create-channel plus (mirrors iOS categoryHeader).
        if (canManage) {
            Spacer(Modifier.weight(1f))
            Icon(
                Icons.Filled.Settings, "Edit category", tint = ZkInk.ink3,
                modifier = Modifier.clip(CircleShape).clickable(onClick = onEditCategory).padding(2.dp).size(15.dp),
            )
            Spacer(Modifier.width(4.dp))
            Icon(
                Icons.Filled.Add, "Create channel", tint = ZkInk.ink3,
                modifier = Modifier.clip(CircleShape).clickable(onClick = onAddChannel).padding(2.dp).size(16.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChannelRow(store: AppStore, state: AppState, ch: Channel, onLongPress: (Channel) -> Unit = {}) {
    val ctx = LocalContext.current
    val p = ZkTheme.palette
    val unread = isChannelUnread(state, ch)
    val mentions = state.readStates[ch.id]?.mentionCount ?: 0
    val icon = channelIcon(ch)
    val onClick: () -> Unit = when {
        ch.linkUrl != null -> { { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ch.linkUrl))) } } }
        ch.isVoice -> { { store.requestVoice(ch.id) } }
        else -> { { store.selectChannel(ch.id) } }
    }
    val voiceMembers = if (ch.isVoice) state.voiceStates.values.filter { it.channelId == ch.id } else emptyList()
    // Connected voice channel reads as an ACTIVE row (iOS .rowActive — accent
    // tint while you're in it; web row-active).
    val connectedHere = ch.isVoice && (state.activeVoiceChannelId == ch.id || state.activeStageChannelId == ch.id)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                // iOS insets the list 8pt and pads the row another 8 INSIDE the
                // .rowActive fill (MainView.swift:1032, :1295), so the active
                // highlight is a rounded inset pill — not a full-bleed band.
                .padding(horizontal = 8.dp)
                .clip(RoundedCornerShape(8.dp))
                .then(if (connectedHere) Modifier.background(p.accent.copy(alpha = 0.12f)) else Modifier)
                .combinedClickable(onClick = onClick, onLongClick = { onLongPress(ch) })
                .padding(horizontal = 8.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                Icon(icon, null, tint = p.accent, modifier = Modifier.size(16.dp))
                // Restricted (locked) channels get a small lock overlay, any type.
                if (ch.restricted == true) {
                    Icon(
                        Icons.Filled.Lock, null, tint = ZkInk.ink3,
                        modifier = Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-3).dp).size(9.dp),
                    )
                }
            }
            Text(
                ch.name ?: "channel",
                color = if (unread || connectedHere) ZkInk.ink1 else ZkInk.ink2,
                fontFamily = ZkSans,
                fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 8.dp).weight(1f),
            )
            when {
                mentions > 0 -> MentionCapsule(mentions)
                ch.isVoice && voiceMembers.isNotEmpty() -> Text("${voiceMembers.size}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                unread -> Box(Modifier.size(6.dp).clip(CircleShape).background(ZkInk.ink1))
            }
        }
        // Joined voice participants, indented under the channel. Quiet grey
        // treatment: 18pt avatar, ink3 name, small ink4 mute/deafen glyphs
        // (iOS MainView.swift:1304-1327 — NOT the red error tint).
        voiceMembers.forEach { vs ->
            val u = voiceUser(state, vs.userId)
            Row(
                // iOS nests the participant VStack at .leading 24 inside the
                // list's 8 (MainView.swift:1211-1219) → 32 absolute. The old 36
                // was derived from the pre-parity 12dp row origin, not from iOS.
                Modifier.fillMaxWidth().padding(start = 32.dp, end = 12.dp, top = 1.dp, bottom = 1.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(url = u?.avatarUrl, name = u?.bestName ?: "?", size = 18.dp, toneId = vs.userId)
                Text(u?.bestName ?: "Unknown", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp).weight(1f, fill = false))
                if (vs.selfDeaf == true) {
                    Icon(Icons.Filled.VolumeOff, "Deafened", tint = ZkInk.ink4, modifier = Modifier.padding(start = 6.dp).size(10.dp))
                } else if (vs.selfMute == true) {
                    Icon(Icons.Filled.MicOff, "Muted", tint = ZkInk.ink4, modifier = Modifier.padding(start = 6.dp).size(10.dp))
                }
            }
        }
    }
}

private fun voiceUser(state: AppState, userId: String): com.zekktris.data.model.PublicUser? =
    if (userId == state.me?.id) state.me?.let { com.zekktris.data.model.PublicUser(id = it.id, username = it.username, displayName = it.displayName, avatarUrl = it.avatarUrl) }
    else state.membersByGuild.values.asSequence().flatten().firstOrNull { it.userId == userId }?.user

@Composable
private fun MentionCapsule(count: Int) {
    Text(
        if (count > 99) "99+" else "$count",
        color = androidx.compose.ui.graphics.Color.White,
        fontFamily = ZkSans,
        fontWeight = FontWeight.Bold,
        fontSize = 10.sp,
        modifier = Modifier
            .clip(CircleShape)
            .background(ZkStatus.danger)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

private fun channelIcon(ch: Channel): ImageVector = when {
    ch.type.contains("stage") -> Icons.Filled.Podcasts
    ch.type.contains("voice") -> Icons.Filled.VolumeUp
    ch.type.contains("forum") -> Icons.AutoMirrored.Filled.ListAlt
    ch.linkUrl != null || ch.type.contains("link") -> Icons.Filled.OpenInNew
    else -> Icons.Filled.Tag
}

// ── DM list pane ─────────────────────────────────────────────────────────────

@Composable
private fun DmListPane(store: AppStore, state: AppState, onOverlay: (DmOverlay) -> Unit) {
    Column(
        Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
    ) {
        QuickRow(Icons.Filled.People, "Friends") { onOverlay(DmOverlay.Friends) }
        QuickRow(Icons.Filled.CalendarMonth, "Your events") { onOverlay(DmOverlay.Events) }
        QuickRow(Icons.Filled.BookmarkBorder, "Saved messages") { onOverlay(DmOverlay.Saved) }
        QuickRow(Icons.Filled.Schedule, "Scheduled messages") { onOverlay(DmOverlay.Scheduled) }
        QuickRow(Icons.Filled.Search, "Search messages") { onOverlay(DmOverlay.Search) }

        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("DIRECT MESSAGES", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.5.sp)
            Spacer(Modifier.weight(1f))
            Icon(
                Icons.Filled.Add, "Add friend", tint = ZkInk.ink3,
                modifier = Modifier.clip(CircleShape).clickable { onOverlay(DmOverlay.Friends) }.size(18.dp),
            )
        }

        if (state.dms.isEmpty()) {
            // iOS: "No direct messages yet" — no trailing period, 13pt, leading
            // at the list's 8pt inset (MainView.swift:1425-1430).
            Text(
                "No direct messages yet", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 12.dp).padding(top = 8.dp),
            )
        }
        state.dms.forEach { dm -> DmRow(store, state, dm) }
    }
}

@Composable
private fun QuickRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = ZkInk.ink3, modifier = Modifier.size(18.dp))
        Text(label, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun DmRow(store: AppStore, state: AppState, dm: Channel) {
    val p = ZkTheme.palette
    val other = dm.recipients?.firstOrNull()
    // Personal DM nickname wins over the peer's own display name (viewer-private).
    val name = store.dmNickname(other?.id) ?: other?.bestName ?: dm.name ?: "Direct Message"
    val presence = state.presenceOf(other?.id)
    val unread = isChannelUnread(state, dm)
    Row(
        Modifier.fillMaxWidth().clickable { store.selectChannel(dm.id) }.padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Avatar(url = other?.avatarUrl, name = name, size = 36.dp, decoration = other?.avatarDecoration, toneId = other?.id)
            // 36dp avatar → iOS's max(10, 36*0.3) ≈ 11.
            PresenceDot(presence, Modifier.align(Alignment.BottomEnd), ringColor = p.bg2, size = 11.dp)
            // E2EE indicator: accent lock on the avatar's top-right (mirrors iOS DMRow).
            if (dm.isE2EE) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 3.dp, y = (-3).dp)
                        .size(13.dp)
                        .clip(CircleShape)
                        .background(p.bg2)
                        .border(1.dp, p.accent.copy(alpha = 0.45f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Lock, null, tint = p.accent, modifier = Modifier.size(8.dp))
                }
            }
        }
        // Clan tag pill (self-typed) + name. Name wraps to content (fill = false)
        // so the streak pill sits right beside it; staff names shimmer.
        val hasTag = !other?.tagLabel.isNullOrBlank()
        if (hasTag) NameTag(other?.tagLabel, other?.tagColor, Modifier.padding(start = 10.dp))
        StaffName(
            user = other,
            text = name,
            baseColor = if (unread) ZkInk.ink1 else ZkInk.ink2,
            fontSize = 15.sp,
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            modifier = Modifier.padding(start = if (hasTag) 6.dp else 10.dp).weight(1f, fill = false),
        )
        (dm.streak ?: 0).takeIf { it > 0 }?.let { Spacer(Modifier.width(6.dp)); StreakPill(it) }
        Spacer(Modifier.weight(1f))
        val mentions = state.readStates[dm.id]?.mentionCount ?: 0
        when {
            mentions > 0 -> MentionCapsule(mentions)
            unread -> Box(Modifier.size(7.dp).clip(CircleShape).background(ZkInk.ink1))
        }
    }
}

// ── Mentions pane ────────────────────────────────────────────────────────────

@Composable
private fun MentionsPane(store: AppStore, state: AppState) {
    androidx.compose.runtime.LaunchedEffect(Unit) { store.loadMentions() }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Mentions",
                color = ZkInk.ink1,
                fontFamily = ZkSans,
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f),
            )
            if (state.mentions.isNotEmpty()) {
                Text(
                    "Clear",
                    color = ZkTheme.palette.accent,
                    fontFamily = ZkSans,
                    fontSize = 13.sp,
                    modifier = Modifier.clickable { store.clearMentions() },
                )
            }
        }
        if (state.mentions.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Filled.AlternateEmail, null, tint = ZkInk.ink3, modifier = Modifier.size(48.dp))
                    Text("No mentions", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(top = 8.dp))
                }
            }
            return
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            state.mentions.forEach { m ->
                // A system_join "welcome" mention is attributed to the SERVER
                // (guild name + icon), not the newcomer (iOS MainView.swift:4135-4146).
                val guild = m.guildId?.let { gid -> state.guilds.firstOrNull { it.id == gid } }
                val isJoin = m.type == "system_join"
                val rowName = if (isJoin) guild?.name ?: "Server" else m.author?.bestName ?: "Unknown"
                val rowAvatar = if (isJoin) guild?.iconUrl else m.author?.avatarUrl
                val rowToneId = if (isJoin) guild?.id else m.author?.id
                Row(
                    Modifier
                        .fillMaxWidth()
                        // Jump to the mentioned message (iOS openMention).
                        .clickable { store.selectChannel(m.channelId, jumpToMessageId = m.id) }
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Avatar(url = rowAvatar, name = rowName, size = 32.dp, toneId = rowToneId)
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(rowName, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.weight(1f))
                            Text(com.zekktris.ui.components.shortTime(m.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                        }
                        // Source line: accent @ glyph + "#channel · <server>" (mirrors iOS MentionRow).
                        val serverName = m.guildId?.let { gid -> state.guilds.firstOrNull { it.id == gid }?.name }
                        val source = buildString {
                            m.channelName?.let { append("#").append(it) }
                            if (!serverName.isNullOrBlank()) {
                                if (isNotEmpty()) append(" · ")
                                append(serverName)
                            }
                        }
                        if (source.isNotEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 1.dp)) {
                                Icon(Icons.Filled.AlternateEmail, null, tint = ZkTheme.palette.accent, modifier = Modifier.size(11.dp))
                                Text(
                                    source, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(start = 3.dp),
                                )
                            }
                        }
                        Text(
                            m.content ?: "",
                            color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp,
                            maxLines = 2, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    Icon(
                        Icons.Filled.Close, "Dismiss", tint = ZkInk.ink4,
                        modifier = Modifier.clip(CircleShape).clickable { store.dismissMention(m.id) }.padding(4.dp).size(14.dp),
                    )
                }
            }
        }
    }
}

// ── Shared ───────────────────────────────────────────────────────────────────

/**
 * iOS `isChannelUnread`: unread only when the channel's newest message is
 * strictly NEWER than the acked one. A plain `!=` also fires when the newest
 * message is DELETED — lastMessageId then moves backward to an id we already
 * acked, pinning a dot that opening the channel can never clear.
 */
private fun isChannelUnread(state: AppState, ch: Channel): Boolean {
    val last = ch.lastMessageId?.takeIf { it.isNotEmpty() } ?: return false
    if (ch.id == state.selectedChannelId) return false
    val read = state.readStates[ch.id]?.lastMessageId?.takeIf { it.isNotEmpty() } ?: return true
    return snowflakeGreater(last, read)
}

/** Snowflake ids vary in length, so a raw string compare mis-ranks them. */
private fun snowflakeGreater(a: String, b: String): Boolean {
    val ai = a.toULongOrNull()
    val bi = b.toULongOrNull()
    if (ai != null && bi != null) return ai > bi
    if (a.length != b.length) return a.length > b.length
    return a > b
}

@Composable
private fun PresenceDot(
    status: String?,
    modifier: Modifier = Modifier,
    ringColor: Color? = null,
    // iOS scales the dot with the avatar (Components.swift:425 — max(10, size*0.3)),
    // so callers on smaller avatars pass a smaller size.
    size: androidx.compose.ui.unit.Dp = 13.dp,
) {
    val p = ZkTheme.palette
    // Always render — offline/invisible/unknown fall through to the grey dot
    // (iOS PresenceDot/presenceColor; web bg-ink-3).
    val color = when (status) {
        "online" -> ZkStatus.online
        "idle" -> ZkStatus.idle
        "dnd" -> ZkStatus.dnd
        else -> ZkStatus.offline
    }
    Box(
        modifier.size(size).clip(CircleShape).background(ringColor ?: p.bg1),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(size * 0.7f).clip(CircleShape).background(color))
    }
}
