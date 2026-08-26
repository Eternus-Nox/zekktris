package com.zekktris.ui.components

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * QR *decoding* — the mirror of [QrCode], which encodes.
 *
 * WHY A STILL PHOTO INSTEAD OF A LIVE VIEWFINDER: the app already depends on
 * `com.google.zxing:core`, which is the whole decoder as well as the encoder,
 * so reading a QR out of a Bitmap costs nothing. What it does NOT have is any
 * way to get camera frames — there is no CameraX (`androidx.camera:*`), no ML
 * Kit barcode module, and LiveKit's capturer is not usable for this. A live
 * scanner therefore means a new dependency, which is not something to add
 * silently, so this takes the picture with the SYSTEM camera app (or an
 * existing photo) and decodes the result. One extra tap; zero new libraries.
 *
 * If a live viewfinder is wanted later: androidx.camera core/camera2/lifecycle/
 * view + an ImageAnalysis analyzer feeding PlanarYUVLuminanceSource into the
 * zxing-core reader already imported here (no ML Kit needed).
 */
object QrScan {

    /**
     * Longest edge we decode at. A QR needs far less resolution than a modern
     * camera produces, and the intermediate IntArray is 4 bytes/pixel on top of
     * the Bitmap — decoding a 12 MP JPEG at full size would allocate ~100 MB for
     * no gain in read rate.
     */
    private const val MAX_EDGE = 1280

    /**
     * Decode the first QR code in the image at [uri], or null if there isn't
     * one. Runs entirely off the main thread (JPEG decode + a full-frame
     * binarize is tens of milliseconds at best).
     */
    suspend fun decode(context: Context, uri: Uri): String? = withContext(Dispatchers.IO) {
        val bitmap = loadDownsampled(context, uri) ?: return@withContext null
        try {
            decodeBitmap(bitmap)
        } finally {
            bitmap.recycle()
        }
    }

    private fun decodeBitmap(bitmap: Bitmap): String? {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return null
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
        val source = RGBLuminanceSource(w, h, pixels)
        // A photo of a phone screen is a hard case: glare, moiré, and (with a
        // dark app theme around it) uneven exposure. Hybrid handles mixed
        // lighting, global histogram handles flat high-contrast, and the
        // inverted pass catches a light-on-dark render. Cheap enough to try all
        // four rather than fail and make the user retake the picture.
        val hints = mapOf<DecodeHintType, Any>(DecodeHintType.TRY_HARDER to true)
        for (candidate in listOf(source, source.invert())) {
            for (binary in binarizers(candidate)) {
                // A miss throws NotFoundException; that is the normal answer for
                // three of these four attempts, not an error worth surfacing.
                val text = runCatching { QRCodeReader().decode(binary, hints).text }.getOrNull()
                if (!text.isNullOrBlank()) return text
            }
        }
        return null
    }

    private fun binarizers(source: LuminanceSource): List<BinaryBitmap> = listOf(
        BinaryBitmap(HybridBinarizer(source)),
        BinaryBitmap(GlobalHistogramBinarizer(source)),
    )

    /**
     * Decode bounds first, then the image at a power-of-two sample size that
     * keeps the longest edge under [MAX_EDGE]. Two passes over the stream, one
     * of which reads only the header.
     */
    private fun loadDownsampled(context: Context, uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        runCatching {
            context.contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, bounds)
            }
        }
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (longest <= 0) return null
        var sample = 1
        while (longest / sample > MAX_EDGE) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            // getPixels() below needs real ARGB; a HARDWARE bitmap (the default
            // on some paths) would throw on read-back.
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return runCatching {
            context.contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, opts)
            }
        }.getOrNull()
    }
}
