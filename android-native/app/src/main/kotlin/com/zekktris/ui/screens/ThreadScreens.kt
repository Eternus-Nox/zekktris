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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.data.model.Message
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/** Threads under a text channel — tap to open (a thread is a channel). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadsSheet(store: AppStore, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var threads by remember { mutableStateOf<List<Channel>?>(null) }
    LaunchedEffect(channelId) { threads = store.threadsFor(channelId) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).padding(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
            Text("THREADS", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
            val list = threads
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                list.isEmpty() -> Text("No threads yet. Long-press a message → Create thread.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
                else -> Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    list.forEach { t -> ThreadRow(t) { store.selectChannel(t.id); onDismiss() } }
                }
            }
        }
    }
}

@Composable
private fun ThreadRow(t: Channel, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("🧵", fontSize = 15.sp)
        Text(t.name ?: "thread", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
    }
}

/** Forum channel body — its posts (each a thread), with a New Post action. */
@Composable
fun ForumPane(store: AppStore, state: AppState, channelId: String, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    var posts by remember(channelId) { mutableStateOf<List<Channel>?>(null) }
    var reload by remember(channelId) { mutableStateOf(0) }
    var composing by remember(channelId) { mutableStateOf(false) }
    LaunchedEffect(channelId, reload) { posts = store.threadsFor(channelId) }

    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).clip(RoundedCornerShape(10.dp)).background(p.accent).clickable { composing = true }.padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Add, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(18.dp))
            Text("New Post", color = androidx.compose.ui.graphics.Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(start = 6.dp))
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val list = posts
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                list.isEmpty() -> Text("No posts yet — start one with New Post.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                else -> list.forEach { post ->
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).clickable { store.selectChannel(post.id) }.padding(14.dp)) {
                        Text(post.name ?: "post", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        post.topic?.takeIf { it.isNotBlank() }?.let { Text(it, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp)) }
                    }
                }
            }
        }
    }
    if (composing) ForumPostDialog(store, channelId, onDismiss = { done -> composing = false; if (done) reload++ })
}

@Composable
private fun ForumPostDialog(store: AppStore, forumId: String, onDismiss: (Boolean) -> Unit) {
    val p = ZkTheme.palette
    var title by remember { mutableStateOf("") }
    var content by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss(false) },
        title = { Text("New post", color = ZkInk.ink1, fontFamily = ZkSans) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTextField(title, { title = it.take(100) }, "Title", Modifier.fillMaxWidth())
                FilledTextField(content, { content = it.take(4000) }, "Write something…", Modifier.fillMaxWidth().height(120.dp), singleLine = false, minLines = 3)
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank() && content.isNotBlank() && !busy, onClick = {
                busy = true
                store.createForumPost(forumId, title, content) { ok -> busy = false; onDismiss(ok) }
            }) { Text(if (busy) "Posting…" else "Post", color = p.accent, fontFamily = ZkSans) }
        },
        dismissButton = { TextButton(onClick = { onDismiss(false) }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
        containerColor = p.bg2,
    )
}

/** Name-a-thread dialog for "Create thread" off a message. */
@Composable
fun CreateThreadDialog(store: AppStore, msg: Message, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Create thread", color = ZkInk.ink1, fontFamily = ZkSans) },
        text = {
            Column {
                Text("Start a thread off this message.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))
                FilledTextField(name, { name = it.take(100) }, "Thread name (optional)", Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true
                store.createThreadFromMessage(msg.channelId, msg.id, name) { onDismiss() }
            }) { Text(if (busy) "Creating…" else "Create", color = p.accent, fontFamily = ZkSans) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) } },
        containerColor = p.bg2,
    )
}
