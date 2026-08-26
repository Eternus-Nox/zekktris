package com.zekktris.voice

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import java.io.File
import kotlin.math.roundToInt

/**
 * Records a voice message to a temporary AAC `.m4a`, sampling the mic level for
 * a 48-bucket waveform. Mirrors the iOS VoiceRecorder wire format so the clip
 * renders identically (waveform = base64 of 48 bytes, each level*255 clamped
 * 4..255; the recipient's decodeWaveform reads byte/255).
 */
class VoiceRecorder(private val ctx: Context) {
    data class Recording(val bytes: ByteArray, val filename: String, val durationSec: Int, val waveform: String)

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startMs = 0L
    private val amplitudes = mutableListOf<Int>()

    /** Begin recording. Returns false if the mic couldn't be opened. */
    fun start(): Boolean {
        val dir = File(ctx.cacheDir, "voice").apply { mkdirs() }
        val f = File(dir, "vm-${System.nanoTime()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else MediaRecorder()
        return runCatching {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(64_000)
            r.setAudioSamplingRate(44_100)
            r.setOutputFile(f.absolutePath)
            r.prepare(); r.start()
            recorder = r; file = f; startMs = SystemClock.elapsedRealtime(); amplitudes.clear()
            true
        }.getOrElse { runCatching { r.release() }; false }
    }

    /** Elapsed recording time in ms (0 when not recording). */
    fun elapsedMs(): Long = if (recorder == null) 0L else SystemClock.elapsedRealtime() - startMs

    /** Sample the current mic level — call periodically while recording. */
    fun sample() { runCatching { recorder?.maxAmplitude?.let { amplitudes.add(it) } } }

    /** Instantaneous mic level 0..1, for the settings mic-test meter. */
    fun currentLevel(): Float {
        val amp = runCatching { recorder?.maxAmplitude }.getOrNull() ?: return 0f
        return (amp / 32767f).coerceIn(0f, 1f)
    }

    /** Stop + finalize; returns the clip, or null on failure (incl. a too-short
     *  recording where MediaRecorder.stop() throws and the file is invalid). */
    fun stop(): Recording? {
        val r = recorder ?: return null
        val f = file
        recorder = null; file = null
        val durSec = (elapsedRoundSec(startMs)).coerceAtLeast(1)
        // stop() throws ("stop failed") when no frames were captured (sub-second
        // clip); the file is left without a valid moov atom → discard it.
        val stopped = runCatching { r.stop() }.isSuccess
        runCatching { r.release() }
        if (!stopped || f == null || !f.exists()) { runCatching { f?.delete() }; return null }
        val bytes = runCatching { f.readBytes() }.getOrNull()
        runCatching { f.delete() }  // consumed into memory — don't leak in cacheDir
        if (bytes == null || bytes.isEmpty()) return null
        return Recording(bytes, f.name, durSec, encodeWaveform(amplitudes, 48))
    }

    /** Abort + delete the file. */
    fun cancel() {
        val r = recorder; recorder = null
        runCatching { r?.stop() }; runCatching { r?.release() }
        runCatching { file?.delete() }; file = null
    }

    private fun elapsedRoundSec(start: Long): Int =
        ((SystemClock.elapsedRealtime() - start) / 1000.0).roundToInt()
}

private fun encodeWaveform(amps: List<Int>, buckets: Int): String {
    if (amps.isEmpty()) return Base64.encodeToString(ByteArray(buckets) { 8 }, Base64.NO_WRAP)
    val maxAmp = 32767.0
    val out = ByteArray(buckets)
    for (i in 0 until buckets) {
        val start = (i * amps.size / buckets).coerceIn(0, amps.size)
        val end = maxOf(start + 1, (i + 1) * amps.size / buckets).coerceAtMost(amps.size)
        val slice = if (start < end) amps.subList(start, end) else emptyList()
        val avg = if (slice.isEmpty()) 0.0 else slice.average()
        val norm = (avg / maxAmp).coerceIn(0.0, 1.0)
        out[i] = maxOf(4.0, minOf(255.0, norm * 255.0)).toInt().toByte()
    }
    return Base64.encodeToString(out, Base64.NO_WRAP)
}
