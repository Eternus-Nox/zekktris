package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.PublicUser
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.StaffName
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

private fun hex(hex: String?): Color? {
    if (hex.isNullOrBlank()) return null
    return runCatching { Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex")) }.getOrNull()
}

private val TIER_COLORS = mapOf("scout" to Color(0xFF3D9BFF), "guardian" to Color(0xFF9D7BFF), "legend" to Color(0xFFF4C95B))

/** A left-tail speech bubble whose tail points SW (down-left) toward the avatar —
 *  a direct port of iOS SpeechBubbleLeft. The tail protrudes past the body's left
 *  edge, so the content needs extra leading padding to clear it. */
private val SpeechBubbleLeft: Shape = object : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val tailWidth = with(density) { 8.dp.toPx() }
        val tailHeight = with(density) { 8.dp.toPx() }
        val cornerRadius = with(density) { 9.dp.toPx() }
        val tailTipDY = with(density) { 8.dp.toPx() }
        val r = minOf(cornerRadius, size.height / 2f - 1f, (size.width - tailWidth) / 2f - 1f)
        val minX = tailWidth              // body left edge (tail protrudes left of this)
        val maxX = size.width
        val minY = 0f
        val maxY = size.height
        val minCY = minY + r + tailHeight / 2f
        val maxCY = maxY - r - tailHeight / 2f
        val cy = minOf(maxOf(minY + (maxY - minY) * 0.5f, minCY), maxOf(minCY, maxCY))
        val p = Path().apply {
            moveTo(minX + r, minY)
            lineTo(maxX - r, minY)
            quadraticBezierTo(maxX, minY, maxX, minY + r)          // TR
            lineTo(maxX, maxY - r)
            quadraticBezierTo(maxX, maxY, maxX - r, maxY)          // BR
            lineTo(minX + r, maxY)
            quadraticBezierTo(minX, maxY, minX, maxY - r)          // BL
            lineTo(minX, cy + tailHeight / 2f)                     // down to tail base
            lineTo(0f, cy + tailTipDY)                             // out to the tail tip
            lineTo(minX, cy - tailHeight / 2f)                     // back to the edge
            lineTo(minX, minY + r)
            quadraticBezierTo(minX, minY, minX + r, minY)          // TL
            close()
        }
        return Outline.Generic(p)
    }
}

/** The user profile card — banner, avatar, name/tag/tier, bio, and the full
 *  action set (Message, Call, Friend, Block, Report). Mirrors iOS ProfileCardView. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ProfileSheet(store: AppStore, state: AppState, user: PublicUser, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val relType = state.relationships.firstOrNull { it.user.id == user.id }?.type
    val isSelf = user.id == state.me?.id
    val guildId = state.selectedGuildId
    // Highest colored role tints the name (iOS memberColor ?? ink1). The staff
    // shimmer is StaffName's own job — staffColor is NOT a name color.
    val nameColor = store.memberColorRGB(guildId, user.id)
        ?.let { Color(0xFF000000.toInt() or it) } ?: ZkInk.ink1
    var showReport by remember { mutableStateOf(false) }
    var showNickname by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            // Banner — a fixed 250dp tall, cropped full-bleed; the custom status
            // floats in it (bottom-left) as a speech bubble, like iOS.
            // Fallback gradient: accent@0.55 → accent2@0.45, leading→trailing
            // (iOS MessageViews.swift:3566-3577 / web ProfileCard).
            Box(Modifier.fillMaxWidth().height(250.dp).background(Brush.horizontalGradient(listOf(p.accent.copy(alpha = 0.55f), p.accent2.copy(alpha = 0.45f))))) {
                Config.absoluteUrl(user.bannerUrl)?.let {
                    AsyncImage(it, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                // Suppress expired statuses (server leaves expired rows for the
                // client to hide); show when EITHER emoji or text is non-blank
                // (iOS MessageViews.swift:3741-3749).
                val statusExpired = user.customStatusExpiresAt?.let { iso ->
                    runCatching { java.time.Instant.parse(iso) <= java.time.Instant.now() }.getOrDefault(false)
                } ?: false
                val hasStatus = !statusExpired &&
                    (!user.customStatus.isNullOrBlank() || !user.customStatusEmoji.isNullOrBlank())
                if (hasStatus) {
                    // Speech bubble whose left tail points back at the avatar.
                    Row(
                        Modifier.align(Alignment.BottomStart).padding(start = 92.dp, bottom = 10.dp, end = 12.dp)
                            .shadow(4.dp, SpeechBubbleLeft).clip(SpeechBubbleLeft).background(p.bg3)
                            .border(1.dp, p.line, SpeechBubbleLeft)
                            .padding(start = 11.dp + 8.dp, end = 11.dp, top = 6.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        user.customStatusEmoji?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 13.sp, modifier = Modifier.padding(end = 5.dp)) }
                        user.customStatus?.takeIf { it.isNotBlank() }?.let {
                            Text(it, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            // Avatar straddles the banner's bottom edge with name + username to
            // its RIGHT, top-aligned (iOS ProfileCardView layout).
            Column(Modifier.padding(horizontal = 16.dp).offset(y = (-34).dp)) {
                Row(verticalAlignment = Alignment.Top) {
                    Box {
                        Box(Modifier.clip(CircleShape).background(p.bg1).padding(3.dp)) {
                            Avatar(url = user.avatarUrl, name = user.bestName, size = 76.dp, decoration = user.avatarDecoration, toneId = user.id)
                        }
                        val presence = state.presenceOf(user.id)
                        val presenceDot = presenceColorOf(presence)
                        // iOS: max(10, 76*0.3) ≈ 23pt with a 2pt ring, nudged
                        // OUTWARD past the avatar edge (Components.swift:423-427).
                        Box(
                            Modifier.align(Alignment.BottomEnd).offset(x = 1.dp, y = 1.dp).size(23.dp).clip(CircleShape).background(p.bg1),
                            contentAlignment = Alignment.Center,
                        ) { Box(Modifier.size(19.dp).clip(CircleShape).background(presenceDot)) }
                    }
                    Column(Modifier.padding(start = 12.dp, top = 6.dp).weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            // Shared NameTag: accent fallback when the tag has no
                            // color + honors the viewer's Hide-clan-tags pref.
                            com.zekktris.ui.components.NameTag(user.tagLabel, user.tagColor, Modifier.padding(end = 6.dp))
                            StaffName(user = user, text = user.bestName, baseColor = nameColor, fontSize = 21.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f, fill = false))
                            if (user.isBot == true) {
                                Text("BOT", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp, modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(p.accent.copy(alpha = 0.2f)).padding(horizontal = 5.dp, vertical = 1.dp))
                            }
                            user.subscriptionTier?.let { tier ->
                                val tc = TIER_COLORS[tier] ?: p.accent
                                Text(tier.uppercase(), color = tc, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 8.5.sp, letterSpacing = 0.5.sp, modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(tc.copy(alpha = 0.18f)).padding(horizontal = 5.dp, vertical = 1.5.dp))
                            }
                        }
                        // Bots / webhook authors have no username — iOS omits the
                        // line entirely rather than printing a bare "@"
                        // (MessageViews.swift:4186-4190).
                        user.username?.takeIf { it.isNotBlank() }?.let {
                            Text("@$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                        }
                    }
                }
                if (!user.bio.isNullOrBlank()) {
                    Column(Modifier.padding(top = 14.dp)) {
                        SectionLabel("ABOUT ME")
                        Text(user.bio!!, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                }

                // Earned achievements — a wrapping grid of badges sitting directly
                // on the sheet (no card behind each), matching iOS AchievementBadge.
                // Explicit loading spinner + earned-only empty state
                // (iOS MainView.swift:10827-10846); tap opens a small detail sheet.
                var achievements by remember(user.id) { mutableStateOf<List<com.zekktris.data.model.Achievement>>(emptyList()) }
                var achievementsLoaded by remember(user.id) { mutableStateOf(false) }
                var achievementDetail by remember(user.id) { mutableStateOf<com.zekktris.data.model.Achievement?>(null) }
                LaunchedEffect(user.id) { achievements = store.fetchUserAchievements(user.id); achievementsLoaded = true }
                val earned = achievements.filter { it.isEarned }
                Column(Modifier.padding(top = 14.dp)) {
                    // iOS only prints the header once there's at least one earned
                    // badge — the loading and empty branches are bare
                    // (MainView.swift:10811-10815).
                    if (earned.isNotEmpty()) SectionLabel("ACHIEVEMENTS")
                    when {
                        !achievementsLoaded -> androidx.compose.material3.CircularProgressIndicator(
                            color = p.accent, strokeWidth = 2.dp,
                            modifier = Modifier.padding(top = 8.dp).size(18.dp),
                        )
                        earned.isEmpty() -> Text(
                            "No achievements unlocked yet.",
                            color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                        else -> FlowRow(
                            Modifier.fillMaxWidth().padding(top = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            earned.forEach { a -> AchievementBadge(a) { achievementDetail = a } }
                        }
                    }
                }
                achievementDetail?.let { a ->
                    AlertDialog(
                        onDismissRequest = { achievementDetail = null },
                        title = { Text("${a.marker}  ${a.name}", color = ZkInk.ink1, fontFamily = ZkSans) },
                        text = { Text(a.description, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp) },
                        confirmButton = {
                            TextButton(onClick = { achievementDetail = null }) { Text("Done", color = p.accent, fontFamily = ZkSans) }
                        },
                        containerColor = p.bg2,
                    )
                }

                if (!isSelf) {
                    // Contact buttons only when the server SAYS we can (or a
                    // friend); unknown/failed fetch keeps them hidden
                    // (iOS MessageViews.swift:3549-3553).
                    val canContact = relType != "blocked" && (user.canMessage == true || relType == "friend")
                    // Divider between the bio/achievements block and the actions
                    // (iOS draws a 1px Theme.line rule here).
                    Box(Modifier.fillMaxWidth().padding(top = 14.dp).height(1.dp).background(p.line))

                    Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (canContact) {
                            // Message + Call — two equal accent buttons side-by-side.
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                ProfileButton("Message", Modifier.weight(1f), accent = true, icon = Icons.AutoMirrored.Filled.Message) { store.messageFromProfile(user.id) }
                                ProfileButton("Call", Modifier.weight(1f), accent = true, icon = Icons.Filled.Call) { store.callFromProfile(user.id) }
                            }
                        }
                        when (relType) {
                            "friend" -> ProfileButton("Remove Friend", Modifier.fillMaxWidth(), icon = Icons.Filled.PersonRemove) { store.removeFriend(user.id) }
                            "outgoing_request" -> ProfileButton("Cancel Friend Request", Modifier.fillMaxWidth(), icon = Icons.Filled.Close) { store.removeFriend(user.id) }
                            "incoming_request" -> ProfileButton("Accept Friend Request", Modifier.fillMaxWidth(), icon = Icons.Filled.PersonAdd) { store.acceptFriend(user.id) }
                            "blocked" -> {}
                            else -> user.username?.let { un -> ProfileButton("Add Friend", Modifier.fillMaxWidth(), icon = Icons.Filled.PersonAdd) { store.addFriend(un) {} } }
                        }
                        // Personal DM nickname — viewer-private, opens a separate
                        // editor sheet (iOS treats it as a single secondary button).
                        if (user.isBot != true) {
                            val cur = state.dmNicknames[user.id]?.takeIf { it.isNotBlank() }
                            ProfileButton(if (cur != null) "Edit Nickname" else "Set Nickname", Modifier.fillMaxWidth(), icon = Icons.Filled.Edit) { showNickname = true }
                        }
                        ProfileButton(if (relType == "blocked") "Unblock" else "Block", Modifier.fillMaxWidth(), danger = true, icon = Icons.Filled.Block) {
                            if (relType == "blocked") store.unblockUser(user.id) else store.blockUser(user.id)
                        }
                        // Report only when the target is a member of the CURRENT
                        // guild (selectedGuildId lingers when opened from a DM;
                        // iOS gates on store.members[user.id] != nil).
                        val isGuildMember = guildId != null &&
                            state.membersByGuild[guildId]?.any { it.userId == user.id } == true
                        if (isGuildMember && relType != "friend") {
                            ProfileButton("Report User", Modifier.fillMaxWidth(), danger = true, icon = Icons.Outlined.Flag) { showReport = true }
                        }
                    }

                    // Assignable roles — guild managers can toggle a member's roles
                    // (sends the whole set; server diffs). ROLES sits LAST, after the
                    // action buttons, matching iOS ProfileCard order.
                    if (guildId != null && state.canManageRoles(guildId)) {
                        LaunchedEffect(guildId, user.id) {
                            if (state.rolesByGuild[guildId] == null) store.refreshRoles(guildId)
                            if (state.membersByGuild[guildId] == null) store.refreshMembers(guildId)
                        }
                        val assignable = (state.rolesByGuild[guildId] ?: emptyList())
                            .filterNot { it.id == guildId || it.managed == true }
                            .sortedByDescending { it.position }
                        // Only for an actual member of THIS guild — `selectedGuildId`
                        // can linger when the card is opened from a DM (iOS guards the
                        // same way), and roleIds must come from the real membership.
                        val member = state.membersByGuild[guildId]?.firstOrNull { it.userId == user.id }
                        val memberRoleIds = (member?.roleIds ?: emptyList()).toSet()
                        if (assignable.isNotEmpty() && member != null) {
                            Column(Modifier.padding(top = 16.dp)) {
                                SectionLabel("ROLES")
                                Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    assignable.forEach { r ->
                                        val has = memberRoleIds.contains(r.id)
                                        val rc = if (r.color == 0) ZkInk.ink4 else Color(0xFF000000.toInt() or r.color.coerceIn(0, 0xFFFFFF))
                                        Row(
                                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable { store.toggleMemberRole(guildId, user.id, r.id) }.padding(horizontal = 12.dp, vertical = 10.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Box(Modifier.size(12.dp).clip(CircleShape).background(rc))
                                            Text(r.name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f))
                                            if (has) Icon(Icons.Filled.Check, "Assigned", tint = p.accent, modifier = Modifier.size(18.dp))
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Moderation — kick / ban / timeout a member of THIS guild
                    // (gated; the server re-checks). Android-only extra, kept below
                    // ROLES so the primary card order matches iOS.
                    if (guildId != null) {
                        val gm = state.membersByGuild[guildId]?.firstOrNull { it.userId == user.id }
                        val canKick = state.canKickMembers(guildId)
                        val canBan = state.canBanMembers(guildId)
                        val canTimeout = state.canModerateMembers(guildId)
                        if (gm != null && (canKick || canBan || canTimeout)) {
                            var confirmKick by remember(user.id) { mutableStateOf(false) }
                            var confirmBan by remember(user.id) { mutableStateOf(false) }
                            var timeoutMenu by remember(user.id) { mutableStateOf(false) }
                            Column(Modifier.padding(top = 16.dp)) {
                                SectionLabel("MODERATION")
                                Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    if (canTimeout) {
                                        val timedOut = gm.communicationDisabledUntil != null
                                        Box {
                                            ProfileButton(if (timedOut) "Remove timeout" else "Time out…", Modifier.fillMaxWidth()) {
                                                if (timedOut) store.timeoutMember(guildId, user.id, 0) else timeoutMenu = true
                                            }
                                            DropdownMenu(expanded = timeoutMenu, onDismissRequest = { timeoutMenu = false }) {
                                                listOf("5 minutes" to 5, "10 minutes" to 10, "1 hour" to 60, "1 day" to 1440, "1 week" to 10080).forEach { (label, mins) ->
                                                    DropdownMenuItem(text = { Text(label, color = ZkInk.ink1, fontFamily = ZkSans) }, onClick = { timeoutMenu = false; store.timeoutMember(guildId, user.id, mins) })
                                                }
                                            }
                                        }
                                    }
                                    if (canKick) ProfileButton("Kick member", Modifier.fillMaxWidth(), danger = true) { confirmKick = true }
                                    if (canBan) ProfileButton("Ban member", Modifier.fillMaxWidth(), danger = true) { confirmBan = true }
                                }
                            }
                            if (confirmKick) AlertDialog(
                                onDismissRequest = { confirmKick = false },
                                title = { Text("Kick ${user.bestName}?", color = ZkInk.ink1, fontFamily = ZkSans) },
                                text = { Text("They'll be removed from the server but can rejoin with an invite.", color = ZkInk.ink3, fontFamily = ZkSans) },
                                confirmButton = { TextButton(onClick = { confirmKick = false; store.kickMember(guildId, user.id) { if (it) onDismiss() } }) { Text("Kick", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
                                dismissButton = { TextButton(onClick = { confirmKick = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
                                containerColor = p.bg2,
                            )
                            if (confirmBan) AlertDialog(
                                onDismissRequest = { confirmBan = false },
                                title = { Text("Ban ${user.bestName}?", color = ZkInk.ink1, fontFamily = ZkSans) },
                                text = { Text("They'll be removed and blocked from rejoining.", color = ZkInk.ink3, fontFamily = ZkSans) },
                                confirmButton = { TextButton(onClick = { confirmBan = false; store.banMember(guildId, user.id, null) { if (it) onDismiss() } }) { Text("Ban", color = ZkStatus.dangerSoft, fontFamily = ZkSans) } },
                                dismissButton = { TextButton(onClick = { confirmBan = false }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
                                containerColor = p.bg2,
                            )
                        }
                    }
                }
            }
        }
    }
    if (showNickname) {
        NicknameSheet(store = store, state = state, user = user, onDismiss = { showNickname = false })
    }
    if (showReport && guildId != null) {
        ReportSheet(onSubmit = { reason, details ->
            store.reportUser(guildId, user.id, reason, details) { showReport = false; onDismiss() }
        }, onDismiss = { showReport = false })
    }
}

@Composable
private fun ProfileButton(label: String, modifier: Modifier, accent: Boolean = false, danger: Boolean = false, icon: ImageVector? = null, onClick: () -> Unit) {
    val p = ZkTheme.palette
    // iOS: accent (Message/Call) fills; every other action — incl. Block/Report —
    // is a NEUTRAL bg3 button, red text only for danger actions.
    val bg = if (accent) p.accent else p.bg3
    val fg = when { accent -> Color.White; danger -> ZkStatus.danger; else -> ZkInk.ink1 }
    Row(
        modifier = modifier.clip(RoundedCornerShape(10.dp)).background(bg).clickable(onClick = onClick).padding(vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let { Icon(it, null, tint = fg, modifier = Modifier.size(17.dp)) }
        Text(
            label, color = fg, fontFamily = ZkSans,
            fontWeight = if (accent) FontWeight.SemiBold else FontWeight.Medium, fontSize = 15.sp,
            textAlign = TextAlign.Center,
        )
    }
}

private val REPORT_REASONS = listOf("spam" to "Spam", "harassment" to "Harassment", "nsfw" to "NSFW", "violence" to "Violence", "other" to "Other")

/** Personal DM-nickname editor — a viewer-private label shown in place of the
 *  user's name in DMs. Opens as its own sheet (iOS presents the same). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NicknameSheet(store: AppStore, state: AppState, user: PublicUser, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val cur = state.dmNicknames[user.id]?.takeIf { it.isNotBlank() }
    var text by remember { mutableStateOf(cur ?: "") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("NICKNAME", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            Text("A nickname only you see, shown in place of ${user.bestName}'s name in direct messages.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            FilledTextField(text, { text = it.take(32); err = null }, "Nickname", Modifier.fillMaxWidth())
            err?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ProfileButton(if (busy) "Saving…" else "Save", Modifier.weight(1f), accent = true) {
                    if (busy) return@ProfileButton
                    busy = true; err = null
                    scope.launch {
                        val e = store.setDmNickname(user.id, text)
                        busy = false
                        if (e == null) onDismiss() else err = e
                    }
                }
                if (cur != null) {
                    ProfileButton("Remove", Modifier.weight(1f), danger = true) {
                        if (busy) return@ProfileButton
                        busy = true; err = null
                        scope.launch {
                            val e = store.setDmNickname(user.id, null)
                            busy = false
                            if (e == null) onDismiss() else err = e
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReportSheet(onSubmit: (String, String) -> Unit, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var reason by remember { mutableStateOf<String?>(null) }
    var details by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("REPORT USER", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            Text("Reports go to this server's moderators. Choose a reason and describe what happened.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            REPORT_REASONS.forEach { (value, label) ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { reason = value }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(18.dp).clip(CircleShape).border(2.dp, if (reason == value) p.accent else ZkInk.ink4, CircleShape), contentAlignment = Alignment.Center) {
                        if (reason == value) Box(Modifier.size(9.dp).clip(CircleShape).background(p.accent))
                    }
                    Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 10.dp))
                }
            }
            FilledTextField(details, { details = it.take(1000) }, "Describe what happened", Modifier.fillMaxWidth().height(90.dp), singleLine = false, minLines = 3)
            Text("${details.length}/1000", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.align(Alignment.End))
            val ok = reason != null && details.isNotBlank()
            Text(
                "Submit report", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (ok) ZkStatus.danger else p.bg3)
                    .let { if (ok) it.clickable { onSubmit(reason!!, details) } else it }.padding(vertical = 13.dp),
            )
        }
    }
}

/** A single earned-achievement badge — a gradient circle holding the marker glyph
 *  with the name below, sitting directly on the sheet (no card behind), laid out
 *  in a wrapping grid. Mirrors iOS AchievementBadge. */
@Composable
private fun AchievementBadge(a: com.zekktris.data.model.Achievement, onClick: () -> Unit = {}) {
    val p = ZkTheme.palette
    // iOS sits each badge on a bg2 card at radius 10 with 8pt vertical padding
    // (MainView.swift:10921-10924).
    Column(
        Modifier.width(92.dp).clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable(onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        // 40dp gradient circle holding the marker glyph. iOS puts its SF symbol
        // here and the marker in a corner capsule; Android has no symbol map, so
        // printing the marker in BOTH places just doubled the glyph — the capsule
        // is dropped rather than duplicated.
        Box(
            Modifier.size(40.dp).clip(CircleShape)
                .background(Brush.linearGradient(listOf(p.accent.copy(alpha = 0.35f), p.accent2.copy(alpha = 0.25f)))),
            contentAlignment = Alignment.Center,
        ) { Text(a.marker, fontSize = 18.sp) }
        Text(
            a.name, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 10.sp, fontWeight = FontWeight.Medium,
            maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
        )
    }
}

// iOS passes a NON-optional status into the avatar dot (MessageViews.swift:4163),
// so Components.swift:424 always draws it — an offline user still gets a grey dot
// rather than no dot at all. Returning null here silently dropped it. Mirrors the
// GuildSheets sibling, which already returns ZkStatus.offline.
private fun presenceColorOf(status: String?): Color = when (status) {
    "online" -> ZkStatus.online
    "idle" -> ZkStatus.idle
    "dnd" -> ZkStatus.dnd
    else -> ZkStatus.offline
}
