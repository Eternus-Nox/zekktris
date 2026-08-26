package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Bot
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

/**
 * Owner-facing bot management: create bots, reveal one-time tokens, regenerate
 * or delete, add a bot to a server you own, and configure an event callback.
 * Mirrors the iOS BotsView.
 */
@Composable
fun BotsScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var uname by remember { mutableStateOf("") }
    var dname by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // The plaintext token/secret is shown exactly once, right after create/regen.
    var oneTimeToken by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { store.loadBots() }

    ScreenScaffold("Bots", onBack) {
        LazyColumn(
            Modifier.fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Column {
                    SectionLabel("CREATE A BOT")
                    Spacer(Modifier.height(8.dp))
                    FilledTextField(uname, { uname = it.take(32); error = null }, "username", Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    FilledTextField(dname, { dname = it.take(80); error = null }, "display name", Modifier.fillMaxWidth())
                    error?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp)
                    }
                    Spacer(Modifier.height(10.dp))
                    PrimaryButton(if (busy) "Creating…" else "Create bot", enabled = !busy && uname.isNotBlank() && dname.isNotBlank()) {
                        busy = true; error = null
                        scope.launch {
                            val r = store.createBot(uname, dname)
                            busy = false
                            r.onSuccess { oneTimeToken = it; uname = ""; dname = "" }
                                .onFailure { error = it.message ?: "Couldn't create bot" }
                        }
                    }
                }
            }

            oneTimeToken?.let { token ->
                item { TokenCallout(token) { oneTimeToken = null } }
            }

            item { SectionLabel("YOUR BOTS") }
            if (state.bots.isEmpty()) {
                item { Text("You haven't created any bots yet.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp) }
            } else {
                items(state.bots, key = { it.id }) { bot ->
                    BotCard(store, state, bot, onToken = { oneTimeToken = it })
                }
            }
        }
    }
}

/** One-time secret reveal: a violet callout with a copy button and a warning. */
@Composable
private fun TokenCallout(token: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.accent.copy(alpha = 0.12f)).padding(12.dp),
    ) {
        Text("COPY THIS NOW", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp)
        Text("You won't be able to see it again.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(8.dp)).background(p.bg0).padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                token, color = ZkInk.ink1, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Filled.ContentCopy, "Copy", tint = p.accent,
                modifier = Modifier.padding(start = 8.dp).clip(RoundedCornerShape(6.dp))
                    .clickable { clipboard.setText(AnnotatedString(token)) }.padding(4.dp).size(20.dp),
            )
        }
        Text(
            "Done", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
            modifier = Modifier.padding(top = 8.dp).clickable(onClick = onDismiss),
        )
    }
}

@Composable
private fun BotCard(store: AppStore, state: AppState, bot: Bot, onToken: (String) -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf(false) }
    var showServers by remember { mutableStateOf(false) }
    var showEvents by remember { mutableStateOf(false) }
    var eventUrl by remember(bot.id) { mutableStateOf(bot.botEventUrl ?: "") }
    var eventSecret by remember(bot.id) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val ownedGuilds = state.guilds.filter { it.ownerId != null && it.ownerId == state.me?.id }

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(url = bot.avatarUrl, name = bot.name, size = 36.dp)
            Column(Modifier.padding(start = 10.dp).weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(bot.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("BOT", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp, modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(3.dp)).background(p.accent.copy(alpha = 0.2f)).padding(horizontal = 4.dp, vertical = 1.dp))
                }
                bot.username?.let { Text("@$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp) }
            }
        }

        // Action chips.
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Regenerate token", enabled = !busy) {
                busy = true
                scope.launch {
                    val r = store.regenerateBotToken(bot.id)
                    busy = false
                    r.onSuccess { onToken(it) }
                }
            }
            Chip(if (showEvents) "Events ▲" else "Events") { showEvents = !showEvents; showServers = false }
        }
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ownedGuilds.isNotEmpty()) {
                Chip(if (showServers) "Add to server ▲" else "Add to server") { showServers = !showServers; showEvents = false }
            }
            Chip(if (confirmDelete) "Confirm delete" else "Delete", danger = true, enabled = !busy) {
                if (!confirmDelete) { confirmDelete = true } else {
                    busy = true; scope.launch { store.deleteBot(bot.id); busy = false }
                }
            }
        }

        // Add-to-server picker.
        if (showServers) {
            Column(Modifier.padding(top = 10.dp)) {
                SectionLabel("ADD TO A SERVER YOU OWN")
                ownedGuilds.forEach { g ->
                    Text(
                        g.name ?: "Server",
                        color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp,
                        modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) {
                            busy = true
                            scope.launch { store.addBotToGuild(g.id, bot.id); busy = false; showServers = false }
                        }.padding(vertical = 10.dp),
                    )
                }
            }
        }

        // Event callback editor.
        if (showEvents) {
            Column(Modifier.padding(top = 10.dp)) {
                SectionLabel("EVENT CALLBACK URL")
                Text("We POST signed message events to this HTTPS URL.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(vertical = 4.dp))
                FilledTextField(eventUrl, { eventUrl = it }, "https://example.com/webhook", Modifier.fillMaxWidth())
                eventSecret?.let { secret ->
                    Spacer(Modifier.height(8.dp))
                    TokenCallout(secret) { eventSecret = null }
                }
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip(if (busy) "Saving…" else "Save", enabled = !busy && eventUrl.isNotBlank()) {
                        busy = true
                        scope.launch {
                            val r = store.setBotEventConfig(bot.id, eventUrl)
                            busy = false
                            r.onSuccess { eventSecret = it }
                        }
                    }
                    Chip("Clear", enabled = !busy && bot.botEventUrl != null) {
                        busy = true
                        scope.launch { store.setBotEventConfig(bot.id, null); busy = false; eventUrl = ""; eventSecret = null }
                    }
                }
            }
        }
    }
}

@Composable
private fun Chip(label: String, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val fg = if (danger) ZkStatus.dangerSoft else ZkInk.ink1
    Text(
        label, color = if (enabled) fg else ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(p.bg3)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    )
}
