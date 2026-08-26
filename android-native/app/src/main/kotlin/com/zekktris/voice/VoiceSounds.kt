package com.zekktris.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sin

/**
 * The voice-call UI sounds, synthesized — there are no audio assets in this
 * repo and there deliberately aren't any here either (web synthesizes its
 * pings with the Web Audio API; iOS with AVAudioEngine; this is the Android
 * analog). Each cue is a pair of sine notes with a short attack and an
 * exponential decay to silence, matching the cross-platform spec exactly so
 * the app sounds like ONE product on every device:
 *
 *   CONNECT  523.25 → 783.99 Hz, 90 ms each,  peak 0.16   (you joined)
 *   HANGUP   783.99 → 523.25 Hz, 110 ms each, peak 0.16   (the call ended)
 *   JOIN     659.25 → 880.00 Hz, 55 ms each,  peak 0.09   (someone arrived)
 *   LEAVE    880.00 → 659.25 Hz, 55 ms each,  peak 0.09   (someone left)
 *
 * Join/leave are half the volume and half the length on purpose: they are
 * ambient events that can fire often, not the user's own action.
 *
 * Routing: while a call is up these play with USAGE_VOICE_COMMUNICATION so
 * they follow the in-call volume slider and the current route (earpiece vs
 * speakerphone, per [VoiceManager.preferSpeakerphone]) instead of blasting at
 * media volume over the top of a call. Outside a call they fall back to a
 * notification usage.
 *
 * PCM is synthesized once per cue and cached; playback allocates only a short
 * MODE_STATIC AudioTrack, which is released as soon as the tone finishes (and
 * unconditionally on [release] at voice disconnect).
 */
class VoiceSounds {

    enum class Cue { CONNECT, HANGUP, JOIN, LEAVE }

    private companion object {
        const val SAMPLE_RATE = 44_100
        const val ATTACK_SEC = 0.012          // 12 ms — same attack the web build uses
        const val TAIL_SEC = 0.003            // hard linear fade of the last 3 ms
        const val DECAY_FLOOR = 0.0001        // exponential decay target (≈ -80 dB)
        const val GAP_SEC = 0.010             // silence after the second note
        /** Ambient join/leave blips: at most one per this window, extras coalesce. */
        const val AMBIENT_MIN_GAP_MS = 300L
        /** Long enough for the hangup tone to finish before we reclaim tracks. */
        const val END_RELEASE_DELAY_MS = 800L
    }

    /** [note1Hz, note2Hz, secondsPerNote, peakGain] per the shared spec. */
    private fun spec(cue: Cue): Spec = when (cue) {
        Cue.CONNECT -> Spec(523.25, 783.99, 0.090, 0.16)
        Cue.HANGUP -> Spec(783.99, 523.25, 0.110, 0.16)
        Cue.JOIN -> Spec(659.25, 880.00, 0.055, 0.09)
        Cue.LEAVE -> Spec(880.00, 659.25, 0.055, 0.09)
    }

    private data class Spec(val f1: Double, val f2: Double, val noteSec: Double, val peak: Double)

    private val handler = Handler(Looper.getMainLooper())
    private val buffers = HashMap<Cue, ShortArray>()
    private val live = HashSet<AudioTrack>()

    /** True while a LiveKit room is up — flips the output routing (see class doc). */
    @Volatile private var callActive = false

    /** Bumped on every call boundary so a pending end-of-call release can't reach
     *  across into the NEXT call and cut its connect tone short. */
    @Volatile private var epoch = 0

    private var lastAmbientAtMs = 0L

    /** A call is up: route cues through the voice-communication stream. */
    fun beginCall() {
        callActive = true
        epoch++
    }

    /** The call ended: stop using the call stream, and reclaim tracks once the
     *  hangup tone (played just before this) has finished. */
    fun endCall() {
        callActive = false
        val mine = ++epoch
        handler.postDelayed({ if (epoch == mine) release() }, END_RELEASE_DELAY_MS)
    }

    /**
     * Play a cue. Join/leave are rate-limited to one per 300 ms so five people
     * arriving at once is a single blip rather than a chord; connect/hangup are
     * never limited (they happen once per call).
     *
     * Deafen is NOT checked here — [VoiceManager] owns that state and gates every
     * call site, so there is exactly one place that decides "deafened means silent".
     */
    fun play(cue: Cue) {
        if (cue == Cue.JOIN || cue == Cue.LEAVE) {
            val now = android.os.SystemClock.elapsedRealtime()
            synchronized(this) {
                if (now - lastAmbientAtMs < AMBIENT_MIN_GAP_MS) return
                lastAmbientAtMs = now
            }
        }
        val pcm = buffer(cue) ?: return
        runCatching { start(pcm) }
    }

    /** Synthesize on first use, then reuse — never re-synthesize per play. */
    private fun buffer(cue: Cue): ShortArray? = synchronized(buffers) {
        buffers.getOrPut(cue) { render(spec(cue)) }
    }.takeIf { it.isNotEmpty() }

    /** Two back-to-back enveloped sine notes into one 16-bit mono PCM buffer. */
    private fun render(s: Spec): ShortArray {
        val perNote = (s.noteSec * SAMPLE_RATE).toInt()
        val tail = (GAP_SEC * SAMPLE_RATE).toInt()
        val out = ShortArray(perNote * 2 + tail)
        writeNote(out, 0, perNote, s.f1, s.peak)
        writeNote(out, perNote, perNote, s.f2, s.peak)
        return out
    }

    /**
     * One note: linear attack to [peak], then an exponential decay that reaches
     * the -80 dB floor exactly at the note's end, plus a hard linear fade over the
     * final 3 ms. Every note therefore starts AND ends at true zero amplitude, so
     * the note boundary and the buffer end can't click.
     */
    private fun writeNote(out: ShortArray, offset: Int, len: Int, freq: Double, peak: Double) {
        if (len <= 0) return
        val attack = (ATTACK_SEC * SAMPLE_RATE).toInt().coerceIn(1, len)
        val tailStart = (len - TAIL_SEC * SAMPLE_RATE).toInt().coerceIn(0, len)
        // decay constant k such that exp(-k * decaySamples) == DECAY_FLOOR
        val decaySamples = (len - attack).coerceAtLeast(1)
        val k = -ln(DECAY_FLOOR) / decaySamples
        val step = 2.0 * Math.PI * freq / SAMPLE_RATE
        for (i in 0 until len) {
            var env = if (i < attack) peak * (i.toDouble() / attack)
                      else peak * exp(-k * (i - attack))
            if (i >= tailStart && len > tailStart) {
                env *= (len - i).toDouble() / (len - tailStart)
            }
            val v = sin(step * i) * env * Short.MAX_VALUE
            out[offset + i] = v.toInt().coerceIn(-32768, 32767).toShort()
        }
    }

    private fun attributes(): AudioAttributes = AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .setUsage(
            if (callActive) AudioAttributes.USAGE_VOICE_COMMUNICATION
            else AudioAttributes.USAGE_NOTIFICATION_EVENT
        )
        .build()

    private fun start(pcm: ShortArray) {
        val bytes = pcm.size * 2
        val track = AudioTrack.Builder()
            .setAudioAttributes(attributes())
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(bytes)
            .build()
        // In MODE_STATIC the state is STATE_NO_STATIC_DATA until the buffer is
        // written and only then STATE_INITIALIZED — so the pre-write check is for
        // STATE_UNINITIALIZED (a track that failed to allocate) and the readiness
        // check happens after the write.
        if (track.state == AudioTrack.STATE_UNINITIALIZED) { runCatching { track.release() }; return }
        track.write(pcm, 0, pcm.size)
        if (track.state != AudioTrack.STATE_INITIALIZED) { runCatching { track.release() }; return }
        synchronized(live) { live.add(track) }
        track.play()
        // Reclaim the track once the tone has drained. Playback is fire-and-forget:
        // an SFX that outlived its own teardown would leak a hardware track per blip.
        val ms = (pcm.size * 1000L / SAMPLE_RATE) + 200L
        handler.postDelayed({ dispose(track) }, ms)
    }

    private fun dispose(track: AudioTrack) {
        synchronized(live) { if (!live.remove(track)) return }
        runCatching { track.stop() }
        runCatching { track.release() }
    }

    /** Release every outstanding track — called on voice disconnect. The cached
     *  PCM is kept (a few KB) so the next call doesn't re-synthesize. */
    fun release() {
        val snapshot = synchronized(live) { live.toList().also { live.clear() } }
        snapshot.forEach {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
    }
}
