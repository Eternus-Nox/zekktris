import Foundation
import CallKit
import AVFAudio
import LiveKit
import UIKit

/// CallKit bridge: 1:1 DM calls ring and behave like normal phone calls —
/// full-screen system UI on the lock screen, answer/decline/mute from the
/// system call screen, and the green in-call indicator while connected.
///
/// The store wires `onAnswer` / `onEnd` / `onSetMuted`; every user-facing
/// accept/decline goes THROUGH CallKit (answerFromApp/endFromApp) so the
/// system call UI never drifts out of sync with the in-app state. If a
/// CallKit transaction fails (rare — e.g. restricted device), the closures
/// run directly as a fallback.
@MainActor
final class CallManager: NSObject, ObservableObject {
    static let shared = CallManager()

    /// Join the call for this DM channel (system Answer / in-app Accept).
    var onAnswer: ((String) -> Void)?
    /// Decline a ringing call or hang up an active one for this channel.
    var onEnd: ((String) -> Void)?
    /// A ring expired unanswered (the 45s safety net). Distinct from onEnd: the
    /// user never acted, so the store must clear its own ringing UI and decline
    /// server-side so the caller stops ringing.
    var onRingTimeout: ((String) -> Void)?
    /// System call-screen (or headset) mute changed to this value. Already
    /// de-duplicated: repeats and the echo of our own reportMuted() never get
    /// here. The store SETS this state; it must never toggle on it.
    var onSetMuted: ((Bool) -> Void)?
    /// CallKit activated the audio session — the store makes sure the mic is
    /// live on the now-active session (the room connected with the LiveKit
    /// engine gated for CallKit).
    var onAudioActivated: (() -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private var uuidByChannel: [String: UUID] = [:]
    private var channelByUUID: [UUID: String] = [:]
    /// UUIDs still in the ringing (unanswered) state.
    private var ringing: Set<UUID> = []
    /// UUIDs whose audio session CallKit actually activated. Used by forget()
    /// to tell "this call had live audio, a room teardown is coming, don't
    /// touch the engine gate" from "this call never got audio, restoring the
    /// gate here is the safety net it was written to be."
    private var audioActivated: Set<UUID> = []
    /// Per-ring safety-net timeouts. iOS fires no delegate method when an
    /// incoming call it displayed simply times out unanswered and the system
    /// auto-dismisses the UI — the app must proactively end it. Normally the
    /// gateway CANCEL (remoteCancelled) does that; if that's missed, this
    /// bounds the leak so the peer's NEXT call can still ring.
    private var ringTimeouts: [UUID: Task<Void, Never>] = [:]
    /// The mute state CallKit holds for each live call: whatever it last told
    /// us (CXSetMutedCallAction) or we last asked it for (reportMuted). Absent
    /// means unmuted, CallKit's starting state. It lets the provider drop a
    /// CXSetMutedCallAction that changes nothing — CallKit's echo of our own
    /// request, and the repeats iOS 17+ is known to send in bursts — instead
    /// of passing each one on to flip the mic again.
    private var mutedByUUID: [UUID: Bool] = [:]
    /// Action ids of the CXSetMutedCallActions we requested ourselves and
    /// CallKit hasn't performed back yet. Recognises our own echo exactly even
    /// when two in-app taps overtake each other, where the state check alone
    /// would take the first echo for a user change.
    private var ownMuteActions: Set<UUID> = []

    /// A CallKit call has been answered and hasn't ended, so the audio session
    /// is CallKit's. VoiceManager checks this whenever a Room goes away: while
    /// it holds, the mic stays on .inputMixer and the engine gate is left to
    /// didActivate, because the Room going away is not this call's (typically
    /// guild voice being swapped out for a call just answered from the lock
    /// screen) and resetting either would undo the answer handler's setup.
    /// The call's own teardown always runs after forget(), so it still gets
    /// the resting state back.
    var hasAnsweredCall: Bool { !audioActivated.isEmpty }

    /// CallKit holds the answered call muted. A mute pressed on the system call
    /// screen before the call's Room exists has nothing to apply to yet, so
    /// VoiceManager.performConnect starts the call muted from this instead of
    /// publishing a live mic under CallKit's muted button.
    var isAnsweredCallMuted: Bool { audioActivated.contains { mutedByUUID[$0] == true } }

    override private init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        // THE ONLY route from the system call screen back into the app.
        //
        // For an audio-only call (supportsVideo false / hasVideo false) iOS keeps
        // its own in-call UI up after the answer action is fulfilled — it does NOT
        // foreground the VoIP app, and there is no public API that can. The single
        // affordance is the app-icon button in the system button grid, and that
        // button only exists if iconTemplateImageData is set. It never was, so
        // answering from the lock screen left the user stranded on the CallKit
        // screen while the app sat correctly staged on its .voice route in the
        // background — the "stays in CallKit instead of transferring to the app"
        // report.
        //
        // Deliberately NOT fixed by flipping hasVideo/supportsVideo to force a
        // foreground: that turns an audio call into a video ring and puts CallKit
        // into video mode, which also fights the .videoChat session category the
        // answer handler configures.
        config.iconTemplateImageData = Self.callKitTemplateIcon()
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// 40x40 template mark for the CallKit in-call button grid.
    ///
    /// Generated in code rather than shipped as an asset because CallKit imposes
    /// two invariants that art can silently violate: the image MUST be square (a
    /// non-square icon throws when the provider config is applied) and only its
    /// ALPHA channel is used — iOS tints the shape itself, so colour is ignored.
    /// Rendering it here guarantees both, and leaves no binary artwork to drift
    /// out of sync with the app icon.
    private static func callKitTemplateIcon() -> Data? {
        let side: CGFloat = 40
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { _ in
            let glyph = "Z" as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 30, weight: .heavy),
                .foregroundColor: UIColor.black,
            ]
            let size = glyph.size(withAttributes: attrs)
            glyph.draw(
                at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2),
                withAttributes: attrs
            )
        }
        return image.pngData()
    }

    // MARK: Bookkeeping

    private func uuid(for channelId: String) -> UUID {
        if let u = uuidByChannel[channelId] { return u }
        let u = UUID()
        uuidByChannel[channelId] = u
        channelByUUID[u] = channelId
        return u
    }

    private func forget(_ channelId: String) {
        var wasAudioActivated = false
        if let u = uuidByChannel.removeValue(forKey: channelId) {
            channelByUUID.removeValue(forKey: u)
            ringing.remove(u)
            ringTimeouts.removeValue(forKey: u)?.cancel()
            mutedByUUID.removeValue(forKey: u)
            wasAudioActivated = audioActivated.remove(u) != nil
        }
        // Echo ids aren't keyed by call; once no call is left, none can come.
        if uuidByChannel.isEmpty { ownMuteActions.removeAll() }
        // Safety net ONLY: restore the resting engine state when this call never
        // had its audio session activated (e.g. the caller cancelled as we
        // answered, or a ring was declined) — there is no room teardown to race
        // in that case.
        //
        // If the call WAS activated, do NOT touch the gate here. forget() runs
        // synchronously inside the CXEndCallAction handler, i.e. BEFORE the
        // teardown it triggers (onEnd defers leaveCurrentVoice into a Task), so
        // flipping the gate to .default here re-enabled the LiveKit audio engine
        // against a Room that was about to be destroyed. A device crash caught
        // exactly that: the main thread inside [AVAudioSession currentRoute]
        // under a LiveKit route-change observer while the room tore down, and
        // the WebRTC worker null-dereffed. For activated calls the restore now
        // happens in provider(_:didDeactivate:) and, authoritatively, at the end
        // of VoiceManager.performDisconnect() once the Room is actually gone.
        // (The null dereference itself was LiveKit's #929 — see
        // VoiceManager.sessionChain — but the order above still holds.)
        if !wasAudioActivated {
            try? AudioManager.shared.setEngineAvailability(.default)
        }
    }

    // MARK: Incoming

    /// Ring with the native call screen (banner in-app, full screen when
    /// locked). The in-app ringing overlay still renders as well; both
    /// answer paths converge on `onAnswer`.
    func reportIncoming(channelId: String, callerName: String) {
        let u = uuid(for: channelId)
        guard !ringing.contains(u) else {
            // Apple REQUIRES every received VoIP push to report a CallKit
            // call. Silently swallowing a duplicate (caller cancel+redial
            // racing the gateway cancel while the first ring is still up)
            // is the one thing that gets the app killed and — repeated —
            // gets VoIP delivery throttled/blacklisted, which permanently
            // breaks CallKit until reinstall. Satisfy the contract with a
            // THROWAWAY call: report it, then end it immediately; the
            // visible ring for the channel is untouched.
            let throwaway = UUID()
            let update = CXCallUpdate()
            update.remoteHandle = CXHandle(type: .generic, value: callerName)
            update.localizedCallerName = callerName
            update.hasVideo = false
            provider.reportNewIncomingCall(with: throwaway, update: update) { [weak self] _ in
                // CallKit invokes this off-main; provider is main-actor
                // isolated — hop back (same idiom as the error path below).
                Task { @MainActor in
                    self?.provider.reportCall(with: throwaway, endedAt: nil, reason: .answeredElsewhere)
                }
            }
            return
        }
        ringing.insert(u)
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        provider.reportNewIncomingCall(with: u, update: update) { [weak self] error in
            if error != nil {
                // CallKit refused (call restrictions, etc.) — the in-app
                // overlay remains the answer surface.
                Task { @MainActor in self?.forget(channelId) }
                return
            }
            // Safety net: if this ring is never answered/ended and the gateway
            // CANCEL is missed, iOS auto-dismisses the UI silently, leaving the
            // UUID stuck in `ringing` forever (blocking the peer's next call).
            // Bound the leak: end the stale call after ~45s if still ringing.
            Task { @MainActor in
                guard let self, self.ringing.contains(u) else { return }
                self.ringTimeouts[u] = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 45_000_000_000)
                    guard let self, self.ringing.contains(u) else { return }
                    self.provider.reportCall(with: u, endedAt: nil, reason: .unanswered)
                    // Tell the STORE too, before forgetting the call. Dismissing
                    // only CallKit's copy left the in-app ringing overlay (and
                    // its ringtone) running forever — the phone kept ringing for
                    // a call the system had already given up on — and never
                    // declined server-side, so the caller sat there ringing into
                    // a dead end. onRingTimeout clears incomingCall and POSTs the
                    // decline.
                    if let cid = self.channelByUUID[u] {
                        self.onRingTimeout?(cid)
                        self.forget(cid)
                    }
                }
            }
        }
    }

    /// The caller hung up before we answered.
    func remoteCancelled(channelId: String) {
        guard let u = uuidByChannel[channelId] else { return }
        provider.reportCall(with: u, endedAt: nil, reason: .remoteEnded)
        forget(channelId)
    }

    // MARK: In-app actions routed through CallKit

    func answerFromApp(channelId: String) {
        guard let u = uuidByChannel[channelId], ringing.contains(u) else {
            onAnswer?(channelId)
            return
        }
        controller.request(CXTransaction(action: CXAnswerCallAction(call: u))) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    self?.ringing.remove(u)
                    self?.ringTimeouts.removeValue(forKey: u)?.cancel()
                    self?.onAnswer?(channelId)
                }
            }
        }
    }

    func endFromApp(channelId: String) {
        guard let u = uuidByChannel[channelId] else {
            onEnd?(channelId)
            return
        }
        controller.request(CXTransaction(action: CXEndCallAction(call: u))) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    self?.onEnd?(channelId)
                    self?.forget(channelId)
                }
            }
        }
    }

    /// The call is over (we hung up, the peer left, or it was declined).
    func callEnded(channelId: String, remoteEnded: Bool) {
        guard let u = uuidByChannel[channelId] else { return }
        provider.reportCall(with: u, endedAt: nil, reason: remoteEnded ? .remoteEnded : .declinedElsewhere)
        forget(channelId)
    }

    /// The app's own mute changed (in-app mic button, deafen): mirror it into
    /// CallKit. A CallKit call's mute is also a system-level input mute on
    /// iOS 17+, so a CallKit "muted" left behind by an in-app unmute kept the
    /// mic silenced under an unmuted icon — the in-app button never told
    /// CallKit anything before. No-op for calls CallKit doesn't own (guild
    /// voice, outgoing calls, calls that rang only in-app because the app was
    /// frontmost) and while ringing. CallKit performs the request back through
    /// provider(_:perform: CXSetMutedCallAction), where the bookkeeping
    /// written here marks it as our own echo.
    func reportMuted(channelId: String, muted: Bool) {
        guard let u = uuidByChannel[channelId], !ringing.contains(u),
              (mutedByUUID[u] ?? false) != muted else { return }
        let previous = mutedByUUID[u]
        mutedByUUID[u] = muted
        let action = CXSetMutedCallAction(call: u, muted: muted)
        let actionId = action.uuid
        ownMuteActions.insert(actionId)
        controller.request(CXTransaction(action: action)) { [weak self] error in
            guard error != nil else { return }
            // Refused (e.g. the call ended meanwhile), so CallKit kept its old
            // state and will never perform it; the bookkeeping must follow,
            // unless something newer has already overwritten it.
            Task { @MainActor in
                guard let self else { return }
                self.ownMuteActions.remove(actionId)
                if self.mutedByUUID[u] == muted { self.mutedByUUID[u] = previous }
            }
        }
    }
}

extension CallManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        // CallKit tore down every call system-side (telephony daemon restart,
        // another VoIP app misbehaving, or the OS invalidating all calls). The
        // contract: discard ALL our call bookkeeping here, or stale entries
        // suppress future rings for those channels.
        Task { @MainActor in
            for t in ringTimeouts.values { t.cancel() }
            ringTimeouts.removeAll()
            uuidByChannel.removeAll()
            channelByUUID.removeAll()
            ringing.removeAll()
            audioActivated.removeAll()
            mutedByUUID.removeAll()
            ownMuteActions.removeAll()
            try? AudioManager.shared.setEngineAvailability(.default)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // CallKit answer audio handoff. Two failures bracket this path:
        //   - Keeping the engine AVAILABLE (the previous attempt) let LiveKit
        //     call setActive(true) itself, racing CallKit's own activation —
        //     which threw "Audio Session Error (Failed to configure audio
        //     session)" and broke audio on every lock-screen/background answer.
        //   - Gating the engine OFF *alone* (the attempt before that) deadlocked
        //     silent-both-ways: with the engine gated, LiveKit never set the
        //     session CATEGORY, so CallKit couldn't activate a call session,
        //     didActivate never fired, and the gate never lifted.
        // Fix both: gate the engine OFF so LiveKit doesn't activate the session,
        // but set the .playAndRecord category OURSELVES so CallKit CAN activate
        // it. CallKit then fires provider(_:didActivate:), which flips the gate
        // back to .default; LiveKit's engine starts on the already-active
        // session (its setActive(true) becomes a harmless no-op). voiceChat mode
        // + the speaker preference match what LiveKit configures, so the later
        // re-config doesn't fight this one.
        try? AudioManager.shared.setEngineAvailability(.none)
        // While CallKit owns the call, mute the mic at LiveKit's input mixer
        // instead of through voice processing. LiveKit's default
        // (.voiceProcessing) sets the system-level voiceProcessingInputMuted on
        // every mute: iOS plays its mute chime, and on iOS 17+ that system mute
        // is coupled to the CallKit call's own mute, so each LiveKit mute or
        // unmute came back to us as a CXSetMutedCallAction. .inputMixer only
        // zeroes LiveKit's mixer (the track is still disabled and the mute
        // still signalled to the SFU); the cost is that the orange mic
        // indicator stays on while muted. Switched here, with the engine gated
        // off and stopped, so it is pure bookkeeping in LiveKit's audio device
        // rather than a change to a running engine.
        // VoiceManager keeps it for as long as the call is answered
        // (hasAnsweredCall), even across a Room teardown, and restores
        // .voiceProcessing once the call is gone.
        try? AudioManager.shared.set(microphoneMuteMode: .inputMixer)
        // Match LiveKit's playAndRecordSpeaker config (.videoChat + these
        // options) so the engine's later re-config in didActivate is a no-op,
        // not a category change on an already-active CallKit session.
        // `allowBluetoothHFP` is the current name (the old `allowBluetooth` is
        // deprecated/renamed); it's available since iOS 8.0, so it's safe at our
        // iOS 16 deployment target with no runtime gate.
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord,
            mode: .videoChat,
            options: [.allowBluetoothHFP, .allowBluetoothA2DP, .allowAirPlay]
        )
        Task { @MainActor in
            if let channelId = channelByUUID[action.callUUID] {
                ringing.remove(action.callUUID)
                ringTimeouts.removeValue(forKey: action.callUUID)?.cancel()
                // Answering means this call gets a live audio session AND a
                // LiveKit Room, so its teardown owns the engine-gate restore —
                // forget() must not race it. (didActivate carries no call UUID,
                // so we record it here, where we do know which call it is.)
                audioActivated.insert(action.callUUID)
                onAnswer?(channelId)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            if let channelId = channelByUUID[action.callUUID] {
                onEnd?(channelId)
                forget(channelId)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            let u = action.callUUID
            // Pass on only a real change to a call we own. This used to forward
            // every action, and the store flipped the mic on each: CallKit's
            // echo of a mute, plus the true/false bursts iOS 17+ sends, became
            // the "auto-mutes multiple times" report. Our own request coming
            // back is skipped outright; reportMuted already wrote its state.
            if ownMuteActions.remove(action.uuid) == nil,
               channelByUUID[u] != nil, (mutedByUUID[u] ?? false) != action.isMuted {
                mutedByUUID[u] = action.isMuted
                onSetMuted?(action.isMuted)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit has activated the audio session — release the engine gate so
        // LiveKit starts capture/playback on the now-active session (honoring
        // the mic/subscribe requests issued by the room connect). This is the
        // documented LiveKit CallKit hook (AudioManager.setEngineAvailability).
        try? AudioManager.shared.setEngineAvailability(.default)
        // Force the output route to match the speaker preference. CallKit can
        // activate the session on the EARPIECE; without this an answered call
        // is near-silent until the user fiddles with routing. Agrees with
        // LiveKit's own session config (isSpeakerOutputPreferred), so they
        // don't fight — this just guarantees it on the CallKit-activated path.
        // Symmetric: when the user has chosen earpiece (preference false), CLEAR
        // any prior .speaker pin (.none) instead of leaving it stuck on the
        // loudspeaker — otherwise an answer/reactivation re-pins speaker over
        // their earpiece choice. .none restores the default route (earpiece, or
        // a connected Bluetooth/AirPlay device).
        if AudioManager.shared.isSpeakerOutputPreferred {
            try? audioSession.overrideOutputAudioPort(.speaker)
        } else {
            try? audioSession.overrideOutputAudioPort(.none)
        }
        // The mic was published while the engine was gated; re-assert it now
        // that the session is live so the peer actually hears us.
        Task { @MainActor in onAudioActivated?() }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        // Safety restore: never leave the global engine gate closed once the
        // CallKit session is gone, or a later guild-voice/next-call session
        // would be silently gated off. .default is the resting state; LiveKit
        // won't start the engine without a pending request.
        //
        // Deliberately NOT LiveKit's README pattern (.none here, reopened in
        // didActivate). That pattern assumes the SDK's automatic AVAudioSession
        // configuration is off; ours is on, so LiveKit itself deactivates and
        // reactivates this session around engine restarts. If any of those
        // reach us here mid-call, closing the gate would stop the engine and
        // nothing would reopen it — a silent call, or a deactivate/activate
        // ping-pong. Mid-call the gate is already .default, so this line is a
        // no-op there.
        try? AudioManager.shared.setEngineAvailability(.default)
    }
}
