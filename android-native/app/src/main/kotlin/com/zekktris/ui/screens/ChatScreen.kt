package com.zekktris.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import kotlin.math.roundToInt
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.animation.core.animateFloatAsState
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Mood
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Mic
import androidx.compose.runtime.DisposableEffect
import com.zekktris.ui.theme.ZkMono
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.ApiClient
import com.zekktris.data.Config
import com.zekktris.data.model.Attachment
import com.zekktris.data.model.Channel
import com.zekktris.data.model.ForwardSource
import com.zekktris.data.model.Message
import com.zekktris.data.model.MessageEmbed
import com.zekktris.data.model.Sticker
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.EmojiPickerSheet
import com.zekktris.ui.components.ImageLightbox
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.MessageContent
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.NameTag
import com.zekktris.ui.components.StaffName
import com.zekktris.ui.components.StreakPill
import com.zekktris.ui.components.VideoPlayerDialog
import com.zekktris.ui.components.VoiceMessageView
import com.zekktris.ui.components.dayLabel
import com.zekktris.ui.components.shortTime
import com.zekktris.ui.components.withinMinutes
import com.zekktris.ui.components.zkFieldColors
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import com.zekktris.crypto.E2EE
import com.zekktris.util.ProfanityFilter

private const val AVATAR_LANE = 52 // avatar area width so grouped lines align
private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥")

private fun isRecent(createdAt: String, seconds: Long): Boolean =
    runCatching {
        java.time.Duration.between(java.time.Instant.parse(createdAt), java.time.Instant.now()).seconds < seconds
    }.getOrDefault(true)

// Poke variants (keep in sync with server POKE_VARIANTS / iOS PokeVariant).
private val POKE_VARIANTS = listOf("poke" to "👉", "heart" to "❤️", "wave" to "👋", "like" to "👍", "fire" to "🔥")
private fun pokeEmoji(t: String) = POKE_VARIANTS.firstOrNull { it.first == t }?.second ?: "👉"
private fun pokeVerb(t: String) = when (t) {
    "heart" -> "sent you a heart"; "wave" -> "waved at you"; "like" -> "liked you"; "fire" -> "sent you fire"; else -> "poked you"
}
private fun pokeSentVerb(t: String) = when (t) {
    "heart" -> "sent a heart"; "wave" -> "waved"; "like" -> "liked them"; "fire" -> "sent fire"; else -> "poked them"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val channel = state.currentChannel
    val channelId = state.selectedChannelId
    val messages = channelId?.let { state.messagesByChannel[it] } ?: emptyList()
    BackHandler { store.closeChannel() }

    // Composer interaction state: replying to / editing a message.
    var replyTo by remember(channelId) { mutableStateOf<Message?>(null) }
    var editing by remember(channelId) { mutableStateOf<Message?>(null) }
    // Long-pressed message → action sheet.
    var actionFor by remember(channelId) { mutableStateOf<Message?>(null) }
    var emojiReactFor by remember(channelId) { mutableStateOf<Message?>(null) }
    var forwardFor by remember(channelId) { mutableStateOf<Message?>(null) }
    var confirmDelete by remember(channelId) { mutableStateOf<Message?>(null) }
    var showPokeSheet by remember(channelId) { mutableStateOf(false) }
    var showDmSettings by remember(channelId) { mutableStateOf(false) }
    var showPins by remember(channelId) { mutableStateOf(false) }
    var showMembers by remember(channelId) { mutableStateOf(false) }
    var lightbox by remember(channelId) { mutableStateOf<Pair<List<String>, Int>?>(null) }
    // E2EE (.zke) images open a separate lightbox fed from IN-MEMORY decrypted
    // bytes — never plaintext URLs.
    var encLightbox by remember(channelId) { mutableStateOf<Pair<List<Attachment>, Int>?>(null) }
    var videoUrl by remember(channelId) { mutableStateOf<String?>(null) }
    var showThreads by remember(channelId) { mutableStateOf(false) }
    var createThreadFor by remember(channelId) { mutableStateOf<Message?>(null) }
    var showSearch by remember(channelId) { mutableStateOf(false) }
    val isForum = channel?.isForum == true

    // Notification deep-link reply prefill (guild channels, iOS openFromPush).
    // Keyed on messages.size — and consuming the target only AFTER the lookup
    // succeeds — exactly like the sibling JUMP effect in MessageList: on the
    // first pass the channel has just been selected and `messages` is still
    // empty, so consuming here would burn the one-shot before the pushed
    // message ever arrives (the jump's loadAround also merges it in later).
    LaunchedEffect(channelId, state.pendingReplyPrefillId, messages.size) {
        val target = state.pendingReplyPrefillId ?: return@LaunchedEffect
        if (channelId == null || messages.isEmpty()) return@LaunchedEffect
        val found = messages.firstOrNull { it.id == target } ?: return@LaunchedEffect
        store.consumePendingReplyPrefill()
        replyTo = found
    }

    // Swipe right anywhere on the chat to close it, following the finger, then
    // settling open or closed on release.
    //
    // Scoped to a HORIZONTAL drag that starts moving rightward, so it cannot
    // steal the vertical scroll of the message list — awaitHorizontalTouchSlop
    // only wins the gesture once the pointer has travelled further across than
    // down, which is what `detectHorizontalDragGestures` gives us.
    val closeThresholdPx = with(LocalDensity.current) { 96.dp.toPx() }
    var dragX by remember(channelId) { mutableFloatStateOf(0f) }
    val dragOffset by animateFloatAsState(dragX, label = "chatSwipe")

    Column(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(dragOffset.roundToInt(), 0) }
            .pointerInput(channelId) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (dragX > closeThresholdPx) store.closeChannel()
                        dragX = 0f
                    },
                    onDragCancel = { dragX = 0f },
                ) { _, delta ->
                    // Rightward only, and never drag past the screen edge.
                    dragX = (dragX + delta).coerceIn(0f, size.width.toFloat())
                }
            }
            .background(p.bg1),
    ) {
        ChatHeader(
            state, channel,
            onBack = { store.closeChannel() },
            onPoke = { showPokeSheet = true },
            onSettings = { showDmSettings = true },
            onPins = { showPins = true },
            onMembers = { showMembers = true },
            onThreads = { showThreads = true },
            onCall = { channelId?.let { store.requestVoice(it) } },
            onSearch = { showSearch = true },
            onOpenProfile = { store.openProfile(it) },
        )
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
        if (isForum && channelId != null) {
            // A forum channel shows its posts (each a thread), not a message list.
            ForumPane(store, state, channelId, modifier = Modifier.weight(1f).fillMaxWidth())
        } else {
            MessageList(
                store, state, channelId, messages,
                onLongPress = { actionFor = it },
                onImageTap = { list, i -> lightbox = list to i },
                onVideoTap = { videoUrl = it },
                onEncImageTap = { atts, i -> encLightbox = atts to i },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
            if (channelId != null) {
                // Locked E2EE DM: explicit unlock affordance in the conversation
                // (iOS replaces the list with an UnlockPanel; web shows a banner
                // with an "Enter password" button).
                val lockedHere = channel?.isE2EE == true && !state.e2eeUnlocked.contains(channelId)
                if (lockedHere) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(p.accent.copy(alpha = 0.10f))
                            .clickable { showDmSettings = true }
                            .padding(horizontal = 12.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Lock, null, tint = p.accent, modifier = Modifier.size(14.dp))
                        Text(
                            "This conversation is encrypted.",
                            color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp,
                            modifier = Modifier.padding(start = 8.dp).weight(1f),
                        )
                        Text("Enter password", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    }
                }
                TypingLine(state, channelId, messages)
                Composer(
                    store = store,
                    state = state,
                    channelId = channelId,
                    replyTo = replyTo,
                    editing = editing,
                    onCancelReply = { replyTo = null },
                    onCancelEdit = { editing = null },
                    onSent = { replyTo = null; editing = null },
                )
            }
        }
    }

    // Long-press action sheet: quick reactions + contextual actions.
    actionFor?.let { msg ->
        val isMine = msg.authorId != null && msg.authorId == state.me?.id
        val pending = msg.id.startsWith("pending-")
        val clipboard = LocalClipboardManager.current
        ModalBottomSheet(
            onDismissRequest = { actionFor = null },
            containerColor = p.bg2,
        ) {
            Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
                if (!pending) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        QUICK_REACTIONS.forEach { emoji ->
                            Text(
                                emoji, fontSize = 24.sp,
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .clickable {
                                        store.toggleReaction(msg.channelId, msg.id, emoji)
                                        actionFor = null
                                    }
                                    .padding(8.dp),
                            )
                        }
                        // Full emoji picker (unicode + server) for anything beyond the 8 quick ones.
                        Box(
                            Modifier.size(40.dp).clip(CircleShape).background(p.bg3).clickable {
                                emojiReactFor = msg; actionFor = null
                            },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Filled.Add, "More emoji", tint = ZkInk.ink2, modifier = Modifier.size(20.dp)) }
                    }
                }
                SheetAction(Icons.AutoMirrored.Filled.Reply, "Reply", enabled = !pending) {
                    editing = null; replyTo = msg; actionFor = null
                }
                // Copy the DECRYPTED body the user is reading — copying raw
                // zkE2EE ciphertext and pasting it back into the composer would
                // double-encrypt it. renderContent hands back a "🔒 …" tombstone
                // whenever it can't produce plaintext (locked channel, legacy
                // v1/v2 wire on an unlocked channel, failed decrypt); none of
                // those are worth putting on the clipboard.
                // Memoized: the sheet reads `state`, so it recomposes on every
                // AppState emit (typing, presence, each arriving message) and an
                // unmemoized call would re-run AES-GCM decrypt on the main thread
                // each pass — and renderContent can now evict a stale E2EE key,
                // i.e. mutate the store, during composition.
                val copyText = remember(msg.id, msg.content, state.e2eeUnlocked) {
                    store.renderContent(msg.channelId, msg.content)
                }
                // The "🔒 …" tombstone only means "couldn't decrypt" for content
                // that is actually encrypted — renderContent passes plaintext
                // through untouched, so a message a user genuinely typed starting
                // with a lock emoji must stay copyable.
                val copyBlocked = E2EE.isEncrypted(msg.content) && copyText.startsWith("🔒")
                SheetAction(Icons.Filled.ContentCopy, "Copy text", enabled = copyText.isNotBlank() && !copyBlocked) {
                    clipboard.setText(AnnotatedString(copyText)); actionFor = null
                }
                if (!pending) {
                    SheetAction(Icons.Filled.Share, "Forward") { forwardFor = msg; actionFor = null }
                    val saved = state.savedIds.contains(msg.id)
                    SheetAction(
                        if (saved) Icons.Filled.Bookmark else Icons.Filled.BookmarkBorder,
                        if (saved) "Remove bookmark" else "Save message",
                    ) { store.toggleSave(msg); actionFor = null }
                }
                // Pin/Unpin — only in guild channels (server 403s in DMs).
                if (state.currentChannel?.isDM == false && !pending) {
                    SheetAction(
                        Icons.Filled.PushPin,
                        if (msg.pinned) "Unpin message" else "Pin message",
                    ) { store.togglePin(msg.channelId, msg); actionFor = null }
                    // Start a thread off this message (guild text channels).
                    if (state.currentChannel?.isText == true) {
                        SheetAction(Icons.Filled.Forum, "Create thread") { createThreadFor = msg; actionFor = null }
                    }
                }
                // Edit: your own message within the 60s window, OR you hold
                // MANAGE_MESSAGES (the server lets a moderator edit past the
                // window — but still only their OWN message; editing others'
                // content is blocked server-side).
                val gid = state.selectedGuildId
                val canManageMsgs = gid != null && state.currentChannel?.isDM == false && state.canManageMessages(gid)
                if (isMine && !pending && (isRecent(msg.createdAt, 60) || canManageMsgs)) {
                    SheetAction(Icons.Filled.Edit, "Edit message") {
                        replyTo = null; editing = msg; actionFor = null
                    }
                }
                // Delete: your own within the window, OR a moderator can delete
                // ANY message (any author, any age).
                if (!pending && ((isMine && isRecent(msg.createdAt, 60)) || canManageMsgs)) {
                    SheetAction(Icons.Filled.Delete, "Delete message", tint = ZkStatus.danger) {
                        confirmDelete = msg; actionFor = null
                    }
                }
            }
        }
    }

    if (showThreads && channelId != null) {
        ThreadsSheet(store, channelId, onDismiss = { showThreads = false })
    }
    if (showSearch && channelId != null) {
        ChannelSearchSheet(
            store, channel, channelId,
            onJump = { id -> showSearch = false; store.selectChannel(channelId, jumpToMessageId = id) },
            onDismiss = { showSearch = false },
        )
    }
    createThreadFor?.let { msg ->
        CreateThreadDialog(store, msg, onDismiss = { createThreadFor = null })
    }
    if (showPokeSheet && channelId != null) {
        PokeSheet(store, channelId, onDismiss = { showPokeSheet = false })
    }
    if (showDmSettings && channelId != null) {
        DmSettingsSheet(store, state, channelId, onDismiss = { showDmSettings = false })
    }
    if (showPins && channelId != null) {
        PinsSheet(store, channelId, onDismiss = { showPins = false })
    }
    if (showMembers) {
        state.selectedGuildId?.let { gid ->
            MembersSheet(store, state, gid, onDismiss = { showMembers = false })
        }
    }
    lightbox?.let { (urls, i) ->
        ImageLightbox(urls, i, onDismiss = { lightbox = null })
    }
    encLightbox?.let { (atts, i) ->
        if (channelId != null) {
            com.zekktris.ui.components.EncryptedImageLightbox(store, channelId, atts, i, onDismiss = { encLightbox = null })
        }
    }
    videoUrl?.let { url ->
        VideoPlayerDialog(url, onDismiss = { videoUrl = null })
    }
    emojiReactFor?.let { msg ->
        EmojiPickerSheet(
            onDismiss = { emojiReactFor = null },
            onPick = { store.toggleReaction(msg.channelId, msg.id, it); emojiReactFor = null },
            serverEmojis = state.guildEmojis.map { it.name to (com.zekktris.data.Config.absoluteUrl(it.url) ?: it.url) },
        )
    }
    forwardFor?.let { msg ->
        ForwardSheet(
            state,
            onPick = { target -> store.forwardMessage(msg, target); forwardFor = null },
            onDismiss = { forwardFor = null },
        )
    }
    confirmDelete?.let { msg ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete message?", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { Text("This can't be undone.", color = ZkInk.ink3, fontFamily = ZkSans) },
            confirmButton = {
                TextButton(onClick = { store.deleteMessage(msg.channelId, msg.id); confirmDelete = null }) {
                    Text("Delete", color = ZkStatus.dangerSoft, fontFamily = ZkSans)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = null }) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) }
            },
            containerColor = p.bg2,
        )
    }
}

/** Pick a channel/DM to forward a message into. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ForwardSheet(state: AppState, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val guildChannels = state.selectedGuildId?.let { state.channelsByGuild[it]?.filter { c -> c.isText } } ?: emptyList()
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp)) {
            Text("FORWARD TO", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
            if (guildChannels.isNotEmpty()) {
                Text("CHANNELS", color = ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp, modifier = Modifier.padding(vertical = 4.dp))
                guildChannels.forEach { c ->
                    Text("#${c.name ?: "channel"}", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clickable { onPick(c.id) }.padding(vertical = 10.dp))
                }
            }
            if (state.dms.isNotEmpty()) {
                Text("DIRECT MESSAGES", color = ZkInk.ink4, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                state.dms.forEach { dm ->
                    val peer = dm.recipients?.firstOrNull()
                    val title = peer?.id?.let { state.dmNicknames[it] }?.takeIf { it.isNotBlank() }
                        ?: peer?.bestName ?: dm.name ?: "Direct Message"
                    Row(Modifier.fillMaxWidth().clickable { onPick(dm.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(url = dm.recipients?.firstOrNull()?.avatarUrl, name = title, size = 28.dp)
                        Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PokeSheet(store: AppStore, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var history by remember { mutableStateOf<List<com.zekktris.data.model.PokeHistoryEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(channelId) { history = store.pokeHistory(channelId) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp)) {
            Text("RECENT POKES", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            val h = history
            when {
                h == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 10.dp))
                h.isEmpty() -> Text("No pokes yet — say hi below.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 10.dp))
                else -> Column(Modifier.padding(vertical = 8.dp)) {
                    h.forEach { e ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(pokeEmoji(e.pokeType), fontSize = 15.sp)
                            Text(e.initiatorName, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp))
                            Text(pokeVerb(e.pokeType), color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(start = 4.dp).weight(1f))
                            Text(relativeShort(e.createdAt), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
            Row(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                POKE_VARIANTS.forEach { (type, emoji) ->
                    Text(
                        emoji, fontSize = 24.sp,
                        modifier = Modifier
                            .padding(horizontal = 5.dp)
                            .clip(CircleShape)
                            .clickable {
                                store.poke(channelId, type) { error = it }
                                onDismiss()
                            }
                            .padding(8.dp),
                    )
                }
            }
            error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
        }
    }
}

private fun relativeShort(iso: String): String {
    val then = runCatching { java.time.Instant.parse(iso) }.getOrNull() ?: return ""
    val s = java.time.Duration.between(then, java.time.Instant.now()).seconds
    return when {
        s < 45 -> "just now"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        else -> "${s / 86400}d"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DmSettingsSheet(store: AppStore, state: AppState, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var settings by remember { mutableStateOf<com.zekktris.data.model.DmChannelSettings?>(null) }
    LaunchedEffect(channelId) { settings = store.getDmSettings(channelId) }

    val channel = state.dms.firstOrNull { it.id == channelId }
    val isE2EE = channel?.isE2EE == true
    val unlocked = state.e2eeUnlocked.contains(channelId)
    var e2eePw by remember(channelId) { mutableStateOf("") }
    var e2eeBusy by remember(channelId) { mutableStateOf(false) }
    var e2eeErr by remember(channelId) { mutableStateOf<String?>(null) }
    var confirmDisableE2EE by remember(channelId) { mutableStateOf(false) }
    var showMediaGallery by remember(channelId) { mutableStateOf(false) }

    // Order (top→bottom, mirrors iOS DmSettingsSheet): Shared media,
    // Notifications, Read receipts, Auto-delete, End-to-end encryption,
    // Close DM.
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("SHARED MEDIA", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(p.bg2)
                    .clickable { showMediaGallery = true }
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.PhotoLibrary, null, tint = p.accent, modifier = Modifier.size(16.dp))
                Text(
                    "Photos & Files", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp,
                    modifier = Modifier.weight(1f).padding(start = 8.dp),
                )
                Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink3, modifier = Modifier.size(16.dp))
            }

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

            Text("NOTIFICATIONS", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp)
            // No explicit override → plaintext DMs default ON, E2EE DMs default
            // OFF (matches actual push behavior; iOS `?? !isE2EE`).
            val showContent = settings?.notificationShowContent ?: !isE2EE
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(p.bg2)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Show message in notifications", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
                    Text(
                        if (isE2EE) "Reveals decrypted message text in push notifications." else "Previews message text in push notifications.",
                        color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                }
                androidx.compose.material3.Switch(
                    checked = showContent,
                    onCheckedChange = { next ->
                        settings = (settings ?: com.zekktris.data.model.DmChannelSettings()).copy(notificationShowContent = next)
                        scope.launch { store.setNotificationPreview(channelId, next) }
                    },
                    colors = androidx.compose.material3.SwitchDefaults.colors(
                        checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                        checkedTrackColor = p.accent,
                        uncheckedThumbColor = ZkInk.ink3,
                        uncheckedTrackColor = p.bg3,
                        uncheckedBorderColor = p.line,
                    ),
                )
            }
            Text(
                if (isE2EE)
                    "When on, push notifications reveal the decrypted message and sender. When off, you only see that you have new messages — your encrypted content stays hidden on the lock screen."
                else
                    "When on, push notifications show a preview of the message. When off, you only see that you have new messages.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
            )

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

            Text("READ RECEIPTS", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp)
            val receipts = state.me?.dmReadReceiptsEnabled != false
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(p.bg2)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Send read receipts", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
                    Text(
                        "Let people you DM see Delivered and Read on their messages. When off, you won't see receipts on messages sent to you either.",
                        color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                    )
                }
                androidx.compose.material3.Switch(
                    checked = receipts,
                    onCheckedChange = { store.setDmReadReceipts(it) },
                    colors = androidx.compose.material3.SwitchDefaults.colors(
                        checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                        checkedTrackColor = p.accent,
                        uncheckedThumbColor = ZkInk.ink3,
                        uncheckedTrackColor = p.bg3,
                        uncheckedBorderColor = p.line,
                    ),
                )
            }

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

            // Auto-delete after read: full-width stacked rows (radio style),
            // not the old pill row — matches the iOS list layout.
            Text("AUTO-DELETE MESSAGES", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp)
            val ttlOptions = listOf<Pair<String, Int?>>("Off" to null, "30 seconds" to 30, "1 minute" to 60, "2 minutes" to 120)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                ttlOptions.forEachIndexed { i, (label, secs) ->
                    val selected = settings?.ttlSecondsAfterRead == secs
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable {
                                settings = (settings ?: com.zekktris.data.model.DmChannelSettings()).copy(ttlSecondsAfterRead = secs)
                                scope.launch { store.setDmTtl(channelId, secs) }
                            }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
                        if (selected) {
                            Icon(Icons.Filled.Check, null, tint = p.accent, modifier = Modifier.size(16.dp))
                        }
                    }
                    if (i < ttlOptions.size - 1) Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
                }
            }
            Text(
                "When on, each message disappears this long after the other person reads it. This applies to both of you.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
            )

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

            // End-to-end encryption — moved near the bottom (iOS parity).
            Text("END-TO-END ENCRYPTION", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp)
            when {
                isE2EE && unlocked -> {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(p.bg2)
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Lock, null, tint = p.accent, modifier = Modifier.size(15.dp))
                        Text(
                            "Enabled", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp,
                            modifier = Modifier.weight(1f).padding(start = 8.dp),
                        )
                        Text(
                            "Turn Off…",
                            color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                            modifier = Modifier.clickable(enabled = !e2eeBusy) { confirmDisableE2EE = true },
                        )
                    }
                    Text(
                        "Messages are encrypted with your shared password. Turning this off permanently deletes the encrypted history for both of you.",
                        color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                    )
                    e2eeErr?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
                }
                isE2EE && !unlocked -> {
                    Text("This conversation is encrypted. Enter the shared password to read and send messages.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                    FilledTextField(e2eePw, { e2eePw = it; e2eeErr = null }, "Shared password", Modifier.fillMaxWidth(), masked = true)
                    e2eeErr?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
                    PrimaryButton(if (e2eeBusy) "Unlocking…" else "Unlock", enabled = !e2eeBusy && e2eePw.isNotBlank()) {
                        e2eeBusy = true
                        store.unlockE2EE(channelId, e2eePw) { ok -> e2eeBusy = false; if (ok) e2eePw = "" else e2eeErr = "Wrong password" }
                    }
                }
                else -> {
                    Text("End-to-end encrypt this conversation. Both people must enter the same shared password; the server never sees it or the key.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                    FilledTextField(e2eePw, { e2eePw = it; e2eeErr = null }, "Choose a shared password", Modifier.fillMaxWidth(), masked = true)
                    e2eeErr?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
                    PrimaryButton(if (e2eeBusy) "Enabling…" else "Turn on encryption", enabled = !e2eeBusy && e2eePw.length >= 4) {
                        e2eeBusy = true
                        store.enableE2EE(channelId, e2eePw) { ok -> e2eeBusy = false; if (ok) e2eePw = "" else e2eeErr = "Couldn't enable encryption" }
                    }
                }
            }

            Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))

            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .clickable {
                        store.closeDm(channelId)
                        onDismiss()
                    }
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Close, "Close DM", tint = ZkStatus.danger, modifier = Modifier.size(18.dp))
                Text("Close DM", color = ZkStatus.danger, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 8.dp))
            }
            Text(
                "Removes this conversation from your list. The other person keeps their copy.",
                color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp,
            )
        }
    }

    if (showMediaGallery) {
        MediaGalleryDialog(store, state, channelId, onDismiss = { showMediaGallery = false })
    }

    if (confirmDisableE2EE) {
        AlertDialog(
            onDismissRequest = { confirmDisableE2EE = false },
            title = { Text("Turn off encryption?") },
            text = { Text("All encrypted messages in this conversation are permanently deleted for both of you.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisableE2EE = false
                    e2eeBusy = true; e2eeErr = null
                    store.disableE2EE(channelId) { ok -> e2eeBusy = false; if (!ok) e2eeErr = "Couldn't turn off encryption" }
                }) { Text("Turn Off & Delete History", color = ZkStatus.danger) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisableE2EE = false }) { Text("Cancel") }
            },
            containerColor = p.bg2,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PinsSheet(store: AppStore, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var pins by remember { mutableStateOf<List<Message>?>(null) }
    LaunchedEffect(channelId) { pins = store.loadPins(channelId) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 28.dp)) {
            Text("PINNED MESSAGES", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 0.5.sp)
            val list = pins
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp))
                list.isEmpty() -> Text("No pinned messages yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 12.dp))
                else -> Column(Modifier.padding(top = 6.dp)) {
                    list.forEach { m ->
                        PinRow(m) {
                            store.togglePin(channelId, m)
                            pins = pins?.filterNot { it.id == m.id }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinRow(m: Message, onUnpin: () -> Unit) {
    val name = m.author?.bestName ?: "Unknown"
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        Avatar(url = m.author?.avatarUrl, name = name, size = 32.dp)
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(shortTime(m.createdAt), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
            }
            Text(pinPreview(m), color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp))
        }
        Icon(
            Icons.Filled.PushPin, "Unpin", tint = ZkInk.ink3,
            modifier = Modifier.clip(CircleShape).clickable(onClick = onUnpin).padding(6.dp).size(14.dp),
        )
    }
}

private fun pinPreview(m: Message): String = when {
    m.content.isNotBlank() -> m.content
    m.sticker != null -> "🏷️ Sticker"
    m.attachments.isNotEmpty() -> "📎 Attachment"
    else -> "Message"
}

@Composable
private fun SheetAction(
    icon: ImageVector,
    label: String,
    tint: Color = ZkInk.ink1,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 13.dp)
            .alpha(if (enabled) 1f else 0.4f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Text(label, color = tint, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 14.dp))
    }
}

@Composable
private fun ChatHeader(
    state: AppState,
    channel: Channel?,
    onBack: () -> Unit,
    onPoke: () -> Unit,
    onSettings: () -> Unit,
    onPins: () -> Unit,
    onMembers: () -> Unit,
    onThreads: () -> Unit,
    onCall: () -> Unit,
    onSearch: () -> Unit = {},
    onOpenProfile: (com.zekktris.data.model.PublicUser) -> Unit = {},
) {
    val p = ZkTheme.palette
    val isDm = channel?.isDM == true
    val other = channel?.recipients?.firstOrNull()
    val dmNick = other?.id?.let { state.dmNicknames[it] }?.takeIf { it.isNotBlank() }
    val title = when {
        channel == null -> ""
        isDm -> dmNick ?: other?.bestName ?: (channel.name ?: "Direct Message")
        else -> channel.name ?: "channel"
    }
    Box(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp)) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .padding(start = 12.dp)
                .size(width = 52.dp, height = 40.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(p.bg2)
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.ChevronLeft, "Back", tint = ZkInk.ink2, modifier = Modifier.size(24.dp))
        }
        if (isDm && channel != null) {
            // DM: avatar + presence + name + streak, iOS-style rich header.
            Row(
                Modifier.align(Alignment.CenterStart).padding(start = 74.dp).fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box {
                    Avatar(url = other?.avatarUrl, name = title, size = 28.dp, decoration = other?.avatarDecoration, toneId = other?.id)
                    val presence = state.presenceOf(other?.id)
                    val color = when (presence) {
                        "online" -> ZkStatus.online; "idle" -> ZkStatus.idle; "dnd" -> ZkStatus.dnd; else -> null
                    }
                    if (color != null) {
                        Box(
                            Modifier.align(Alignment.BottomEnd).size(10.dp).clip(CircleShape).background(p.bg1),
                            contentAlignment = Alignment.Center,
                        ) { Box(Modifier.size(7.dp).clip(CircleShape).background(color)) }
                    }
                    // E2EE badge: small themed lock pinned to the top-trailing
                    // corner of the avatar (iOS parity) — the only E2EE
                    // indicator in the header. Tint still distinguishes
                    // locked (muted) vs unlocked (green) on this device.
                    if (channel.isE2EE) {
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .offset(x = 4.dp, y = (-4).dp)
                                .size(13.dp)
                                .clip(CircleShape)
                                .background(p.bg2)
                                .border(1.dp, p.accent.copy(alpha = 0.45f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Filled.Lock, "Encrypted",
                                tint = if (state.e2eeUnlocked.contains(channel.id)) ZkStatus.online else ZkInk.ink3,
                                modifier = Modifier.size(7.dp),
                            )
                        }
                    }
                }
                // Name + tag + streak share one weighted region: the name hugs
                // its content (fill = false) so the streak pill sits right beside
                // it (not shoved to the far edge), while the trailing action icons
                // stay right-aligned outside this Row. Staff names shimmer.
                Row(
                    Modifier.weight(1f).padding(start = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (!other?.tagLabel.isNullOrBlank()) {
                        NameTag(other?.tagLabel, other?.tagColor, Modifier.padding(end = 6.dp))
                    }
                    StaffName(
                        user = other, text = title, baseColor = ZkInk.ink1,
                        fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                        // Tapping the name opens the shared profile card (the
                        // same one message avatars and member rows open). 1:1
                        // DMs only — in a group DM the title is the channel
                        // name and `other` is just whoever came back first.
                        modifier = Modifier
                            .weight(1f, fill = false)
                            .clip(RoundedCornerShape(6.dp))
                            .then(
                                if (other != null && channel.type == "dm") {
                                    Modifier.clickable { onOpenProfile(other) }
                                } else {
                                    Modifier
                                },
                            ),
                    )
                    (channel.streak ?: 0).takeIf { it > 0 }?.let {
                        Spacer(Modifier.width(6.dp)); StreakPill(it)
                    }
                }
                // Search leads the trailing action group; hidden for E2EE
                // channels (iOS MessageViews.swift:493-500).
                if (!channel.isE2EE) {
                    Icon(
                        Icons.Filled.Search, "Search", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable(onClick = onSearch).padding(8.dp).size(18.dp),
                    )
                }
                // Call + poke: strictly 1:1 DMs (iOS gates on type == "dm"). The
                // poke is a greyed monochrome hand icon (matches Call/Settings +
                // web/iOS parity), not the colorful 👉 emoji.
                if (channel.type == "dm") {
                    Icon(
                        Icons.Filled.Call, "Start call", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable(onClick = onCall).padding(8.dp).size(18.dp),
                    )
                    Icon(
                        Icons.Filled.TouchApp, "Poke", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable(onClick = onPoke).padding(8.dp).size(18.dp),
                    )
                }
                Icon(
                    Icons.Filled.Settings, "Conversation settings", tint = ZkInk.ink3,
                    modifier = Modifier.padding(end = 10.dp).clip(CircleShape).clickable(onClick = onSettings).padding(8.dp).size(18.dp),
                )
            }
        } else {
            Row(Modifier.align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
                Text("#", color = ZkInk.ink3, fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.padding(end = 5.dp))
                Text(
                    text = title,
                    color = ZkInk.ink1,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 17.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 220.dp),
                )
            }
        }
        // Guild-channel actions: pinned messages + member roster.
        if (!isDm && channel != null) {
            Row(
                Modifier.align(Alignment.CenterEnd).padding(end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Search leads the trailing group (iOS MessageViews.swift:493-500).
                Icon(
                    Icons.Filled.Search, "Search", tint = ZkInk.ink3,
                    modifier = Modifier.clip(CircleShape).clickable(onClick = onSearch).padding(6.dp).size(18.dp),
                )
                if (channel.isText) {
                    Icon(
                        Icons.Filled.Forum, "Threads", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable(onClick = onThreads).padding(6.dp).size(18.dp),
                    )
                }
                Icon(
                    Icons.Filled.PushPin, "Pinned messages", tint = ZkInk.ink3,
                    modifier = Modifier.clip(CircleShape).clickable(onClick = onPins).padding(6.dp).size(18.dp),
                )
                Icon(
                    Icons.Filled.People, "Members", tint = ZkInk.ink3,
                    modifier = Modifier.clip(CircleShape).clickable(onClick = onMembers).padding(6.dp).size(18.dp),
                )
            }
        }
    }
}

@Composable
private fun MessageList(
    store: AppStore,
    state: AppState,
    channelId: String?,
    messages: List<Message>,
    onLongPress: (Message) -> Unit,
    onImageTap: (List<String>, Int) -> Unit,
    onVideoTap: (String) -> Unit,
    onEncImageTap: (List<Attachment>, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = ZkTheme.palette
    val listState = rememberLazyListState()
    // The frozen unread boundary for this open (pre-ack read pointer) → the red
    // "New messages" divider + guild land-on-unread (iOS unreadBoundaryId).
    val unreadBoundary = channelId?.let { state.unreadBoundaryByChannel[it] }
    val unreadIdx = if (unreadBoundary == null) -1 else messages.indexOfFirst {
        !it.id.startsWith("pending-") && it.id > unreadBoundary
    }
    val isDmChannel = state.currentChannel?.isDM == true
    // Opening a conversation lands at the BOTTOM (the newest messages) —
    // instantly, no animation — EXCEPT a guild channel with unread, which
    // lands on the "New messages" divider (iOS MessageViews.swift:245-251).
    // The list state is shared across channel switches (ChatScreen stays
    // mounted), so track which channel we've positioned.
    //
    // For later appends the rule matches iOS (MessageViews.swift:289,
    // `ownSend || (appended && isNearBottom)`): your OWN send always follows,
    // someone else's message only follows if you are already at the bottom.
    // Reading history must never be interrupted.
    var positionedFor by remember { mutableStateOf<String?>(null) }
    var lastSeenId by remember(channelId) { mutableStateOf<String?>(null) }
    // Message count at the last scroll decision. Distinguishes a genuine APPEND
    // from a tail DELETION — both change `last.id`, but only one should scroll.
    var lastSeenCount by remember(channelId) { mutableStateOf(0) }
    // Derived from layoutInfo (not firstVisibleItemIndex) so the scrollback
    // spinner occupying index 0 can't skew it. This is the ONE near-bottom
    // notion in this screen: it gates the auto-follow below AND the visibility
    // of the jump-to-newest button, so the button can never claim you're
    // scrolled up while a new message is still following you down.
    val atBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || last.index >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(channelId, messages.size) {
        if (messages.isEmpty()) return@LaunchedEffect
        val last = messages.last()
        if (positionedFor != channelId) {
            if (!isDmChannel && unreadIdx >= 0) listState.scrollToItem(unreadIdx)
            else listState.scrollToItem(messages.lastIndex)
            positionedFor = channelId
            lastSeenId = last.id
            lastSeenCount = messages.size
            return@LaunchedEffect
        }
        if (last.id != lastSeenId) {
            // A genuinely NEW tail — not an older-history prepend (size grows,
            // last id unchanged) and not a tail deletion (size SHRINKS, last id
            // changes). Without the count check, deleting the newest message
            // yanked a reader in history down to the bottom.
            val appended = messages.size > lastSeenCount
            val mine = last.authorId != null && last.authorId == state.me?.id
            if (appended && (mine || atBottom)) {
                listState.animateScrollToItem(messages.lastIndex)
            }
            lastSeenId = last.id
            lastSeenCount = messages.size
        }
    }
    // Older-history pagination: prefetch the next older page when the reader
    // nears the top of the loaded window (iOS prefetch-within-10 parity).
    val nearTop by remember {
        derivedStateOf { listState.firstVisibleItemIndex <= 10 }
    }
    LaunchedEffect(channelId, nearTop, messages.size) {
        if (channelId != null && nearTop && messages.size >= 50) store.loadOlderMessages(channelId)
    }
    // Jump-to-message: tapping a reply reference scrolls to the quoted message
    // when it's in the loaded window, and flashes it. Older-history pagination
    // (an `around:` fetch) is a separate, larger feature — for now a target
    // outside the window just tells the user it isn't loaded.
    val jumpScope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var highlightedId by remember(channelId) { mutableStateOf<String?>(null) }
    val onJumpTo: (String) -> Unit = onJump@{ targetId ->
        val idx = messages.indexOfFirst { it.id == targetId }
        if (idx < 0) {
            android.widget.Toast.makeText(ctx, "Message not loaded", android.widget.Toast.LENGTH_SHORT).show()
            return@onJump
        }
        highlightedId = targetId
        jumpScope.launch { listState.animateScrollToItem(idx.coerceAtLeast(0)) }
    }
    // Clear the flash after a beat.
    LaunchedEffect(highlightedId) {
        if (highlightedId != null) { kotlinx.coroutines.delay(1200); highlightedId = null }
    }
    // One-shot jump target (mention tap / notification deep-link): scroll to
    // the message + flash; fetch a window around it when it's outside ours.
    LaunchedEffect(channelId, state.pendingJumpMessageId, messages.size) {
        val target = state.pendingJumpMessageId ?: return@LaunchedEffect
        if (channelId == null || messages.isEmpty()) return@LaunchedEffect
        store.consumePendingJump()
        // consumePendingJump() clears one of this effect's own keys, so the
        // effect is cancelled the moment it suspends — the around-fetch and the
        // scroll have to run on the composition scope, which survives it.
        jumpScope.launch {
            var idx = messages.indexOfFirst { it.id == target }
            if (idx < 0 && store.loadAround(channelId, target)) {
                idx = (store.state.value.messagesByChannel[channelId] ?: emptyList()).indexOfFirst { it.id == target }
            }
            // The composition scope outlives this channel, and `listState` is
            // shared across channel switches — an around-fetch that resolves
            // after the user moved on would scroll the NEW conversation to an
            // index computed from the OLD one.
            if (store.state.value.selectedChannelId != channelId) return@launch
            if (idx >= 0) {
                highlightedId = target
                listState.animateScrollToItem(idx)
            }
        }
    }
    if (messages.isEmpty()) {
        Box(modifier.background(p.bg1), contentAlignment = Alignment.Center) {
            Text("No messages yet — say hi 👋", color = ZkInk.ink3, fontSize = 14.sp)
        }
        return
    }
    // Built ONCE for the whole list, not per row. Each is `remember`ed on the
    // narrow state slices it reads, so it stays the same instance across the
    // unrelated AppState emits (presence, typing, read acks) that were previously
    // recomposing every visible row while scrolling.
    val mentionResolve = com.zekktris.ui.components.rememberMentionResolver(state)
    val emojiUrl = com.zekktris.ui.components.rememberEmojiResolver(state)
    // The list plus a floating "jump to newest" affordance, stacked.
    Box(modifier.background(p.bg1)) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(vertical = 10.dp),
        ) {
            // Top spinner row while an older page is loading.
            if (channelId != null && state.loadingOlderChannelIds.contains(channelId)) {
                item(key = "older-spinner") {
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.Center) {
                        androidx.compose.material3.CircularProgressIndicator(
                            color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
            // Anchor the Sent/Delivered/Read receipt on our newest confirmed
            // message (DMs only), mirroring iOS — notice rows (poke /
            // streak_warning / system_*) never anchor it.
            val isDm = state.currentChannel?.isDM == true
            val receiptAnchorId = if (isDm) {
                messages.lastOrNull {
                    it.authorId == state.me?.id && !it.id.startsWith("pending-") &&
                        it.metadata?.kind == null && it.type == "default"
                }?.id
            } else null
            itemsIndexed(messages, key = { _, m -> m.id }) { i, m ->
                val prev = messages.getOrNull(i - 1)
                val newDay = prev == null || !com.zekktris.ui.components.sameLocalDay(prev.createdAt, m.createdAt)
                if (newDay) DayDivider(dayLabel(m.createdAt))
                // Red "New messages" divider at the frozen unread boundary.
                if (i == unreadIdx) UnreadDivider()
                if (m.metadata?.kind == "poke") {
                    PokeNoticeRow(state.me, m)
                    return@itemsIndexed
                }
                // Streak-expiry warning → centered quiet notice, never an authored
                // bubble (iOS MessageViews.swift:1433-1444).
                if (m.metadata?.kind == "streak_warning") {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 5.dp, horizontal = 14.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        Text(
                            store.renderContent(m.channelId, m.content), color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                    }
                    return@itemsIndexed
                }
                // Call record → quiet gutter notice, not an authored row
                // (iOS systemRow, MessageViews.swift:1405-1427).
                if (m.type == "system_call") {
                    CallNoticeRow(state.me, m)
                    return@itemsIndexed
                }
                var grouped = !newDay && prev != null &&
                    m.type == "default" &&
                    prev.type == "default" &&
                    m.metadata?.kind == null &&
                    prev.metadata?.kind == null &&
                    prev.authorId != null &&
                    prev.authorId == m.authorId &&
                    m.replyToId == null &&
                    withinMinutes(prev.createdAt, m.createdAt)
                if (grouped) {
                    // Re-show the author header every 6th message of an
                    // uninterrupted run (iOS headerEveryNInRun = 6).
                    var runPos = 1
                    var j = i - 1
                    while (j > 0) {
                        val cur = messages[j]
                        val before = messages[j - 1]
                        val chained = cur.type == "default" && before.type == "default" &&
                            cur.metadata?.kind == null && before.metadata?.kind == null &&
                            before.authorId != null && before.authorId == cur.authorId &&
                            cur.replyToId == null &&
                            com.zekktris.ui.components.sameLocalDay(before.createdAt, cur.createdAt) &&
                            withinMinutes(before.createdAt, cur.createdAt)
                        if (!chained) break
                        runPos += 1
                        j -= 1
                    }
                    if (runPos % 6 == 0) grouped = false
                }
                // Resolve the row's inputs HERE, not inside the row. These reads
                // happen in the list scope, which recomposes on state change
                // anyway; passing the results down as primitives is what lets an
                // individual row skip. See the note on MessageRow's signature.
                val rowRepliedTo = m.replyToId?.let { rid -> messages.firstOrNull { it.id == rid } }
                MessageRow(
                    store = store,
                    selectedGuildId = state.selectedGuildId,
                    joinGuild = if (m.type == "system_join") {
                        state.selectedGuildId?.let { gid -> state.guilds.firstOrNull { it.id == gid } }
                    } else null,
                    isDM = state.currentChannel?.isDM == true,
                    isFailed = state.failedSendIds.contains(m.id),
                    maskProfane = state.family?.restrictions?.filterProfanity == true,
                    e2eeUnlocked = state.e2eeUnlocked.contains(m.channelId),
                    repliedTo = rowRepliedTo,
                    repliedToUnlocked = rowRepliedTo != null && state.e2eeUnlocked.contains(rowRepliedTo.channelId),
                    guildEmojis = state.guildEmojis,
                    mentionResolve = mentionResolve,
                    emojiUrl = emojiUrl,
                    msg = m,
                    grouped = grouped,
                    onLongPress = onLongPress,
                    onImageTap = onImageTap,
                    onVideoTap = onVideoTap,
                    onEncImageTap = onEncImageTap,
                    showReceipt = m.id == receiptAnchorId,
                    highlighted = m.id == highlightedId,
                    onJumpTo = onJumpTo,
                )
            }
        }
        // Jump to newest. Gated on the SAME `atBottom` derivation the
        // auto-follow above uses, so the two can never disagree: the button
        // is visible exactly when an incoming message would NOT follow.
        // Composed conditionally rather than faded out — at the bottom it must
        // not exist at all, or its 44dp tap target would sit over the
        // composer's send button and swallow taps meant for it.
        if (!atBottom) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    // Padding OUTSIDE .size(), so the 44dp tap target itself
                    // stops 2dp short of the list's bottom edge — which is the
                    // composer's top edge. That 2dp is the gap; the ripple
                    // cannot reach the composer either.
                    //
                    // The disc is bottom-end aligned inside the 44dp target, so
                    // the target grows UP and LEFT and the DISC is what sits on
                    // the 15dp inset (iOS does the same with
                    // `alignment: .bottomTrailing`). Concentric with the send
                    // button: that button's centre is 10 (composer row
                    // padding) + 46/2 = 33dp in from the screen edge, and the
                    // disc's centre is 15 + 36/2 = 33dp. Both numbers move if
                    // the disc size changes — recompute, don't nudge.
                    .padding(end = 15.dp, bottom = 2.dp)
                    .size(44.dp)
                    .clip(CircleShape)
                    .clickable { jumpScope.launch { listState.animateScrollToItem(messages.lastIndex) } },
                contentAlignment = Alignment.BottomEnd,
            ) {
                Box(
                    Modifier
                        .size(36.dp)
                        // iOS spec is black @35%, blur 6, y +2. Compose has no
                        // direct equivalent — its elevation shadow renders at
                        // roughly y = E/2 and blur = 1.5E, so 4dp is the
                        // closest single number, and it matches the elevation
                        // the profile-card bubble already uses.
                        .shadow(4.dp, CircleShape)
                        .clip(CircleShape)
                        .background(p.bg2)
                        .border(1.dp, p.line, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.KeyboardArrowDown,
                        contentDescription = "Jump to newest messages",
                        tint = ZkInk.ink2,
                        modifier = Modifier.size(15.dp),
                    )
                }
            }
        }
    }
}

/** The red "New messages" separator at the frozen unread boundary — one rule
 *  then the label, no trailing rule (iOS UnreadDividerView,
 *  MessageViews.swift:1846-1856; web matches). */
@Composable
private fun UnreadDivider() {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(ZkStatus.danger))
        Text(
            "New messages", color = ZkStatus.danger, fontFamily = ZkSans, fontWeight = FontWeight.Bold,
            fontSize = 10.sp, letterSpacing = 0.sp, modifier = Modifier.padding(horizontal = 8.dp),
        )
    }
}

/** system_call notice: "Call ended · 5m 23s", red "Missed call from X" only for
 *  the callee, "No answer" for the caller — no avatar (iOS systemRow). */
@Composable
private fun CallNoticeRow(me: com.zekktris.data.model.SelfUser?, msg: Message) {
    val missed = msg.metadata?.missed == true
    val alert = missed && msg.metadata?.initiatorId != me?.id
    val caller = msg.author?.bestName ?: "Someone"
    val summary = if (missed) {
        if (msg.metadata?.initiatorId == me?.id) "No answer" else "Missed call from $caller"
    } else {
        val total = (msg.metadata?.durationMs ?: 0L) / 1000
        val label = when {
            total >= 3600 -> "${total / 3600}h ${(total % 3600) / 60}m"
            total >= 60 -> "${total / 60}m ${total % 60}s"
            else -> "${total}s"
        }
        "Call ended · $label"
    }
    Row(
        Modifier.fillMaxWidth().padding(start = AVATAR_LANE.dp, end = 14.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Call, null,
            tint = if (alert) ZkStatus.dangerSoft.copy(alpha = 0.85f) else ZkInk.ink3,
            modifier = Modifier.size(13.dp),
        )
        Text(
            summary, color = if (alert) ZkStatus.dangerSoft.copy(alpha = 0.9f) else ZkInk.ink2,
            fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(start = 7.dp),
        )
        Text("·", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 5.dp))
        Text(shortTime(msg.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp)
    }
}

/** Legacy persisted pokes (metadata.kind == "poke") render as a centered
 *  notice line — no avatar — and break author grouping (iOS parity). */
@Composable
private fun PokeNoticeRow(me: com.zekktris.data.model.SelfUser?, msg: Message) {
    val type = msg.metadata?.pokeType ?: "poke"
    val mine = msg.metadata?.initiatorId == me?.id
    val text = if (mine) "You ${pokeSentVerb(type)}"
    else "${msg.author?.bestName ?: "Someone"} ${pokeVerb(type)}"
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(pokeEmoji(type), fontSize = 15.sp)
        Text(text, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
    }
}

@Composable
private fun DayDivider(label: String) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(p.lineSoft))
        // Uppercased, tracked, ink3 semibold (iOS MessageViews.swift:1260-1273).
        Text(
            label.uppercase(), color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold,
            fontSize = 10.sp, letterSpacing = 1.sp, modifier = Modifier.padding(horizontal = 10.dp),
        )
        Box(Modifier.weight(1f).height(1.dp).background(p.lineSoft))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    store: AppStore,
    // NARROWED ON PURPOSE — do not reintroduce `state: AppState` or the whole
    // message list here.
    //
    // Kotlin 2.1.20 + the Compose plugin means strong skipping is on, so unstable
    // parameters are compared by INSTANCE. AppState is a fresh instance on every
    // state change and the message list is a fresh list whenever messages change,
    // so passing either handed every visible row a new value on every presence
    // tick, typing indicator or unread update — recomposing every row, images and
    // embeds included, precisely while the user was scrolling. `store` is fine:
    // it is the same instance for the life of the screen.
    //
    // Everything below is a primitive or a small stable value the CALLER resolves,
    // so a row now recomposes only when its own inputs actually change.
    selectedGuildId: String?,
    joinGuild: com.zekktris.data.model.Guild?,
    isDM: Boolean,
    isFailed: Boolean,
    maskProfane: Boolean,
    e2eeUnlocked: Boolean,
    repliedTo: Message?,
    repliedToUnlocked: Boolean,
    guildEmojis: List<com.zekktris.data.model.GuildEmoji>,
    mentionResolve: (Char, String) -> String,
    emojiUrl: (String) -> String?,
    msg: Message,
    grouped: Boolean,
    onLongPress: (Message) -> Unit,
    onImageTap: (List<String>, Int) -> Unit,
    onVideoTap: (String) -> Unit,
    onEncImageTap: (List<Attachment>, Int) -> Unit = { _, _ -> },
    showReceipt: Boolean = false,
    highlighted: Boolean = false,
    onJumpTo: (String) -> Unit = {},
) {
    val p = ZkTheme.palette
    // system_join renders under the SERVER's identity — guild name + icon, no
    // profile tap, no tag/shimmer (iOS MessageViews.swift:1648-1667).
    // joinGuild is resolved by the caller (see the narrowing note above).
    // In a DM, the viewer's personal nickname for the author wins (iOS parity),
    // but never over a webhook's explicit author-name override.
    val dmNick = if (isDM) store.dmNickname(msg.authorId) else null
    val name = joinGuild?.name ?: msg.authorOverrideName ?: dmNick ?: msg.author?.bestName ?: "Unknown"
    val avatarUrl = joinGuild?.iconUrl ?: msg.authorOverrideAvatar ?: msg.author?.avatarUrl
    val pending = msg.id.startsWith("pending-")
    val failed = pending && isFailed
    val profileTapEnabled = msg.author != null && joinGuild == null
    // Parental control: one flag for BOTH the body and the reply quote, matching
    // iOS rowData (display + repliedDisplay are masked together).
    val maskProfane = maskProfane
    // Brief accent wash when this row is the jump-to target.
    val flash by androidx.compose.animation.animateColorAsState(
        if (highlighted) p.accent.copy(alpha = 0.14f) else androidx.compose.ui.graphics.Color.Transparent,
        label = "jumpFlash",
    )

    Column(
        Modifier
            .fillMaxWidth()
            // Pinned rows carry a faint amber wash under the jump-to flash
            // (iOS MessageViews.swift:2321-2326; web matches).
            .background(if (msg.pinned) Color(0xFFF59E0B).copy(alpha = 0.04f) else Color.Transparent)
            .background(flash)
            .combinedClickable(onClick = {}, onLongClick = { onLongPress(msg) })
            .padding(top = if (grouped) 1.dp else 8.dp, bottom = 1.dp)
            .alpha(if (pending) 0.55f else 1f),
    ) {
        // Reply reference: small quoted line above the message. Tapping it jumps
        // to the quoted message when it's in the loaded window.
        msg.replyToId?.let { rid ->
            val ref = repliedTo
            // Same treatment as the body below: decrypt E2EE replies (else the
            // quote shows raw ciphertext), memoize so the crypto doesn't re-run
            // on every recompose, and mask it for a supervised child — iOS masks
            // repliedDisplay alongside display (MessageViews.swift rowData).
            val refUnlocked = ref != null && repliedToUnlocked
            val refBody: String? = remember(ref?.channelId, ref?.content, refUnlocked, maskProfane) {
                if (ref == null) null else {
                    val rendered = store.renderContent(ref.channelId, ref.content)
                    (if (maskProfane) ProfanityFilter.mask(rendered) else rendered).ifBlank { "attachment" }
                }
            }
            Row(
                Modifier
                    .padding(start = AVATAR_LANE.dp, end = 14.dp, bottom = 1.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .clickable { onJumpTo(rid) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Filled.Reply, null, tint = ZkInk.ink4, modifier = Modifier.size(12.dp))
                Text(
                    text = if (ref != null && refBody != null)
                        "${ref.author?.bestName ?: "Unknown"}: $refBody"
                    else "Original message",
                    color = ZkInk.ink3,
                    fontFamily = ZkSans,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 4.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth()) {
            Box(Modifier.width(AVATAR_LANE.dp), contentAlignment = Alignment.TopCenter) {
                if (!grouped) {
                    val opener = Modifier.clip(CircleShape).clickable(enabled = profileTapEnabled) { msg.author?.let { store.openProfile(it) } }
                    Box(opener) {
                        Avatar(
                            url = avatarUrl, name = name, size = 40.dp,
                            // iOS passes the author's decoration frame here, and
                            // suppresses it for webhook / server-identity rows
                            // (MessageViews.swift:2242-2252).
                            decoration = if (joinGuild != null || msg.authorOverrideName != null) null else msg.author?.avatarDecoration,
                            toneId = joinGuild?.id ?: if (msg.authorOverrideName != null) null else msg.author?.id,
                        )
                    }
                }
            }
            Column(Modifier.weight(1f).padding(end = 14.dp)) {
                if (!grouped) {
                    // A webhook / server author (authorOverrideName) — and the
                    // guild identity on system_join — never gets the staff
                    // shimmer or the real user's tag.
                    val realAuthor = if (msg.authorOverrideName != null || joinGuild != null) null else msg.author
                    // Guild channels color the name by the member's highest
                    // colored role (iOS authorColorRGB); DMs stay ink1.
                    val roleColor = if (realAuthor != null && !isDM) {
                        store.memberColorRGB(selectedGuildId, msg.authorId)?.let {
                            Color(0xFF000000.toInt() or it)
                        }
                    } else null
                    Row(verticalAlignment = Alignment.Bottom) {
                        if (realAuthor != null && !realAuthor.tagLabel.isNullOrBlank()) {
                            NameTag(realAuthor.tagLabel, realAuthor.tagColor, Modifier.align(Alignment.CenterVertically).padding(end = 5.dp))
                        }
                        StaffName(
                            user = realAuthor, text = name, baseColor = roleColor ?: ZkInk.ink1, fontSize = 15.sp,
                            fontWeight = FontWeight.Medium,
                            // weight(fill = false) so the name yields to the
                            // timestamp and takes what is left, instead of being
                            // measured first and ellipsized early. Without it a
                            // long username was cut off well before it had to be
                            // — the DM header at :965 already does this.
                            modifier = Modifier
                                .weight(1f, fill = false)
                                .clickable(enabled = profileTapEnabled) { msg.author?.let { store.openProfile(it) } },
                        )
                        Text(
                            shortTime(msg.createdAt),
                            color = ZkInk.ink3,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(start = 8.dp, bottom = 1.dp),
                        )
                    }
                }
                msg.forwardedFrom?.let { ForwardedBlock(it) }
                if (msg.content.isNotBlank()) {
                    // E2EE: decrypt when unlocked, else a lock tombstone; plain
                    // content passes through unchanged. Memoized on (content, unlock)
                    // so the PBKDF/AES work doesn't re-run on every recompose.
                    // Parental control: bake the swear-word mask into the same
                    // memoized display string (iOS rowData) — a supervised
                    // child must never see the raw body, and keying on the flag
                    // re-renders when family loads or the parent toggles it.
                    
                    val display = remember(msg.content, e2eeUnlocked, maskProfane) {
                        val rendered = store.renderContent(msg.channelId, msg.content)
                        if (maskProfane) ProfanityFilter.mask(rendered) else rendered
                    }
                    Row(verticalAlignment = Alignment.Bottom) {
                        MessageContent(
                            display, mentionResolve, emojiUrl,
                            modifier = Modifier.weight(1f, fill = false).padding(top = 1.dp),
                        )
                        if (msg.editedAt != null) {
                            Text(
                                "(edited)",
                                color = ZkInk.ink4,
                                fontFamily = ZkSans,
                                fontStyle = FontStyle.Italic,
                                fontSize = 10.sp,
                                modifier = Modifier.padding(start = 5.dp, bottom = 1.dp),
                            )
                        }
                    }
                }
                msg.sticker?.let { StickerView(it) }
                msg.poll?.let { PollCard(msg, it, store) }
                MessageMedia(
                    store, msg.channelId, msg.attachments,
                    e2eeUnlocked = e2eeUnlocked,
                    onImageTap = onImageTap, onVideoTap = onVideoTap, onEncImageTap = onEncImageTap,
                )
                msg.embeds?.takeIf { it.isNotEmpty() }?.forEach { EmbedView(it) }
                if (msg.reactions.isNotEmpty()) {
                    ReactionChips(msg, guildEmojis) { emoji -> store.toggleReaction(msg.channelId, msg.id, emoji) }
                }
                if (showReceipt && !pending) {
                    val label = when {
                        msg.viewedAt != null -> "Read ${shortTime(msg.viewedAt)}"
                        msg.deliveredAt != null -> "Delivered"
                        else -> "Sent"
                    }
                    Text(
                        label,
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 10.sp,
                        modifier = Modifier.align(Alignment.End).padding(top = 2.dp),
                    )
                }
                // Optimistic-send status footer (iOS MessageViews.swift:1759-1786):
                // "Sending…" while in flight; red Failed + Retry/Delete on error.
                if (pending) {
                    if (failed) {
                        Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Failed to send", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 11.sp)
                            Text(
                                "Retry", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
                                modifier = Modifier.padding(start = 10.dp).clip(RoundedCornerShape(6.dp))
                                    .clickable { store.retrySend(msg.channelId, msg.id) }.padding(horizontal = 4.dp, vertical = 2.dp),
                            )
                            Text(
                                "Delete", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp,
                                modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(6.dp))
                                    .clickable { store.discardFailedSend(msg.channelId, msg.id) }.padding(horizontal = 4.dp, vertical = 2.dp),
                            )
                        }
                    } else {
                        Text("Sending…", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 10.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
    }
}

private val CUSTOM_REACTION = Regex("^:([a-zA-Z0-9_]{2,32}):$")

@Composable
private fun ReactionChips(msg: Message, guildEmojis: List<com.zekktris.data.model.GuildEmoji>, onToggle: (String) -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.padding(top = 4.dp).horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        msg.reactions.forEach { r ->
            // A custom `:name:` reaction resolves to the guild emoji image; a
            // plain unicode reaction renders as text (matches iOS/web glyph).
            val customUrl = CUSTOM_REACTION.find(r.emoji)?.groupValues?.get(1)?.let { name ->
                guildEmojis.firstOrNull { it.name == name }?.let { Config.absoluteUrl(it.url) ?: it.url }
            }
            // iOS ReactionPill (MessageViews.swift:3103-3119): radius 6, 6/3
            // padding, a border on EVERY pill, and an always-ink2 regular count.
            Row(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (r.me) p.accent.copy(alpha = 0.2f) else p.bg2)
                    .border(1.dp, if (r.me) p.accent.copy(alpha = 0.6f) else p.line, RoundedCornerShape(6.dp))
                    .clickable { onToggle(r.emoji) }
                    .padding(horizontal = 6.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (customUrl != null) {
                    AsyncImage(customUrl, r.emoji, contentScale = ContentScale.Fit, modifier = Modifier.size(18.dp))
                } else {
                    Text(r.emoji, fontSize = 13.sp)
                }
                Text(
                    "${r.count}",
                    color = ZkInk.ink2,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.Normal,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(start = 4.dp),
                )
            }
        }
    }
}

/** Opens an http(s) link (guards against untrusted deep-link schemes). */
private fun openLink(handler: UriHandler, url: String) {
    if (url.startsWith("http://") || url.startsWith("https://")) runCatching { handler.openUri(url) }
}

/** "Forwarded from X in #Y" snapshot block, above the message body. */
@Composable
private fun ForwardedBlock(fwd: ForwardSource) {
    val p = ZkTheme.palette
    val who = fwd.author?.bestName ?: "Unknown"
    val where = fwd.channel?.name?.let { "#$it" } ?: "a channel"
    Row(Modifier.padding(vertical = 2.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(p.line))
        Column(Modifier.padding(start = 8.dp)) {
            Text(
                "↪ Forwarded from $who in $where",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (fwd.content.isBlank()) {
                Text("[unavailable]", color = ZkInk.ink4, fontFamily = ZkSans, fontStyle = FontStyle.Italic, fontSize = 14.sp, modifier = Modifier.padding(top = 1.dp))
            } else {
                Text(fwd.content, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 1.dp))
            }
        }
    }
}

/** A message sticker: a 140dp bare image (no card), leading-aligned. */
@Composable
private fun StickerView(sticker: Sticker) {
    val url = Config.absoluteUrl(sticker.url) ?: return
    AsyncImage(
        model = url,
        contentDescription = sticker.name,
        contentScale = ContentScale.Fit,
        modifier = Modifier.padding(top = 2.dp).size(140.dp),
    )
}

/** Link / rich / image embed card under a message. */
@Composable
private fun EmbedView(embed: MessageEmbed) {
    val handler = LocalUriHandler.current
    when (embed.kind) {
        "image" -> {
            val url = Config.absoluteUrl(embed.imageUrl)
            if (url != null) {
                AsyncImage(
                    model = url, contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .padding(top = 2.dp)
                        .widthIn(max = 260.dp)
                        .height(146.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .clickable { openLink(handler, embed.url) },
                )
            }
        }
        "rich" -> RichEmbedCard(embed, handler)
        else -> LinkEmbedCard(embed, handler)
    }
}

@Composable
private fun LinkEmbedCard(embed: MessageEmbed, handler: UriHandler) {
    val p = ZkTheme.palette
    Row(
        Modifier
            .padding(top = 2.dp)
            .widthIn(max = 300.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(p.bg2)
            .clickable { openLink(handler, embed.url) }
            .height(IntrinsicSize.Min)
            .padding(10.dp),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(p.accent))
        Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            val fav = Config.absoluteUrl(embed.faviconUrl)
            if (!embed.siteName.isNullOrBlank()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (fav != null) {
                        AsyncImage(fav, null, modifier = Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).padding(end = 0.dp))
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(embed.siteName!!, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (!embed.title.isNullOrBlank()) {
                Text(embed.title!!, color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!embed.description.isNullOrBlank()) {
                Text(embed.description!!, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
            if (embed.title.isNullOrBlank() && embed.description.isNullOrBlank()) {
                Text(embed.url, color = p.accent, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Config.absoluteUrl(embed.imageUrl)?.let { img ->
                AsyncImage(
                    img, null, contentScale = ContentScale.Fit,
                    modifier = Modifier.padding(top = 2.dp).widthIn(max = 240.dp).height(135.dp).clip(RoundedCornerShape(8.dp))
                        .clickable { openLink(handler, embed.url) },
                )
            }
        }
    }
}

@Composable
private fun RichEmbedCard(embed: MessageEmbed, handler: UriHandler) {
    val p = ZkTheme.palette
    val bar = embed.color?.let {
        Color(red = (it shr 16 and 0xff) / 255f, green = (it shr 8 and 0xff) / 255f, blue = (it and 0xff) / 255f)
    } ?: p.accent
    Row(
        Modifier
            .padding(top = 2.dp)
            .widthIn(max = 340.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(p.bg2)
            .clickable { openLink(handler, embed.url) }
            .height(IntrinsicSize.Min),
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(bar))
        Column(Modifier.weight(1f).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val authorIcon = Config.absoluteUrl(embed.authorIconUrl)
            if (!embed.authorName.isNullOrBlank()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (authorIcon != null) {
                        AsyncImage(authorIcon, null, modifier = Modifier.size(18.dp).clip(CircleShape))
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(embed.authorName!!, color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (!embed.title.isNullOrBlank()) {
                Text(embed.title!!, color = if (embed.url.isBlank()) ZkInk.ink1 else p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            }
            if (!embed.description.isNullOrBlank()) {
                Text(embed.description!!, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp)
            }
            embed.fields?.forEach { f ->
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(f.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
                    Text(f.value, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp)
                }
            }
            Config.absoluteUrl(embed.imageUrl)?.let { img ->
                AsyncImage(
                    img, null, contentScale = ContentScale.Fit,
                    modifier = Modifier.widthIn(max = 280.dp).height(158.dp).clip(RoundedCornerShape(8.dp))
                        .clickable { openLink(handler, embed.url) },
                )
            }
            if (!embed.footerText.isNullOrBlank()) {
                Text(embed.footerText!!, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Config.absoluteUrl(embed.thumbnailUrl)?.let { thumb ->
            AsyncImage(
                thumb, null, contentScale = ContentScale.Crop,
                modifier = Modifier.padding(top = 10.dp, end = 10.dp).size(64.dp).clip(RoundedCornerShape(6.dp)),
            )
        }
    }
}

/** A poll message: question + option rows with a proportional fill bar, vote
 *  counts, and tap-to-vote (mirrors iOS PollCard). */
@Composable
private fun PollCard(msg: Message, poll: com.zekktris.data.model.Poll, store: AppStore) {
    val p = ZkTheme.palette
    Column(
        Modifier.padding(top = 4.dp).widthIn(max = 320.dp)
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, p.line, RoundedCornerShape(10.dp))
            .background(p.bg2)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(poll.question, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        poll.options.sortedBy { it.position }.forEach { opt ->
            val mine = poll.myVotes.contains(opt.id)
            val frac = if (poll.totalVoters > 0) (opt.voteCount.toFloat() / poll.totalVoters).coerceIn(0f, 1f) else 0f
            Box(
                Modifier
                    .fillMaxWidth().height(36.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(p.bg3.copy(alpha = 0.4f))
                    .clickable(enabled = poll.isOpen) { store.togglePollVote(msg, opt.id) },
            ) {
                Box(
                    Modifier.fillMaxHeight().fillMaxWidth(frac).clip(RoundedCornerShape(8.dp))
                        .background(if (mine) p.accent.copy(alpha = 0.28f) else p.bg3),
                )
                Row(
                    Modifier.fillMaxSize().padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (mine) Text("✓", color = p.accent, fontSize = 13.sp, modifier = Modifier.padding(end = 6.dp))
                    Text(opt.text, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text("${opt.voteCount}", color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 12.sp)
                }
            }
        }
        val footer = buildList {
            add("${poll.totalVoters} vote${if (poll.totalVoters == 1) "" else "s"}")
            if (poll.multipleChoice) add("Multiple choice")
            if (!poll.isOpen) add("Closed")
        }.joinToString(" · ")
        Text(footer, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
    }
}

/** Images → tappable single image or 2-col grid (opens the lightbox); other
 *  attachments (video/file) fall through to the file chip. E2EE (.zke)
 *  attachments are bucketed by their INNER filename (the server only sees
 *  octet-stream ciphertext): images render via EncryptedImageThumb from
 *  in-memory decrypted bytes, everything else shows a sealed-file chip. */
@Composable
private fun MessageMedia(
    store: AppStore,
    channelId: String,
    attachments: List<Attachment>,
    e2eeUnlocked: Boolean,
    onImageTap: (List<String>, Int) -> Unit,
    onVideoTap: (String) -> Unit,
    onEncImageTap: (List<Attachment>, Int) -> Unit,
) {
    // Playable voice notes first (E2EE .zke clips need the crypto layer, so
    // they fall through to the sealed chip below).
    val voice = attachments.filter { it.isVoiceMessage == true && !com.zekktris.ui.components.isZke(it) }
    voice.forEach { VoiceMessageView(it) }
    // Video attachments → tappable poster card that opens the full-screen player.
    // Once retention has aged the original out there is nothing to play, so the
    // card keeps its (permanently-kept) poster but loses the play affordance.
    attachments.filter { it.isVideo }.forEach { v ->
        VideoCard(v, playUrl = if (v.blobExpired) null else Config.absoluteUrl(v.url), onTap = onVideoTap)
    }
    val images = attachments.filter { it.isImage && it.isVoiceMessage != true }
    // The pageable lightbox set: only images whose FULL-SIZE original is still
    // stored — the lightbox loads the original, and an expired one 404s into a
    // permanent spinner. Carried as (id, url) pairs so the tapped index always
    // lines up with the URL list even when entries drop out of it.
    val openable = images.filter { !it.blobExpired }
        .mapNotNull { att -> Config.absoluteUrl(att.url)?.let { att.id to it } }
    val openUrls = openable.map { it.second }
    when {
        images.isEmpty() -> {}
        images.size == 1 -> {
            val att = images[0]
            inlineImageUrl(att)?.let { u ->
                val idx = openable.indexOfFirst { it.first == att.id }
                Box(Modifier.padding(top = 4.dp)) {
                    AsyncImage(
                        model = u, contentDescription = att.filename, contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .widthIn(max = 260.dp).heightIn(max = 320.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .then(if (idx >= 0) Modifier.clickable { onImageTap(openUrls, idx) } else Modifier),
                    )
                    if (att.blobExpired) ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
                }
            }
        }
        else -> {
            Column(Modifier.padding(top = 4.dp).widthIn(max = 260.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                images.chunked(2).forEach { rowImgs ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        rowImgs.forEach { img ->
                            val idx = openable.indexOfFirst { it.first == img.id }
                            Box(Modifier.weight(1f)) {
                                AsyncImage(
                                    model = inlineImageUrl(img), contentDescription = img.filename,
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(8.dp))
                                        .then(if (idx >= 0) Modifier.clickable { onImageTap(openUrls, idx) } else Modifier),
                                )
                                if (img.blobExpired) ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
                            }
                        }
                        if (rowImgs.size == 1) Box(Modifier.weight(1f))
                    }
                }
            }
        }
    }
    // Encrypted images: decrypted in memory, rendered like the plain grid.
    // Tap → the encrypted lightbox (same in-memory bytes, swipe between them).
    val encImages = attachments.filter { com.zekktris.ui.components.isZkeImage(it) }
    // Same rule as the plain grid: the E2EE lightbox decrypts the FULL blob, so
    // an expired original isn't in the pageable set. Its (client-encrypted)
    // thumbnail is kept forever and still renders inline.
    val encOpenable = encImages.filter { !it.blobExpired }
    when {
        encImages.isEmpty() -> {}
        encImages.size == 1 -> {
            val att = encImages[0]
            // Reserve the slot from the plaintext dims metadata (the server
            // can't measure ciphertext) so the row doesn't reflow on decrypt.
            val ratio = if (att.width != null && att.height != null && att.width > 0 && att.height > 0) {
                (att.width.toFloat() / att.height.toFloat()).coerceIn(0.5f, 2.5f)
            } else 4f / 3f
            Box(Modifier.padding(top = 4.dp)) {
                com.zekktris.ui.components.EncryptedImageThumb(
                    store, channelId, att, e2eeUnlocked, ContentScale.Crop,
                    Modifier
                        .widthIn(max = 260.dp).heightIn(max = 320.dp)
                        .aspectRatio(ratio)
                        .clip(RoundedCornerShape(10.dp))
                        .then(
                            if (att.blobExpired) Modifier
                            else Modifier.clickable { onEncImageTap(encOpenable, 0) },
                        ),
                )
                if (att.blobExpired) ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
            }
        }
        else -> {
            Column(Modifier.padding(top = 4.dp).widthIn(max = 260.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                encImages.chunked(2).forEach { rowImgs ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        rowImgs.forEach { att ->
                            val idx = encOpenable.indexOfFirst { it.id == att.id }
                            Box(Modifier.weight(1f)) {
                                com.zekktris.ui.components.EncryptedImageThumb(
                                    store, channelId, att, e2eeUnlocked, ContentScale.Crop,
                                    Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(8.dp))
                                        .then(
                                            if (idx >= 0) Modifier.clickable { onEncImageTap(encOpenable, idx) }
                                            else Modifier,
                                        ),
                                )
                                if (att.blobExpired) ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
                            }
                        }
                        if (rowImgs.size == 1) Box(Modifier.weight(1f))
                    }
                }
            }
        }
    }
    // Encrypted non-images (files / voice clips): a sealed chip showing the
    // INNER filename — opening/decrypting these buckets is phase 2.
    attachments.filter { com.zekktris.ui.components.isZke(it) && !com.zekktris.ui.components.isZkeImage(it) }
        .forEach { EncryptedFileChip(it) }
    // File chips for the rest — but NOT the playable voice notes already rendered
    // by VoiceMessageView above (else they'd double-render as a chip too), and
    // NOT .zke attachments (all rendered by the encrypted buckets above).
    attachments.filterNot {
        it.isImage || it.isVideo || com.zekktris.ui.components.isZke(it) || it.isVoiceMessage == true
    }.forEach { AttachmentView(it) }
}

/** Sealed E2EE file chip: lock icon + the inner (decrypted) filename. */
@Composable
private fun EncryptedFileChip(att: Attachment) {
    val p = ZkTheme.palette
    Row(
        Modifier
            .padding(top = 4.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(p.bg2)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (att.blobExpired) Icons.Filled.Schedule else Icons.Filled.Lock,
            contentDescription = if (att.blobExpired) "Original expired" else "Encrypted file",
            tint = ZkInk.ink3, modifier = Modifier.size(18.dp),
        )
        Column(Modifier.padding(start = 8.dp)) {
            Text(
                com.zekktris.ui.components.zkeInnerName(att),
                color = ZkInk.ink2,
                fontSize = 13.sp,
            )
            // Sealed file whose ciphertext retention aged out — nothing left to
            // decrypt, so say that plainly rather than looking merely locked.
            if (att.blobExpired) {
                Text("Original expired", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
            }
        }
    }
}

/** A video attachment poster (thumbnail or dark box) with a centered play
 *  overlay. Tap opens the full-screen player.
 *
 *  [playUrl] is null once media retention aged the original out: the poster (a
 *  permanently-kept thumbnail) stays, but the play overlay and the tap go away
 *  rather than handing the player a dead URL to buffer forever. */
@Composable
private fun VideoCard(att: Attachment, playUrl: String?, onTap: (String) -> Unit) {
    val p = ZkTheme.palette
    val thumb = Config.absoluteUrl(att.thumbnailUrl)
    Box(
        Modifier
            .padding(top = 4.dp)
            .widthIn(max = 260.dp)
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black)
            .then(if (playUrl != null) Modifier.clickable { onTap(playUrl) } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (thumb != null) {
            AsyncImage(model = thumb, contentDescription = att.filename, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        if (playUrl != null) {
            Box(
                Modifier.size(52.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.PlayArrow, "Play video", tint = Color.White, modifier = Modifier.size(32.dp)) }
        } else {
            ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
        }
    }
}

/** Calm corner marker for a photo/video whose full-size original the server no
 *  longer stores. Mirrors the iOS ExpiredOriginalBadge (MessageViews.swift):
 *  small translucent capsule over the surviving thumbnail — the picture is
 *  still there, only the original went. */
@Composable
private fun ExpiredOriginalBadge(modifier: Modifier = Modifier) {
    Row(
        modifier
            .padding(6.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.45f))
            .padding(horizontal = 6.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Schedule, contentDescription = null,
            tint = Color.White.copy(alpha = 0.92f), modifier = Modifier.size(10.dp),
        )
        Text(
            "Original expired",
            color = Color.White.copy(alpha = 0.92f),
            fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 10.sp,
            modifier = Modifier.padding(start = 3.dp),
        )
    }
}

/** The URL to render INLINE for a plain image: the small server thumbnail when
 *  there is one, else the original — but NEVER the original once retention has
 *  expired it, since that path no longer resolves. Mirrors iOS
 *  inlineAttachmentURL (MessageViews.swift). Null ⇒ nothing renderable. */
private fun inlineImageUrl(att: Attachment): String? =
    Config.absoluteUrl(att.thumbnailUrl) ?: if (att.blobExpired) null else Config.absoluteUrl(att.url)

@Composable
private fun AttachmentView(att: Attachment) {
    val p = ZkTheme.palette
    val url = inlineImageUrl(att)
    if (att.isImage && url != null) {
        AsyncImage(
            model = url,
            contentDescription = att.filename,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .padding(top = 4.dp)
                .widthIn(max = 260.dp)
                .heightIn(max = 320.dp)
                .clip(RoundedCornerShape(10.dp)),
        )
    } else {
        // iOS fileChip (MessageViews.swift:3006-3023): bg3 tile, 8pt padding,
        // grey doc glyph, ink1 medium filename.
        Row(
            Modifier
                .padding(top = 4.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(p.bg3)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (att.blobExpired) Icons.Filled.Schedule else Icons.AutoMirrored.Filled.InsertDriveFile,
                contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(18.dp),
            )
            Column(Modifier.padding(start = 8.dp)) {
                Text(
                    att.filename ?: "attachment",
                    color = ZkInk.ink1,
                    fontWeight = FontWeight.Medium,
                    fontSize = 13.sp,
                )
                // The bytes are gone; the row stays as a record of what was shared.
                if (att.blobExpired) {
                    Text("Original expired", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
                }
            }
        }
    }
}

/** "X is typing…" above the composer, resolved from the open channel's typing map. */
@Composable
private fun TypingLine(state: AppState, channelId: String, messages: List<Message>) {
    val now = System.currentTimeMillis()
    val typingIds = state.typingByChannel[channelId]?.filterValues { it > now }?.keys.orEmpty()
    if (typingIds.isEmpty()) return
    val channel = state.currentChannel
    fun nameOf(uid: String): String =
        channel?.recipients?.firstOrNull { it.id == uid }?.bestName
            ?: state.selectedGuildId?.let { g -> state.membersByGuild[g]?.firstOrNull { it.userId == uid }?.user?.bestName }
            ?: messages.lastOrNull { (it.authorId ?: it.author?.id) == uid }?.author?.bestName
            ?: "Someone"
    // iOS typingText (MessageViews.swift:1404-1410): one name, "A and B", then
    // a flat "Several people" collapse — rendered 11pt italic ink3 (:1183-1191).
    val ordered = typingIds.toList()
    val label = when (ordered.size) {
        1 -> "${nameOf(ordered[0])} is typing…"
        2 -> "${nameOf(ordered[0])} and ${nameOf(ordered[1])} are typing…"
        else -> "Several people are typing…"
    }
    Text(
        text = label,
        color = ZkInk.ink3,
        fontFamily = ZkSans,
        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
        fontSize = 11.sp,
        modifier = Modifier.padding(start = 16.dp, bottom = 2.dp),
    )
}

/** A picked/captured attachment waiting in the composer. [preview] is set only
 *  when the source file is gone by the time the chip renders (camera captures
 *  are deleted right after the read), so the thumbnail comes from memory. */
private class PendingFile(
    val part: ApiClient.UploadFilePart,
    val uri: android.net.Uri,
    val preview: ImageBitmap? = null,
)

/** An @-mention autocomplete candidate (member, or the @everyone/@here specials). */
private data class MentionCand(
    val id: String,
    val name: String,
    val username: String?,
    val avatar: String?,
    val special: Boolean = false,
)

@Composable
private fun Composer(
    store: AppStore,
    state: AppState,
    channelId: String,
    replyTo: Message?,
    editing: Message?,
    onCancelReply: () -> Unit,
    onCancelEdit: () -> Unit,
    onSent: () -> Unit,
) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val ioScope = androidx.compose.runtime.rememberCoroutineScope()
    var text by remember(channelId) { mutableStateOf("") }
    var pendingFiles by remember(channelId) { mutableStateOf<List<PendingFile>>(emptyList()) }

    // @-mention autocomplete: the trailing @word (at start or after whitespace,
    // no spaces) drives a suggestion list. Tapping inserts the <@id> token the
    // renderer resolves (or @everyone/@here literally).
    val atIdx = run {
        val i = text.lastIndexOf('@')
        if (i < 0 || editing != null) return@run -1
        val after = text.substring(i + 1)
        if (after.any { it == ' ' || it == '\n' }) return@run -1
        if (i > 0 && !text[i - 1].isWhitespace()) return@run -1
        i
    }
    val mentionSuggestions: List<MentionCand> = if (atIdx < 0) emptyList() else {
        val q = text.substring(atIdx + 1).lowercase()
        val pool = mutableListOf<MentionCand>()
        val guildId = state.selectedGuildId
        if (guildId != null) {
            state.membersByGuild[guildId]?.forEach { m ->
                pool += MentionCand(m.userId, m.user.bestName, m.user.username, m.user.avatarUrl)
            }
            pool += MentionCand("everyone", "everyone", null, null, special = true)
            pool += MentionCand("here", "here", null, null, special = true)
        } else {
            state.dms.firstOrNull { it.id == channelId }?.recipients?.forEach { u ->
                pool += MentionCand(u.id, u.bestName, u.username, u.avatarUrl)
            }
        }
        pool.filter {
            it.name.lowercase().contains(q) || it.username?.lowercase()?.contains(q) == true || (it.special && it.name.startsWith(q))
        }.distinctBy { it.id }.take(8)
    }
    fun applyMention(c: MentionCand) {
        val prefix = text.substring(0, atIdx)
        text = if (c.special) "$prefix@${c.name} " else "$prefix<@${c.id}> "
    }

    // Slash-command autocomplete: only while typing the command word itself
    // (a leading '/' with no space yet), and never when editing.
    val slashSuggestions: List<SlashCmd> = run {
        if (editing != null || !text.startsWith("/")) return@run emptyList()
        val body = text.drop(1)
        if (body.any { it == ' ' || it == '\n' }) return@run emptyList()
        SLASH_COMMANDS.filter { body.isEmpty() || it.name.startsWith(body.lowercase()) }
    }

    val focusRequester = remember { FocusRequester() }
    val channel = state.currentChannel
    val placeholderName = when {
        editing != null -> "Edit message"
        channel?.isDM == true -> ("Message " + (channel.recipients?.firstOrNull()?.bestName ?: "")).trim()
        channel != null -> "Message #${channel.name ?: "channel"}"
        else -> "Message"
    }
    // Starting a reply raises the keyboard.
    LaunchedEffect(replyTo) { if (replyTo != null) runCatching { focusRequester.requestFocus() } }

    // Prefill when entering edit mode (keyed on the target message).
    // Prefill the edit composer with the DECRYPTED text for E2EE messages (else
    // the user would edit — and re-send — the raw ciphertext).
    LaunchedEffect(editing?.id) { editing?.let { text = store.renderContent(it.channelId, it.content) } }

    var showAttachMenu by remember { mutableStateOf(false) }
    var showSchedule by remember { mutableStateOf(false) }
    var showEmoji by remember { mutableStateOf(false) }
    var showPoll by remember { mutableStateOf(false) }
    var showVoice by remember { mutableStateOf(false) }
    // rememberSaveable (as a String) so the capture target survives activity
    // recreation / process-death while the system camera is foregrounded —
    // otherwise the returned photo is silently dropped on low-RAM devices.
    var cameraUri by rememberSaveable { mutableStateOf<String?>(null) }

    // Wipe a camera capture off disk once it's been consumed into memory (same
    // rule as VoiceRecorder.stop: "consumed into memory — don't leak in
    // cacheDir"). The system camera writes a full-resolution PLAINTEXT JPEG,
    // which would otherwise outlive the send, sign-out and E2EE entirely.
    // NOTE: File(uri.path) is NOT this file — a FileProvider URI's path is
    // "/captures/<name>", which resolves to the filesystem root; the real file
    // has to be rebuilt under cacheDir.
    fun deleteCapture(uri: android.net.Uri?) {
        val name = uri?.lastPathSegment ?: return
        runCatching { java.io.File(java.io.File(ctx.cacheDir, "captures"), name).delete() }
    }

    // Read + attach the picked URIs OFF the main thread — reading a large
    // video fully into memory on the ActivityResult callback (which runs on
    // main) would ANR, and oversized files are dropped with a toast rather than
    // OOMing the process.
    fun attachUris(uris: List<android.net.Uri>, fromCamera: Boolean = false) {
        if (uris.isEmpty()) return
        ioScope.launch {
            val loaded = withContext(kotlinx.coroutines.Dispatchers.IO) {
                val out = uris.mapNotNull { loadPendingFile(ctx, it, withPreview = fromCamera) }
                // Delete only AFTER the read has finished, on this same IO
                // dispatcher — deleting back in the ActivityResult callback
                // would race the read and lose the attachment outright. Files
                // rejected for size are deleted too: the plaintext must go
                // either way.
                if (fromCamera) uris.forEach { deleteCapture(it) }
                out
            }
            val tooBig = uris.size - loaded.size
            pendingFiles = (pendingFiles + loaded).take(10)
            if (tooBig > 0) android.widget.Toast.makeText(ctx, "File too large (max $MAX_ATTACH_MB MB)", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(maxItems = 10),
    ) { uris -> attachUris(uris) }
    // Arbitrary file (documents, audio, anything).
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { attachUris(listOf(it)) }
    }
    // Camera capture → the system camera writes a JPEG to our FileProvider URI.
    // Either way that plaintext JPEG gets removed from cacheDir: on success by
    // attachUris once the bytes are in memory, on cancel right here (the file
    // already exists, possibly half-written).
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri?.let { android.net.Uri.parse(it) }
        cameraUri = null
        if (uri != null) {
            if (ok) attachUris(listOf(uri), fromCamera = true)
            else ioScope.launch { withContext(kotlinx.coroutines.Dispatchers.IO) { deleteCapture(uri) } }
        }
    }
    fun launchCamera() {
        val dir = java.io.File(ctx.cacheDir, "captures").apply { mkdirs() }
        val file = java.io.File(dir, "capture_${System.nanoTime()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        cameraUri = uri.toString()
        cameraLauncher.launch(uri)
    }

    // CAMERA has to be GRANTED before ACTION_IMAGE_CAPTURE, not merely
    // declared — and that is the whole bug this fixes.
    //
    // Counter-intuitively, an app that never declares CAMERA can fire
    // ACTION_IMAGE_CAPTURE freely: the camera app owns the hardware and its own
    // permission. But we DO declare it in the manifest (for voice video), and
    // Android then treats an un-granted declaration as "this app wants the
    // camera and was refused", so it throws SecurityException at the launcher
    // instead of opening the camera app. Chat capture had no runtime request at
    // all, so it threw for anyone who had not already granted CAMERA for a
    // video call. DeviceLoginScreens.kt hit the identical trap and documents it
    // the same way; keep the two in step.
    //
    // Asked for HERE, on the tap that needs it — never at launch.
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) launchCamera()
        else android.widget.Toast.makeText(
            ctx,
            "Camera access is off, so photos can't be taken. You can still attach from your gallery.",
            android.widget.Toast.LENGTH_LONG,
        ).show()
    }

    /** Entry point for the composer's camera action: gate, then capture. */
    fun captureFromCamera() {
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            ctx, android.Manifest.permission.CAMERA,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermission.launch(android.Manifest.permission.CAMERA)
    }

    // ── System share sheet hand-off ─────────────────────────────────────────
    // The user shared something into Zekktris from another app. A direct-share
    // target carries the DM it was aimed at; picking the plain app entry does
    // not, in which case the payload lands in the first conversation opened
    // after the share. Either way it is STAGED, never auto-sent — the user still
    // reviews (and can caption) it before it leaves the device.
    LaunchedEffect(state.pendingShare, channelId) {
        val share = state.pendingShare ?: return@LaunchedEffect
        if (share.channelId != null && share.channelId != channelId) return@LaunchedEffect
        // Consume FIRST so this can only ever fire once. Everything below runs
        // without suspending, so the recomposition this state write schedules
        // cannot cancel this coroutine part-way through — keep it that way if
        // anything is added here.
        store.consumePendingShare()
        share.text?.takeIf { it.isNotBlank() }?.let { shared ->
            text = if (text.isBlank()) shared else text.trimEnd() + "\n" + shared
        }
        if (share.uris.isNotEmpty()) {
            attachUris(share.uris.mapNotNull { runCatching { android.net.Uri.parse(it) }.getOrNull() })
        }
        runCatching { focusRequester.requestFocus() }
    }

    // E2EE DM whose key we don't hold: can't encrypt, so block sends (and keep
    // the draft) rather than shipping plaintext or silently dropping it.
    val e2eeLocked = state.dms.firstOrNull { it.id == channelId }?.isE2EE == true &&
        !state.e2eeUnlocked.contains(channelId)
    val e2eeOn = state.dms.firstOrNull { it.id == channelId }?.isE2EE == true

    fun submit() {
        if (e2eeLocked) return
        val t = text.trim()
        val e = editing
        if (e != null) {
            if (t.isNotEmpty() && t != e.content) store.editMessage(channelId, e.id, t)
            text = ""
            onSent()
            return
        }
        if (t.isEmpty() && pendingFiles.isEmpty()) return
        if (pendingFiles.isNotEmpty()) {
            // Attachment captions are sent verbatim — iOS applies no slash
            // transform to the caption path. On failure (encryption or upload)
            // the picked files are restored so the user can retry without
            // re-selecting everything (iOS sendAttachments behavior).
            val toSend = pendingFiles
            store.sendMessageWithFiles(channelId, t, replyTo?.id, toSend.map { it.part }) { ok, err ->
                if (!ok && pendingFiles.isEmpty()) pendingFiles = toSend
                // A pre-upload failure the user can act on — most often "we
                // couldn't build the mandatory E2EE preview for this photo".
                // Restoring the picks silently would look like nothing happened.
                if (!ok && err != null) {
                    android.widget.Toast.makeText(ctx, err, android.widget.Toast.LENGTH_LONG).show()
                }
            }
            pendingFiles = emptyList()
        } else {
            // Rewrite /me, /shrug, /tableflip, /unflip, /spoiler on send. Transform
            // the RAW draft THEN trim, matching iOS applySlashTransform(draft).trim()
            // so a leading-space slash stays literal.
            val out = applySlashTransform(text, state.me?.bestName ?: "someone").trim()
            store.sendMessage(channelId, out, replyTo?.id)
        }
        text = ""
        onSent()
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(p.bg1)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
    ) {
        // Hairline separating the composer from the stream (iOS
        // MessageViews.swift:1329 — a lineSoft rule along the composer's top).
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.lineSoft))
        // Slash-command suggestions (float above the input row).
        if (slashSuggestions.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp)).background(p.bg2),
            ) {
                slashSuggestions.forEach { cmd ->
                    Row(
                        Modifier.fillMaxWidth().clickable { text = "/${cmd.name} " }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("/${cmd.name}", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text(cmd.desc, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
                    }
                }
            }
        }
        // @-mention suggestions (float above the input row).
        if (mentionSuggestions.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(10.dp)).background(p.bg2),
            ) {
                mentionSuggestions.forEach { c ->
                    Row(
                        Modifier.fillMaxWidth().clickable { applyMention(c) }
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (c.special) {
                            Box(Modifier.size(24.dp).clip(CircleShape).background(p.accent.copy(alpha = 0.2f)), contentAlignment = Alignment.Center) {
                                Text("@", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            }
                        } else {
                            Avatar(url = c.avatar, name = c.name, size = 24.dp)
                        }
                        Text(
                            if (c.special) "@${c.name}" else c.name,
                            color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                            modifier = Modifier.padding(start = 8.dp),
                        )
                        c.username?.let {
                            Text("@$it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
        }
        // Reply / edit banner — iOS MessageViews.swift:1157-1180: a bordered
        // bg3 card at radius 6, with "Replying to" in ink3 and the name in
        // semibold ink2.
        if (replyTo != null || editing != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(p.bg3)
                    .border(1.dp, p.line, RoundedCornerShape(6.dp))
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (editing != null) Icons.Filled.Edit else Icons.AutoMirrored.Filled.Reply,
                    null, tint = p.accent, modifier = Modifier.size(14.dp),
                )
                if (editing != null) {
                    Text(
                        text = "Editing message",
                        color = ZkInk.ink2,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp).weight(1f),
                    )
                } else {
                    Text(
                        text = "Replying to ",
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                        maxLines = 1,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                    Text(
                        text = replyTo?.author?.bestName ?: "Unknown",
                        color = ZkInk.ink2,
                        fontFamily = ZkSans,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
                Icon(
                    Icons.Filled.Close, "Cancel", tint = ZkInk.ink3,
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable { if (editing != null) { text = ""; onCancelEdit() } else onCancelReply() }
                        .padding(4.dp)
                        .size(18.dp),
                )
            }
        }
        // Pending attachment chips.
        if (pendingFiles.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                pendingFiles.forEach { f ->
                    Box {
                        val chipMod = Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)).background(p.bg2)
                        val prev = f.preview
                        // Camera captures no longer exist on disk — draw them
                        // from the in-memory thumb instead of the (dead) URI.
                        if (prev != null) {
                            androidx.compose.foundation.Image(
                                bitmap = prev,
                                contentDescription = f.part.filename,
                                contentScale = ContentScale.Crop,
                                modifier = chipMod,
                            )
                        } else {
                            AsyncImage(
                                model = f.uri,
                                contentDescription = f.part.filename,
                                contentScale = ContentScale.Crop,
                                modifier = chipMod,
                            )
                        }
                        Icon(
                            Icons.Filled.Close, "Remove", tint = ZkInk.ink1,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(2.dp)
                                .clip(CircleShape)
                                .background(p.bg0.copy(alpha = 0.7f))
                                .clickable { pendingFiles = pendingFiles.filterNot { it === f } }
                                .padding(2.dp)
                                .size(12.dp),
                        )
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // "+" menu (hidden while editing — edits are text-only). In E2EE DMs
            // photos/camera ARE available — image bytes are encrypted with the
            // channel key before upload (.zke). Arbitrary files, voice notes and
            // polls stay suppressed there (phase 2); scheduling pre-encrypts.
            if (editing == null) {
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(p.bg2)
                        .clickable { showAttachMenu = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.Add, "Attach", tint = ZkInk.ink2, modifier = Modifier.size(20.dp))
                }
            }
            OutlinedTextField(
                value = text,
                onValueChange = {
                    text = it
                    if (it.isNotBlank() && editing == null) store.noteTyping(channelId)
                },
                enabled = !e2eeLocked,
                modifier = Modifier.weight(1f).focusRequester(focusRequester),
                placeholder = { Text(if (e2eeLocked) "🔒 Unlock in settings to send" else placeholderName, color = ZkInk.ink4) },
                maxLines = 5,
                // iOS composer is a flat radius-8 box, not a pill
                // (MessageViews.swift:1301-1305).
                shape = RoundedCornerShape(8.dp),
                colors = zkFieldColors(),
                trailingIcon = if (e2eeLocked) null else ({
                    Icon(
                        Icons.Filled.Mood, "Emoji", tint = ZkInk.ink3,
                        modifier = Modifier.clip(CircleShape).clickable { showEmoji = true }.padding(4.dp).size(22.dp),
                    )
                }),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { submit() }),
            )
            val canSend = (text.isNotBlank() || pendingFiles.isNotEmpty()) && !e2eeLocked
            // iOS (MessageViews.swift:1297-1303) is a 26pt `arrow.up.circle.fill`
            // with no container — and that SF symbol is itself a FILLED disc with
            // the arrow knocked out of it. So "no container" means no button
            // chrome around the glyph, NOT a bare arrow: the disc is the glyph.
            // A 44dp transparent box keeps the tap target while the visible disc
            // stays 26dp. (Icons.Filled.ArrowCircleUp lives in
            // material-icons-extended, which this module doesn't depend on, so
            // the disc is composed from primitives rather than adding a dep.)
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .clickable(enabled = canSend) { submit() },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(26.dp)
                        .clip(CircleShape)
                        .background(if (canSend) p.accent else ZkInk.ink4),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.KeyboardArrowUp,
                        contentDescription = "Send",
                        tint = p.bg0,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }

    if (showAttachMenu) {
        AttachMenuSheet(
            // Photos + camera work in E2EE DMs (encrypted before upload);
            // arbitrary files don't yet.
            allowMedia = true,
            allowFiles = !e2eeOn,
            // Polls are a guild-channel feature (not DMs) and can't be encrypted.
            allowPoll = state.currentChannel?.isDM == false && !e2eeOn,
            allowVoice = !e2eeOn,
            // E2EE: images only — encrypted video playback isn't wired yet, so
            // don't let a video slip into the (image-scoped) send path.
            mediaLabel = if (e2eeOn) "Photo" else "Photo or video",
            onDismiss = { showAttachMenu = false },
            onPhotoVideo = {
                showAttachMenu = false
                picker.launch(
                    PickVisualMediaRequest(
                        if (e2eeOn) ActivityResultContracts.PickVisualMedia.ImageOnly
                        else ActivityResultContracts.PickVisualMedia.ImageAndVideo,
                    ),
                )
            },
            onCamera = { showAttachMenu = false; captureFromCamera() },
            onFile = { showAttachMenu = false; filePicker.launch("*/*") },
            onSchedule = { showAttachMenu = false; showSchedule = true },
            onPoll = { showAttachMenu = false; showPoll = true },
            onVoice = { showAttachMenu = false; showVoice = true },
        )
    }
    if (showVoice) {
        VoiceRecordSheet(store, channelId, onDismiss = { showVoice = false })
    }
    if (showPoll) {
        CreatePollSheet(store, channelId, onDismiss = { showPoll = false })
    }
    if (showSchedule) {
        ScheduleSheet(
            store = store,
            state = state,
            channelId = channelId,
            draft = text,
            onScheduled = { text = "" },
            onDismiss = { showSchedule = false },
        )
    }
    if (showEmoji) {
        EmojiPickerSheet(
            onDismiss = { showEmoji = false },
            // Insert the glyph (or :name: custom-emoji shortcode) into the draft.
            onPick = { text += it },
            serverEmojis = state.guildEmojis.map { it.name to (com.zekktris.data.Config.absoluteUrl(it.url) ?: it.url) },
            title = "Add emoji",
        )
    }
}

/**
 * Rewrite the classic slash commands on send, byte-for-byte with iOS
 * applySlashTransform: /me → *speaker action*, /shrug|/tableflip|/unflip →
 * emoticon (optionally after arg text), /spoiler → ||text||. Unknown or
 * arg-less /me and /spoiler pass through unchanged.
 */
private fun applySlashTransform(input: String, speaker: String): String {
    if (!input.startsWith("/")) return input
    val body = input.drop(1)
    val sp = body.indexOfFirst { it == ' ' || it == '\n' || it == '\t' }
    val name = (if (sp >= 0) body.substring(0, sp) else body).lowercase()
    val arg = (if (sp >= 0) body.substring(sp + 1) else "").trim()
    val shrug = "¯\\_(ツ)_/¯"
    val tableflip = "(╯°□°)╯︵ ┻━┻"
    val unflip = "┬─┬ ノ( ゜-゜ノ)"
    return when (name) {
        "me" -> if (arg.isEmpty()) input else "*$speaker $arg*"
        "shrug" -> if (arg.isEmpty()) shrug else "$arg $shrug"
        "tableflip" -> if (arg.isEmpty()) tableflip else "$arg $tableflip"
        "unflip" -> if (arg.isEmpty()) unflip else "$arg $unflip"
        "spoiler" -> if (arg.isEmpty()) input else "||$arg||"
        else -> input
    }
}

/** The slash commands surfaced in the composer autocomplete. */
private data class SlashCmd(val name: String, val usage: String, val desc: String)
private val SLASH_COMMANDS = listOf(
    SlashCmd("me", "/me <action>", "Send an action — *you wave*"),
    SlashCmd("shrug", "/shrug [text]", "Append ¯\\_(ツ)_/¯"),
    SlashCmd("tableflip", "/tableflip [text]", "Append (╯°□°)╯︵ ┻━┻"),
    SlashCmd("unflip", "/unflip [text]", "Append ┬─┬ ノ( ゜-゜ノ)"),
    SlashCmd("spoiler", "/spoiler <text>", "Hide text behind a spoiler"),
)

/** Client-side attach cap (matches the server's default MAX_UPLOAD_SIZE_MB). */
private const val MAX_ATTACH_MB = 100
private const val MAX_ATTACH_BYTES = MAX_ATTACH_MB * 1024L * 1024L

/** Small in-memory thumb for a composer chip whose source file is about to be
 *  deleted (bounds pass + inSampleSize — never decodes a 12MP capture at full
 *  size for a 56dp chip). Mirrors EncryptedMedia's decodeDownsampled, which is
 *  private to that file. */
private fun decodeChipPreview(bytes: ByteArray, maxDim: Int = 160): ImageBitmap? = runCatching {
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
    val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}.getOrNull()

/**
 * Reads a content URI into an upload part. Call OFF the main thread — it reads
 * the whole file into memory. Files over [MAX_ATTACH_BYTES] are rejected (null)
 * before any read, so a huge video can't OOM/ANR the app.
 *
 * [withPreview] decodes the composer thumbnail up front, for sources (camera
 * captures) whose file is deleted the moment this returns.
 */
private fun loadPendingFile(
    ctx: android.content.Context,
    uri: android.net.Uri,
    withPreview: Boolean = false,
): PendingFile? = runCatching {
    var filename = "upload"
    var size = -1L
    ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
        val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
        if (c.moveToFirst()) {
            if (nameIdx >= 0) filename = c.getString(nameIdx) ?: filename
            if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
        }
    }
    if (size > MAX_ATTACH_BYTES) return@runCatching null
    val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
    // Give a name-less URI an extension so the server (which types by extension)
    // renders it correctly rather than as a generic octet-stream download.
    if (!filename.contains('.')) {
        android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { filename = "$filename.$it" }
    }
    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
    // Size may be unknown (-1) from the provider — enforce the cap post-read too.
    if (bytes.size > MAX_ATTACH_BYTES) return@runCatching null
    PendingFile(
        ApiClient.UploadFilePart(filename, mime, bytes), uri,
        preview = if (withPreview && mime.startsWith("image/")) decodeChipPreview(bytes) else null,
    )
}.getOrNull()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttachMenuSheet(
    allowMedia: Boolean,
    allowFiles: Boolean,
    allowPoll: Boolean,
    allowVoice: Boolean,
    mediaLabel: String,
    onDismiss: () -> Unit,
    onPhotoVideo: () -> Unit,
    onCamera: () -> Unit,
    onFile: () -> Unit,
    onSchedule: () -> Unit,
    onPoll: () -> Unit,
    onVoice: () -> Unit,
) {
    val p = ZkTheme.palette
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            if (allowMedia) {
                SheetAction(Icons.Filled.Image, mediaLabel, onClick = onPhotoVideo)
                SheetAction(Icons.Filled.PhotoCamera, "Camera", onClick = onCamera)
            }
            if (allowFiles) {
                SheetAction(Icons.AutoMirrored.Filled.InsertDriveFile, "File", onClick = onFile)
            }
            if (allowVoice) SheetAction(Icons.Filled.Mic, "Voice message", onClick = onVoice)
            if (allowPoll) SheetAction(Icons.Filled.BarChart, "Poll", onClick = onPoll)
            SheetAction(Icons.Filled.Schedule, "Schedule message", onClick = onSchedule)
        }
    }
}

/** Record + send a voice message. Auto-starts recording on open (mic permission
 *  requested), shows a live timer, then Stop → Send / re-record / cancel. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoiceRecordSheet(store: AppStore, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val recorder = remember { com.zekktris.voice.VoiceRecorder(ctx) }
    // States: idle → recording → stopped(recording) ; plus permission + busy.
    var recording by remember { mutableStateOf(false) }
    var elapsed by remember { mutableStateOf(0L) }
    var clip by remember { mutableStateOf<com.zekktris.voice.VoiceRecorder.Recording?>(null) }
    var busy by remember { mutableStateOf(false) }
    var permGranted by remember {
        mutableStateOf(androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permGranted = granted
        if (granted) { recording = recorder.start() }
    }

    // Start on open (or request permission first).
    LaunchedEffect(Unit) {
        if (permGranted) recording = recorder.start() else permLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
    }
    // Tick the timer + sample the waveform while recording.
    LaunchedEffect(recording) {
        while (recording) {
            recorder.sample()
            elapsed = recorder.elapsedMs()
            kotlinx.coroutines.delay(100)
        }
    }
    // Ensure the recorder is torn down if the sheet is dismissed mid-record.
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(
            Modifier.fillMaxWidth().padding(24.dp).padding(bottom = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("VOICE MESSAGE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(16.dp))
            val shownMs = if (clip != null) (clip!!.durationSec * 1000L) else elapsed
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (recording) Box(Modifier.size(10.dp).clip(CircleShape).background(ZkStatus.danger))
                Text(
                    "%d:%02d".format((shownMs / 1000) / 60, (shownMs / 1000) % 60),
                    color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 34.sp, modifier = Modifier.padding(start = if (recording) 10.dp else 0.dp),
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    !permGranted -> "Microphone permission needed."
                    recording -> "Recording… tap Stop when done."
                    clip != null -> "Ready to send."
                    else -> "Tap to record."
                },
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
            )
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (recording) {
                    Box(
                        Modifier.size(64.dp).clip(CircleShape).background(ZkStatus.danger).clickable {
                            recording = false
                            clip = recorder.stop()
                        },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.Stop, "Stop", tint = Color.White, modifier = Modifier.size(28.dp)) }
                } else if (clip != null) {
                    // Re-record.
                    Box(Modifier.size(52.dp).clip(CircleShape).background(p.bg3).clickable {
                        clip = null; elapsed = 0L; recording = recorder.start()
                    }, contentAlignment = Alignment.Center) { Icon(Icons.Filled.Mic, "Re-record", tint = ZkInk.ink1, modifier = Modifier.size(24.dp)) }
                    // Send.
                    Box(
                        Modifier.size(64.dp).clip(CircleShape).background(if (busy) p.bg3 else p.accent).clickable(enabled = !busy) {
                            busy = true
                            val c = clip ?: return@clickable
                            store.sendVoiceMessage(channelId, c) { ok -> busy = false; if (ok) onDismiss() }
                        },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = p.bg0, modifier = Modifier.size(26.dp)) }
                } else if (permGranted) {
                    // Idle (e.g. a too-short clip was discarded) → offer to record again.
                    Box(
                        Modifier.size(64.dp).clip(CircleShape).background(ZkStatus.danger).clickable {
                            elapsed = 0L; clip = null; recording = recorder.start()
                        },
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.Mic, "Record", tint = Color.White, modifier = Modifier.size(28.dp)) }
                }
            }
        }
    }
}

/** Compose a poll (guild channels only). Mirrors iOS CreatePollSheet: question,
 *  2–10 options, multiple-choice toggle, and a duration. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreatePollSheet(store: AppStore, channelId: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var question by remember { mutableStateOf("") }
    var options by remember { mutableStateOf(listOf("", "")) }
    var multiple by remember { mutableStateOf(false) }
    var durationHours by remember { mutableStateOf(24) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val durations = listOf(1 to "1h", 8 to "8h", 24 to "1d", 72 to "3d", 168 to "7d")
    val validOptions = options.map { it.trim() }.filter { it.isNotEmpty() }
    // The server requires 2+ UNIQUE options (max 80 chars each, enforced by the
    // input cap below), so mirror that here rather than 400ing on submit.
    val hasDupes = validOptions.size != validOptions.map { it.lowercase() }.toSet().size
    val canCreate = question.isNotBlank() && validOptions.size >= 2 && !hasDupes && !busy

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text("CREATE A POLL", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            FilledTextField(question, { question = it.take(300); error = null }, "Ask a question", Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            Text("OPTIONS", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(6.dp))
            options.forEachIndexed { i, opt ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    FilledTextField(opt, { v -> options = options.toMutableList().also { it[i] = v.take(80) }; error = null }, "Option ${i + 1}", Modifier.weight(1f))
                    if (options.size > 2) {
                        Icon(
                            Icons.Filled.Close, "Remove", tint = ZkInk.ink3,
                            modifier = Modifier.padding(start = 6.dp).clip(CircleShape)
                                .clickable { options = options.filterIndexed { idx, _ -> idx != i } }.padding(4.dp).size(18.dp),
                        )
                    }
                }
            }
            if (options.size < 10) {
                Text(
                    "+ Add option", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                    modifier = Modifier.padding(top = 4.dp).clickable { options = options + "" },
                )
            }
            if (hasDupes) {
                Text("Options must be unique.", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
            }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Allow multiple choices", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
                androidx.compose.material3.Switch(checked = multiple, onCheckedChange = { multiple = it })
            }
            Spacer(Modifier.height(8.dp))
            Text("DURATION", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                durations.forEach { (h, label) ->
                    val sel = h == durationHours
                    Text(
                        label, color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                        modifier = Modifier.clip(RoundedCornerShape(18.dp)).background(if (sel) p.accent else p.bg3).clickable { durationHours = h }.padding(horizontal = 14.dp, vertical = 7.dp),
                    )
                }
            }
            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp)
            }
            Spacer(Modifier.height(14.dp))
            PrimaryButton(if (busy) "Creating…" else "Create poll", enabled = canCreate) {
                busy = true; error = null
                scope.launch {
                    val err = store.sendPoll(channelId, question.trim(), validOptions, multiple, durationHours)
                    busy = false
                    if (err == null) onDismiss() else error = err
                }
            }
        }
    }
}

/**
 * Compose the current draft for future delivery + manage the pending queue.
 * Mirrors the iOS ScheduleSheet. E2EE DMs pre-encrypt in the store; the draft
 * shown here is the plaintext the user typed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleSheet(
    store: AppStore,
    state: AppState,
    channelId: String,
    draft: String,
    onScheduled: () -> Unit,
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    val trimmed = draft.trim()
    // Default to one hour out; the DatePicker/TimePicker mutate this instant.
    var whenMillis by remember { mutableStateOf(System.currentTimeMillis() + 3_600_000L) }
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { store.loadScheduled() }

    val whenLabel = remember(whenMillis) {
        val fmt = java.text.SimpleDateFormat("EEE, MMM d · h:mm a", java.util.Locale.getDefault())
        fmt.format(java.util.Date(whenMillis))
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text("SCHEDULE MESSAGE", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            if (trimmed.isEmpty()) {
                Text(
                    "Type a message in the composer first, then schedule it for later.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                )
            } else {
                Text(
                    draft,
                    color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp,
                    maxLines = 4, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg3).padding(10.dp),
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(p.bg3)
                            .clickable { showDate = true }.padding(vertical = 11.dp, horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.CalendarMonth, null, tint = p.accent, modifier = Modifier.size(16.dp))
                        Text(whenLabel, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
                    }
                    Box(
                        Modifier.clip(RoundedCornerShape(10.dp)).background(p.bg3)
                            .clickable { showTime = true }.padding(vertical = 11.dp, horizontal = 12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Schedule, "Pick time", tint = p.accent, modifier = Modifier.size(16.dp))
                    }
                }
                Spacer(Modifier.height(12.dp))
                PrimaryButton(if (busy) "Scheduling…" else "Schedule", enabled = !busy) {
                    // Guard against a past instant (the picker can land in the past).
                    if (whenMillis <= System.currentTimeMillis() + 60_000L) {
                        error = "Pick a time in the future."
                        return@PrimaryButton
                    }
                    busy = true; error = null
                    scope.launch {
                        val iso = java.time.Instant.ofEpochMilli(whenMillis).toString()
                        val err = store.scheduleMessage(channelId, trimmed, iso)
                        busy = false
                        if (err == null) { onScheduled(); onDismiss() } else error = err
                    }
                }
                error?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp)
                }
            }

            Spacer(Modifier.height(16.dp))
            Text("PENDING", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            Spacer(Modifier.height(8.dp))
            val pending = state.scheduled
            if (pending.isEmpty()) {
                Text("No scheduled messages.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    pending.take(20).forEach { sm ->
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg3).padding(10.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    sm.content?.let { store.renderContent(sm.channelId ?: channelId, it) } ?: "🔒 Encrypted message",
                                    color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis,
                                )
                                Text(scheduledWhenLabel(sm.scheduledFor), color = p.accent, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                            }
                            Icon(
                                Icons.Filled.Delete, "Cancel", tint = ZkStatus.dangerSoft,
                                modifier = Modifier.padding(start = 8.dp).clip(CircleShape).clickable { store.cancelScheduled(sm.id) }.padding(2.dp).size(16.dp),
                            )
                        }
                    }
                }
            }
        }
    }

    if (showDate) {
        val dateState = androidx.compose.material3.rememberDatePickerState(initialSelectedDateMillis = localDateAsUtcMillis(whenMillis))
        androidx.compose.material3.DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    dateState.selectedDateMillis?.let { whenMillis = mergeDate(whenMillis, it) }
                    showDate = false
                }) { Text("OK", color = p.accent) }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { showDate = false }) { Text("Cancel", color = ZkInk.ink3) } },
        ) { androidx.compose.material3.DatePicker(state = dateState) }
    }
    if (showTime) {
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = whenMillis }
        val timeState = androidx.compose.material3.rememberTimePickerState(
            initialHour = cal.get(java.util.Calendar.HOUR_OF_DAY),
            initialMinute = cal.get(java.util.Calendar.MINUTE),
            is24Hour = false,
        )
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showTime = false },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    whenMillis = mergeTime(whenMillis, timeState.hour, timeState.minute)
                    showTime = false
                }) { Text("OK", color = p.accent) }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { showTime = false }) { Text("Cancel", color = ZkInk.ink3) } },
            containerColor = p.bg2,
            text = { androidx.compose.material3.TimePicker(state = timeState) },
        )
    }
}

/** UTC-midnight millis for the LOCAL calendar date of [base] — the form a
 *  Material3 DatePicker expects (and that mergeDate reads back), so the picker
 *  opens on the user's local date instead of drifting a day near midnight. */
private fun localDateAsUtcMillis(base: Long): Long {
    val local = java.util.Calendar.getInstance().apply { timeInMillis = base }
    return java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
        clear()
        set(local.get(java.util.Calendar.YEAR), local.get(java.util.Calendar.MONTH), local.get(java.util.Calendar.DAY_OF_MONTH))
    }.timeInMillis
}

/** Replace the y/m/d of [base] with the calendar date encoded in [dateUtcMillis] (UTC midnight from the DatePicker), keeping [base]'s time-of-day. */
private fun mergeDate(base: Long, dateUtcMillis: Long): Long {
    val d = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply { timeInMillis = dateUtcMillis }
    return java.util.Calendar.getInstance().apply {
        timeInMillis = base
        set(java.util.Calendar.YEAR, d.get(java.util.Calendar.YEAR))
        set(java.util.Calendar.MONTH, d.get(java.util.Calendar.MONTH))
        set(java.util.Calendar.DAY_OF_MONTH, d.get(java.util.Calendar.DAY_OF_MONTH))
    }.timeInMillis
}

/** Replace the time-of-day of [base] with [hour]:[minute] (seconds zeroed). */
private fun mergeTime(base: Long, hour: Int, minute: Int): Long =
    java.util.Calendar.getInstance().apply {
        timeInMillis = base
        set(java.util.Calendar.HOUR_OF_DAY, hour)
        set(java.util.Calendar.MINUTE, minute)
        set(java.util.Calendar.SECOND, 0)
        set(java.util.Calendar.MILLISECOND, 0)
    }.timeInMillis

/** Human "Mon, Jul 14 · 3:30 PM" for a scheduled ISO-8601 instant. */
private fun scheduledWhenLabel(iso: String): String = runCatching {
    val millis = java.time.Instant.parse(iso).toEpochMilli()
    java.text.SimpleDateFormat("EEE, MMM d · h:mm a", java.util.Locale.getDefault()).format(java.util.Date(millis))
}.getOrDefault(iso)

/** Channel-scoped message search (iOS SearchSheet, MessageViews.swift:3139-3226):
 *  submit → per-channel full-text search, result rows with author/time/preview;
 *  tapping a result jumps to the message. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelSearchSheet(
    store: AppStore,
    channel: Channel?,
    channelId: String,
    onJump: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Message>?>(null) }
    var searching by remember { mutableStateOf(false) }
    fun search() {
        val q = query.trim()
        if (q.isEmpty()) return
        searching = true
        scope.launch {
            results = store.searchChannelMessages(channelId, q)
            searching = false
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().heightIn(min = 320.dp).padding(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = {
                    Text(
                        if (channel?.isDM == true) "Search this conversation" else "Search this channel",
                        color = ZkInk.ink4,
                    )
                },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                colors = zkFieldColors(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { search() }),
                modifier = Modifier.fillMaxWidth(),
            )
            val r = results
            when {
                searching -> Text("Searching…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 14.dp))
                r == null -> Text("Search messages in this conversation.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 14.dp))
                r.isEmpty() -> Text("No results.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(vertical = 14.dp))
                else -> Column(Modifier.fillMaxWidth().heightIn(max = 480.dp).verticalScroll(rememberScrollState()).padding(top = 8.dp)) {
                    r.forEach { m ->
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { onJump(m.id) }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            Avatar(url = m.author?.avatarUrl, name = m.author?.bestName ?: "?", size = 30.dp, toneId = m.author?.id)
                            Column(Modifier.padding(start = 10.dp)) {
                                Row(verticalAlignment = Alignment.Bottom) {
                                    Text(m.author?.bestName ?: "Unknown", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                                    Text(shortTime(m.createdAt), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                                }
                                val preview = when {
                                    m.content.isNotBlank() -> store.renderContent(m.channelId, m.content)
                                    m.poll != null -> "📊 Poll"
                                    m.attachments.isNotEmpty() -> "📎 Attachment"
                                    else -> "Message"
                                }
                                Text(preview, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}
