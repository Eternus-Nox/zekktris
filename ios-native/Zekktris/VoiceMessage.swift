import SwiftUI
import AVFoundation

// MARK: - Recording

/// Records a voice message to a temporary `.m4a` (AAC) file, sampling the
/// mic level for a live waveform. On stop, returns the file URL, rounded
/// duration, and a 48-sample base64 waveform matching the web format.
@MainActor
final class VoiceRecorder: ObservableObject {
    @Published var recording = false
    /// True after the user taps STOP but before they send or discard — the
    /// recording is finalized and waiting in the composer for review. Lets the
    /// bar swap its STOP button for a SEND button without leaving the recorder.
    @Published var recordingComplete = false
    @Published var elapsed: TimeInterval = 0
    @Published var levels: [CGFloat] = []   // recent live levels, 0…1

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var fileURL: URL?
    private var powerSamples: [Float] = []
    // Captured at stopRecording() time so finalize() can hand them to onSend
    // (the AVAudioRecorder is torn down on stop, so currentTime is gone).
    private var finalDuration = 0
    private var finalWaveform: String?

    func start() {
        // Never seize the shared audio session from a live call — recording
        // a voice message mid-call would kill the call's mic/audio. (The
        // composer also hides the recorder during a call; this is defense
        // in depth.)
        guard !VoiceManager.callAudioActive else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default)
            try session.setActive(true)
        } catch { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vm-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.isMeteringEnabled = true
            rec.record()
            recorder = rec
            fileURL = url
            recording = true
            elapsed = 0
            powerSamples = []
            levels = []
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch {
            recording = false
        }
    }

    private func tick() {
        guard let rec = recorder, rec.isRecording else { return }
        rec.updateMeters()
        let power = rec.averagePower(forChannel: 0)
        powerSamples.append(power)
        levels.append(CGFloat(Self.normalize(power)))
        if levels.count > 56 { levels.removeFirst(levels.count - 56) }
        elapsed = rec.currentTime
    }

    /// Stop recording; returns (fileURL, durationSeconds, waveformBase64).
    func stop() -> (URL, Int, String)? {
        timer?.invalidate(); timer = nil
        guard let rec = recorder, let url = fileURL else { return nil }
        let dur = max(1, Int(rec.currentTime.rounded()))
        rec.stop()
        recording = false
        // Don't deactivate the shared session while a call holds it — that
        // would drop the call's audio. If a call is active the recorder
        // never activated the session (start() bailed), so skipping is safe.
        if !VoiceManager.callAudioActive { try? AVAudioSession.sharedInstance().setActive(false) }
        let waveform = Self.waveformBase64(from: powerSamples, buckets: 48)
        recorder = nil
        return (url, dur, waveform)
    }

    /// Stop recording WITHOUT sending: finalize the duration + waveform and
    /// hold the file so the composer can show a SEND button for review. Idempotent.
    func stopRecording() {
        guard recording, let rec = recorder else { return }
        timer?.invalidate(); timer = nil
        finalDuration = max(1, Int(rec.currentTime.rounded()))
        rec.stop()
        finalWaveform = Self.waveformBase64(from: powerSamples, buckets: 48)
        recorder = nil
        recording = false
        recordingComplete = true
        // Recording is done — release the session unless a call holds it (see stop()).
        if !VoiceManager.callAudioActive { try? AVAudioSession.sharedInstance().setActive(false) }
    }

    /// Hand off a stopped-but-unsent recording for sending. Clears the
    /// completed state; the caller owns the file from here.
    func finalize() -> (URL, Int, String)? {
        guard let url = fileURL, let wf = finalWaveform else { return nil }
        recordingComplete = false
        return (url, finalDuration, wf)
    }

    func cancel() {
        timer?.invalidate(); timer = nil
        recorder?.stop()
        recorder = nil
        recording = false
        recordingComplete = false
        finalWaveform = nil
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        // See stop(): never deactivate the shared session out from under a call.
        if !VoiceManager.callAudioActive { try? AVAudioSession.sharedInstance().setActive(false) }
    }

    /// Map an averagePower dB reading (~ -50…0) to 0…1.
    static func normalize(_ db: Float) -> Float {
        let minDb: Float = -50
        if db <= minDb { return 0 }
        if db >= 0 { return 1 }
        return (db - minDb) / -minDb
    }

    static func waveformBase64(from powers: [Float], buckets: Int) -> String {
        guard !powers.isEmpty else {
            return Data(repeating: 8, count: buckets).base64EncodedString()
        }
        var out = [UInt8]()
        for i in 0..<buckets {
            let start = i * powers.count / buckets
            let end = max(start + 1, (i + 1) * powers.count / buckets)
            let slice = powers[start..<min(end, powers.count)]
            let avg = slice.isEmpty ? -50 : slice.reduce(0, +) / Float(slice.count)
            let norm = normalize(avg)
            out.append(UInt8(max(4, min(255, norm * 255))))
        }
        return Data(out).base64EncodedString()
    }
}

// MARK: - Playback

/// Streams a single voice-message clip with play/pause and progress.
@MainActor
final class VoiceClipPlayer: ObservableObject {
    @Published var playing = false
    @Published var progress: Double = 0   // 0…1

    private var player: AVPlayer?
    private var observer: Any?
    // Optional so an encrypted clip can be created before its decrypted
    // temp-file URL is ready; set via setSource(_:) once decryption finishes.
    private var url: URL?
    private let duration: Double

    init(url: URL?, duration: Double) {
        self.url = url
        self.duration = max(0.1, duration)
    }

    /// Supply the playable URL after construction (e.g. a decrypted E2EE
    /// voice note written to a temp file). No-op once the player exists.
    func setSource(_ newURL: URL) {
        if player == nil { url = newURL }
    }

    func toggle() { playing ? pause() : play() }

    func play() {
        guard let url else { return } // encrypted clip not yet decrypted
        if player == nil {
            let p = AVPlayer(url: url)
            observer = p.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.05, preferredTimescale: 600), queue: .main
            ) { [weak self] t in
                let secs = t.seconds
                Task { @MainActor in
                    guard let self else { return }
                    self.progress = min(1, secs / self.duration)
                    if secs >= self.duration { self.finish() }
                }
            }
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.finish() }
            }
            player = p
        }
        // Don't re-categorize/activate the shared session while a call owns it
        // (that would switch the call's route / interrupt it). The clip still
        // plays on the call's already-active session.
        if !VoiceManager.callAudioActive {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        player?.play()
        playing = true
    }

    func pause() { player?.pause(); playing = false }

    func finish() {
        player?.pause()
        player?.seek(to: .zero)
        progress = 0
        playing = false
    }

    /// Remove the time observer before the player deallocates (avoids the
    /// "observers still registered" crash) and release it.
    func cleanup() {
        if let observer { player?.removeTimeObserver(observer); self.observer = nil }
        player?.pause()
        player = nil
        playing = false
    }
}

// MARK: - Waveform

/// A row of amplitude bars. `progress` fills bars up to that fraction.
struct WaveformBars: View {
    let levels: [CGFloat]      // 0…1
    var progress: Double = 0   // 0…1
    var activeColor: Color = Theme.accent
    var inactiveColor: Color = Theme.ink4

    var body: some View {
        GeometryReader { geo in
            HStack(alignment: .center, spacing: 2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { i, lvl in
                    let frac = levels.isEmpty ? 0 : Double(i) / Double(max(1, levels.count - 1))
                    RoundedRectangle(cornerRadius: 1)
                        .fill(frac <= progress ? activeColor : inactiveColor)
                        .frame(height: max(3, lvl * geo.size.height))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }
}

// MARK: - Playback view (in messages)

struct VoiceMessageView: View {
    let store: AppStore
    let attachment: Attachment
    let channel: Channel
    @StateObject private var player: VoiceClipPlayer
    // Encrypted clips aren't playable until their audio is fetched +
    // decrypted to a temp file; plaintext clips are ready immediately.
    @State private var ready: Bool
    // The decrypted-audio temp file (encrypted clips only) — deleted on
    // disappear so it doesn't linger in tmp.
    @State private var tempAudioURL: URL?

    init(store: AppStore, attachment: Attachment, channel: Channel) {
        self.store = store
        self.attachment = attachment
        self.channel = channel
        let encrypted = attachment.filename?.hasSuffix(".zke") == true
        if encrypted {
            _player = StateObject(wrappedValue: VoiceClipPlayer(url: nil, duration: Double(attachment.durationSeconds ?? 1)))
            _ready = State(initialValue: false)
        } else {
            let url = assetURL(attachment.url) ?? URL(string: Config.assetOrigin)!
            _player = StateObject(wrappedValue: VoiceClipPlayer(url: url, duration: Double(attachment.durationSeconds ?? 1)))
            _ready = State(initialValue: true)
        }
    }

    private var bars: [CGFloat] {
        guard let wf = attachment.waveform, let data = Data(base64Encoded: wf), !data.isEmpty else {
            return Array(repeating: 0.3, count: 32)
        }
        return data.map { CGFloat($0) / 255.0 }
    }

    private var durationText: String {
        let s = attachment.durationSeconds ?? 0
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { player.toggle() } label: {
                Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 30)).foregroundColor(ready ? Theme.accent : Theme.ink4)
            }
            .buttonStyle(.plain)
            .disabled(!ready)
            WaveformBars(levels: bars, progress: player.progress)
                .frame(height: 28)
            Text(durationText)
                .font(.zkMono(12)).foregroundColor(Theme.ink3)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: 260)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task {
            // Encrypted voice note: fetch + decrypt the audio, write it to a
            // temp file, and hand that URL to the player. Plaintext clips are
            // already ready (set in init) and skip this.
            guard !ready, attachment.filename?.hasSuffix(".zke") == true else { return }
            if let data = await store.decryptedAttachmentData(attachment, in: channel) {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + ".m4a")
                if (try? data.write(to: tmp)) != nil {
                    tempAudioURL = tmp
                    player.setSource(tmp)
                    ready = true
                }
            }
        }
        .onDisappear {
            player.cleanup()
            if let tempAudioURL { try? FileManager.default.removeItem(at: tempAudioURL) }
        }
    }
}

// MARK: - Recording bar (in composer)

struct VoiceRecorderBar: View {
    @ObservedObject var recorder: VoiceRecorder
    var onSend: (URL, Int, String) -> Void
    var onCancel: () -> Void

    private var elapsedText: String {
        let s = Int(recorder.elapsed)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { recorder.cancel(); onCancel() } label: {
                Image(systemName: "trash").font(.system(size: 18)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
            Circle().fill(Theme.danger).frame(width: 8, height: 8)
                .opacity(recorder.recording ? 1 : 0.3)
            Text(elapsedText).font(.zkMono(13)).foregroundColor(Theme.ink2)
            WaveformBars(
                levels: recorder.levels.isEmpty ? [0.2] : recorder.levels,
                progress: 0, activeColor: Theme.accent2, inactiveColor: Theme.accent2
            )
            .frame(height: 24)
            if recorder.recording {
                // STOP: end recording and hold it for review (the bar stays,
                // now showing a SEND button) instead of sending immediately.
                Button { recorder.stopRecording() } label: {
                    Image(systemName: "stop.circle.fill").font(.system(size: 28)).foregroundColor(Theme.danger)
                }
                .buttonStyle(.plain)
            } else {
                // SEND the stopped recording.
                Button {
                    if let (url, dur, wf) = recorder.finalize() { onSend(url, dur, wf) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)).foregroundColor(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }
}
