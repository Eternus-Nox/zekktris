package com.zekktris.ui.components

import android.content.ContentValues
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppStore
import com.zekktris.data.model.Attachment
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * E2EE (.zke) attachment rendering — the Compose translation of iOS
 * `EncryptedAttachmentView` + `ImageLightboxView`'s encrypted pages.
 *
 * Invariant: decrypted bytes exist ONLY in memory (AppStore's
 * DecryptedMediaCache + transient decode bitmaps). Nothing here touches
 * Coil's disk cache, temp files, or any file-backed loader. Save-to-gallery
 * happens exclusively on an explicit user tap in the lightbox.
 */

/** Original (inner) filename without the .zke wire suffix. */
fun zkeInnerName(att: Attachment): String {
    val n = att.filename ?: "file"
    return if (n.endsWith(".zke")) n.dropLast(4) else n
}

/** Is this an encrypted attachment (.zke wire name)? */
fun isZke(att: Attachment): Boolean = att.filename?.endsWith(".zke") == true

private val IMAGE_EXTS = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff")

/** Encrypted attachment whose INNER filename is an image (mirrors the iOS
 *  extension bucket) — the server only sees octet-stream ciphertext, so the
 *  inner name decides image-vs-file. */
fun isZkeImage(att: Attachment): Boolean =
    isZke(att) && zkeInnerName(att).substringAfterLast('.', "").lowercase() in IMAGE_EXTS

/** Decode bytes to a bitmap, downsampled so the longest side is ~[maxDim]px
 *  (bounds pass + inSampleSize — never decodes a 12MP image at full size for
 *  an inline thumb). */
private fun decodeDownsampled(bytes: ByteArray, maxDim: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}.getOrNull()

/**
 * Inline encrypted image: downloads + decrypts the small thumbnail (falling
 * back to the full blob for pre-thumbnail messages), renders from an
 * in-memory bitmap. Locked (no key) => lock placeholder; failed decrypt =>
 * broken-lock placeholder. Re-runs on unlock via the [unlocked] key.
 */
@Composable
fun EncryptedImageThumb(
    store: AppStore,
    channelId: String,
    att: Attachment,
    unlocked: Boolean,
    contentScale: ContentScale,
    modifier: Modifier = Modifier,
) {
    var bitmap by remember(att.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(att.id) { mutableStateOf(false) }
    LaunchedEffect(att.id, unlocked) {
        if (!unlocked) { bitmap = null; failed = false; return@LaunchedEffect }
        if (bitmap != null) return@LaunchedEffect
        // Full-blob fallback is for pre-thumbnail messages ONLY. Once retention
        // has aged the original out there is nothing at that path, so skip the
        // doomed fetch and let the placeholder stand (the caller draws the
        // "Original expired" badge over it).
        val bytes = store.decryptedThumbnail(channelId, att)
            ?: if (att.blobExpired) null else store.decryptedAttachment(channelId, att)
        val decoded = bytes?.let { withContext(Dispatchers.Default) { decodeDownsampled(it, 720) } }
        bitmap = decoded
        failed = decoded == null
    }
    val bmp = bitmap
    if (bmp != null) {
        Image(
            bitmap = bmp,
            contentDescription = zkeInnerName(att),
            contentScale = contentScale,
            modifier = modifier,
        )
    } else {
        val p = ZkTheme.palette
        Box(modifier.background(p.bg2), contentAlignment = Alignment.Center) {
            if (unlocked && !failed) {
                CircularProgressIndicator(
                    color = ZkInk.ink3, strokeWidth = 2.dp, modifier = Modifier.size(20.dp),
                )
            } else {
                Icon(
                    if (failed) Icons.Filled.BrokenImage else Icons.Filled.Lock,
                    contentDescription = if (failed) "Couldn't decrypt" else "Encrypted image — unlock to view",
                    tint = ZkInk.ink3,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

/**
 * Full-screen viewer for encrypted images: swipe between a message's .zke
 * images, pinch/double-tap to zoom, save to the gallery (explicit user tap —
 * the saved file is the decrypted ORIGINAL bytes, written straight from
 * memory). Pages decrypt the FULL blob lazily as they become visible.
 */
@Composable
fun EncryptedImageLightbox(
    store: AppStore,
    channelId: String,
    attachments: List<Attachment>,
    startIndex: Int,
    onDismiss: () -> Unit,
) {
    if (attachments.isEmpty()) { onDismiss(); return }
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val pager = rememberPagerState(initialPage = startIndex.coerceIn(0, attachments.lastIndex)) { attachments.size }
    var savedNote by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onDismiss)

    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.97f))) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
            EncryptedZoomablePage(store, channelId, attachments[page])
        }
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            EncLightboxButton(Icons.Filled.Close, "Close", onDismiss)
            if (attachments.size > 1) {
                Text(
                    "${pager.currentPage + 1} / ${attachments.size}",
                    color = Color.White, fontSize = 14.sp,
                    modifier = Modifier.padding(start = 12.dp),
                )
            }
            Box(Modifier.weight(1f))
            EncLightboxButton(Icons.Filled.Download, "Save") {
                scope.launch {
                    val att = attachments[pager.currentPage]
                    val bytes = if (att.blobExpired) null else store.decryptedAttachment(channelId, att)
                    val ok = bytes != null && saveDecryptedToGallery(ctx, zkeInnerName(att), bytes)
                    savedNote = when {
                        ok -> "Saved to gallery"
                        att.blobExpired -> "Original expired"
                        else -> "Couldn't save"
                    }
                }
            }
        }
        savedNote?.let {
            Text(
                it, color = Color.White, fontSize = 13.sp,
                modifier = Modifier.align(Alignment.BottomCenter).statusBarsPadding().padding(bottom = 40.dp)
                    .clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }
    }
}

/** One lightbox page: decrypt the full blob on appear, render zoomable. */
@Composable
private fun EncryptedZoomablePage(store: AppStore, channelId: String, att: Attachment) {
    var bitmap by remember(att.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(att.id) { mutableStateOf(false) }
    var scale by remember(att.id) { mutableFloatStateOf(1f) }
    var offsetX by remember(att.id) { mutableFloatStateOf(0f) }
    var offsetY by remember(att.id) { mutableFloatStateOf(0f) }
    LaunchedEffect(att.id) {
        if (bitmap != null) return@LaunchedEffect
        // Callers keep aged-out originals out of the pageable set; if one slips
        // through, say so instead of firing a fetch that can only 404.
        if (att.blobExpired) { failed = true; return@LaunchedEffect }
        val bytes = store.decryptedAttachment(channelId, att)
        // Cap the decode at ~2560px so a huge original can't blow past the
        // canvas texture limit; the bytes themselves stay full-res for Save.
        val decoded = bytes?.let { withContext(Dispatchers.Default) { decodeDownsampled(it, 2560) } }
        bitmap = decoded
        failed = decoded == null
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val bmp = bitmap
        when {
            bmp != null -> Image(
                bitmap = bmp,
                contentDescription = zkeInnerName(att),
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offsetX, translationY = offsetY)
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 5f)
                            if (scale > 1f) { offsetX += pan.x; offsetY += pan.y }
                            else { offsetX = 0f; offsetY = 0f }
                        }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = {
                            if (scale > 1f) { scale = 1f; offsetX = 0f; offsetY = 0f } else scale = 2.5f
                        })
                    },
            )
            failed -> Icon(
                if (att.blobExpired) Icons.Filled.Schedule else Icons.Filled.BrokenImage,
                if (att.blobExpired) "Original expired" else "Couldn't decrypt",
                tint = Color.White.copy(alpha = 0.6f), modifier = Modifier.size(40.dp),
            )
            else -> CircularProgressIndicator(color = Color.White.copy(alpha = 0.7f), strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
        }
    }
}

@Composable
private fun EncLightboxButton(icon: androidx.compose.ui.graphics.vector.ImageVector, desc: String, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.12f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, desc, tint = Color.White, modifier = Modifier.size(22.dp))
    }
}

/** Write the decrypted ORIGINAL bytes into the Pictures collection (explicit
 *  user tap only — this is the one sanctioned exit from the in-memory world,
 *  same as iOS Save to Photos). No re-compression: the exact plaintext file
 *  the sender attached is what lands in the gallery. */
private suspend fun saveDecryptedToGallery(
    ctx: android.content.Context,
    innerName: String,
    bytes: ByteArray,
): Boolean = withContext(Dispatchers.IO) {
    runCatching {
        val ext = innerName.substringAfterLast('.', "").lowercase()
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "image/jpeg"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, innerName)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Zekktris")
            }
        }
        val uri = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: return@runCatching false
        ctx.contentResolver.openOutputStream(uri)?.use { out -> out.write(bytes) } ?: return@runCatching false
        true
    }.getOrDefault(false)
}
