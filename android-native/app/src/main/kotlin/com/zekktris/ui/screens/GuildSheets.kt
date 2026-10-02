package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Spacer
import com.zekktris.ui.components.ScreenScaffold
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.GuildMember
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.NameTag
import com.zekktris.ui.components.StaffName
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

/** iOS presenceColor (Components.swift:606-613): offline / invisible / unknown
 *  all fall through to the grey offline dot — the dot is never omitted. */
private fun presenceColor(status: String?): Color = when (status) {
    "online" -> ZkStatus.online
    "idle" -> ZkStatus.idle
    "dnd" -> ZkStatus.dnd
    else -> ZkStatus.offline
}

/** A member-list section: a hoisted role (with its color) or the fallback
 *  Online / Offline buckets. */
private data class MemberSection(val label: String, val color: Color?, val members: List<GuildMember>)

/** RGB role color (0 = none) → an opaque Compose color, or null. Clamps to the
 *  valid [0, 0xFFFFFF] range like iOS (max(0, min(0xFFFFFF, rgb))) so a
 *  malformed/negative int can't bleed into the alpha channel. */
private fun roleColorOf(rgb: Int): Color? =
    if (rgb == 0) null else Color(0xFF000000.toInt() or rgb.coerceIn(0, 0xFFFFFF))

/** Guild roster — Discord-style hoisted-role sections (one per hoisted role,
 *  members under their highest hoisted role), then Online, then Offline.
 *  Mirrors iOS MemberListView.computeSections byte-for-byte. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MembersSheet(store: AppStore, state: AppState, guildId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    LaunchedEffect(guildId) { store.refreshMembers(guildId); store.refreshRoles(guildId) }
    val members = state.membersByGuild[guildId] ?: emptyList()
    val roles = state.rolesByGuild[guildId] ?: emptyList()

    fun statusOf(m: GuildMember): String = state.presenceOf(m.userId)

    val sections = remember(members, roles, state.presence) {
        val hoisted = roles.filter { it.hoist }.sortedBy { it.position }
        val roleIdx = hoisted.withIndex().associate { (i, r) -> r.id to i }
        val buckets = Array(hoisted.size) { mutableListOf<GuildMember>() }
        val online = mutableListOf<GuildMember>()
        val offline = mutableListOf<GuildMember>()
        for (m in members) {
            val st = statusOf(m)
            if (st == "offline" || st == "invisible") { offline += m; continue }
            var best = -1
            for (rid in m.roleIds) {
                val idx = roleIdx[rid] ?: continue
                if (best == -1 || idx < best) best = idx
            }
            if (best == -1) online += m else buckets[best] += m
        }
        val byName = compareBy<GuildMember> { it.user.bestName.lowercase() }
        buildList {
            hoisted.forEachIndexed { i, r ->
                if (buckets[i].isNotEmpty()) add(MemberSection(r.name.uppercase(), roleColorOf(r.color), buckets[i].sortedWith(byName)))
            }
            if (online.isNotEmpty()) add(MemberSection("ONLINE", null, online.sortedWith(byName)))
            if (offline.isNotEmpty()) add(MemberSection("OFFLINE", null, offline.sortedWith(byName)))
        }
    }

    // FULL SCREEN with a back button, not a draggable sheet. A roster is a
    // destination you read and scroll, not a quick action: the sheet capped it at
    // 560dp, so on a busy server most of the list sat below the fold behind a
    // drag handle, and the scroll gesture fought the sheet's own dismiss drag.
    // ScreenScaffold is the same full-screen idiom the rest of the app uses, so
    // the back chevron matches every other page.
    BackHandler(onBack = onDismiss)
    ScreenScaffold(title = "Members — ${members.size}", onBack = onDismiss) {
        if (members.isEmpty()) {
            Text("Loading members…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
        } else {
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
                sections.forEach { sec ->
                    MemberSectionLabel("${sec.label} — ${sec.members.size}", sec.color)
                    sec.members.forEach { m ->
                        MemberRow(
                            m, statusOf(m),
                            nameColor = store.memberColorRGB(guildId, m.userId)?.let { roleColorOf(it) },
                        ) { store.openProfile(m.user) }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun MemberSectionLabel(text: String, color: Color? = null) {
    Text(
        text, color = color ?: ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
        modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp),
    )
}

@Composable
private fun MemberRow(m: GuildMember, status: String, nameColor: Color? = null, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val u = m.user
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            Avatar(url = u.avatarUrl, name = u.bestName, size = 32.dp, decoration = u.avatarDecoration, toneId = u.id)
            val presence = presenceColor(status)
            Box(
                Modifier.align(Alignment.BottomEnd).size(11.dp).clip(CircleShape).background(p.bg2),
                contentAlignment = Alignment.Center,
            ) { Box(Modifier.size(8.dp).clip(CircleShape).background(presence)) }
        }
        val hasTag = !u.tagLabel.isNullOrBlank()
        if (hasTag) NameTag(u.tagLabel, u.tagColor, Modifier.padding(start = 10.dp))
        // Role color on the name (iOS store.memberColor ?? ink1); the staff
        // shimmer still overrides inside StaffName.
        StaffName(
            user = u, text = u.bestName, baseColor = nameColor ?: ZkInk.ink1, fontSize = 15.sp, fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(start = if (hasTag) 6.dp else 10.dp).weight(1f, fill = false),
        )
        if (u.isBot == true) {
            Text(
                "BOT", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp,
                modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(3.dp)).background(p.accent.copy(alpha = 0.2f)).padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
    }
}

private val INVITE_TTLS: List<Pair<String, Int?>> = listOf(
    "30 min" to 1800, "1 hour" to 3600, "6 hours" to 21600,
    "1 day" to 86400, "7 days" to 604800, "Never" to null,
)

/** Create + share an invite for a text channel in this guild. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteSheet(store: AppStore, state: AppState, guildId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val textChannels = (state.channelsByGuild[guildId] ?: emptyList()).filter { it.isText }

    var channelId by remember { mutableStateOf(textChannels.firstOrNull()?.id) }
    var ttlIndex by remember { mutableStateOf(2) } // default 6 hours
    var maxUses by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var createdCode by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("INVITE PEOPLE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)

            val code = createdCode
            if (code == null) {
                // Channel picker.
                if (textChannels.isEmpty()) {
                    Text("This server has no text channels to invite to.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                } else {
                    Text("CHANNEL", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        textChannels.forEach { ch ->
                            val sel = ch.id == channelId
                            Text(
                                "#${ch.name ?: "channel"}",
                                color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                                modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (sel) p.accent else p.bg3).clickable { channelId = ch.id }.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
                // Expiry picker.
                Text("EXPIRE AFTER", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    INVITE_TTLS.forEachIndexed { i, (label, _) ->
                        val sel = i == ttlIndex
                        Text(
                            label,
                            color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (sel) p.accent else p.bg3).clickable { ttlIndex = i }.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
                // Max uses.
                Text("MAX USES (BLANK = UNLIMITED)", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
                FilledTextField(maxUses, { s -> maxUses = s.filter { it.isDigit() }.take(4) }, "Unlimited", Modifier.fillMaxWidth())

                error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }

                val canCreate = channelId != null && !busy
                Text(
                    if (busy) "Creating…" else "Create invite",
                    color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (canCreate) p.accent else p.bg3)
                        .let { if (canCreate) it.clickable {
                            busy = true; error = null
                            scope.launch {
                                val inv = store.createInvite(channelId!!, maxUses.toIntOrNull(), INVITE_TTLS[ttlIndex].second)
                                busy = false
                                if (inv != null) createdCode = inv.code else error = "Couldn't create an invite. You may not have permission."
                            }
                        } else it }.padding(vertical = 13.dp),
                )
            } else {
                // Result: code + copy actions.
                val link = "${com.zekktris.data.Config.CDN_BASE_URL}/invite/$code"
                Text("INVITE CODE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
                Text(code, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    InviteCopyButton("Copy code", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(code)) }
                    InviteCopyButton("Copy link", Modifier.weight(1f)) { clipboard.setText(AnnotatedString(link)) }
                }
                Text(link, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                // QR of the invite link on a white card + "Scan to join"
                // (iOS MainView.swift:6784-6795).
                Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier.clip(RoundedCornerShape(12.dp)).background(Color.White).padding(10.dp),
                    ) { com.zekktris.ui.components.QrCode(link, size = 180.dp) }
                    Text("Scan to join", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
                }
                Text(
                    "Create another",
                    color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                    modifier = Modifier.clickable { createdCode = null }.padding(vertical = 4.dp),
                )
            }
        }
    }
}

/** Guild header menu — mute/leave/mark-read + (manager) create channel +
 *  server settings. `canManageChannels`/`canManageGuild` gate the manager rows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GuildMenuSheet(
    store: AppStore,
    state: AppState,
    guildId: String,
    isOwner: Boolean,
    canManageChannels: Boolean,
    canManageGuild: Boolean,
    onCreateChannel: () -> Unit,
    onServerSettings: () -> Unit,
    onInvite: () -> Unit = {},
    onReorderChannels: () -> Unit = {},
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val muted = store.isGuildMuted(guildId)
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            // Invites live here (iOS GuildInfoCard placement), not the header '+'.
            GuildMenuRow("Invite People") { onDismiss(); onInvite() }
            if (canManageGuild) GuildMenuRow("Server Settings") { onDismiss(); onServerSettings() }
            if (canManageChannels) GuildMenuRow("Create Channel") { onDismiss(); onCreateChannel() }
            if (canManageChannels) GuildMenuRow("Reorder Channels") { onDismiss(); onReorderChannels() }
            GuildMenuRow("Mark All as Read") { store.markGuildRead(guildId); onDismiss() }
            GuildMenuRow(if (muted) "Unmute Server" else "Mute Server") { store.setGuildMuted(guildId, !muted); onDismiss() }
            if (!isOwner) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.line).padding(vertical = 4.dp))
                GuildMenuRow("Leave Server", danger = true) { store.leaveGuild(guildId); onDismiss() }
            }
        }
    }
}

@Composable
private fun GuildMenuRow(label: String, danger: Boolean = false, onClick: () -> Unit) {
    Text(
        label,
        color = if (danger) ZkStatus.dangerSoft else ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp),
    )
}

private val CHANNEL_TYPES = listOf(
    "guild_text" to "Text", "guild_voice" to "Voice", "guild_stage" to "Stage",
    "guild_forum" to "Forum", "guild_link" to "Link", "guild_category" to "Category",
)

/** Create a channel/category (MANAGE_CHANNELS). All iOS types; link needs a
 *  URL, non-category types can drop into a category. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateChannelSheet(store: AppStore, state: AppState, guildId: String, initialParentId: String? = null, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var name by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("guild_text") }
    var linkUrl by remember { mutableStateOf("") }
    // Pre-scoped when opened from a category's '+' (iOS createInCategory).
    var parentId by remember { mutableStateOf(initialParentId) }
    val categories = (state.channelsByGuild[guildId] ?: emptyList()).filter { it.isCategory }.sortedBy { it.position ?: 0 }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("CREATE CHANNEL", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CHANNEL_TYPES.forEach { (value, label) ->
                    val sel = type == value
                    Text(
                        label, color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (sel) p.accent else p.bg3).clickable { type = value }.padding(horizontal = 14.dp, vertical = 7.dp),
                    )
                }
            }
            FilledTextField(name, { name = it.take(80) }, if (type == "guild_category") "Category name" else "channel-name", Modifier.fillMaxWidth())
            if (type == "guild_link") FilledTextField(linkUrl, { linkUrl = it.take(500) }, "https://…", Modifier.fillMaxWidth())
            if (type != "guild_category" && categories.isNotEmpty()) {
                Text("CATEGORY", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val noneSel = parentId == null
                    Text("None", color = if (noneSel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (noneSel) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (noneSel) p.accent else p.bg3).clickable { parentId = null }.padding(horizontal = 12.dp, vertical = 6.dp))
                    categories.forEach { cat ->
                        val sel = parentId == cat.id
                        Text(cat.name ?: "category", color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (sel) p.accent else p.bg3).clickable { parentId = cat.id }.padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                }
            }
            val ok = name.isNotBlank() && (type != "guild_link" || linkUrl.isNotBlank())
            Text(
                if (type == "guild_category") "Create category" else "Create channel", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (ok) p.accent else p.bg3)
                    .let { if (ok) it.clickable {
                        store.createChannel(guildId, type, name, parentId = if (type == "guild_category") null else parentId, linkUrl = if (type == "guild_link") linkUrl else null) {}
                        onDismiss()
                    } else it }.padding(vertical = 13.dp),
            )
        }
    }
}

private val CHANNEL_LEVELS = listOf("all" to "All messages", "mentions" to "Only @mentions", "nothing" to "Nothing")

/** Channel long-press: notification level + (manager) edit / delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelMenuSheet(store: AppStore, state: AppState, channel: com.zekktris.data.model.Channel, guildId: String, canManageChannels: Boolean, onEdit: () -> Unit, onPermissions: () -> Unit, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val current = store.channelLevel(channel.id, guildId)
    var confirmDelete by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text("#${channel.name ?: "channel"}", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 4.dp))
            Text("NOTIFICATIONS", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp, modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 4.dp))
            CHANNEL_LEVELS.forEach { (value, label) ->
                Row(
                    Modifier.fillMaxWidth().clickable { store.setChannelLevel(channel.id, value); onDismiss() }.padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    if (current == value) Text("✓", color = p.accent, fontSize = 16.sp)
                }
            }
            if (canManageChannels) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
                Text(
                    if (channel.isCategory) "Edit Category" else "Edit Channel", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                    modifier = Modifier.fillMaxWidth().clickable { onDismiss(); onEdit() }.padding(horizontal = 20.dp, vertical = 14.dp),
                )
                if (!channel.isCategory) {
                    Text(
                        "Permissions", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                        modifier = Modifier.fillMaxWidth().clickable { onDismiss(); onPermissions() }.padding(horizontal = 20.dp, vertical = 14.dp),
                    )
                }
                Text(
                    "Delete Channel", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 15.sp,
                    modifier = Modifier.fillMaxWidth().clickable { confirmDelete = true }.padding(horizontal = 20.dp, vertical = 14.dp),
                )
            }
        }
    }
    if (confirmDelete) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete #${channel.name ?: "channel"}?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("This can't be undone.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = { androidx.compose.material3.TextButton(onClick = { store.deleteChannel(channel.id, guildId); confirmDelete = false; onDismiss() }) { Text("Delete", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { confirmDelete = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
            containerColor = p.bg2,
        )
    }
}

@Composable
private fun InviteCopyButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        modifier = modifier.clip(RoundedCornerShape(10.dp)).background(p.accent.copy(alpha = 0.12f)).clickable(onClick = onClick).padding(vertical = 11.dp),
    )
}
