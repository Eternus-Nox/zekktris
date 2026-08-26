package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Comment
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.VerifiedUser
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppStore
import com.zekktris.data.model.MonetizationConfig
import com.zekktris.data.model.QualityTiers
import com.zekktris.data.model.SecurityConfig
import com.zekktris.data.model.SecurityEvent
import com.zekktris.data.model.SecurityWord
import com.zekktris.data.model.UploadCapsMb
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.shortTime
import com.zekktris.ui.theme.ZkFx
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

// ── Security tab ─────────────────────────────────────────────────────────────

@Composable
fun AdminSecurityTab(store: AppStore, isAdmin: Boolean) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf<SecurityConfig?>(null) }
    var words by remember { mutableStateOf<List<SecurityWord>>(emptyList()) }
    var events by remember { mutableStateOf<List<SecurityEvent>?>(null) }
    var filter by remember { mutableStateOf<String?>(null) }
    var newWord by remember { mutableStateOf("") }
    var newSeverity by remember { mutableStateOf("blocked") }
    var showPreset by remember { mutableStateOf(false) }
    // Kept apart so the events reload can't clear a config/words failure (the
    // two effects race) and vice versa.
    var configError by remember { mutableStateOf<String?>(null) }
    var logError by remember { mutableStateOf<String?>(null) }

    // Admin-only fetches: moderators get 403 on config/words, so we don't ask.
    LaunchedEffect(Unit) {
        if (!isAdmin) return@LaunchedEffect
        store.adminSecurityConfig()
            .onSuccess { config = it }
            .onFailure { configError = "Couldn't load security settings." }
        store.adminSecurityWords()
            .onSuccess { words = it }
            .onFailure { configError = "Couldn't load security settings." }
    }
    // Owns the events GET — this effect also runs on first composition, so a
    // separate load in the LaunchedEffect(Unit) above would double-fetch.
    LaunchedEffect(filter) {
        store.adminSecurityEvents(filter)
            .onSuccess { events = it; logError = null }
            .onFailure { events = emptyList(); logError = "Couldn't load the security log." }
    }

    fun patch(next: SecurityConfig) {
        config = next
        scope.launch { store.adminPatchSecurityConfig(next)?.let { config = it } }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        (configError ?: logError)?.let {
            Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp)
        }

        if (isAdmin) {
            config?.let { c ->
                // ── Spam throttle ──
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("SPAM PROTECTION")
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(vertical = 4.dp)) {
                        ToggleLine("Rate-limit spammers", c.spamEnabled) { patch(c.copy(spamEnabled = it)) }
                        // Server caps these at 2..100 and 60..86400s; without the
                        // upper clamp "+" PATCHes a 400 and the optimistic write
                        // leaves a value on screen the server never accepted.
                        StepperLine("Trigger", "msgs / ${c.spamWindowSeconds}s", c.spamMaxMessages, 2..100) {
                            patch(c.copy(spamMaxMessages = it))
                        }
                        StepperLine("Cooldown", "minutes at 1 msg/min", c.spamCooldownSeconds / 60, 1..1440) {
                            patch(c.copy(spamCooldownSeconds = it * 60))
                        }
                    }
                    Text(
                        "After the trigger, the user can only send one message per minute until the cooldown ends. " +
                            "Encrypted conversations are never metered or inspected.",
                        color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp,
                    )
                }

                // ── Banned words ──
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionLabel("BANNED WORDS")
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(vertical = 4.dp)) {
                        ToggleLine("Block banned words", c.wordFilterEnabled) { patch(c.copy(wordFilterEnabled = it)) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(p.bg0).padding(horizontal = 10.dp, vertical = 9.dp)) {
                            BasicTextField(
                                value = newWord, onValueChange = { newWord = it },
                                singleLine = true,
                                textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp),
                                cursorBrush = SolidColor(p.accent),
                                modifier = Modifier.fillMaxWidth(),
                                decorationBox = { inner ->
                                    if (newWord.isEmpty()) Text("Add a word…", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 14.sp)
                                    inner()
                                },
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                        SegChip("Block", newSeverity == "blocked") { newSeverity = "blocked" }
                        SegChip("Watch", newSeverity == "watch") { newSeverity = "watch" }
                        Spacer(Modifier.width(6.dp))
                        Icon(
                            Icons.Filled.Add, "Add word",
                            tint = if (newWord.isNotBlank()) p.accent else ZkInk.ink4,
                            modifier = Modifier.clip(CircleShape).clickable(enabled = newWord.isNotBlank()) {
                                val w = newWord.trim().lowercase(); newWord = ""
                                scope.launch { store.adminAddSecurityWord(w, newSeverity)?.let { words = it } }
                            }.padding(4.dp).size(20.dp),
                        )
                    }
                    // Opens the browser — adding the whole list is a deliberate
                    // secondary action inside the sheet, never a single tap here.
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(50))
                            .background(p.accent.copy(alpha = 0.12f))
                            .clickable { showPreset = true }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.PlaylistAdd, null, tint = p.accent, modifier = Modifier.size(14.dp))
                        Text("Common wordlist…", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    }
                    Text(
                        "Blocked words are rejected in messages and can't appear in usernames, display names, or clan tags. " +
                            "Watch words are logged only — the message still sends.",
                        color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp,
                    )
                    val blockedWords = words.filter { it.severity == "blocked" }
                    val watchWords = words.filter { it.severity == "watch" }
                    if (words.isEmpty()) {
                        Text(
                            "No words yet. Blocked words are rejected and reported here; watch words are logged.",
                            color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp,
                        )
                    } else {
                        if (blockedWords.isNotEmpty()) WordChips("BLOCKED — HARD BLOCK", blockedWords, ZkStatus.dangerSoft) { w ->
                            scope.launch { store.adminRemoveSecurityWord(w)?.let { words = it } }
                        }
                        if (watchWords.isNotEmpty()) WordChips("WATCH — ALERT ONLY", watchWords, ZkStatus.warning) { w ->
                            scope.launch { store.adminRemoveSecurityWord(w)?.let { words = it } }
                        }
                    }
                }
            }
        }

        // Security log (all staff).
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("SECURITY LOG")
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip("All", filter == null) { filter = null }
                FilterChip("Spam", filter == "spam_limited") { filter = "spam_limited" }
                FilterChip("Banned words", filter == "banned_word") { filter = "banned_word" }
                FilterChip("Staff", filter == "staff") { filter = "staff" }
            }
            val evs = events
            when {
                evs == null -> Box(Modifier.fillMaxWidth().padding(20.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = p.accent)
                }
                evs.isEmpty() -> Text("Nothing logged. That's a good sign.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                else -> evs.forEach { ev -> EventRow(ev) }
            }
        }
    }

    if (showPreset) {
        AdminPresetWordsSheet(
            store = store,
            words = words,
            onWords = { words = it },
            onDismiss = { showPreset = false },
        )
    }
}

@Composable
private fun ToggleLine(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Switch(
            checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White, checkedTrackColor = p.accent,
                uncheckedThumbColor = ZkInk.ink3, uncheckedTrackColor = p.bg3, uncheckedBorderColor = p.line,
            ),
        )
    }
}

/** Two-line leading label + bare number, clamped to the server's accepted
 *  [range] (stepping past it would PATCH a 400 the UI never surfaces). */
@Composable
private fun StepperLine(label: String, detail: String, value: Int, range: IntRange, onSet: (Int) -> Unit) {
    val p = ZkTheme.palette
    val canMinus = value > range.first
    val canPlus = value < range.last
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp)
            Text(detail, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 10.sp)
        }
        Text(
            "$value",
            color = p.accent, fontFamily = ZkMono, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
            modifier = Modifier.padding(end = 4.dp),
        )
        Text(
            "−", color = if (canMinus) p.accent else ZkInk.ink4, fontSize = 18.sp,
            modifier = Modifier.clip(CircleShape)
                .clickable(enabled = canMinus) { onSet(value - 1) }
                .padding(horizontal = 10.dp, vertical = 2.dp),
        )
        Text(
            "+", color = if (canPlus) p.accent else ZkInk.ink4, fontSize = 18.sp,
            modifier = Modifier.clip(CircleShape)
                .clickable(enabled = canPlus) { onSet(value + 1) }
                .padding(horizontal = 10.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun SegChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) p.bg0 else ZkInk.ink2,
        fontFamily = ZkSans, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, fontSize = 11.sp,
        modifier = Modifier.clip(RoundedCornerShape(7.dp)).background(if (selected) p.accent else p.bg3).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 5.dp),
    )
}

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) p.bg0 else ZkInk.ink2,
        fontFamily = ZkSans, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, fontSize = 12.sp,
        modifier = Modifier.clip(CircleShape).background(if (selected) p.accent else p.bg2).clickable(onClick = onClick).padding(horizontal = 11.dp, vertical = 6.dp),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WordChips(title: String, list: List<SecurityWord>, color: Color, onRemove: (String) -> Unit) {
    Column {
        Text(title, color = color, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
        // Wraps — a long blocklist used to scroll off the side of the screen.
        FlowRow(
            Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            list.forEach { w ->
                Row(
                    Modifier.clip(RoundedCornerShape(8.dp)).background(color.copy(alpha = 0.12f)).padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(w.word, color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 12.sp)
                    Icon(
                        Icons.Filled.Close, "Remove", tint = ZkInk.ink3,
                        modifier = Modifier.padding(start = 5.dp).clickable { onRemove(w.word) }.size(12.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun EventRow(ev: SecurityEvent) {
    val p = ZkTheme.palette
    // Mirrors iOS's three symbols/tints. plasmaAmber (0xFFB000) is NOT
    // ZkStatus.warning (0xF59E0B) — the log deliberately uses the plasma tone.
    val icon = when {
        ev.isStaffAction -> Icons.Filled.VerifiedUser
        ev.kind == "banned_word" -> Icons.AutoMirrored.Filled.Comment
        else -> Icons.Filled.Speed
    }
    val tint = when {
        ev.isStaffAction -> Color(0xFF38BDF8)
        ev.kind == "banned_word" -> ZkStatus.dangerSoft
        else -> ZkFx.plasmaAmber
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(11.dp))
            Text(
                ev.actorName + (ev.targetName?.let { " → $it" } ?: ""),
                color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 6.dp).weight(1f),
            )
            Text(shortTime(ev.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 10.sp)
        }
        if (ev.detail.isNotBlank()) {
            Text(ev.detail, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
        }
        ev.contentSnapshot?.takeIf { it.isNotBlank() }?.let {
            Text(
                it, color = ZkInk.ink3, fontFamily = ZkMono, fontSize = 11.sp,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp).fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(p.bg0).padding(6.dp),
            )
        }
    }
}

/**
 * Browser for the server's common moderation wordlist: tap a word to ban it on
 * this instance, or "Add all". Already-banned words show a check. Mirrors iOS
 * PresetWordsSheet — browsing is the point, bulk-add is the secondary action.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun AdminPresetWordsSheet(
    store: AppStore,
    words: List<SecurityWord>,
    onWords: (List<SecurityWord>) -> Unit,
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var preset by remember { mutableStateOf<List<String>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var addingAll by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        store.adminSecurityWordPreset()
            .onSuccess { preset = it }
            .onFailure { error = "Couldn't load the wordlist." }
        loading = false
    }

    val allAdded = preset.isNotEmpty() && preset.all { w -> words.any { it.word == w } }
    val canAddAll = !addingAll && !loading && !allAdded

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(bottom = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.ChevronLeft, "Close", tint = ZkInk.ink2, modifier = Modifier.size(20.dp))
                }
                Text(
                    "Common wordlist",
                    color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 17.sp,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    Modifier.heightIn(min = 44.dp).padding(end = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (addingAll) {
                        CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    } else {
                        Text(
                            "Add all",
                            color = if (canAddAll) p.accent else ZkInk.ink4,
                            fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = canAddAll) {
                                addingAll = true
                                scope.launch {
                                    store.adminApplyWordPreset()?.let(onWords)
                                    addingAll = false
                                }
                            }.padding(horizontal = 8.dp, vertical = 8.dp),
                        )
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    "Tap a word to ban it on this instance. Checked words are already banned.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                )
                error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
                if (loading) {
                    Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = p.accent)
                    }
                } else {
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        preset.forEach { w ->
                            PresetPill(w, added = words.any { it.word == w }) {
                                scope.launch { store.adminAddSecurityWord(w, "blocked")?.let(onWords) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PresetPill(word: String, added: Boolean, onAdd: () -> Unit) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .clip(shape)
            .background(p.bg2.copy(alpha = if (added) 0.55f else 1f))
            .border(1.dp, if (added) p.line else p.accent.copy(alpha = 0.35f), shape)
            .clickable(enabled = !added, onClick = onAdd)
            .padding(horizontal = 9.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            if (added) Icons.Filled.Check else Icons.Filled.Add,
            contentDescription = null,
            tint = if (added) ZkStatus.success else p.accent,
            modifier = Modifier.size(10.dp),
        )
        Text(
            word,
            color = if (added) ZkInk.ink4 else ZkInk.ink1,
            fontFamily = ZkMono, fontSize = 12.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

// ── Monetization tab ─────────────────────────────────────────────────────────

private val TIER_OPTIONS = listOf("none" to "Everyone", "scout" to "Scout", "guardian" to "Guardian", "legend" to "Legend")

@Composable
fun AdminMonetizationTab(store: AppStore) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf<MonetizationConfig?>(null) }
    var saveState by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { config = store.getMonetization() }

    val c = config
    if (c == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
        return
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "Minimum membership tier for each feature. \"Everyone\" removes the gate.",
            color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
        )
        SectionLabel("SCREEN SHARE — MIN TIER")
        TierPickerRow("1080p", c.stream.p1080) { config = c.copy(stream = c.stream.copy(p1080 = it)); saveState = null }
        TierPickerRow("2K", c.stream.k2) { config = c.copy(stream = c.stream.copy(k2 = it)); saveState = null }
        TierPickerRow("4K", c.stream.k4) { config = c.copy(stream = c.stream.copy(k4 = it)); saveState = null }
        SectionLabel("CAMERA — MIN TIER")
        TierPickerRow("1080p", c.camera.p1080) { config = c.copy(camera = c.camera.copy(p1080 = it)); saveState = null }
        TierPickerRow("2K", c.camera.k2) { config = c.copy(camera = c.camera.copy(k2 = it)); saveState = null }
        TierPickerRow("4K", c.camera.k4) { config = c.copy(camera = c.camera.copy(k4 = it)); saveState = null }
        SectionLabel("APPEARANCE / COSMETICS")
        TierPickerRow("Min tier", c.appearance) { config = c.copy(appearance = it); saveState = null }
        SectionLabel("UPLOAD CAPS — MB (BLANK = SERVER DEFAULT)")
        CapRow("Free", c.uploadCapsMb.free) { config = c.copy(uploadCapsMb = c.uploadCapsMb.copy(free = it)); saveState = null }
        CapRow("Scout", c.uploadCapsMb.scout) { config = c.copy(uploadCapsMb = c.uploadCapsMb.copy(scout = it)); saveState = null }
        CapRow("Guardian", c.uploadCapsMb.guardian) { config = c.copy(uploadCapsMb = c.uploadCapsMb.copy(guardian = it)); saveState = null }
        CapRow("Legend", c.uploadCapsMb.legend) { config = c.copy(uploadCapsMb = c.uploadCapsMb.copy(legend = it)); saveState = null }
        PrimaryButton(saveState ?: "Save changes") {
            saveState = "Saving…"
            scope.launch {
                val echoed = store.putMonetization(config ?: return@launch)
                if (echoed != null) { config = echoed; saveState = "Saved ✓" } else saveState = "Save failed — retry"
            }
        }
    }
}

@Composable
private fun TierPickerRow(label: String, value: String, onPick: (String) -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
        TIER_OPTIONS.forEach { (id, name) ->
            val selected = value == id
            Text(
                name,
                color = if (selected) p.bg0 else ZkInk.ink3,
                fontFamily = ZkSans, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, fontSize = 10.sp,
                modifier = Modifier
                    .padding(start = 3.dp)
                    .clip(RoundedCornerShape(7.dp))
                    .background(if (selected) p.accent else p.bg3)
                    .clickable { onPick(id) }
                    .padding(horizontal = 6.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun CapRow(label: String, value: Int?, onChange: (Int?) -> Unit) {
    val p = ZkTheme.palette
    var text by remember(label) { mutableStateOf(value?.toString() ?: "") }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Box(Modifier.width(90.dp).clip(RoundedCornerShape(7.dp)).background(p.bg3).padding(horizontal = 8.dp, vertical = 7.dp)) {
            BasicTextField(
                value = text,
                onValueChange = { v ->
                    val digits = v.filter(Char::isDigit).take(6)
                    text = digits
                    onChange(digits.toIntOrNull())
                },
                singleLine = true,
                textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 13.sp),
                cursorBrush = SolidColor(p.accent),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (text.isEmpty()) Text("default", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp)
                    inner()
                },
            )
        }
        Text("MB", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
    }
}
