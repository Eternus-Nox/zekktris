package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.AdminAccount
import com.zekktris.data.model.AdminAccountContacts
import com.zekktris.data.model.AdminContactPerson
import com.zekktris.data.model.AdminUser
import com.zekktris.data.model.StaffNote
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Admin → Users → an account. One page per account, replacing the row's "⋮"
 * dropdown (web AdminAccountPage / iOS AdminAccountView parity).
 *
 * Who sees what (user-decided 2026-09-27; the server enforces all of it, this
 * only avoids offering what the caller can't do):
 *   admins      account info, edit username / email / DOB, send password
 *               reset, role, membership, mute, ban, sign out, delete, notes,
 *               contacts
 *   moderators  mute, ban, sign out, DOB unlock, notes — no account info and
 *               no contacts, and nothing at all on another staff account.
 *
 * Each action runs its own API call (via [AppStore.adminCall]) so failures show
 * the SERVER's message inline, and the Users list is patched as actions land.
 * Contacts load only when asked for — viewing them writes a staff audit row.
 */
private enum class AccountDialog { Username, Email, Dob, Reset, Mute, Ban, Role, Gift, Delete }

private val MOD_SKY = Color(0xFF38BDF8)
private val MUTE_AMBER = Color(0xFFF59E0B)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun AdminAccountScreen(store: AppStore, state: AppState, userId: String, onBack: () -> Unit) {
    val user = state.adminUsers.firstOrNull { it.id == userId }
    if (user == null) {
        // Deleted from this page (or dropped out of the list) — nothing to show.
        LaunchedEffect(Unit) { onBack() }
        return
    }
    val p = ZkTheme.palette
    val selfIsAdmin = state.me?.isAdmin == true
    val isSelf = state.me?.id == userId
    val canModerate = selfIsAdmin || !user.isStaff
    val scope = rememberCoroutineScope()

    var account by remember(userId) { mutableStateOf<AdminAccount?>(null) }
    var notes by remember(userId) { mutableStateOf<List<StaffNote>?>(null) }
    var contacts by remember(userId) { mutableStateOf<AdminAccountContacts?>(null) }
    var loadingContacts by remember(userId) { mutableStateOf(false) }
    var banner by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<AccountDialog?>(null) }
    var draft by remember { mutableStateOf("") }
    var noteDraft by remember { mutableStateOf("") }
    var giftTier by remember { mutableStateOf<String?>(null) }

    suspend fun refreshAccount() {
        if (selfIsAdmin) runCatching { store.adminCall { adminAccount(userId) } }.onSuccess { account = it }
    }
    LaunchedEffect(userId) {
        refreshAccount()
        if (canModerate) notes = runCatching { store.adminCall { adminNotes(userId) } }.getOrDefault(emptyList())
    }
    LaunchedEffect(banner) {
        if (banner != null) { delay(3500); banner = null }
    }

    /** One action: page busy, server message shown on failure, record refreshed. */
    fun run(success: String?, work: suspend () -> Unit) {
        scope.launch {
            busy = true
            try {
                work()
                success?.let { banner = it to false }
                refreshAccount()
            } catch (e: Exception) {
                banner = (e.message ?: "Action failed") to true
            } finally {
                busy = false
            }
        }
    }

    BackHandler(onBack = onBack)
    ScreenScaffold(title = "@${user.username}", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            banner?.let { (text, isError) ->
                val c = if (isError) ZkStatus.danger else ZkStatus.online
                Text(
                    text, color = c, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.copy(alpha = 0.12f)).padding(10.dp),
                )
            }

            // Header
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(url = user.avatarUrl, name = user.name, size = 52.dp, toneId = user.id)
                Column(Modifier.padding(start = 12.dp).weight(1f)) {
                    Text(user.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("@${user.username}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
                        if (user.isAdmin) Pill("ADMINISTRATOR", p.accent)
                        if (user.isModerator) Pill("MODERATOR", MOD_SKY)
                        if (user.isBanned) Pill(user.bannedUntil?.let { "BANNED · UNTIL ${fmtDate(it)}" } ?: "BANNED", ZkStatus.danger)
                        if (user.isMuted) Pill(user.mutedUntil?.let { "MUTED · UNTIL ${fmtDateTime(it)}" } ?: "MUTED", MUTE_AMBER)
                        user.subscriptionTier?.let { Pill(it.uppercase(), p.accent2) }
                    }
                }
            }

            // Account — admins only
            if (selfIsAdmin) {
                Card("Account") {
                    val a = account
                    if (a == null) {
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.CenterHorizontally).size(24.dp))
                    } else {
                        InfoRow("Username", "@${a.username}", onEdit = { draft = a.username; dialog = AccountDialog.Username })
                        InfoRow("Email", a.email, note = if (a.emailVerified) "verified" else "unverified",
                            noteColor = if (a.emailVerified) ZkStatus.online else MUTE_AMBER,
                            onEdit = { draft = a.email; dialog = AccountDialog.Email })
                        InfoRow("Date of birth", a.dateOfBirth?.let(::fmtDob) ?: "Not on record",
                            note = listOfNotNull(if (a.isMinor) "minor" else null, if (a.dobLocked) "locked" else "self-change open").joinToString(" · "),
                            onEdit = { dialog = AccountDialog.Dob })
                        InfoRow("Joined", fmtDate(a.createdAt))
                        InfoRow("Last online", a.lastSeenAt?.let(::fmtDateTime) ?: "—")
                        InfoRow("Two-factor", if (a.twoFactorEnabled) "On" else "Off")
                        InfoRow("Signed-in devices", "${a.activeSessions}")
                        InfoRow("Servers / friends", "${a.guildCount} / ${a.friendCount}")
                        InfoRow("Perk tier", a.subscriptionTier?.let { t ->
                            "$t · " + (a.subscriptionExpiresAt?.let { "until ${fmtDate(it)}" } ?: "forever")
                        } ?: "None")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                            if (!isSelf) ActionChip("Send password reset") { dialog = AccountDialog.Reset }
                            ActionChip("Allow one DOB change") {
                                run("@${user.username} can change their date of birth once more") { store.adminCall { adminResetDobLock(userId) } }
                            }
                        }
                    }
                }
            }

            // Moderation
            if (!isSelf && canModerate) {
                Card("Moderation") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (user.isMuted) {
                            ActionChip("Unmute") {
                                run("Unmuted @${user.username}") {
                                    store.adminCall { adminUnmuteUser(userId) }
                                    store.patchAdminUser(userId) { it.copy(mutedAt = null, mutedUntil = null) }
                                }
                            }
                        } else {
                            ActionChip("Mute") { dialog = AccountDialog.Mute }
                        }
                        if (user.isBanned) {
                            ActionChip("Unban") {
                                run("Unbanned @${user.username}") {
                                    store.adminCall { adminUnbanUser(userId) }
                                    store.patchAdminUser(userId) { it.copy(bannedAt = null, bannedUntil = null) }
                                }
                            }
                        } else {
                            ActionChip("Ban", danger = true) { dialog = AccountDialog.Ban }
                            ActionChip("Sign out everywhere") {
                                run("Signed @${user.username} out of all devices") { store.adminCall { adminLogoutUser(userId) } }
                            }
                        }
                        if (!selfIsAdmin) {
                            ActionChip("Allow one DOB change") {
                                run("@${user.username} can change their date of birth once more") { store.adminCall { adminResetDobLock(userId) } }
                            }
                        }
                        if (selfIsAdmin) {
                            ActionChip("Role") { dialog = AccountDialog.Role }
                            ActionChip("Perk tier") { giftTier = null; dialog = AccountDialog.Gift }
                            ActionChip("Delete account", danger = true) { dialog = AccountDialog.Delete }
                        }
                    }
                }
            }
            if (!canModerate) {
                Text("Moderators can't act on staff accounts.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            }

            // Staff notes — admins and moderators
            if (canModerate) {
                Card("Staff notes") {
                    Text("Only staff can see these. The account never does.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                    Row(verticalAlignment = Alignment.Top) {
                        Field(noteDraft, { noteDraft = it.take(2000) }, "Add a note…", Modifier.weight(1f), singleLine = false)
                        Spacer(Modifier.width(8.dp))
                        val canAdd = noteDraft.isNotBlank() && !busy
                        Text(
                            "Add", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (canAdd) p.accent else p.accent.copy(alpha = 0.4f))
                                .clickable(enabled = canAdd) {
                                    val body = noteDraft.trim()
                                    run(null) {
                                        store.adminCall { adminAddNote(userId, body) }
                                        noteDraft = ""
                                        notes = store.adminCall { adminNotes(userId) }
                                    }
                                }
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                        )
                    }
                    val list = notes
                    when {
                        list == null -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.CenterHorizontally).size(24.dp))
                        list.isEmpty() -> Text("No notes yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                        else -> list.forEach { n ->
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bg1).padding(10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        (n.author?.let { "@${it.username}" } ?: "former staff") + " · " + fmtDateTime(n.createdAt),
                                        color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.weight(1f),
                                    )
                                    if (selfIsAdmin || n.author?.id == state.me?.id) {
                                        Icon(
                                            Icons.Filled.Delete, "Delete note", tint = ZkInk.ink3,
                                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(enabled = !busy) {
                                                run(null) {
                                                    store.adminCall { adminDeleteNote(userId, n.id) }
                                                    notes = notes?.filterNot { it.id == n.id }
                                                }
                                            }.padding(4.dp).size(16.dp),
                                        )
                                    }
                                }
                                Text(n.body, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
                            }
                        }
                    }
                }
            }

            // Contacts — admins only, loaded on request (viewing is audited)
            if (selfIsAdmin) {
                Card("Contacts") {
                    val c = contacts
                    when {
                        c != null -> {
                            ContactGroup("Friends", c.friends)
                            ContactGroup("Friend requests received", c.incomingRequests)
                            ContactGroup("Friend requests sent", c.outgoingRequests)
                            ContactGroup("Blocked", c.blocked)
                            ContactGroup("Direct messages with", c.dmPartners)
                            Text("Names only — message content is never shown.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                        }
                        loadingContacts -> CircularProgressIndicator(color = p.accent, modifier = Modifier.align(Alignment.CenterHorizontally).size(24.dp))
                        else -> {
                            ActionChip("Show contacts") {
                                loadingContacts = true
                                scope.launch {
                                    runCatching { store.adminCall { adminAccountContacts(userId) } }
                                        .onSuccess { contacts = it }
                                        .onFailure { banner = (it.message ?: "Couldn't load contacts.") to true }
                                    loadingContacts = false
                                }
                            }
                            Text("Viewing contacts is recorded in the staff log.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                        }
                    }
                }
            }
            Spacer(Modifier.heightIn(min = 24.dp))
        }
    }

    // ── Dialogs ──────────────────────────────────────────────────────────────
    val close = { dialog = null }
    when (dialog) {
        AccountDialog.Username, AccountDialog.Email -> {
            val isName = dialog == AccountDialog.Username
            AlertDialog(
                onDismissRequest = close,
                title = { Text(if (isName) "Change username" else "Change email", color = ZkInk.ink1, fontFamily = ZkSans) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Field(draft, { draft = it }, if (isName) "username" else "email", Modifier.fillMaxWidth(),
                            keyboardType = if (isName) KeyboardType.Text else KeyboardType.Email)
                        Text(
                            if (isName) "Doesn't use up their own username-change allowance."
                            else "The new address is treated as verified, and the old address is told it changed.",
                            color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                        )
                    }
                },
                confirmButton = {
                    TextButton(enabled = draft.isNotBlank(), onClick = {
                        val value = draft.trim().lowercase()
                        close()
                        if (isName) {
                            run("Username changed to @$value") {
                                store.adminCall { adminSetUsername(userId, value) }
                                store.patchAdminUser(userId) { it.copy(username = value) }
                            }
                        } else {
                            run("Email changed — the old address was notified") {
                                store.adminCall { adminSetEmail(userId, value) }
                                store.patchAdminUser(userId) { it.copy(email = value) }
                            }
                        }
                    }) { Text("Save", color = p.accent, fontFamily = ZkSans) }
                },
                dismissButton = { TextButton(onClick = close) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
                containerColor = p.bg2,
            )
        }
        AccountDialog.Dob -> {
            // Latest selectable day: exactly 13 years ago (the server's floor).
            val latest = LocalDate.now().minusYears(13)
            val initial = account?.dateOfBirth?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                ?: LocalDate.now().minusYears(18)
            val picker = rememberDatePickerState(
                initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
                selectableDates = object : SelectableDates {
                    override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                        !Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isAfter(latest)
                    override fun isSelectableYear(year: Int): Boolean = year in 1900..latest.year
                },
            )
            DatePickerDialog(
                onDismissRequest = close,
                confirmButton = {
                    TextButton(onClick = {
                        val ms = picker.selectedDateMillis ?: return@TextButton
                        // DatePicker selections are UTC midnight — read the day in UTC.
                        val dob = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate().toString()
                        close()
                        run("Date of birth updated") { store.adminCall { adminSetDateOfBirth(userId, dob) } }
                    }) { Text("Save", color = p.accent, fontFamily = ZkSans) }
                },
                dismissButton = { TextButton(onClick = close) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
            ) {
                DatePicker(state = picker, showModeToggle = false)
            }
        }
        AccountDialog.Reset -> ConfirmDialog(
            title = "Send a password reset?",
            body = "Emails @${user.username} the standard reset link and signs them out of every device. You never see the link or choose the password.",
            confirm = "Send reset link",
            onDismiss = close,
        ) {
            close()
            run("Reset link sent and all sessions signed out") { store.adminCall { adminSendPasswordReset(userId) } }
        }
        AccountDialog.Delete -> ConfirmDialog(
            title = "Delete account?",
            body = "Permanently deletes @${user.username}'s account and data. This can't be undone.",
            confirm = "Delete",
            danger = true,
            onDismiss = close,
        ) {
            close()
            run(null) {
                store.adminCall { adminDeleteUser(userId) }
                // Dropping the row makes `user` null, which pops this page.
                store.removeAdminUser(userId)
            }
        }
        AccountDialog.Mute -> ChoiceDialog(
            title = "Mute @${user.username}",
            note = "They can still sign in and read, but can't send messages or DMs, react, or talk in voice.",
            choices = listOf("1h" to "1 hour", "1d" to "1 day", "1w" to "1 week", "perm" to "Permanent"),
            onDismiss = close,
        ) { d ->
            close()
            run("Muted @${user.username}") {
                store.adminCall { adminMuteUser(userId, d) }
                val until = when (d) {
                    "1h" -> Instant.now().plusSeconds(3600)
                    "1d" -> Instant.now().plusSeconds(86_400)
                    "1w" -> Instant.now().plusSeconds(604_800)
                    else -> null
                }
                store.patchAdminUser(userId) { it.copy(mutedAt = Instant.now().toString(), mutedUntil = until?.toString()) }
            }
        }
        AccountDialog.Ban -> ChoiceDialog(
            title = "Ban @${user.username}",
            note = "Bans revoke sessions and evict from all voice until lifted.",
            choices = listOf("1m" to "1 month", "3m" to "3 months", "6m" to "6 months", "perm" to "Permanent"),
            onDismiss = close,
        ) { d ->
            close()
            run("Banned @${user.username}") {
                store.adminCall { adminBanUser(userId, d) }
                val months = mapOf("1m" to 1L, "3m" to 3L, "6m" to 6L)[d]
                store.patchAdminUser(userId) {
                    it.copy(bannedAt = Instant.now().toString(), bannedUntil = months?.let { m -> Instant.now().plusSeconds(m * 30 * 86_400).toString() })
                }
            }
        }
        AccountDialog.Role -> ChoiceDialog(
            title = "Instance role",
            note = null,
            choices = buildList {
                if (!user.isAdmin) add("administrator" to "Administrator")
                if (!user.isModerator) add("moderator" to "Moderator")
                if (user.isStaff) add("none" to "Remove role")
            },
            onDismiss = close,
        ) { role ->
            close()
            run("Role updated") {
                store.adminCall { adminSetRole(userId, role) }
                store.patchAdminUser(userId) { it.copy(isAdmin = role == "administrator", isModerator = role == "moderator") }
            }
        }
        AccountDialog.Gift -> {
            val tier = giftTier
            if (tier == null) {
                ChoiceDialog(
                    title = "Perk tier",
                    note = null,
                    choices = buildList {
                        add("scout" to "Give Scout"); add("guardian" to "Give Guardian"); add("legend" to "Give Legend")
                        if (user.subscriptionTier != null) add("reset" to "Remove tier")
                    },
                    onDismiss = close,
                ) { choice ->
                    if (choice == "reset") {
                        close()
                        run("Perk tier removed") {
                            store.adminCall { adminRemoveSubscription(userId) }
                            store.patchAdminUser(userId) { it.copy(subscriptionTier = null) }
                        }
                    } else {
                        giftTier = choice
                    }
                }
            } else {
                ChoiceDialog(
                    title = "Give ${tier.replaceFirstChar { it.uppercase() }} for…",
                    note = null,
                    choices = listOf("1m" to "1 month", "3m" to "3 months", "6m" to "6 months", "forever" to "Forever"),
                    onDismiss = close,
                ) { d ->
                    close()
                    run("Gave the $tier tier") {
                        store.adminCall { adminGiftSubscription(userId, tier, d) }
                        store.patchAdminUser(userId) { it.copy(subscriptionTier = tier) }
                    }
                }
            }
        }
        null -> Unit
    }
}

// ── Building blocks ──────────────────────────────────────────────────────────

@Composable
private fun Card(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(ZkTheme.palette.bg2).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title.uppercase(), color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        content()
    }
}

@Composable
private fun InfoRow(label: String, value: String, note: String? = null, noteColor: Color = ZkInk.ink3, onEdit: (() -> Unit)? = null) {
    Row(verticalAlignment = Alignment.Top) {
        Text(label, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.width(118.dp))
        Column(Modifier.weight(1f)) {
            Text(value, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp)
            if (!note.isNullOrBlank()) Text(note, color = noteColor, fontFamily = ZkSans, fontSize = 11.sp)
        }
        if (onEdit != null) {
            Icon(
                Icons.Filled.Edit, "Edit ${label.lowercase()}", tint = ZkInk.ink3,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onEdit).padding(6.dp).size(16.dp),
            )
        }
    }
}

@Composable
private fun ActionChip(label: String, danger: Boolean = false, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (danger) ZkStatus.danger else ZkInk.ink1,
        fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp))
            .background(if (danger) ZkStatus.danger.copy(alpha = 0.12f) else p.bg3)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
    )
}

@Composable
private fun Pill(label: String, color: Color) {
    Text(
        label, color = color, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp,
        modifier = Modifier.clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = 0.2f)).padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    val p = ZkTheme.palette
    Box(modifier.clip(RoundedCornerShape(8.dp)).background(p.bg1).padding(10.dp)) {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = singleLine,
            maxLines = if (singleLine) 1 else 5,
            textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp),
            cursorBrush = SolidColor(p.accent),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                if (value.isEmpty()) Text(placeholder, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 14.sp)
                inner()
            },
        )
    }
}

@Composable
private fun ContactGroup(title: String, people: List<AdminContactPerson>) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("$title (${people.size})", color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        if (people.isEmpty()) Text("None", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
        people.forEach { person ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(url = person.avatarUrl, name = person.name, size = 26.dp, toneId = person.id)
                Column(Modifier.padding(start = 8.dp)) {
                    Text(person.name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("@${person.username} · since ${fmtDate(person.since)}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirm: String,
    danger: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, color = ZkInk.ink1, fontFamily = ZkSans) },
        text = { Text(body, color = ZkInk.ink3, fontFamily = ZkSans) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirm, color = if (danger) ZkStatus.danger else ZkTheme.palette.accent, fontFamily = ZkSans)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
        containerColor = ZkTheme.palette.bg2,
    )
}

@Composable
private fun ChoiceDialog(
    title: String,
    note: String?,
    choices: List<Pair<String, String>>,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, color = ZkInk.ink1, fontFamily = ZkSans) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                note?.let { Text(it, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp)) }
                choices.forEach { (value, label) ->
                    Text(
                        label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { onPick(value) }.padding(vertical = 12.dp, horizontal = 8.dp),
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
        containerColor = ZkTheme.palette.bg2,
    )
}

// ── Dates ────────────────────────────────────────────────────────────────────

private fun fmtDate(iso: String): String = runCatching {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).toLocalDate().format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
}.getOrDefault("—")

private fun fmtDateTime(iso: String): String = runCatching {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
}.getOrDefault("—")

/** A stored DOB is a calendar day with no zone — format it as one. */
private fun fmtDob(dob: String): String = runCatching {
    LocalDate.parse(dob).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG))
}.getOrDefault(dob)
