import Foundation
import AVFoundation

/// Voice-call UI cues (connect / hangup / someone-joined / someone-left).
///
/// SYNTHESIZED, not bundled. There are no audio assets in this app and the web
/// client synthesizes its sounds through the Web Audio API (see
/// `apps/web/src/lib/sounds.ts`); this is the same idea with the same numbers so
/// every platform sounds like one product. Each cue is a two-note sine motif
/// rendered once into an in-memory 16-bit mono WAV and cached — the synthesis
/// cost is paid on first use per cue, never per play.
///
/// ⚠️ AUDIO-SESSION HAZARD ⚠️
/// `VoiceManager.callAudioActive` means "a live call owns the shared
/// AVAudioSession". While it is true this file MUST NOT touch setCategory /
/// setActive — re-categorizing or deactivating the session mid-call kills the
/// call's audio (the invariant VoiceMessage.swift also honours at :33/:85/:103/
/// :124/:208). We just play into the session the call already configured;
/// AVAudioPlayer needs no session ownership of its own. Only when NO call is up
/// do we configure the session, and then with exactly the shape
/// `VoiceClipPlayer.play()` uses (.playback + setActive(true), no teardown).
///
/// In practice every cue fires during a call (connect fires on `.connected`,
/// hangup fires before the room is torn down, join/leave only fire while we are
/// in a channel), so the no-call branch is defensive rather than load-bearing.
///
/// Threading: `play(_:)` is @MainActor (so reading the MainActor-owned
/// `callAudioActive` / deafen state is legal) but does no work there — synthesis
/// and playback are hopped onto a private serial queue, so a cue can never
/// stall the UI.
/// `@unchecked Sendable` is honest here: the only mutable instance state
/// (`players`) is confined to the private serial queue, and the two statics are
/// main-actor-only touch points (same contract as `VoiceManager.callAudioActive`).
final class VoiceSounds: @unchecked Sendable {
    enum Cue: Hashable {
        /// You joined/answered a call. Ascending, definitive.
        case connect
        /// The call ended (either side hung up). Descending, definitive.
        case hangup
        /// SOMEONE ELSE entered your voice channel. Short ascending blip, quieter.
        case join
        /// SOMEONE ELSE left your voice channel. Short descending blip, quieter.
        case leave

        /// The SHARED cross-platform spec. Do not diverge from these numbers
        /// without changing web + Android to match.
        ///   CONNECT: 523.25 → 783.99 Hz, 90 ms each, peak 0.16
        ///   HANGUP : 783.99 → 523.25 Hz, 110 ms each, peak 0.16
        ///   JOIN   : 659.25 → 880.00 Hz, 55 ms each, peak 0.09
        ///   LEAVE  : 880.00 → 659.25 Hz, 55 ms each, peak 0.09
        /// Join/leave are deliberately ~half the volume and shorter: they are
        /// ambient events that can happen often, not the user's own action.
        var tones: [(freq: Double, ms: Double)] {
            switch self {
            case .connect: return [(523.25, 90), (783.99, 90)]
            case .hangup:  return [(783.99, 110), (523.25, 110)]
            case .join:    return [(659.25, 55), (880.00, 55)]
            case .leave:   return [(880.00, 55), (659.25, 55)]
            }
        }

        var peak: Double {
            switch self {
            case .connect, .hangup: return 0.16
            case .join, .leave: return 0.09
            }
        }

        /// Ambient cues (other people coming and going) are rate-limited;
        /// connect/hangup happen once per call and are always let through.
        var isAmbient: Bool {
            switch self {
            case .join, .leave: return true
            case .connect, .hangup: return false
            }
        }
    }

    static let shared = VoiceSounds()

    /// Mirror of `VoiceManager.isDeafened`, kept in sync by that property's
    /// didSet. Deafened means NO audio — a blip that ignores it is a bug — so
    /// this gates every cue centrally instead of relying on each call site to
    /// remember. Written and read only from the main actor (same contract as
    /// `VoiceManager.callAudioActive`).
    nonisolated(unsafe) static var suppressed = false

    /// Ambient rate limit: at most one join/leave blip per 300 ms. Five people
    /// arriving at once should be a blip, not a chord — later cues inside the
    /// window are coalesced away (dropped), which is what "one blip" means.
    private static let ambientMinInterval: TimeInterval = 0.3
    @MainActor private static var lastAmbientAt: Date = .distantPast

    /// Serial queue owning `players` — synthesis and AVAudioPlayer work happen
    /// here so the main actor is never blocked.
    private let queue = DispatchQueue(label: "com.zekktris.voicesounds", qos: .userInitiated)
    private var players: [Cue: AVAudioPlayer] = [:]

    private init() {}

    /// Play a cue. Safe to call from any @MainActor code; returns immediately.
    /// Silently no-ops while deafened, or if synthesis/playback fails (a UI cue
    /// is never worth surfacing an error for).
    @MainActor
    static func play(_ cue: Cue) {
        guard !suppressed else { return }
        if cue.isAmbient {
            let now = Date()
            guard now.timeIntervalSince(lastAmbientAt) >= ambientMinInterval else { return }
            lastAmbientAt = now
        }
        // Read the call-ownership flag HERE, on the main actor that owns it,
        // and carry the answer to the background queue.
        let callActive = VoiceManager.callAudioActive
        shared.enqueue(cue, callActive: callActive)
    }

    private func enqueue(_ cue: Cue, callActive: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            // Never re-categorize or activate the session while a call owns it.
            // Outside a call, follow VoiceClipPlayer.play()'s exact shape.
            if !callActive {
                try? AVAudioSession.sharedInstance().setCategory(.playback)
                try? AVAudioSession.sharedInstance().setActive(true)
            }
            guard let player = self.player(for: cue) else { return }
            player.currentTime = 0
            player.play()
        }
    }

    /// Cached one-player-per-cue. The WAV is synthesized exactly once per cue
    /// for the process lifetime. Must be called on `queue`.
    private func player(for cue: Cue) -> AVAudioPlayer? {
        if let existing = players[cue] { return existing }
        guard let data = VoiceSounds.renderWAV(tones: cue.tones, peak: cue.peak),
              let player = try? AVAudioPlayer(data: data) else { return nil }
        player.prepareToPlay()
        players[cue] = player
        return player
    }

    // MARK: - Synthesis

    private static let sampleRate = 44_100.0

    /// Render a sequence of sine tones into a 16-bit mono PCM WAV.
    ///
    /// Envelope per tone: a 4 ms linear attack up to full amplitude (so the note
    /// doesn't click in), then an exponential decay that lands on EXACTLY zero
    /// at the tone's end. Two reasons the true zero matters — it makes the seam
    /// between the two notes silent, and it ends the file on silence so the tail
    /// doesn't pop. (A raw `exp(-kt)` never reaches zero, hence the offset +
    /// renormalize.) The decay is measured from the END of the attack, so the
    /// envelope really does touch 1.0 and the rendered peak is exactly the
    /// spec'd `peak` — including the deliberate ~half-volume ratio between the
    /// ambient join/leave blips and the connect/hangup cues.
    private static func renderWAV(tones: [(freq: Double, ms: Double)], peak: Double) -> Data? {
        guard !tones.isEmpty else { return nil }
        let decayK = 5.0
        let floorValue = exp(-decayK)   // envelope value at u = 1, subtracted off

        var samples: [Int16] = []
        samples.reserveCapacity(tones.reduce(0) { $0 + Int(sampleRate * $1.ms / 1000.0) } + 256)

        for tone in tones {
            let count = Int(sampleRate * tone.ms / 1000.0)
            guard count > 0 else { continue }
            // 4 ms attack, but never more than a tenth of the tone (a very short
            // cue must still get a real decay, not be all ramp).
            let attackSamples = max(1, min(Int(sampleRate * 0.004), count / 10))
            let decaySamples = max(1, count - attackSamples)
            for i in 0..<count {
                let env: Double
                if i < attackSamples {
                    env = Double(i) / Double(attackSamples)
                } else {
                    let u = Double(i - attackSamples) / Double(decaySamples)
                    env = (exp(-decayK * u) - floorValue) / (1.0 - floorValue)
                }
                let value = sin(2.0 * .pi * tone.freq * Double(i) / sampleRate) * env * peak
                samples.append(Int16(max(-1.0, min(1.0, value)) * 32_767.0))
            }
        }
        // A few ms of trailing silence so playback stops cleanly.
        samples.append(contentsOf: [Int16](repeating: 0, count: Int(sampleRate * 0.005)))

        return wavContainer(samples: samples)
    }

    /// Wrap raw mono 16-bit samples in a canonical 44-byte RIFF/WAVE header.
    private static func wavContainer(samples: [Int16]) -> Data {
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let rate = UInt32(sampleRate)
        let byteRate = rate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataBytes = UInt32(samples.count * MemoryLayout<Int16>.size)

        var data = Data(capacity: Int(dataBytes) + 44)
        func append(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func append32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func append16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }

        append("RIFF")
        append32(36 + dataBytes)
        append("WAVE")
        append("fmt ")
        append32(16)                // PCM fmt chunk size
        append16(1)                 // format = PCM
        append16(channels)
        append32(rate)
        append32(byteRate)
        append16(blockAlign)
        append16(bitsPerSample)
        append("data")
        append32(dataBytes)
        for sample in samples {
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }
}
