package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Permissions
import com.zekktris.data.model.Role
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/** RGB role color (0 = none) → opaque Compose color, clamped like elsewhere. */
private fun roleColor(rgb: Int): Color? = if (rgb == 0) null else Color(0xFF000000.toInt() or rgb.coerceIn(0, 0xFFFFFF))

// iOS RoleEditSheet palette (byte-exact).
private val ROLE_PALETTE = listOf(
    0x000000, 0x1ABC9C, 0x2ECC71, 0x3498DB, 0x9B59B6, 0xE91E63,
    0xF1C40F, 0xE67E22, 0xE74C3C, 0x95A5A6, 0x607D8B,
    0x11806A, 0x1F8B4C, 0x206694, 0x71368A, 0xAD1457,
    0x3DD7EC, 0x9D7BFF, 0xEC5FB5, 0xFF5C5C,
)

/** Roles list — highest position first, @everyone hidden (its id == guildId).
 *  Tap to edit; (+) to create. Mirrors iOS RolesListView. */
@Composable
fun RolesListScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    LaunchedEffect(guildId) { store.refreshRoles(guildId) }
    val roles = (state.rolesByGuild[guildId] ?: emptyList())
        .filterNot { it.id == guildId }
        .sortedByDescending { it.position }
    var editRole by remember { mutableStateOf<Role?>(null) }
    var creating by remember { mutableStateOf(false) }

    ScreenScaffold("Roles", onBack) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (roles.isEmpty()) Text("No custom roles yet. Tap + to create one.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                roles.forEach { r ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable { editRole = r }.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(roleColor(r.color) ?: ZkInk.ink4))
                        Text(r.name, color = roleColor(r.color) ?: ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f))
                        if (r.hoist) Text("HOISTED", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(p.bg3).padding(horizontal = 5.dp, vertical = 2.dp))
                    }
                }
                Spacer(Modifier.height(72.dp))
            }
            // FAB — create role.
            Box(
                Modifier.align(Alignment.BottomEnd).padding(20.dp).size(52.dp).clip(CircleShape).background(p.accent).clickable { creating = true },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Add, "New role", tint = Color.White, modifier = Modifier.size(26.dp)) }
        }
    }

    if (creating) RoleEditSheet(store, guildId, null) { creating = false }
    editRole?.let { r -> RoleEditSheet(store, guildId, r) { editRole = null } }
}

/** Create or edit a role: name, color palette, hoist / mentionable /
 *  self-assignable, and the full permission grid. Mirrors iOS RoleEditSheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoleEditSheet(store: AppStore, guildId: String, role: Role?, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val isEdit = role != null
    var name by remember { mutableStateOf(role?.name ?: "") }
    var colorRGB by remember { mutableStateOf(role?.color ?: 0) }
    var hoist by remember { mutableStateOf(role?.hoist ?: false) }
    var mentionable by remember { mutableStateOf(role?.mentionable ?: false) }
    var selfAssignable by remember { mutableStateOf(role?.selfAssignable ?: false) }
    var permBits by remember { mutableStateOf(Permissions.parse(role?.permissions)) }
    var busy by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (isEdit) "EDIT ROLE" else "NEW ROLE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            SectionLabel("Role name")
            FilledTextField(name, { name = it.take(100) }, "new role", Modifier.fillMaxWidth())

            SectionLabel("Color")
            LazyVerticalGrid(
                columns = GridCells.Fixed(6),
                modifier = Modifier.fillMaxWidth().height(((ROLE_PALETTE.size + 5) / 6 * 48).dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                userScrollEnabled = false,
            ) {
                items(ROLE_PALETTE) { c ->
                    Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                        Box(
                            Modifier.size(34.dp).clip(CircleShape).background(if (c == 0) p.bg3 else Color(0xFF000000.toInt() or c))
                                .then(if (colorRGB == c) Modifier.border(2.dp, Color.White, CircleShape) else Modifier)
                                .clickable { colorRGB = c },
                            contentAlignment = Alignment.Center,
                        ) { if (c == 0) Icon(Icons.Filled.Block, null, tint = ZkInk.ink3, modifier = Modifier.size(14.dp)) }
                    }
                }
            }

            ToggleRow("Display separately", "Show members with this role in their own sidebar group", hoist) { hoist = it }
            ToggleRow("Allow anyone to @mention this role", null, mentionable) { mentionable = it }
            if (isEdit) ToggleRow("Self-assignable", "Let members claim this role themselves from Get Roles", selfAssignable) { selfAssignable = it }

            SectionLabel("Permissions")
            Permissions.groupOrder.forEach { group ->
                Text(group.uppercase(), color = ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
                Permissions.all.filter { it.group == group }.forEach { def ->
                    val on = Permissions.has(permBits, def.bit)
                    ToggleRow(def.label, null, on) { want ->
                        permBits = if (want) permBits or Permissions.mask(def.bit) else permBits and Permissions.mask(def.bit).inv()
                    }
                }
            }

            PrimaryButton(if (busy) "Saving…" else if (isEdit) "Save role" else "Create role", enabled = name.isNotBlank() && !busy) {
                busy = true
                val perms = Permissions.serialize(permBits)
                if (isEdit) {
                    store.editRole(guildId, role!!.id, name, colorRGB, hoist, mentionable, selfAssignable, perms) { busy = false; if (it) onDismiss() }
                } else {
                    store.createRole(guildId, name, colorRGB, hoist, mentionable, perms) { busy = false; if (it) onDismiss() }
                }
            }

            if (isEdit) {
                Text(
                    "Delete role", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.12f)).clickable { store.deleteRole(guildId, role!!.id); onDismiss() }.padding(vertical = 11.dp),
                )
            }
        }
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = ZkTheme.palette
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
            if (subtitle != null) Text(subtitle, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
        }
        Switch(checked = checked, onCheckedChange = onChange, colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent))
    }
}

/** "Get Roles" — self-assignable roles a member can claim/drop themselves. */
@Composable
fun BrowseRolesScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var roles by remember { mutableStateOf<List<Role>?>(null) }
    LaunchedEffect(guildId) {
        store.refreshMembers(guildId)
        roles = store.selfAssignableRoles(guildId)
    }
    val myRoleIds = (state.membersByGuild[guildId]?.firstOrNull { it.userId == state.me?.id }?.roleIds ?: emptyList()).toSet()

    ScreenScaffold("Get Roles", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val list = roles
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                list.isEmpty() -> Text("This server has no self-assignable roles.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                else -> list.forEach { r ->
                    val has = myRoleIds.contains(r.id)
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2)
                            .clickable { store.toggleSelfRole(guildId, r.id, has) }.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(roleColor(r.color) ?: ZkInk.ink4))
                        Text(r.name, color = roleColor(r.color) ?: ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 15.sp, modifier = Modifier.padding(start = 10.dp).weight(1f))
                        if (has) Icon(Icons.Filled.Check, null, tint = p.accent, modifier = Modifier.size(20.dp))
                        else Text("Add", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    }
                }
            }
        }
    }
}
