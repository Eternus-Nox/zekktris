package com.zekktris.ui.screens

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.Attachment
import com.zekktris.ui.components.EncryptedImageLightbox
import com.zekktris.ui.components.EncryptedImageThumb
import com.zekktris.ui.components.ImageLightbox
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.VideoPlayerDialog
import com.zekktris.ui.components.isZke
import com.zekktris.ui.components.isZkeImage
import com.zekktris.ui.components.zkeInnerName
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/**
 * DM shared-media gallery — the Compose translation of iOS `MediaGalleryView`
 * (reached from DmSettingsSheet's "Photos & Files" row).
 *
 * Reads GET /channels/:id/attachments (newest-first, `before`-cursor pages).
 * Plain DMs filter server-side (`kind=media` / `kind=files`, one stream per
 * tab); E2EE DMs OMIT `kind` — the `.zke` wrapper hides the real type from
 * the server (deliberate) — and bucket ONE stream client-side by the inner
 * filename. Encrypted thumbnails reuse the existing decrypt path
 * (AppStore.decryptedThumbnail/-Attachment + the in-memory DecryptedMediaCache
 * via EncryptedImageThumb) — plaintext never touches disk.
 */

private const val GALLERY_PAGE = 60

/** Photos-tab membership (E2EE client-side bucketing): plain attachments by
 *  content type, encrypted ones by the INNER filename's image extension
 *  (via isZkeImage — the server only sees octet-stream ciphertext). */
private fun isGalleryMedia(att: Attachment): Boolean =
    if (isZke(att)) isZkeImage(att) else att.isImage || att.isVideo

/** One paginated attachment stream (newest-first, `before` = last item's id). */
private class GalleryPager(
    private val kind: String?,
    private val fetch: suspend (before: String?, kind: String?) -> List<Attachment>?,
) {
    var items by mutableStateOf<List<Attachment>>(emptyList()); private set
    var loading by mutableStateOf(false); private set
    var hasMore by mutableStateOf(true); private set

    suspend fun loadMore() {
        if (loading || !hasMore) return
        loading = true
        val page = fetch(items.lastOrNull()?.id, kind)
        loading = false
        if (page == null) { hasMore = false; return }
        val seen = items.mapTo(HashSet()) { it.id }
        items = items + page.filter { it.id !in seen }
        hasMore = page.size >= GALLERY_PAGE
    }
}

/** Full-screen presentation wrapper — the gallery is opened from inside the
 *  DM-settings bottom sheet, so it lives in its own dialog window and draws
 *  OVER the sheet (mirrors iOS pushing MediaGalleryView inside the sheet's
 *  NavigationStack). Same pattern as VideoPlayerDialog. */
@Composable
fun MediaGalleryDialog(store: AppStore, state: AppState, channelId: String, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        MediaGalleryScreen(store, state, channelId, onBack = onDismiss)
    }
}

@Composable
fun MediaGalleryScreen(store: AppStore, state: AppState, channelId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val isE2EE = state.dms.firstOrNull { it.id == channelId }?.isE2EE == true
    val unlocked = state.e2eeUnlocked.contains(channelId)

    // Plain DMs: one server-filtered stream per tab. E2EE DMs: a single
    // unfiltered stream shared by both tabs, bucketed client-side.
    val mediaPager = remember(channelId, isE2EE) {
        GalleryPager(if (isE2EE) null else "media") { before, kind ->
            store.channelAttachments(channelId, before = before, kind = kind)
        }
    }
    val filesPager = remember(channelId, isE2EE) {
        if (isE2EE) mediaPager
        else GalleryPager("files") { before, kind ->
            store.channelAttachments(channelId, before = before, kind = kind)
        }
    }

    var tab by remember { mutableIntStateOf(0) } // 0 = Photos, 1 = Files
    val currentPager = if (tab == 0) mediaPager else filesPager
    LaunchedEffect(currentPager) { if (currentPager.items.isEmpty()) currentPager.loadMore() }

    val photos = if (isE2EE) mediaPager.items.filter { isGalleryMedia(it) && it.isVoiceMessage != true }
    else mediaPager.items.filter { it.isVoiceMessage != true }
    val files = if (isE2EE) mediaPager.items.filter { !isGalleryMedia(it) && it.isVoiceMessage != true }
    else filesPager.items.filter { it.isVoiceMessage != true }

    // Lightbox targets — presented as overlays INSIDE this dialog window so
    // they pop over the gallery (which itself sits over the settings sheet).
    var lightbox by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    var encLightbox by remember { mutableStateOf<Pair<List<Attachment>, Int>?>(null) }
    var videoUrl by remember { mutableStateOf<String?>(null) }

    /** Open the tapped photo: page across the whole LOADED photo set of the
     *  same kind (plain ↔ plain URLs, encrypted ↔ in-memory decrypt), mirroring
     *  the iOS gallery's swipe-across-everything lightbox.
     *
     *  Items whose full-size original has aged out are NOT in the pageable set
     *  (the lightbox and the player both load the original, and a dead path
     *  would buffer/spin forever) — their surviving thumbnail still shows in the
     *  grid, it just doesn't open. Both sets are carried as id-paired lists so
     *  the tapped index stays aligned once entries drop out. */
    fun openPhoto(att: Attachment) {
        if (att.blobExpired) return
        when {
            isZke(att) -> {
                val encs = photos.filter { isZkeImage(it) && !it.blobExpired }
                val idx = encs.indexOfFirst { it.id == att.id }
                if (idx >= 0) encLightbox = encs to idx
            }
            att.isVideo -> videoUrl = Config.absoluteUrl(att.url)
            else -> {
                val plain = photos.filter { !isZke(it) && it.isImage && !it.blobExpired }
                    .mapNotNull { a -> Config.absoluteUrl(a.url)?.let { a.id to it } }
                val idx = plain.indexOfFirst { it.first == att.id }
                if (idx >= 0) lightbox = plain.map { it.second } to idx
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        ScreenScaffold(title = "Shared Media", onBack = onBack) {
            // Photos / Files segmented control (iOS .segmented Picker).
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(12.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(p.bg3)
                    .padding(2.dp),
            ) {
                listOf("Photos", "Files").forEachIndexed { i, label ->
                    val selected = tab == i
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (selected) p.accent else Color.Transparent)
                            .clickable { tab = i }
                            .padding(vertical = 6.dp),
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

            if (tab == 0) {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 108.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 3.dp, vertical = 3.dp),
                    modifier = Modifier.fillMaxWidth().weight(1f),
                ) {
                    items(photos, key = { it.id }) { att ->
                        GalleryPhotoCell(store, channelId, att, unlocked, onTap = { openPhoto(att) })
                    }
                    galleryFooter(mediaPager, empty = photos.isEmpty(), emptyText = "No photos shared yet.")
                }
            } else {
                LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
                    items(files, key = { it.id }) { att ->
                        GalleryFileRow(att) {
                            // Never hand the system an aged-out object path — the
                            // row is tap-disabled for those, this is belt-and-braces.
                            if (!isZke(att) && !att.blobExpired) {
                                Config.absoluteUrl(att.url)?.let { url ->
                                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                                }
                            }
                        }
                        Box(Modifier.fillMaxWidth().padding(start = 52.dp).height(1.dp).background(p.line))
                    }
                    if (filesPager.loading) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(vertical = 18.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                            }
                        }
                    } else if (filesPager.hasMore && filesPager.items.isNotEmpty()) {
                        item {
                            // Bottom sentinel: fetches the next page when scrolled
                            // into view (re-keyed on size so it keeps paging).
                            LaunchedEffect(filesPager.items.size) { filesPager.loadMore() }
                            Spacer(Modifier.height(1.dp))
                        }
                    } else if (files.isEmpty()) {
                        item {
                            Text(
                                "No files shared yet.",
                                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 44.dp),
                            )
                        }
                    }
                }
            }
        }

        lightbox?.let { (urls, i) -> ImageLightbox(urls, i, onDismiss = { lightbox = null }) }
        encLightbox?.let { (atts, i) ->
            EncryptedImageLightbox(store, channelId, atts, i, onDismiss = { encLightbox = null })
        }
        videoUrl?.let { url -> VideoPlayerDialog(url, onDismiss = { videoUrl = null }) }
    }
}

/** Grid footer: spinner / paging sentinel / empty state, spanning the row. */
private fun androidx.compose.foundation.lazy.grid.LazyGridScope.galleryFooter(
    pager: GalleryPager,
    empty: Boolean,
    emptyText: String,
) {
    if (pager.loading) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Box(Modifier.fillMaxWidth().padding(vertical = 18.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = ZkTheme.palette.accent, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }
        }
    } else if (pager.hasMore && pager.items.isNotEmpty()) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            // Bottom sentinel: fetches the next page when scrolled into view
            // (re-keyed on size so it keeps paging while still visible).
            LaunchedEffect(pager.items.size) { pager.loadMore() }
            Spacer(Modifier.height(1.dp))
        }
    } else if (empty) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Text(
                emptyText,
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 44.dp),
            )
        }
    }
}

/** The URL to render in a grid cell: the small server thumbnail when there is
 *  one, else the original — but NEVER the original once retention expired it,
 *  since that path no longer resolves. Same rule as ChatScreen's
 *  inlineImageUrl. Null ⇒ nothing renderable (the bg2 tile stays). */
private fun galleryImageUrl(att: Attachment): String? =
    Config.absoluteUrl(att.thumbnailUrl) ?: if (att.blobExpired) null else Config.absoluteUrl(att.url)

/** One square photo cell — plain image (Coil), plain video (poster + play
 *  badge), or E2EE image via EncryptedImageThumb (in-memory decrypt, REUSED
 *  from the message rows — same cache, same path).
 *
 *  Once media retention has aged the original out, the (permanently-kept)
 *  thumbnail still fills the cell, but the play overlay and the tap go away and
 *  a calm badge says why. */
@Composable
private fun GalleryPhotoCell(
    store: AppStore,
    channelId: String,
    att: Attachment,
    unlocked: Boolean,
    onTap: () -> Unit,
) {
    val p = ZkTheme.palette
    val expired = att.blobExpired
    Box(
        Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(0.dp))
            .background(p.bg2)
            .then(if (expired) Modifier else Modifier.clickable(onClick = onTap)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            isZke(att) -> EncryptedImageThumb(
                store, channelId, att, unlocked, ContentScale.Crop, Modifier.fillMaxSize(),
            )
            att.isVideo -> {
                Config.absoluteUrl(att.thumbnailUrl)?.let { thumb ->
                    AsyncImage(
                        model = thumb, contentDescription = att.filename,
                        contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                    )
                }
                if (!expired) {
                    Box(
                        Modifier.size(34.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Filled.PlayArrow, "Play video", tint = Color.White, modifier = Modifier.size(22.dp)) }
                }
            }
            else -> galleryImageUrl(att)?.let { u ->
                AsyncImage(
                    model = u, contentDescription = att.filename,
                    contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
                )
            }
        }
        if (expired) ExpiredOriginalBadge(Modifier.align(Alignment.BottomStart))
    }
}

/** Calm corner marker for a photo/video whose full-size original the server no
 *  longer stores — the picture is still there, only the original went. Mirrors
 *  ChatScreen's badge of the same name (and iOS ExpiredOriginalBadge). */
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

/** One document row in the Files tab. Plain files open via the system;
 *  encrypted files show their inner name (decrypt-to-open is a future add,
 *  same as iOS). A file whose bytes retention has aged out keeps its row as a
 *  record of what was shared, but loses the tap and the download glyph. */
@Composable
private fun GalleryFileRow(att: Attachment, onTap: () -> Unit) {
    val p = ZkTheme.palette
    val encrypted = isZke(att)
    val expired = att.blobExpired
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = !encrypted && !expired, onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
            Icon(
                when {
                    expired -> Icons.Filled.Schedule
                    encrypted -> Icons.Filled.Lock
                    else -> Icons.AutoMirrored.Filled.InsertDriveFile
                },
                contentDescription = when {
                    expired -> "Original expired"
                    encrypted -> "Encrypted file"
                    else -> null
                },
                tint = if (expired) ZkInk.ink3 else p.accent, modifier = Modifier.size(20.dp),
            )
        }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(
                zkeInnerName(att),
                color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium,
                fontSize = 14.sp, maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
            att.size?.let {
                Text(byteString(it), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
            }
            if (expired) {
                Text("Original expired", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp)
            }
        }
        if (!encrypted && !expired) {
            Icon(Icons.Filled.Download, "Download", tint = ZkInk.ink3, modifier = Modifier.size(18.dp))
        }
    }
}

private fun byteString(size: Long): String = when {
    size >= 1L shl 30 -> "%.1f GB".format(size / (1L shl 30).toDouble())
    size >= 1L shl 20 -> "%.1f MB".format(size / (1L shl 20).toDouble())
    size >= 1L shl 10 -> "%.0f KB".format(size / (1L shl 10).toDouble())
    else -> "$size B"
}
