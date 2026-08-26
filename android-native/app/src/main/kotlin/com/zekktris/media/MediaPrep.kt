package com.zekktris.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val TAG = "ZekMediaPrep"

/**
 * Shrinks picked media BEFORE it is uploaded — and, critically, BEFORE it is
 * encrypted.
 *
 * WHY THIS HAS TO LIVE ON THE CLIENT. The server has two compression backstops
 * and an E2EE attachment is invisible to both by construction: the WebP
 * re-encode (`apps/api/src/services/uploads.ts`, `encodeWebp(maxDim: 1920,
 * quality: 80)`) and the nightly sweep (`services/imageCompression.ts`) each
 * gate on `contentType` starting with `image/`, and every `.zke` blob is
 * uploaded as `application/octet-stream`. The server holds no channel key, so
 * it could not re-encode the bytes even if it wanted to. Measured on the live
 * server before this existed: a plain image averaged **84 KB** on disk while an
 * E2EE image averaged **~3,100 KB** — the same photos from the same people,
 * 37x the bytes, purely because of which path they took. 96% of all stored
 * bytes were `.zke`.
 *
 * The contract deliberately matches the web client
 * (`apps/web/src/lib/compressImage.ts`: 1920 px longest edge, quality ~0.8) and
 * `ios-native/Zekktris/MessageViews.swift` (`MediaPrep`), so every client puts
 * the same thing on disk.
 *
 * ORIENTATION. This is the one way a downscale can be actively worse than no
 * downscale, and Android makes it easy to get wrong: unlike iOS's ImageIO,
 * `BitmapFactory` does NOT apply the EXIF transform — it hands back the stored
 * pixels and drops the tag, so a naive "decode, scale, re-encode" turns every
 * portrait phone photo sideways. So:
 *  1. [exifOrientation] reads `TAG_ORIENTATION` off the ORIGINAL bytes before
 *     anything is decoded (platform `ExifInterface` over a byte stream — no
 *     temp file, no extra dependency).
 *  2. [decodeUpright] bakes that transform into the pixels with a [Matrix]
 *     (all eight EXIF states, including the two mirrored diagonals), so what we
 *     encode is already upright and carries no orientation tag. Both the main
 *     image and the thumbnail go through it, so they can never disagree.
 *  3. The reported [Prepared.width]/[Prepared.height] are the post-transform
 *     bitmap's own dimensions, i.e. transposed for the 90-degree cases — the
 *     recipient reserves the right-shaped layout slot.
 * Nothing downstream re-applies an orientation, so upright pixels with no tag
 * is exactly right. Video is a different mechanism and is handled in
 * [prepareVideo].
 *
 * Everything here is pure and off-main-safe apart from the video export, which
 * needs a Looper and says so.
 */
object MediaPrep {

    /** Longest-edge bound for a MAIN image upload (web/iOS parity). */
    const val IMAGE_MAX_EDGE = 1920

    /** Lossy quality for a main image upload (web parity: 0.82 → 80). */
    const val IMAGE_QUALITY = 80

    /** Longest-edge bound for the inline preview. Unchanged from the previous
     *  behaviour, and equal to the server's own 480 px thumbnails. */
    const val THUMB_MAX_EDGE = 480

    /** Lossy quality for the inline preview. Unchanged. */
    const val THUMB_QUALITY = 60

    /** Videos smaller than this skip the export: a transcode round-trip costs
     *  the user seconds and battery for a trivial saving. */
    const val VIDEO_EXPORT_MIN_BYTES = 5L * 1024 * 1024

    /** 720p. The two `video.mov.zke` blobs on the live server averaged 44 MB. */
    const val VIDEO_TARGET_SHORT_SIDE = 720

    /** One picked attachment on the way in. */
    class Input(val bytes: ByteArray, val filename: String, val mime: String)

    /**
     * One attachment on the way out. [bytes]/[filename]/[mime] are what should
     * actually be uploaded — they differ from the input whenever the re-encode
     * was a win.
     */
    class Prepared(
        val bytes: ByteArray,
        val filename: String,
        val mime: String,
        /** Pixel dimensions OF THE BYTES IN [bytes], EXIF-corrected. Sent as
         *  plaintext metadata so a recipient can reserve the layout slot for an
         *  E2EE image the server cannot measure. */
        val width: Int?,
        val height: Int?,
        /** PLAINTEXT inline-preview bytes (JPEG). The caller encrypts these in
         *  an E2EE conversation. `null` means we could not decode the image at
         *  all — see the hard-fail in `AppStore.sendMessageWithFiles`. */
        val thumbnail: ByteArray?,
        /** Declared-image input (drives the "a thumbnail is mandatory" rule). */
        val isImage: Boolean,
        /** Original byte count, for the savings log. */
        val originalBytes: Int,
        /** A video whose 720p export was attempted and failed, so the ORIGINAL
         *  bytes are going up. Deliberately non-fatal: never block a send on a
         *  transcode. */
        val videoExportFailed: Boolean,
    )

    /**
     * Prepare a batch. Images are downscaled + re-encoded; videos are exported
     * to 720p; anything else (documents, audio) passes through untouched.
     *
     * Suspends: image work runs on [Dispatchers.Default], the video export
     * hands off to Main for Transformer's Looper.
     */
    suspend fun prepareAll(ctx: Context, inputs: List<Input>): List<Prepared> {
        val out = ArrayList<Prepared>(inputs.size)
        for (input in inputs) {
            out += when {
                input.mime.startsWith("video/") -> prepareVideo(ctx, input)
                input.mime.startsWith("image/") -> withContext(Dispatchers.Default) { prepareImage(input) }
                else -> passthrough(input, isImage = false)
            }
        }
        return out
    }

    private fun passthrough(
        input: Input,
        isImage: Boolean,
        width: Int? = null,
        height: Int? = null,
        thumbnail: ByteArray? = null,
        videoExportFailed: Boolean = false,
    ) = Prepared(
        bytes = input.bytes,
        filename = input.filename,
        mime = input.mime,
        width = width,
        height = height,
        thumbnail = thumbnail,
        isImage = isImage,
        originalBytes = input.bytes.size,
        videoExportFailed = videoExportFailed,
    )

    // ---- images -------------------------------------------------------------

    private fun prepareImage(input: Input): Prepared {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(input.bytes, 0, input.bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            // Undecodable as an image (a mislabelled mime, a truncated file).
            // Leave the bytes alone and leave `thumbnail` null — the E2EE path
            // treats that as fatal rather than storing a preview-less blob.
            return passthrough(input, isImage = true)
        }
        val orientation = exifOrientation(input.bytes)
        // DISPLAYED size of the original: EXIF 5–8 are the 90-degree cases,
        // where the stored width/height are swapped relative to what a viewer
        // sees. These are the dims to report whenever we upload the ORIGINAL
        // bytes — its EXIF tag travels with it and the renderer applies it.
        val transposed = orientation in TRANSPOSING_ORIENTATIONS
        val originalWidth = if (transposed) bounds.outHeight else bounds.outWidth
        val originalHeight = if (transposed) bounds.outWidth else bounds.outHeight

        // Every image gets a preview, INCLUDING the ones we don't re-encode
        // (animated GIFs, images a re-encode wouldn't shrink). The server can't
        // make one for ciphertext, so if we don't ship one the attachment is
        // preview-less forever — which is how 90 of the 268 E2EE images on the
        // live server ended up with no thumbnail at all.
        val thumbnail = decodeUpright(input.bytes, THUMB_MAX_EDGE, orientation)?.let { bmp ->
            val jpeg = compress(bmp, Bitmap.CompressFormat.JPEG, THUMB_QUALITY)
            bmp.recycle()
            jpeg
        }

        fun original() = passthrough(
            input, isImage = true,
            width = originalWidth, height = originalHeight, thumbnail = thumbnail,
        )

        // Multi-frame sources (animated GIF / APNG / animated WebP) must not be
        // re-encoded — BitmapFactory would hand back a single still and we would
        // silently destroy the animation. The still thumbnail above is fine.
        if (isAnimated(input.mime, input.bytes)) return original()

        val full = decodeUpright(input.bytes, IMAGE_MAX_EDGE, orientation) ?: return original()
        val encoded = encode(full)
        // The downscaled bitmap's own dimensions — already upright, so no
        // transposition to undo.
        val encodedWidth = full.width
        val encodedHeight = full.height
        full.recycle()

        // Only take the re-encode when it is actually smaller. A modest,
        // already-compressed image can grow under a second lossy pass, and
        // paying quality for extra bytes is strictly worse than doing nothing.
        if (encoded == null || encoded.bytes.size >= input.bytes.size) return original()

        val base = input.filename.substringBeforeLast('.', input.filename).ifEmpty { "image" }
        return Prepared(
            bytes = encoded.bytes,
            filename = "$base.${encoded.ext}",
            mime = encoded.mime,
            width = encodedWidth,
            height = encodedHeight,
            thumbnail = thumbnail,
            isImage = true,
            originalBytes = input.bytes.size,
            videoExportFailed = false,
        )
    }

    /**
     * Decode at most [maxEdge] on the long side, with the EXIF transform baked
     * into the pixels.
     *
     * `inSampleSize` only steps in powers of two, so it gets us close cheaply
     * (never allocating the full-resolution bitmap) and an exact scale lands on
     * the bound — matching what ImageIO's `ThumbnailMaxPixelSize` does on iOS.
     */
    private fun decodeUpright(bytes: ByteArray, maxEdge: Int, orientation: Int): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return@runCatching null

        val longEdge = max(bmp.width, bmp.height)
        if (longEdge > maxEdge) {
            val scale = maxEdge.toFloat() / longEdge
            val w = max(1, (bmp.width * scale).roundToInt())
            val h = max(1, (bmp.height * scale).roundToInt())
            val scaled = Bitmap.createScaledBitmap(bmp, w, h, true)
            if (scaled !== bmp) {
                bmp.recycle()
                bmp = scaled
            }
        }
        val matrix = exifMatrix(orientation)
        if (matrix != null) {
            val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
            if (rotated !== bmp) {
                bmp.recycle()
                bmp = rotated
            }
        }
        bmp
    }.getOrNull()

    private class Encoded(val bytes: ByteArray, val ext: String, val mime: String)

    /**
     * Encode an already-upright, already-downscaled bitmap.
     *
     * WebP first, for parity with web (which uploads `.webp`) and with the
     * server's own backstop — and because Android's encoder has shipped since
     * API 14, so unlike iOS there is no availability probe to do. JPEG/PNG stay
     * as fallbacks for the rare device whose encoder refuses a frame.
     */
    private fun encode(bitmap: Bitmap): Encoded? {
        compress(bitmap, webpLossyFormat(), IMAGE_QUALITY)?.let { return Encoded(it, "webp", "image/webp") }
        if (bitmap.hasAlpha()) {
            compress(bitmap, Bitmap.CompressFormat.PNG, 100)?.let { return Encoded(it, "png", "image/png") }
        }
        compress(bitmap, Bitmap.CompressFormat.JPEG, IMAGE_QUALITY)?.let { return Encoded(it, "jpg", "image/jpeg") }
        return compress(bitmap, Bitmap.CompressFormat.PNG, 100)?.let { Encoded(it, "png", "image/png") }
    }

    /** `WEBP` was split into `WEBP_LOSSY`/`WEBP_LOSSLESS` in API 30 and the
     *  undifferentiated constant deprecated; minSdk here is 26, so both spellings
     *  are needed. Quality < 100 on the old constant is the same lossy encoder. */
    @Suppress("DEPRECATION")
    private fun webpLossyFormat(): Bitmap.CompressFormat =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY
        else Bitmap.CompressFormat.WEBP

    private fun compress(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray? = runCatching {
        val out = ByteArrayOutputStream()
        if (!bitmap.compress(format, quality, out)) return@runCatching null
        out.toByteArray().takeIf { it.isNotEmpty() }
    }.getOrNull()

    /** EXIF states 5–8 are the four 90-degree cases, where the DISPLAYED size is
     *  the transpose of the stored size. */
    private val TRANSPOSING_ORIENTATIONS = setOf(
        android.media.ExifInterface.ORIENTATION_TRANSPOSE,
        android.media.ExifInterface.ORIENTATION_ROTATE_90,
        android.media.ExifInterface.ORIENTATION_TRANSVERSE,
        android.media.ExifInterface.ORIENTATION_ROTATE_270,
    )

    /**
     * Read the orientation tag off the ORIGINAL bytes. Uses the platform
     * `ExifInterface`'s stream constructor (API 24+; minSdk is 26) so nothing
     * has to be written to disk first. Anything unreadable → treat as upright,
     * which is what the old code effectively assumed for every photo.
     */
    private fun exifOrientation(bytes: ByteArray): Int = runCatching {
        android.media.ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
            android.media.ExifInterface.TAG_ORIENTATION,
            android.media.ExifInterface.ORIENTATION_NORMAL,
        )
    }.getOrDefault(android.media.ExifInterface.ORIENTATION_NORMAL)

    /** The pixel transform for an EXIF orientation, or null when upright.
     *  Covers all eight states — the two mirrored diagonals (TRANSPOSE /
     *  TRANSVERSE) are rare but real, and getting them wrong mirrors the photo. */
    private fun exifMatrix(orientation: Int): Matrix? {
        val m = Matrix()
        when (orientation) {
            android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            android.media.ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            android.media.ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.setRotate(90f); m.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            android.media.ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.setRotate(270f); m.postScale(-1f, 1f)
            }
            android.media.ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(270f)
            else -> return null
        }
        return m
    }

    /**
     * Would re-encoding this destroy an animation?
     *
     * GIF is treated as animated unconditionally — a single-frame GIF is rare
     * and worth nothing, whereas flattening a real one is a visible regression.
     * WebP and PNG carry an explicit marker chunk near the head of the file.
     */
    private fun isAnimated(mime: String, bytes: ByteArray): Boolean = when {
        mime.equals("image/gif", ignoreCase = true) -> true
        mime.equals("image/apng", ignoreCase = true) -> true
        mime.equals("image/webp", ignoreCase = true) -> containsMarker(bytes, "ANIM", 64)
        mime.equals("image/png", ignoreCase = true) -> containsMarker(bytes, "acTL", 4096)
        else -> false
    }

    /** Look for a 4-byte ASCII chunk id inside the first [limit] bytes. */
    private fun containsMarker(bytes: ByteArray, marker: String, limit: Int): Boolean {
        val needle = marker.toByteArray(Charsets.US_ASCII)
        val end = min(bytes.size, limit) - needle.size
        var i = 0
        outer@ while (i <= end) {
            for (j in needle.indices) {
                if (bytes[i + j] != needle[j]) {
                    i++
                    continue@outer
                }
            }
            return true
        }
        return false
    }

    // ---- video --------------------------------------------------------------

    /**
     * Export to 720p H.264/AAC MP4 before upload. Any failure falls back to the
     * ORIGINAL bytes and flags [Prepared.videoExportFailed] — a send is never
     * blocked on a transcode, because a video that won't export is still a
     * video the user wants to send.
     *
     * ROTATION. Transformer reads the track's rotation metadata and applies it
     * before effects run, so the effect chain sees the DISPLAYED frame. That is
     * why [displaySize] transposes the stored dimensions for a 90/270 track:
     * the box we hand [Presentation] has to be in displayed space, or a portrait
     * clip gets measured against a landscape target.
     *
     * The target short side is clamped to the SOURCE's, so a 480p clip is
     * re-encoded at 480p rather than being upscaled into a bigger file. A
     * sub-720p clip is still worth transcoding (a phone-camera bitrate is
     * usually the real problem), and the "keep whichever is smaller" guard
     * below means a pointless transcode costs time, never bytes.
     */
    private suspend fun prepareVideo(ctx: Context, input: Input): Prepared {
        if (input.bytes.size <= VIDEO_EXPORT_MIN_BYTES) return passthrough(input, isImage = false)

        val dir = File(ctx.cacheDir, "mediaprep").apply { mkdirs() }
        val ext = input.filename.substringAfterLast('.', "").ifEmpty { "mp4" }
        val src = File(dir, "src-${UUID.randomUUID()}.$ext")
        val dst = File(dir, "720-${UUID.randomUUID()}.mp4")
        try {
            // Transformer needs a file URI; the picker only ever hands us bytes.
            withContext(Dispatchers.IO) { src.writeBytes(input.bytes) }
            // null = dimensions unreadable; see [runExport] for what that does.
            val target = withContext(Dispatchers.IO) { displaySize(src) }
                ?.let { targetSize(it, VIDEO_TARGET_SHORT_SIDE) }
            if (!runExport(ctx, src, dst, target)) {
                return passthrough(input, isImage = false, videoExportFailed = true)
            }
            val exported = withContext(Dispatchers.IO) { dst.readBytes() }
            // A short clip that is already efficient can come back bigger; keep
            // whichever is smaller. Not a failure — nothing went wrong, the
            // export just didn't pay off.
            if (exported.isEmpty() || exported.size >= input.bytes.size) {
                return passthrough(input, isImage = false)
            }
            val base = input.filename.substringBeforeLast('.', input.filename).ifEmpty { "video" }
            return Prepared(
                bytes = exported,
                filename = "$base.mp4",
                mime = "video/mp4",
                width = null,
                height = null,
                thumbnail = null,
                isImage = false,
                originalBytes = input.bytes.size,
                videoExportFailed = false,
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "video export threw; uploading original", e)
            return passthrough(input, isImage = false, videoExportFailed = true)
        } finally {
            // PLAINTEXT frames of an E2EE video were on disk for the duration —
            // delete both temp files on every path, including the throw.
            runCatching { src.delete() }
            runCatching { dst.delete() }
        }
    }

    private class VideoSize(val width: Int, val height: Int)

    /**
     * DISPLAYED dimensions of a video file, or null if they can't be read.
     *
     * `METADATA_KEY_VIDEO_WIDTH`/`_HEIGHT` are the dimensions as STORED in the
     * track; a phone shooting in portrait records a landscape track plus a
     * `rotation` of 90 or 270. Transformer applies that rotation before the
     * effect chain, so the box handed to [Presentation] must be transposed to
     * match — otherwise a portrait clip is fitted to a landscape target and
     * comes back pillarboxed and far smaller than asked for.
     *
     * (`MediaMetadataRetriever` only became `AutoCloseable` in API 29 and
     * minSdk is 26, so release it by hand.)
     */
    private fun displaySize(file: File): VideoSize? = runCatching {
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(file.absolutePath)
            val w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            val rotation = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
                ?.toIntOrNull() ?: 0
            if (w == null || h == null || w <= 0 || h <= 0) null
            else if (rotation == 90 || rotation == 270) VideoSize(h, w)
            else VideoSize(w, h)
        } finally {
            runCatching { mmr.release() }
        }
    }.getOrNull()

    /**
     * The output box for an export: [source] scaled down until its short side
     * meets [shortSideCap], never scaled up.
     *
     * media3 1.4.1 has no "just cap the short side" factory — only
     * `createForHeight`, `createForWidthAndHeight` and `createForAspectRatio` —
     * and `createForHeight` would bound the LONG side of a portrait clip, so we
     * compute both dimensions here and hand over an explicit box. Because that
     * box carries the source's own aspect ratio, `LAYOUT_SCALE_TO_FIT` is a pure
     * scale and adds no letterbox bars.
     *
     * Both dimensions are rounded DOWN to even numbers: H.264 is 4:2:0, its
     * chroma planes are half-resolution, and an odd width or height is rejected
     * outright by some hardware encoders.
     */
    private fun targetSize(source: VideoSize, shortSideCap: Int): VideoSize {
        val shortSide = min(source.width, source.height)
        if (shortSide <= shortSideCap) return evenized(source.width, source.height)
        val scale = shortSideCap.toDouble() / shortSide
        return evenized(
            (source.width * scale).roundToInt(),
            (source.height * scale).roundToInt(),
        )
    }

    private fun evenized(width: Int, height: Int) =
        VideoSize(max(2, width - (width % 2)), max(2, height - (height % 2)))

    /**
     * Run one Transformer export. Built and started on Main because Transformer
     * requires a thread with a Looper and delivers its callbacks there; the
     * actual encode runs on its own internal threads, so Main is not blocked.
     *
     * If the calling coroutine is cancelled the export is left to finish and its
     * result dropped (the temp files are deleted by the caller's `finally`
     * either way): `Transformer.cancel()` is itself Looper-confined and calling
     * it from an arbitrary cancellation thread would crash.
     *
     * A null [target] means the source dimensions could not be read. We then
     * transcode at the SOURCE resolution rather than guess a box: the bitrate
     * re-encode is most of the saving anyway, and guessing would risk shrinking
     * a portrait clip to a third of the intended size.
     */
    @androidx.annotation.OptIn(UnstableApi::class)
    private suspend fun runExport(ctx: Context, src: File, dst: File, target: VideoSize?): Boolean =
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine<Boolean> { cont ->
                val transformer = Transformer.Builder(ctx)
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, result: ExportResult) {
                            if (cont.isActive) cont.resume(true)
                        }

                        override fun onError(
                            composition: Composition,
                            result: ExportResult,
                            exception: ExportException,
                        ) {
                            Log.w(TAG, "video export failed", exception)
                            if (cont.isActive) cont.resume(false)
                        }
                    })
                    .build()
                val videoEffects: List<androidx.media3.common.Effect> =
                    if (target == null) emptyList()
                    else listOf(
                        Presentation.createForWidthAndHeight(
                            target.width,
                            target.height,
                            Presentation.LAYOUT_SCALE_TO_FIT,
                        ),
                    )
                val effects = Effects(emptyList(), videoEffects)
                val edited = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(src)))
                    .setEffects(effects)
                    .build()
                runCatching { transformer.start(edited, dst.absolutePath) }
                    .onFailure {
                        Log.w(TAG, "transformer.start threw", it)
                        if (cont.isActive) cont.resume(false)
                    }
            }
        }

    // ---- reporting ----------------------------------------------------------

    /**
     * Log the before/after byte counts so the storage win can be confirmed on a
     * real device (`adb logcat -s $TAG`) without instrumenting the server.
     * Sizes only — no filenames, no pixels, nothing derived from content.
     */
    fun logOutcome(prepared: List<Prepared>) {
        for (p in prepared) {
            when {
                p.videoExportFailed ->
                    Log.i(TAG, "video export failed, uploading original (${p.originalBytes} bytes)")
                p.bytes.size != p.originalBytes ->
                    Log.i(TAG, "prepared ${p.originalBytes} -> ${p.bytes.size} bytes")
            }
        }
    }
}
