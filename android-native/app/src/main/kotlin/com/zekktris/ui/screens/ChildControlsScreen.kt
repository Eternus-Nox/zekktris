package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.rememberCoroutineScope
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
import com.zekktris.data.model.ChildDM
import com.zekktris.data.model.ChildRelationship
import com.zekktris.data.model.ChildRestrictions
import com.zekktris.data.model.FamilyFlag
import com.zekktris.data.model.FamilyUser
import com.zekktris.data.model.PeekMessage
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PeekMessageRow
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.shortTime
import com.zekktris.ui.theme.ZkStatus
import kotlinx.coroutines.launch
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChildControlsScreen(store: AppStore, state: AppState, child: FamilyUser, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var words by remember(child.id) { mutableStateOf<List<String>?>(null) }
    var newWord by remember(child.id) { mutableStateOf("") }
    var flags by remember(child.id) { mutableStateOf<List<FamilyFlag>?>(null) }
    var childGuilds by remember(child.id) { mutableStateOf<List<com.zekktris.data.model.ChildGuild>?>(null) }
    var childFriends by remember(child.id) { mutableStateOf<List<ChildRelationship>?>(null) }
    var childDMs by remember(child.id) { mutableStateOf<List<ChildDM>?>(null) }
    var peekDM by remember(child.id) { mutableStateOf<ChildDM?>(null) }
    var peekFriend by remember(child.id) { mutableStateOf<ChildRelationship?>(null) }
    LaunchedEffect(child.id) {
        store.loadChildRestrictions(child.id)
        words = store.familyWatchWords(child.id)
        flags = store.familyChildFlags(child.id)
        childGuilds = store.familyChildGuilds(child.id)
        childFriends = store.familyChildFriends(child.id)
        childDMs = store.familyChildDMs(child.id)
    }
    val r = state.childRestrictions[child.id]

    // A supervised DM conversation is pushed as its own full-screen route
    // (iOS ChildDMMessagesView), not a bottom sheet.
    val activeDM = peekDM
    if (activeDM != null) {
        ChildDMMessagesScreen(store, child, activeDM) { peekDM = null }
        return
    }

    ScreenScaffold(child.name, onBack = onBack) {
        if (r == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = p.accent)
            }
            return@ScreenScaffold
        }
        fun save(next: ChildRestrictions) = store.setChildRestrictions(child.id, next)

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            SectionLabel("WHAT ${child.name.uppercase()} CAN DO")
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                ToggleRow("Add friends", r.canAddFriends) { save(r.copy(canAddFriends = it)) }
                Divider()
                ToggleRow("Remove friends", r.canRemoveFriends) { save(r.copy(canRemoveFriends = it)) }
                Divider()
                ToggleRow("Join voice channels", r.allowVoice) { save(r.copy(allowVoice = it)) }
                Divider()
                ToggleRow("Use video", r.allowVideo) { save(r.copy(allowVideo = it)) }
                Divider()
                ToggleRow("Stream", r.allowStream) { save(r.copy(allowStream = it)) }
                Divider()
                ToggleRow("Join servers", r.allowJoinGuilds) { save(r.copy(allowJoinGuilds = it)) }
                Divider()
                ToggleRow("Send messages", r.allowMessaging) { save(r.copy(allowMessaging = it)) }
                Divider()
                ToggleRow("Create servers", r.allowCreateGuild) { save(r.copy(allowCreateGuild = it)) }
            }

            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                ToggleRow("Blur swear words", r.filterProfanity) { save(r.copy(filterProfanity = it)) }
            }

            // Who they can DM — one joined segmented control (None / Friends / Anyone).
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Who they can DM", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
                DmSegmented(r.dmPolicy) { save(r.copy(dmPolicy = it)) }
            }

            Text(
                "Changes apply to ${child.name}'s account immediately.",
                color = ZkInk.ink3,
                fontFamily = ZkSans,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 4.dp),
            )

            // ---- Child's servers (block on their behalf) ----------------------
            SectionLabel("${child.name.uppercase()}'S SERVERS")
            val g = childGuilds
            if (g != null && g.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                    g.forEachIndexed { i, guild ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(url = guild.iconUrl, name = guild.name, size = 32.dp)
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Text(guild.name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (guild.blocked) Text("Blocked", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 11.sp)
                            }
                            BlockCapsule(guild.blocked) {
                                scope.launch { if (store.familySetGuildBlocked(child.id, guild.id, !guild.blocked)) childGuilds = store.familyChildGuilds(child.id) }
                            }
                        }
                        if (i < g.lastIndex) Divider()
                    }
                }
                Text(
                    "Blocking hides the server and prevents rejoining until unblocked.",
                    color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
                )
            } else if (g != null) {
                Text("Not a member of any servers.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            }

            // ---- Child's friends (observe + block on their behalf) ------------
            SectionLabel("${child.name.uppercase()}'S FRIENDS")
            val allRel = childFriends
            val friendRows = allRel?.filter { it.type == "friend" }.orEmpty()
            val blockedRows = allRel?.filter { it.type == "blocked" }.orEmpty()
            if (allRel != null && (friendRows.isNotEmpty() || blockedRows.isNotEmpty())) {
                if (friendRows.isNotEmpty()) FriendCard(friendRows) { peekFriend = it }
                if (blockedRows.isNotEmpty()) {
                    Text("BLOCKED", color = ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp))
                    FriendCard(blockedRows) { peekFriend = it }
                }
                Text(
                    "Tap a person to view their profile, or block them on ${child.name}'s behalf.",
                    color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
                )
            } else if (allRel != null) {
                Text("No friends yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            }

            // ---- Child's direct messages (read-only oversight) ----------------
            SectionLabel("${child.name.uppercase()}'S DIRECT MESSAGES")
            val dm = childDMs
            if (dm != null && dm.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                    dm.forEachIndexed { i, conv ->
                        Row(
                            Modifier.fillMaxWidth().clickable { peekDM = conv }.padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Avatar(url = conv.recipient?.avatarUrl, name = conv.recipient?.bestName ?: "?", size = 32.dp)
                            Text(
                                conv.recipient?.bestName ?: "Unknown",
                                color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f).padding(start = 10.dp),
                            )
                            Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink4, modifier = Modifier.size(18.dp))
                        }
                        if (i < dm.lastIndex) Divider()
                    }
                }
                Text(
                    "Conversations are read-only. Messages ${child.name} deleted stay visible here, labelled.",
                    color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
                )
            } else if (dm != null) {
                Text("No direct messages.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp)
            }

            // ---- Watch words ---------------------------------------------------
            SectionLabel("WATCH WORDS")
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(12.dp)) {
                Text(
                    "Messages ${child.name} sends or receives containing one of these words get flagged for you to review. Matching is case-insensitive. Add several at once separated by commas.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                )
                Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTextField(newWord, { newWord = it.take(40) }, "e.g. address, phone number", Modifier.weight(1f))
                    val ok = newWord.isNotBlank()
                    Text(
                        "Add",
                        color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (ok) p.accent.copy(alpha = 0.18f) else p.bg3)
                            .border(1.dp, if (ok) p.accent.copy(alpha = 0.4f) else Color.Transparent, RoundedCornerShape(10.dp))
                            .let { if (ok) it.clickable { scope.launch { store.familyAddWatchWord(child.id, newWord)?.let { u -> words = u; newWord = "" } } } else it }
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                    )
                }
                val w = words
                when {
                    w == null -> Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.size(20.dp))
                    }
                    w.isEmpty() -> Text("No watch words yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
                    else -> FlowRow(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        w.forEach { word ->
                            Row(
                                Modifier.clip(CircleShape).background(p.bg2).border(1.dp, p.line, CircleShape).padding(start = 10.dp, end = 7.dp, top = 6.dp, bottom = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(word, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 13.sp)
                                Icon(Icons.Filled.Close, "Remove", tint = ZkInk.ink3, modifier = Modifier.padding(start = 4.dp).clip(CircleShape).clickable { scope.launch { store.familyRemoveWatchWord(child.id, word)?.let { words = it } } }.size(14.dp))
                            }
                        }
                    }
                }
            }

            // ---- Flagged messages ---------------------------------------------
            SectionLabel("FLAGGED MESSAGES")
            val f = flags
            when {
                f == null -> Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = p.accent, modifier = Modifier.size(22.dp))
                }
                f.isEmpty() -> Text("No flagged messages.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    f.forEach { flag ->
                        val reviewed = flag.reviewed
                        Column(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (reviewed) p.bg2 else ZkStatus.idle.copy(alpha = 0.10f))
                                .border(1.dp, if (reviewed) p.line else ZkStatus.idle.copy(alpha = 0.30f), RoundedCornerShape(12.dp))
                                .clickable(enabled = !reviewed) {
                                    // Match iOS/web: reviewing CLEARS the flag from
                                    // the alert list (MainView.swift:9480-9486).
                                    store.familyMarkFlagReviewed(flag.id) { flags = flags?.filterNot { x -> x.id == flag.id } }
                                }
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    flag.matchedWord,
                                    color = ZkStatus.idle, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
                                    modifier = Modifier.clip(CircleShape).background(ZkStatus.idle.copy(alpha = 0.15f)).padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                                Text(
                                    if (flag.byChild) "${child.name} sent" else "received",
                                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp),
                                )
                                Box(Modifier.weight(1f))
                                Text(shortTime(flag.createdAt), color = ZkInk.ink4, fontFamily = ZkMono, fontSize = 10.sp)
                            }
                            flag.snippet?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                            }
                        }
                    }
                }
            }
        }

        peekFriend?.let { rel ->
            ChildFriendProfileSheet(store, child, rel, onChanged = {
                scope.launch { childFriends = store.familyChildFriends(child.id) }
            }) { peekFriend = null }
        }
    }
}

/// Full-screen read-only view of one supervised DM conversation (iOS
/// ChildDMMessagesView). Renders the slim PeekMessage DTOs.
@Composable
private fun ChildDMMessagesScreen(store: AppStore, child: FamilyUser, dm: ChildDM, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var messages by remember(dm.id) { mutableStateOf<List<PeekMessage>?>(null) }
    LaunchedEffect(dm.id) { messages = store.familyChildDMMessages(child.id, dm.id) }
    BackHandler { onBack() }

    ScreenScaffold("${child.name} & ${dm.recipient?.bestName ?: "Unknown"}", onBack = onBack) {
        val m = messages
        when {
            m == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = p.accent)
            }
            m.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No messages in this conversation.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            }
            else -> LazyColumn(
                Modifier.fillMaxWidth().fillMaxHeight().padding(horizontal = 14.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // API returns newest-first; show oldest-first (bottom = newest).
                items(m.reversed(), key = { it.id }) { PeekMessageRow(it) }
            }
        }
    }
}

/// Read-only profile of one of the child's contacts, with the parent-side
/// block/unblock action (iOS ChildFriendProfileSheet).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChildFriendProfileSheet(
    store: AppStore,
    child: FamilyUser,
    rel: ChildRelationship,
    onChanged: () -> Unit,
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    val blocked = rel.type == "blocked"
    var busy by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Avatar(url = rel.user.avatarUrl, name = rel.user.bestName, size = 84.dp)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(rel.user.bestName, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                rel.user.username?.let { Text("@$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp) }
                rel.user.customStatus?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                }
            }
            Text(
                if (blocked) "Blocked for ${child.name}" else "Friends with ${child.name}",
                color = if (blocked) ZkStatus.dangerSoft else ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 12.sp,
                modifier = Modifier.clip(CircleShape).background(p.bg2).padding(horizontal = 10.dp, vertical = 5.dp),
            )
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                    .background(if (blocked) p.bg3 else ZkStatus.danger)
                    .clickable(enabled = !busy) {
                        scope.launch {
                            busy = true
                            val ok = store.familySetUserBlocked(child.id, rel.user.id, !blocked)
                            busy = false
                            if (ok) { onChanged(); onDismiss() }
                        }
                    }
                    .padding(vertical = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (busy) {
                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(18.dp))
                } else {
                    Text(
                        if (blocked) "Unblock for ${child.name}" else "Block for ${child.name}",
                        color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                    )
                }
            }
            if (!blocked) {
                Text(
                    "Blocking removes the friendship and prevents messages and calls between them.",
                    color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
                )
            }
            Box(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun FriendCard(rows: List<ChildRelationship>, onOpen: (ChildRelationship) -> Unit) {
    val p = ZkTheme.palette
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
        rows.forEachIndexed { i, rel ->
            val blocked = rel.type == "blocked"
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(rel) }.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(url = rel.user.avatarUrl, name = rel.user.bestName, size = 32.dp)
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    Text(rel.user.bestName, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    rel.user.username?.let { Text("@$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp) }
                }
                if (blocked) Text("Blocked", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(end = 8.dp))
                Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink4, modifier = Modifier.size(18.dp))
            }
            if (i < rows.lastIndex) Divider()
        }
    }
}

@Composable
private fun BlockCapsule(blocked: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        if (blocked) "Unblock" else "Block",
        color = if (blocked) ZkInk.ink2 else ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(if (blocked) p.bg3 else ZkStatus.danger.copy(alpha = 0.15f)).clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = p.accent,
                uncheckedThumbColor = ZkInk.ink3,
                uncheckedTrackColor = p.bg3,
                uncheckedBorderColor = p.line,
            ),
        )
    }
}

@Composable
private fun Divider() {
    Box(Modifier.fillMaxWidth().padding(start = 14.dp).height(1.dp).background(ZkTheme.palette.line))
}

/// One joined 3-segment control (None / Friends / Anyone) matching the iOS
/// .segmented Picker: shared rounded container, equal-width segments, the
/// active segment accent-filled.
@Composable
private fun DmSegmented(value: String, onChange: (String) -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.width(210.dp).clip(RoundedCornerShape(8.dp)).background(p.bg3).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        listOf("none" to "None", "friends" to "Friends", "all" to "Anyone").forEach { (key, label) ->
            val selected = value == key
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(6.dp)).background(if (selected) p.accent else Color.Transparent).clickable { onChange(key) }.padding(vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (selected) p.bg0 else ZkInk.ink2,
                    fontFamily = ZkSans,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    fontSize = 12.sp,
                )
            }
        }
    }
}
