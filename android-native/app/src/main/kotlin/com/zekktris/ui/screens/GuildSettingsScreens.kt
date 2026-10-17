package com.zekktris.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.Channel
import com.zekktris.data.model.Invite
import com.zekktris.data.model.Permissions
import com.zekktris.ui.components.GuildIcon
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// ── Client-side permission gates (server still enforces). Mirrors iOS
//    AppStore.memberPermissions / canManageGuild etc. Owner + any ADMINISTRATOR
//    role expand to all bits; otherwise OR of @everyone + assigned roles. ──────

fun AppState.memberGuildPerms(guildId: String, userId: String): Long {
    val guild = guilds.firstOrNull { it.id == guildId } ?: return 0L
    if (guild.ownerId == userId) return Permissions.allBits
    val roleIds = (membersByGuild[guildId]?.firstOrNull { it.userId == userId }?.roleIds ?: emptyList()).toSet()
    var acc = 0L
    for (r in (rolesByGuild[guildId] ?: emptyList())) {
        if (r.id == guildId || roleIds.contains(r.id)) acc = acc or Permissions.parse(r.permissions)
    }
    if (Permissions.has(acc, Permissions.ADMINISTRATOR)) return Permissions.allBits
    return acc
}
fun AppState.myGuildPerms(guildId: String): Long = me?.id?.let { memberGuildPerms(guildId, it) } ?: 0L
fun AppState.isGuildOwner(guildId: String): Boolean {
    val g = guilds.firstOrNull { it.id == guildId } ?: return false
    return g.ownerId != null && g.ownerId == me?.id
}
fun AppState.canManageGuild(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_GUILD)
fun AppState.canManageRoles(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_ROLES)
fun AppState.canManageChannels(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_CHANNELS)
fun AppState.canManageInvites(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_INVITES)
fun AppState.canKickMembers(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.KICK_MEMBERS)
fun AppState.canBanMembers(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.BAN_MEMBERS)
fun AppState.canModerateMembers(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MODERATE_MEMBERS)
fun AppState.canViewAuditLog(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.VIEW_AUDIT_LOG)
fun AppState.canManageEmojis(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_EMOJIS)
fun AppState.canManageMessages(guildId: String): Boolean = isGuildOwner(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_MESSAGES)
/** Reports queue — any moderator-ish permission opens it (server re-checks). */
fun AppState.canSeeReports(guildId: String): Boolean = canKickMembers(guildId) || canBanMembers(guildId) || Permissions.has(myGuildPerms(guildId), Permissions.MANAGE_MESSAGES)

/** The single source of truth for a user's online status. The live `presence`
 *  map (seeded from REST snapshots on load, then kept current by PRESENCE_UPDATE
 *  gateway events) is authoritative — every surface must resolve through here so
 *  two views can't disagree (one reading a stale embedded `user.status`, another
 *  the fresh map, and showing the same person online AND offline at once). */
fun AppState.presenceOf(userId: String?): String {
    if (userId == null) return "offline"
    // Ourselves: on a server with multi-device presence (the self user carries
    // chosenStatus) our own PRESENCE_UPDATEs keep `presence` at the EFFECTIVE
    // status: online while any of our devices is in use, else away; before the
    // first one, the self user's `effectiveStatus` (`me.status` is the pick).
    // Chosen Invisible shows Invisible. On an older server the status is the
    // choice. Either way a stale pre-connect "offline" (getMe runs BEFORE the
    // gateway identifies) falls back to the choice — we are demonstrably in
    // the app. Mirrors iOS status(for:) / DevicePresence.selfStatus.
    val self = me
    if (self != null && userId == self.id) {
        val chosen = com.zekktris.data.DevicePresence.pickerStatus(self.chosenStatus, self.status)
        return com.zekktris.data.DevicePresence.selfStatus(
            chosen,
            live = presence[userId],
            effective = self.effectiveStatus ?: self.status,
            serverDerives = self.chosenStatus != null,
        )
    }
    return presence[userId] ?: "offline"
}

/** Read a picked image off-main → (bytes, mime, filename). Null on failure. */
internal fun readGuildImage(ctx: android.content.Context, uri: Uri): Triple<ByteArray, String, String>? = runCatching {
    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
    if (bytes.isEmpty() || bytes.size > 12 * 1024 * 1024) return@runCatching null
    val mime = ctx.contentResolver.getType(uri) ?: "image/jpeg"
    val ext = when {
        mime.contains("png") -> "png"; mime.contains("gif") -> "gif"; mime.contains("webp") -> "webp"; else -> "jpg"
    }
    Triple(bytes, mime, "upload.$ext")
}.getOrNull()

private enum class GuildSub { Roles, GetRoles, Invites, Reports, AuditLog, ReactionRoles, Emoji }

/** Server Settings — overview edit (name/description/rules), icon+banner upload,
 *  discovery, management nav (Roles / Members / Get Roles / Invites), danger zone.
 *  Mirrors iOS GuildSettingsView; every section is gated + the server re-checks. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GuildSettingsScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val guild = state.guilds.firstOrNull { it.id == guildId }
    if (guild == null) { onBack(); return }
    // Load members so my own permission bits resolve for the nav gates.
    LaunchedEffect(guildId) { store.refreshMembers(guildId); store.refreshRoles(guildId) }

    var sub by remember { mutableStateOf<GuildSub?>(null) }
    when (sub) {
        GuildSub.Roles -> { RolesListScreen(store, state, guildId) { sub = null }; return }
        GuildSub.GetRoles -> { BrowseRolesScreen(store, state, guildId) { sub = null }; return }
        GuildSub.Invites -> { ManageInvitesScreen(store, state, guildId) { sub = null }; return }
        GuildSub.Reports -> { ReportsScreen(store, state, guildId) { sub = null }; return }
        GuildSub.AuditLog -> { AuditLogScreen(store, state, guildId) { sub = null }; return }
        GuildSub.ReactionRoles -> { ReactionRolesScreen(store, state, guildId) { sub = null }; return }
        GuildSub.Emoji -> { EmojiManageScreen(store, state, guildId) { sub = null }; return }
        null -> {}
    }

    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val canManage = state.canManageGuild(guildId)
    val isOwner = state.isGuildOwner(guildId)

    var name by remember(guild.id) { mutableStateOf(guild.name) }
    var description by remember(guild.id) { mutableStateOf(guild.description ?: "") }
    var rules by remember(guild.id) { mutableStateOf(guild.rulesContent ?: "") }
    var discoverable by remember(guild.id) { mutableStateOf(guild.discoverable == true) }
    var busy by remember { mutableStateOf(false) }
    var savedFlash by remember { mutableStateOf(false) }
    var showMembers by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }

    fun pickImage(uri: Uri?, banner: Boolean) {
        uri ?: return
        scope.launch {
            val loaded = withContext(Dispatchers.IO) { readGuildImage(ctx, uri) } ?: return@launch
            val (bytes, mime, fn) = loaded
            if (banner) store.uploadGuildBanner(guildId, fn, mime, bytes) else store.uploadGuildIcon(guildId, fn, mime, bytes)
        }
    }
    val iconPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pickImage(it, false) }
    val bannerPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pickImage(it, true) }

    val dirty = name.trim() != guild.name || description != (guild.description ?: "") || rules != (guild.rulesContent ?: "")

    ScreenScaffold("Server Settings", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Spacer(Modifier.height(2.dp))
            // Banner + icon preview.
            val banner = Config.absoluteUrl(guild.bannerUrl)
            Box(
                Modifier.fillMaxWidth().aspectRatio(2.2f).clip(RoundedCornerShape(14.dp)).background(p.bg3)
                    .let { if (canManage) it.clickable { bannerPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } else it },
            ) {
                if (banner != null) AsyncImage(model = banner, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
                if (canManage) Text("Change banner", color = Color.White, fontFamily = ZkSans, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black.copy(alpha = 0.5f)).padding(horizontal = 8.dp, vertical = 4.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(56.dp).clip(RoundedCornerShape(16.dp))
                        .let { if (canManage) it.clickable { iconPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) } else it },
                ) { GuildIcon(name = guild.name, url = guild.iconUrl, size = 56.dp) }
                if (canManage) Text("Tap icon or banner to change", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            }

            if (canManage) {
                SectionLabel("Server name", Modifier.padding(top = 4.dp))
                FilledTextField(name, { name = it.take(100) }, "Server name", Modifier.fillMaxWidth())
                SectionLabel("Description")
                FilledTextField(description, { description = it.take(1000) }, "What's this server about?", Modifier.fillMaxWidth(), singleLine = false, minLines = 2)
                SectionLabel("Rules")
                FilledTextField(rules, { rules = it.take(10000) }, "Server rules (shown to new members)", Modifier.fillMaxWidth(), singleLine = false, minLines = 3)
                PrimaryButton(if (busy) "Saving…" else if (savedFlash && !dirty) "Saved ✓" else "Save changes", enabled = dirty && !busy) {
                    busy = true; savedFlash = false
                    store.editGuild(guildId, name, description, rules) { ok ->
                        busy = false; if (ok) savedFlash = true
                    }
                }

                // Discovery toggle.
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Server Discovery", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        Text("List this server publicly so anyone can find + join it.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                    }
                    Switch(
                        checked = discoverable,
                        onCheckedChange = { want ->
                            discoverable = want
                            store.setGuildDiscovery(guildId, want, guild.discoveryDescription, guild.discoveryCategory) { ok -> if (!ok) discoverable = !want }
                        },
                        colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent),
                    )
                }
            }

            // Management nav.
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
            SectionLabel("Management")
            if (state.canManageRoles(guildId)) GuildNavRow("Roles", "Create + edit roles and permissions") { sub = GuildSub.Roles }
            if (state.canManageRoles(guildId)) GuildNavRow("Reaction Roles", "React to a message to get a role") { sub = GuildSub.ReactionRoles }
            GuildNavRow("Members", "View the member roster") { showMembers = true }
            GuildNavRow("Get Roles", "Self-assignable roles members can pick") { sub = GuildSub.GetRoles }
            if (state.canManageInvites(guildId)) GuildNavRow("Invites", "See + revoke active invites") { sub = GuildSub.Invites }
            if (state.canManageEmojis(guildId)) GuildNavRow("Emoji", "Upload + manage custom emoji") { sub = GuildSub.Emoji }
            if (state.canSeeReports(guildId)) GuildNavRow("Reports", "Member reports moderation queue") { sub = GuildSub.Reports }
            if (state.canViewAuditLog(guildId)) GuildNavRow("Audit Log", "Recent moderation actions") { sub = GuildSub.AuditLog }

            // Danger zone.
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
            SectionLabel("Danger zone")
            if (isOwner) {
                DangerRow("Delete Server") { confirmDelete = true }
            } else {
                DangerRow("Leave Server") { confirmLeave = true }
            }
        }
    }

    if (showMembers) MembersSheet(store, state, guildId, onDismiss = { showMembers = false })

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete ${guild.name}?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("This permanently deletes the server, its channels, and all messages. This can't be undone.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = { TextButton(onClick = { confirmDelete = false; store.deleteGuild(guildId) { ok -> if (ok) onBack() } }) { Text("Delete", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
            containerColor = p.bg2,
        )
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave ${guild.name}?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("You'll need a new invite to rejoin.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = { TextButton(onClick = { confirmLeave = false; store.leaveGuild(guildId); onBack() }) { Text("Leave", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
            containerColor = p.bg2,
        )
    }
}

@Composable
private fun GuildNavRow(title: String, subtitle: String, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp)
            Text(subtitle, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun DangerRow(label: String, onClick: () -> Unit) {
    Text(
        label, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable(onClick = onClick).padding(vertical = 13.dp),
    )
}

private val SLOWMODE_OPTS: List<Pair<String, Int>> = listOf(
    "Off" to 0, "5s" to 5, "10s" to 10, "15s" to 15, "30s" to 30,
    "1m" to 60, "5m" to 300, "15m" to 900, "1h" to 3600, "6h" to 21600,
)

/** Edit a channel or category (name / topic / category / slowmode / NSFW) with
 *  a purge action + delete. Mirrors iOS EditChannelSheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditChannelSheet(store: AppStore, state: AppState, channel: Channel, guildId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val isCategory = channel.isCategory
    val isText = channel.isText
    val categories = (state.channelsByGuild[guildId] ?: emptyList()).filter { it.isCategory }.sortedBy { it.position ?: 0 }

    var name by remember(channel.id) { mutableStateOf(channel.name ?: "") }
    var topic by remember(channel.id) { mutableStateOf(channel.topic ?: "") }
    var parentId by remember(channel.id) { mutableStateOf(channel.parentId) }
    var nsfw by remember(channel.id) { mutableStateOf(channel.nsfw == true) }
    var slowmode by remember(channel.id) { mutableStateOf(channel.rateLimitPerUser ?: 0) }
    var busy by remember { mutableStateOf(false) }
    var confirmPurge by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (isCategory) "EDIT CATEGORY" else "EDIT CHANNEL", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            SectionLabel("Name")
            FilledTextField(name, { name = it.take(100) }, if (isCategory) "category-name" else "channel-name", Modifier.fillMaxWidth())

            if (!isCategory) {
                SectionLabel("Topic")
                FilledTextField(topic, { topic = it.take(1024) }, "What's this channel about?", Modifier.fillMaxWidth(), singleLine = false, minLines = 2)

                if (categories.isNotEmpty()) {
                    SectionLabel("Category")
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Pill("None", parentId == null) { parentId = null }
                        categories.forEach { cat -> Pill(cat.name ?: "category", parentId == cat.id) { parentId = cat.id } }
                    }
                }
            }

            if (isText) {
                SectionLabel("Slowmode")
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SLOWMODE_OPTS.forEach { (label, secs) -> Pill(label, slowmode == secs) { slowmode = secs } }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Age-restricted (NSFW)", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp)
                        Text("Members must confirm they're 18+.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                    }
                    Switch(checked = nsfw, onCheckedChange = { nsfw = it }, colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent))
                }
            }

            PrimaryButton(if (busy) "Saving…" else "Save changes", enabled = name.isNotBlank() && !busy) {
                busy = true
                // Categories have no parent picker (don't send parentId); channels
                // send an explicit null when "None" is chosen so they un-parent.
                val parentJson: JsonElement? = if (isCategory) null else (parentId?.let { JsonPrimitive(it) } ?: JsonNull)
                store.editChannel(
                    channel.id, guildId, name, topic,
                    parentId = parentJson,
                    nsfw = if (isText) nsfw else null,
                    slowmode = if (isText) slowmode else null,
                ) { busy = false; if (it) onDismiss() }
            }

            if (isText) {
                Text(
                    "Purge all messages", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 14.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg3).clickable { confirmPurge = true }.padding(vertical = 11.dp),
                )
            }
            Text(
                if (isCategory) "Delete category" else "Delete channel", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.deleteChannel(channel.id, guildId); onDismiss() }.padding(vertical = 11.dp),
            )
        }
    }
    if (confirmPurge) {
        AlertDialog(
            onDismissRequest = { confirmPurge = false },
            title = { Text("Purge #${channel.name ?: "channel"}?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("This permanently deletes every message in this channel. This can't be undone.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = { TextButton(onClick = { confirmPurge = false; store.purgeChannel(channel.id); onDismiss() }) { Text("Purge", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
            dismissButton = { TextButton(onClick = { confirmPurge = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
            containerColor = p.bg2,
        )
    }
}

/** A selectable rounded pill (shared by the settings/edit sheets). */
@Composable
internal fun Pill(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (selected) p.accent else p.bg3).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

/** Upload + manage custom guild emoji (MANAGE_EMOJIS). */
@Composable
fun EmojiManageScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val emojis = state.guildEmojis
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val nm = name.trim().lowercase().replace(Regex("[^a-z0-9_]"), "_")
        if (nm.length < 2) { error = "Enter a name (2+ chars) first."; return@rememberLauncherForActivityResult }
        busy = true; error = null
        scope.launch {
            val loaded = withContext(Dispatchers.IO) { readGuildImage(ctx, uri) }
            if (loaded == null) { busy = false; error = "Couldn't read that image."; return@launch }
            val (bytes, mime, fn) = loaded
            store.uploadGuildEmoji(guildId, nm, fn, mime, bytes) { ok ->
                busy = false
                if (ok) name = "" else error = "Upload failed — check the name is unique and the image is under the size limit."
            }
        }
    }

    ScreenScaffold("Emoji", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel("Add an emoji")
            Text("A short lowercase name (letters/numbers/underscore) + a small square image.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTextField(name, { name = it.take(32) }, "name", Modifier.weight(1f))
                PrimaryButtonCompact(if (busy) "Uploading…" else "Pick image", enabled = name.trim().length >= 2 && !busy) {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
            }
            error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line).padding(vertical = 4.dp))
            SectionLabel("Server emoji — ${emojis.size}")
            if (emojis.isEmpty()) {
                Text("No custom emoji yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            } else emojis.forEach { e ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    AsyncImage(model = Config.absoluteUrl(e.url) ?: e.url, contentDescription = e.name, modifier = Modifier.size(28.dp))
                    Text(":${e.name}:", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(start = 10.dp).weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Delete", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.deleteGuildEmoji(guildId, e.id) }.padding(horizontal = 10.dp, vertical = 5.dp))
                }
            }
        }
    }
}

/** A compact inline accent button (for rows where PrimaryButton's full width is too much). */
@Composable
private fun PrimaryButtonCompact(label: String, enabled: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label, color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
        modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(if (enabled) p.accent else p.bg3).let { if (enabled) it.clickable(onClick = onClick) else it }.padding(horizontal = 14.dp, vertical = 11.dp),
    )
}

/** Short "Expires in 3d" style countdown for an invite expiry instant. */
private fun inviteExpiryLabel(expiresAt: String?): String {
    if (expiresAt == null) return "Never expires"
    val exp = runCatching { java.time.Instant.parse(expiresAt) }.getOrNull() ?: return "Never expires"
    val secs = java.time.Duration.between(java.time.Instant.now(), exp).seconds
    if (secs <= 0) return "Expired"
    return when {
        secs >= 86400 -> "Expires in ${secs / 86400}d"
        secs >= 3600 -> "Expires in ${secs / 3600}h"
        else -> "Expires in ${maxOf(1L, secs / 60)}m"
    }
}

/** List + revoke a guild's active invites (MANAGE_INVITES). Rows mirror iOS
 *  (MainView.swift:6934-7000): mono code (struck + dimmed when expired), a
 *  copy-link action, and an "Expires in … · uses" status line; a top '+'
 *  creates a new invite and reloads on dismiss. */
@Composable
fun ManageInvitesScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var invites by remember { mutableStateOf<List<Invite>?>(null) }
    var reload by remember { mutableStateOf(0) }
    var showCreate by remember { mutableStateOf(false) }
    LaunchedEffect(guildId, reload) { invites = store.guildInvites(guildId) }

    ScreenScaffold("Invites", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // '+' create entry (toolbar-plus equivalent).
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.accent.copy(alpha = 0.12f))
                    .clickable { showCreate = true }.padding(vertical = 11.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("+ New Invite", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
            val list = invites
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                list.isEmpty() -> Text("No active invites.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                else -> list.forEach { inv ->
                    val uses = inv.uses ?: 0
                    val max = inv.maxUses
                    val expiredByTime = inv.expiresAt?.let {
                        runCatching { java.time.Instant.parse(it) <= java.time.Instant.now() }.getOrDefault(false)
                    } ?: false
                    val expired = expiredByTime || (max != null && uses >= max)
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 14.dp, vertical = 12.dp)
                            .let { if (expired) it else it },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f).let { if (expired) it else it }) {
                            Text(
                                inv.code,
                                color = if (expired) ZkInk.ink4 else ZkInk.ink1,
                                fontFamily = com.zekktris.ui.theme.ZkMono, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                textDecoration = if (expired) androidx.compose.ui.text.style.TextDecoration.LineThrough else null,
                            )
                            val status = if (expired) "Expired" else buildString {
                                append(inviteExpiryLabel(inv.expiresAt))
                                if (max != null) append(" · $uses/$max uses") else append(" · $uses uses")
                            }
                            Text(status, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                        }
                        // Copy-link.
                        Icon(
                            Icons.Filled.ContentCopy, "Copy link", tint = ZkInk.ink3,
                            modifier = Modifier.clip(CircleShape)
                                .clickable { clipboard.setText(androidx.compose.ui.text.AnnotatedString("${com.zekktris.data.Config.CDN_BASE_URL}/invite/${inv.code}")) }
                                .padding(6.dp).size(16.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "Revoke", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.revokeInvite(inv.code) { reload++ } }.padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }
    }
    if (showCreate) {
        InviteSheet(store, state, guildId, onDismiss = { showCreate = false; reload++ })
    }
}
