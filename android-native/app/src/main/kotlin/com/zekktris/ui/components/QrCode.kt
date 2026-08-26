package com.zekktris.ui.components

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Renders [content] as a scannable QR code. Always black-on-white regardless
 * of app theme — authenticator apps need the contrast to scan. Used for the
 * 2FA otpauth:// enrollment URI, mirroring iOS's qrCodeImage().
 *
 * Generated off the main thread (encode + a 512x512 bitmap fill is too heavy
 * for the composition thread) and rendered once ready.
 */
@Composable
fun QrCode(content: String, size: Dp = 200.dp, modifier: Modifier = Modifier) {
    val bitmap by produceState<Bitmap?>(initialValue = null, key1 = content) {
        value = withContext(Dispatchers.Default) { generateQrBitmap(content, 512) }
    }
    bitmap?.let {
        Image(it.asImageBitmap(), contentDescription = "QR code", modifier = modifier.size(size))
    }
}

private fun generateQrBitmap(content: String, px: Int): Bitmap? = try {
    val hints = mapOf(
        EncodeHintType.MARGIN to 1,
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
    )
    val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, px, px, hints)
    val w = matrix.width
    val h = matrix.height
    // Fill an IntArray and hand it to createBitmap in one call — 262k individual
    // setPixel() JNI calls would stall even off the main thread.
    val pixels = IntArray(w * h)
    for (y in 0 until h) {
        val row = y * w
        for (x in 0 until w) {
            pixels[row + x] = if (matrix.get(x, y)) AndroidColor.BLACK else AndroidColor.WHITE
        }
    }
    Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
} catch (e: Exception) {
    null
}
