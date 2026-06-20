import Foundation
import CallKit
import AVFAudio
import LiveKit

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
    /// System call-screen mute toggled.
    var onSetMuted: ((Bool) -> Void)?
    /// CallKit activated the audio session — the store re-asserts the mic so
    /// capture starts on the now-active session (the room connected with the
    /// LiveKit engine gated for CallKit).
    var onAudioActivated: (() -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private var uuidByChannel: [String: UUID] = [:]
    private var channelByUUID: [UUID: String] = [:]
    /// UUIDs still in the ringing (unanswered) state.
    private var ringing: Set<UUID> = []

    override private init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
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
        if let u = uuidByChannel.removeValue(forKey: channelId) {
            channelByUUID.removeValue(forKey: u)
            ringing.remove(u)
        }
        // Safety: ensure the engine gate isn't left closed if a call ended
        // before CallKit's didActivate/didDeactivate fired (e.g. the caller
        // cancelled as we answered). .default is the resting state.
        try? AudioManager.shared.setEngineAvailability(.default)
    }

    // MARK: Incoming

    /// Ring with the native call screen (banner in-app, full screen when
    /// locked). The in-app ringing overlay still renders as well; both
    /// answer paths converge on `onAnswer`.
    func reportIncoming(channelId: String, callerName: String) {
        let u = uuid(for: channelId)
        guard !ringing.contains(u) else { return }
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

    // MARK: Outgoing

    /// We started ringing someone: report the outgoing call so the system
    /// shows call status and routes audio like a phone call.
    func startOutgoing(channelId: String, calleeName: String) {
        let u = uuid(for: channelId)
        let action = CXStartCallAction(call: u, handle: CXHandle(type: .generic, value: calleeName))
        action.isVideo = false
        controller.request(CXTransaction(action: action)) { _ in }
    }

    /// The callee picked up — flip the system call state to connected.
    func outgoingConnected(channelId: String) {
        guard let u = uuidByChannel[channelId] else { return }
        provider.reportOutgoingCall(with: u, connectedAt: nil)
    }

    /// The call is over (we hung up, the peer left, or it was declined).
    func callEnded(channelId: String, remoteEnded: Bool) {
        guard let u = uuidByChannel[channelId] else { return }
        provider.reportCall(with: u, endedAt: nil, reason: remoteEnded ? .remoteEnded : .declinedElsewhere)
        forget(channelId)
    }
}

extension CallManager: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {}

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
            onSetMuted?(action.isMuted)
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
        try? AudioManager.shared.setEngineAvailability(.default)
    }
}
