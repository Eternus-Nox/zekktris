package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.data.model.Permissions
import com.zekktris.data.model.PermissionOverride
import com.zekktris.data.model.ReactionRoleMapping
import com.zekktris.data.model.Role
import com.zekktris.ui.components.EmojiPickerSheet
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

private fun roleDot(rgb: Int): Color = if (rgb == 0) ZkInk.ink4 else Color(0xFF000000.toInt() or rgb.coerceIn(0, 0xFFFFFF))

// ── Reaction roles ──────────────────────────────────────────────────────────

/** Admin reaction-roles: react to a message with an emoji → get a role.
 *  Mirrors iOS ReactionRolesView. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReactionRolesScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var mappings by remember { mutableStateOf<List<ReactionRoleMapping>?>(null) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(guildId) { store.refreshRoles(guildId) }
    LaunchedEffect(guildId, reload) { mappings = store.reactionRoles(guildId) }
    val roles = (state.rolesByGuild[guildId] ?: emptyList()).filterNot { it.id == guildId }.sortedByDescending { it.position }
    val textChannels = (state.channelsByGuild[guildId] ?: emptyList()).filter { it.isText }

    var messageId by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("") }
    var channelId by remember { mutableStateOf<String?>(null) }
    var roleId by remember { mutableStateOf<String?>(null) }
    var showEmoji by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    ScreenScaffold("Reaction Roles", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionLabel("Active mappings")
            val list = mappings
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                list.isEmpty() -> Text("No reaction roles yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                else -> list.forEach { m ->
                    val role = roles.firstOrNull { it.id == m.roleId }
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (m.emoji.startsWith(":")) m.emoji else m.emoji, fontSize = 16.sp)
                        Text("→", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 8.dp))
                        Box(Modifier.size(10.dp).clip(CircleShape).background(roleDot(role?.color ?: 0)))
                        Text(role?.name ?: "(deleted role)", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(start = 6.dp).weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("Remove", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.removeReactionRole(guildId, m.messageId, m.emoji) { reload++ } }.padding(horizontal = 10.dp, vertical = 5.dp))
                    }
                }
            }

            Box(Modifier.fillMaxWidth().padding(vertical = 4.dp)) { Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(1.dp)).background(p.line).size(1.dp)) }
            SectionLabel("Add a mapping")
            FilledTextField(messageId, { messageId = it.trim() }, "Message ID", Modifier.fillMaxWidth())
            Text("CHANNEL", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                textChannels.forEach { c -> Pill("#${c.name ?: "channel"}", channelId == c.id) { channelId = c.id } }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTextField(emoji, { emoji = it }, "Emoji (😀 or :name:)", Modifier.weight(1f))
                Text("Pick", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(p.accent.copy(alpha = 0.12f)).clickable { showEmoji = true }.padding(horizontal = 12.dp, vertical = 10.dp))
            }
            Text("ROLE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                roles.forEach { r -> Pill(r.name, roleId == r.id) { roleId = r.id } }
            }
            val ok = messageId.isNotBlank() && emoji.isNotBlank() && channelId != null && roleId != null && !busy
            PrimaryButton(if (busy) "Adding…" else "Add reaction role", enabled = ok) {
                busy = true
                store.addReactionRole(guildId, messageId.trim(), channelId!!, emoji.trim(), roleId!!) { okAdd ->
                    busy = false
                    if (okAdd) { messageId = ""; emoji = ""; reload++ }
                }
            }
        }
    }
    if (showEmoji) EmojiPickerSheet(
        onDismiss = { showEmoji = false },
        onPick = { emoji = it; showEmoji = false },
        serverEmojis = state.guildEmojis.map { it.name to (com.zekktris.data.Config.absoluteUrl(it.url) ?: it.url) },
    )
}

// ── Channel permission overrides ────────────────────────────────────────────

/** Per-channel role permission overrides (tri-state Allow / Inherit / Deny),
 *  layered over each role's server-wide perms. Mirrors iOS ChannelPermissionsView. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelPermissionsScreen(store: AppStore, state: AppState, channel: Channel, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var overrides by remember { mutableStateOf<List<PermissionOverride>>(emptyList()) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(guildId) { store.refreshRoles(guildId) }
    LaunchedEffect(channel.id, reload) { overrides = store.channelPermissions(channel.id) }
    val roles = (state.rolesByGuild[guildId] ?: emptyList()).sortedByDescending { it.position }
    var editRole by remember { mutableStateOf<Role?>(null) }

    ScreenScaffold("Permissions", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Allow or Deny takes precedence over a role's server-wide permissions for #${channel.name ?: "channel"}. Leave a permission on Inherit to keep the role's default.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            roles.forEach { r ->
                val ov = overrides.firstOrNull { it.targetType == "role" && it.targetId == r.id }
                val a = Permissions.parse(ov?.allow); val d = Permissions.parse(ov?.deny)
                val summary = when {
                    ov == null -> "No override"
                    else -> "${java.lang.Long.bitCount(a)} allowed · ${java.lang.Long.bitCount(d)} denied"
                }
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable { editRole = r }.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(12.dp).clip(CircleShape).background(roleDot(r.color)))
                    Column(Modifier.padding(start = 10.dp).weight(1f)) {
                        Text(if (r.id == guildId) "@everyone" else r.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(summary, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                    }
                }
            }
        }
    }
    editRole?.let { r ->
        val ov = overrides.firstOrNull { it.targetType == "role" && it.targetId == r.id }
        PermOverrideSheet(store, channel.id, r, guildId, ov, onDone = { reload++; editRole = null }, onDismiss = { editRole = null })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PermOverrideSheet(store: AppStore, channelId: String, role: Role, guildId: String, existing: PermissionOverride?, onDone: () -> Unit, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var allow by remember { mutableStateOf(Permissions.parse(existing?.allow)) }
    var deny by remember { mutableStateOf(Permissions.parse(existing?.deny)) }
    var busy by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text((if (role.id == guildId) "@everyone" else role.name).uppercase(), color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            Permissions.groupOrder.forEach { group ->
                Text(group.uppercase(), color = ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
                Permissions.all.filter { it.group == group }.forEach { def ->
                    val mask = Permissions.mask(def.bit)
                    val stateVal = when {
                        (allow and mask) != 0L -> 1   // Allow
                        (deny and mask) != 0L -> -1   // Deny
                        else -> 0                     // Inherit
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(def.label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        TriToggle(stateVal) { next ->
                            allow = if (next == 1) allow or mask else allow and mask.inv()
                            deny = if (next == -1) deny or mask else deny and mask.inv()
                        }
                    }
                }
            }
            PrimaryButton(if (busy) "Saving…" else "Save override", enabled = !busy) {
                busy = true
                store.setChannelPermission(channelId, role.id, "role", Permissions.serialize(allow), Permissions.serialize(deny)) { onDone() }
            }
            if (existing != null) {
                Text("Remove override", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.clearChannelPermission(channelId, role.id, "role") { onDone() } }.padding(vertical = 11.dp))
            }
        }
    }
}

/** Allow (✓) / Inherit (—) / Deny (✕) segmented control. state: 1/0/-1. */
@Composable
private fun TriToggle(state: Int, onChange: (Int) -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(8.dp)).background(ZkTheme.palette.bg3)) {
        TriSeg("✓", state == 1, ZkStatus.online) { onChange(if (state == 1) 0 else 1) }
        TriSeg("—", state == 0, ZkInk.ink3) { onChange(0) }
        TriSeg("✕", state == -1, ZkStatus.danger) { onChange(if (state == -1) 0 else -1) }
    }
}

@Composable
private fun TriSeg(glyph: String, selected: Boolean, tint: Color, onClick: () -> Unit) {
    Text(
        glyph, color = if (selected) Color.White else ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 13.sp, textAlign = TextAlign.Center,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (selected) tint else Color.Transparent).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
    )
}
