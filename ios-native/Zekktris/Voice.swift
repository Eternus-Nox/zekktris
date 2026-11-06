import SwiftUI
import LiveKit
import AudioToolbox
import AVFAudio
import AVFoundation

/// Wraps a single LiveKit `Room` for guild voice channels. The server's
/// `joinVoice` returns a token + wsUrl; we connect, publish the mic, and let
/// LiveKit auto-manage the audio session and remote-audio playback. The
/// participant roster is driven separately by the server's voice states
/// (see `AppStore`), not by LiveKit's participant objects.
///
/// NOTE: requires the LiveKit Swift package
/// (https://github.com/livekit/client-sdk-swift). Guild voice is NOT E2EE
/// (only 1:1 DM calls are, which aren't built yet), so we connect plainly.
@MainActor
final class VoiceManager: ObservableObject {
    enum State: String { case idle, connecting, connected, reconnecting, failed }

    /// True whenever LiveKit owns the shared AVAudioSession (connecting →
    /// connected → reconnecting). Read by VoiceMessage's recorder/player so
    /// they never re-categorize or deactivate the session out from under a
    /// live call (which killed the mic / deactivated the call mid-conversation).
    /// DERIVED from `state` (see its didSet) rather than toggled by hand, so it
    /// can never latch true on a delegate-driven transport failure (which would
    /// silently break voice messages until a manual leave). All touch points
    /// are @MainActor, so the unsafe-static is fine.
    nonisolated(unsafe) static var callAudioActive = false

    @Published private(set) var state: State = .idle {
        didSet {
            Self.callAudioActive =
                state == .connecting || state == .connected || state == .reconnecting
            // CONNECT cue — ONCE per genuine join. `state` reaches .connected
            // from two directions: performConnect's success path and the
            // RoomDelegate connection-state callback, and the delegate re-fires
            // it every time LiveKit recovers from .reconnecting. Without this
            // latch a flapping network would machine-gun the sound. The latch
            // is cleared only when a NEW session starts or the room is torn
            // down (see performConnect / performDisconnect), never in here.
            if state == .connected, !hasAnnouncedConnect {
                hasAnnouncedConnect = true
                VoiceSounds.play(.connect)
            }
        }
    }
    /// Guards the CONNECT cue against reconnect/resume re-entry (see the didSet).
    private var hasAnnouncedConnect = false
    @Published private(set) var isMuted = false
    /// When deafened, all remote audio is muted for the local listener (and the
    /// mic is muted too, mirroring Discord). Restored on undeafen.
    /// Deafened also silences every voice UI cue — deafened means no audio, so
    /// a join/leave blip that ignored it would be a bug. Mirrored into
    /// `VoiceSounds.suppressed` here (a derived flag, like `callAudioActive`)
    /// rather than re-checked at each call site, so no cue can forget.
    @Published private(set) var isDeafened = false {
        didSet { VoiceSounds.suppressed = isDeafened }
    }
    private var wasMutedBeforeDeafen = false
    /// Speaker (loudspeaker) vs receiver (earpiece) output. Defaults ON for
    /// calls — LiveKit otherwise routes a call to the EARPIECE
    /// (.playAndRecordReceiver), so audio comes out the tiny top speaker and
    /// feels like "we can't hear each other." This drives
    /// AudioManager.shared.isSpeakerOutputPreferred (LiveKit reconfigures the
    /// AVAudioSession accordingly). Local-only; not synced to the server.
    /// Seeded from the user's last choice, NOT hard-coded true. Loudspeaker is
    /// only the default for someone who has never picked earpiece.
    @Published private(set) var isSpeakerOn = VoiceManager.storedSpeakerPreference

    /// Persisted so the choice survives the call. `connect()` used to reset this
    /// to `true` on EVERY call, so picking the earpiece never lasted beyond the
    /// current one ("it keeps going back to speakerphone").
    private static let speakerDefaultsKey = "zk.speakerOn"
    private static var storedSpeakerPreference: Bool {
        // Absent key => true (loudspeaker), matching the previous default for a
        // fresh install. `object(forKey:)` distinguishes "unset" from "false".
        UserDefaults.standard.object(forKey: speakerDefaultsKey) as? Bool ?? true
    }

    /// Route call audio to the loudspeaker (on) or the earpiece (off).
    func setSpeaker(_ on: Bool) {
        isSpeakerOn = on
        UserDefaults.standard.set(on, forKey: Self.speakerDefaultsKey)
        AudioManager.shared.isSpeakerOutputPreferred = on
        // LiveKit only swaps the session category/mode (speaker→.videoChat /
        // receiver→.voiceChat) on this preference and NEVER issues a port
        // override — so a previously-applied overrideOutputAudioPort(.speaker)
        // (set by CallKit's didActivate for the default-loud DM call) stays
        // sticky and the route is stuck on the loudspeaker. Apply the override
        // ourselves so the toggle actually moves the route: .speaker forces the
        // loudspeaker; .none clears that pin and restores the default route
        // (earpiece, or a connected Bluetooth/AirPlay device — .none does NOT
        // force the earpiece, it just releases the manual speaker pin).
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    }
    /// Whether the local camera is publishing.
    @Published private(set) var isCameraOn = false
    /// Remote screen-share tracks keyed by user id (kept separate from
    /// camera tracks so one doesn't clobber the other). Native can VIEW a
    /// screen share started elsewhere (e.g. the web client); it can no longer
    /// publish one itself (the in-app ReplayKit capture was removed).
    @Published private(set) var screenTracks: [String: VideoTrack] = [:]
    /// The local camera track (captured on publish) and remote video tracks
    /// keyed by user id, so the arena can render video tiles.
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var remoteVideoTracks: [String: VideoTrack] = [:]
    /// The camera quality the CURRENTLY LIVE publication was actually created
    /// with — not the saved preference, which the user can change at any time.
    /// nil whenever no camera publication exists. toggleCamera compares the two
    /// to decide whether a re-enable can take the cheap unmute path or has to
    /// republish; see the long note there.
    private var publishedCameraQuality: CameraQuality?
    /// Set only for the brief window of a deliberate quality republish, so the
    /// didUnpublishTrack delegate doesn't clear localVideoTrack out from under
    /// the replacement track we are about to publish.
    private var isRepublishingCamera = false
    @Published var lastError: String?
    /// LiveKit identities (== user snowflakes) currently speaking. Drives the
    /// green ring in the voice/stage UI.
    @Published private(set) var speakingUserIds: Set<String> = []
    /// Called with the new speaker set whenever it changes (AppStore counts
    /// our own talking as using the device, for presence).
    var onSpeakingChanged: ((Set<String>) -> Void)?
    /// LiveKit ended a connected session on its own: reconnect attempts
    /// exhausted, or the signalling ping timed out. The store hangs the call
    /// up properly. Never fires for our own disconnect(), because
    /// performDisconnect drops `room` before it calls the SDK. A removal by
    /// our server (a move, the AFK sweep, a kick) only gets here as a late
    /// fallback; see room(_:didDisconnectWithError:). `takenOver` is true when
    /// another session joined with our identity (the call was picked up on
    /// another of our devices): the server's voice state belongs to that
    /// device now, so the store must not tell the server we left. `channelId`
    /// is the tag the dead Room was connected with (nil for stage), so the
    /// store hangs up that channel and not one a newer join has claimed.
    var onConnectionLost: ((_ takenOver: Bool, _ channelId: String?) -> Void)?
    /// The mic's mute changed without the store asking for it: a failed
    /// initial publish forces a mute, a later successful retry lifts it, and a
    /// CallKit mute pressed before the Room existed is applied as the call
    /// connects. The store mirrors it into the server's selfMute (the join
    /// always records us unmuted), so the other side doesn't see a live mic on
    /// someone it can't hear.
    var onMuteChangedInternally: ((Bool) -> Void)?
    /// User ids the local user has muted for themselves only (persisted).
    @Published private(set) var mutedForMe: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "zk.mutedForMe") ?? [])

    /// Push-to-talk: when on, the mic stays muted and only transmits while the
    /// talk button is held. Persisted so the preference survives relaunch.
    @Published var pushToTalkEnabled = UserDefaults.standard.bool(forKey: "zk.pushToTalk")
    /// True while the PTT talk button is physically held (drives the live-mic
    /// visual on the mic control).
    @Published private(set) var pttHeld = false
    /// Guards the PTT mic reconcile loop so rapid press/release can't race two
    /// setMicrophone calls into a stuck-open mic.
    private var pttReconciling = false

    /// F10 — cross-device mute sync. Cached copy of the server's opaque
    /// voice-prefs blob (web-owned: per-user volumes, master volume, audio
    /// processing). We round-trip the WHOLE blob on every write so a mute
    /// never clobbers the web's fields. `voicePrefsHydrated` gates the first
    /// push so we never PATCH from an empty cache (which would wipe the blob).
    private var voicePrefsBlob: [String: Any] = [:]
    private var voicePrefsHydrated = false
    private var voicePrefsPushTask: Task<Void, Never>?

    /// Captured remote audio publications, keyed by user id, so we can
    /// enable/disable them per-user. Cleared on disconnect to release refs.
    private var audioPubs: [String: RemoteTrackPublication] = [:]

    private var room: Room?
    /// The channel `room` was connected for (connect's `tag`). Set together
    /// with `room` in performConnect, so it always describes that Room.
    private var roomTag: String?
    /// True while disconnect() is tearing the room down. Concurrent mic/track
    /// operations bail on this so they can't run against a Room whose WebRTC
    /// transport is being closed. (The call-end EXC_BAD_ACCESS once blamed on
    /// that race was LiveKit's own bug — see `sessionChain`.)
    private var isTearingDown = false
    /// The initial mic publish in performConnect threw, so the user is sitting
    /// connected-but-muted through no choice of their own. ensureMicEnabled
    /// retries the publish once CallKit hands us an activated session (the
    /// usual reason it failed), and any successful unmute clears it.
    private var micPublishFailed = false

    /// Serializes connect/disconnect so the two can NEVER overlap on the same
    /// Room. `isTearingDown` alone was not enough:
    ///   - connect() awaited disconnect(), but disconnect() EARLY-RETURNS when a
    ///     teardown is already in flight — so connect proceeded immediately,
    ///     then reset `isTearingDown = false`, clobbering the running teardown's
    ///     own guard and building a second Room beside the draining one; and
    ///   - `room` is assigned BEFORE `try await r.connect(...)`, so a hangup /
    ///     decline landing mid-connect ran disconnect() on the very Room that
    ///     connect() was still awaiting — concurrent connect + close on one
    ///     transport.
    /// Either way LiveKit reached Room.cleanUpRTC(withError:) -> TransportMode
    /// .close() while a connect was still using the transport. Every enqueued
    /// op runs to completion before the next begins.
    ///
    /// This serialization used to be credited with fixing the call-end crash
    /// (worker_thread, EXC_BAD_ACCESS at 0x28, the CallKit-driven Swift task
    /// blocked in TransportMode.close()). It can't have: that crash is a bug
    /// inside LiveKit's audio device module, livekit/client-sdk-swift#929.
    /// After an earlier audio-engine change fails and rolls back, the module's
    /// FineAudioBuffer is null, and the next PeerConnection close — a plain
    /// hang-up from the CallKit screen is enough, no overlap needed — stops
    /// playout through FineAudioBuffer::ResetPlayout on it; 0x28 is that
    /// method's `str xzr, [x0, #0x28]` on a null `this`. Fixed upstream by
    /// webrtc-sdk/webrtc f47af7b (recreate the buffer before use), first
    /// shipped in client-sdk-swift 2.15.1 — hence the 2.15.3 requirement in
    /// project.yml. The serialization stays: overlapping connect and close on
    /// one Room is still wrong, it just wasn't this crash.
    private var sessionChain: Task<Void, Never>?

    /// Run `op` after any in-flight connect/disconnect finishes.
    private func serialized(_ op: @escaping @MainActor @Sendable () async -> Void) async {
        let previous = sessionChain
        let t = Task { @MainActor in
            _ = await previous?.result
            await op()
        }
        sessionChain = t
        _ = await t.result
    }

    var isConnected: Bool { state == .connected }

    /// `tag` names the voice channel this Room is for; onConnectionLost hands
    /// it back so the store hangs up the right call.
    func connect(url: String, token: String, e2eeKey: Data? = nil, publishMic: Bool = true, tag: String? = nil) async {
        await serialized { [weak self] in
            await self?.performConnect(url: url, token: token, e2eeKey: e2eeKey, publishMic: publishMic, tag: tag)
        }
    }

    /// Room-wide options, shared by the encrypted and plain connect paths so
    /// they can never drift apart.
    ///
    /// `dynacast` is the important bit. The Swift SDK defaults it to FALSE
    /// (RoomOptions' designated init), so without this the phone encodes every
    /// simulcast rung unconditionally — including rungs no viewer in the room
    /// has subscribed to. Our camera is software VP8 (see cameraPublishOptions
    /// for why it can't be hardware H.264), so those unwatched rungs are paid
    /// for in CPU and therefore in heat; thermal throttling then starves the
    /// encoder and smears the picture, which is one half of the "blurry and
    /// never recovers" report. With dynacast on, the SFU tells us which layers
    /// are actually wanted and the rest are paused. The web client has run
    /// dynacast:true all along — this is parity, not a new behaviour.
    ///
    /// `adaptiveStream` is deliberately LEFT at its default (false). That knob
    /// governs what we SUBSCRIBE to (auto-pausing/downgrading remote video
    /// based on the size of the view rendering it), and our tiles are rendered
    /// through a custom arena layout that it cannot measure correctly.
    private static func roomOptions(encryption: EncryptionOptions?) -> RoomOptions {
        RoomOptions(dynacast: true, encryptionOptions: encryption)
    }

    private func performConnect(url: String, token: String, e2eeKey: Data?, publishMic: Bool, tag: String?) async {
        // Already inside the serial chain, so call the raw teardown directly —
        // routing through disconnect() would deadlock waiting on ourselves.
        await performDisconnect()
        // A brand-new session: re-arm the CONNECT cue so this join announces
        // itself (performDisconnect already cleared it; this is explicit so the
        // arming can't be lost if the teardown took an early-return path).
        hasAnnouncedConnect = false
        // Clear the previous attempt's error. The banner now reads this while
        // CONNECTED (to surface a mic that wouldn't open), not only on .failed,
        // so a stale message must not be able to outlive the call that made it.
        lastError = nil
        // state = .connecting drives callAudioActive=true via its didSet, so
        // voice-message playback/recording is blocked from re-categorizing or
        // deactivating the shared session for the call's lifetime.
        state = .connecting
        // Push-to-talk starts muted regardless of publishMic — the mic only
        // opens while the talk button is held.
        // So does a call CallKit holds muted: a mute pressed on the system
        // call screen while the join was still in flight found no Room for
        // setMuted to apply it to, but CallKit kept it, and publishing a live
        // mic under its muted button is exactly the drift its bookkeeping is
        // there to prevent. Read here, with no await between it and `room = r`
        // below, so every later CallKit mute reaches setMuted instead.
        let startMutedByCallKit = publishMic && !pushToTalkEnabled && CallManager.shared.isAnsweredCallMuted
        isMuted = pushToTalkEnabled || !publishMic || startMutedByCallKit
        // Seed the route from the user's SAVED choice — set BEFORE connecting so
        // LiveKit configures the session accordingly when the audio engine
        // starts. (Loudspeaker remains the default for anyone who has never
        // chosen otherwise: without it, calls come out the earpiece and sound
        // silent unless the phone is held to the ear.) This used to hard-code
        // `true`, which silently discarded the earpiece choice on every single
        // call — the user picked earpiece, and the next call was loud again.
        isSpeakerOn = Self.storedSpeakerPreference
        AudioManager.shared.isSpeakerOutputPreferred = isSpeakerOn
        let r: Room
        if let e2eeKey {
            // Encrypted 1:1 call: key LiveKit's media E2EE with the DM key.
            // The Swift SDK's shared-key API takes a *String*, which it
            // UTF-8-encodes and runs through libwebrtc's PBKDF2 (salt
            // "LKFrameEncryptionKey") to derive the media key — LiveKit's
            // documented cross-SDK-compatible path. We pass the base64 of the
            // 32-byte DM key as that string. The web client feeds the IDENTICAL
            // base64 string to `ExternalE2EEKeyProvider.setKey(<string>)` (also
            // PBKDF2), so ALL directions converge on the same media key:
            // native↔native, web↔web, native↔web, web↔native. (Both platforms
            // derive the same DM key from the same password+salt, and the
            // unlock verifier guarantees the keys match before a call starts.)
            let keyProvider = BaseKeyProvider(
                isSharedKey: true,
                sharedKey: e2eeKey.base64EncodedString()
            )
            let encryption = EncryptionOptions(keyProvider: keyProvider, encryptionType: .gcm)
            r = Room(delegate: self, roomOptions: Self.roomOptions(encryption: encryption))
        } else {
            r = Room(delegate: self, roomOptions: Self.roomOptions(encryption: nil))
        }
        room = r
        roomTag = tag
        do {
            try await r.connect(url: url, token: token)
        } catch {
            // Connect itself failed. The SDK's own failure path already ran
            // cleanUp(), which closed the signal socket, so there is nothing of
            // ours left to tear down and dropping the reference is safe here.
            lastError = error.localizedDescription
            state = .failed // didSet clears callAudioActive
            room = nil
            return
        }
        // The room is UP and the SFU has us in its roster. Publishing the mic is
        // a SEPARATE step and must never be able to kill the session.
        //
        // setMicrophone opens the audio device (track.start()) BEFORE it sends
        // AddTrack, so a permission/audio-session failure throws with the call
        // fully connected. This used to share the do/catch above, and the catch
        // set `room = nil` — but VoiceManager.room is the ONLY strong reference
        // (every SDK back-pointer is weak), so the Room deallocated on the spot,
        // closing both PeerConnections WITHOUT ever sending a Leave. The server
        // could then only reap us through its ICE watchdog: four sessions in
        // production sat as silent zombie participants for ~21s each, with the
        // user shown nothing but a red label. Now a mic that won't open leaves
        // you connected-and-muted, with the reason on screen.
        state = .connected
        // In PTT mode the mic stays off at connect — it opens only on hold.
        // `isMuted` is re-read rather than assumed false: a CallKit mute or
        // unmute that landed while connect() was in flight has already set it
        // (setMuted only records the intent while .connecting), and publishing
        // over a mute would put a live mic behind a muted icon.
        if publishMic && !pushToTalkEnabled && !isMuted {
            do {
                try await r.localParticipant.setMicrophone(enabled: true)
            } catch {
                isMuted = true
                micPublishFailed = true
                lastError = "Microphone unavailable — you're connected but muted. (\(error.localizedDescription))"
                // The server's join recorded us unmuted, so without this the
                // other side sees a live mic on someone it can't hear. Not for
                // a token that may not publish at all (voice-disabled channel,
                // no Speak permission, instance mute): that member is a
                // listener, not self-muted, and a selfMute=true here would
                // start the server's AFK sweep, which parks them in the AFK
                // channel after afkTimeoutSeconds.
                if (error as? LiveKitError)?.type != .insufficientPermissions {
                    onMuteChangedInternally?(true)
                }
            }
        } else if startMutedByCallKit && isMuted {
            // Started muted for CallKit and still muted. That mute never went
            // through the store (setMuted refused it, there was no Room), so
            // the server still has the join's unmuted state.
            onMuteChangedInternally?(true)
        }
    }

    /// SET (never toggle) the user's mic mute. Idempotent: asking for the state
    /// we're already in does nothing, which is what lets CallKit's repeated and
    /// echoed CXSetMutedCallActions land harmlessly. The intent is written
    /// BEFORE the await, so a second caller arriving while LiveKit is still
    /// applying the first (its publish queue + the signal round trip) compares
    /// against where we're going, not where we were. The old toggle read the
    /// stale value there and flipped the mic straight back.
    /// Unmuting is refused while deafened (undeafen restores the mic) and in
    /// push-to-talk (the talk button owns the mic), unless `overridePushToTalk`
    /// says an explicit in-app tap asked for it (see toggleMute). Returns
    /// whether the mute state actually changed. Without a Room (the join is
    /// still in flight) there is nothing to set and it returns false; CallKit
    /// mutes from that window are picked up by performConnect instead.
    @discardableResult
    func setMuted(_ muted: Bool, overridePushToTalk: Bool = false) async -> Bool {
        guard let room, !isTearingDown, isMuted != muted else { return false }
        if !muted {
            if isDeafened { return false }
            // The override can't open the mic before the call is up:
            // performConnect never publishes in push-to-talk, so that unmute
            // would only ever reach the icon.
            if pushToTalkEnabled && (!overridePushToTalk || state == .connecting) { return false }
        }
        isMuted = muted
        // Still connecting: there is no publication to change yet, and an
        // unmute would race performConnect's own publish or throw before the
        // publisher exists (a stale error the connected banner would then
        // show). The intent is all it takes: performConnect reads `isMuted`
        // when it decides whether to publish.
        if state == .connecting { return true }
        do {
            try await room.localParticipant.setMicrophone(enabled: !muted)
        } catch {
            // A teardown resets all of this itself; don't write over it.
            guard !isTearingDown, room === self.room else { return false }
            // Roll back to what LiveKit actually has rather than to `!muted`:
            // another setMuted may have queued behind this one meanwhile, and
            // the publication is the only thing that knows which of us won.
            isMuted = !room.localParticipant.isMicrophoneEnabled()
            lastError = error.localizedDescription
            return false
        }
        // An unmute that went through means the mic works after all.
        if !muted && micPublishFailed {
            micPublishFailed = false
            lastError = nil
        }
        return true
    }

    /// The in-app mic button: an explicit tap, so unlike CallKit's set it
    /// doesn't get refused.
    ///   - Unmuting while deafened also undeafens (web and Discord do the
    ///     same; you can't be audible while you can't hear). Refusing it left
    ///     a mic button that silently did nothing.
    ///   - In push-to-talk it opens the mic, as it always did: every other
    ///     surface swaps this for a hold-to-talk button (MicControlButton),
    ///     but the stage speaker control is a plain toggle and is the only way
    ///     a push-to-talk speaker can talk while the stage screen is open.
    func toggleMute() async {
        if isMuted && isDeafened {
            await toggleDeafen()
            // Undeafening reopens the mic itself when it was live before the
            // deafen; only a mute from before the deafen is left to lift.
            guard isMuted, !isDeafened else { return }
        }
        await setMuted(!isMuted, overridePushToTalk: true)
    }

    /// Make sure the mic is live once CallKit activates the audio session.
    /// On the CallKit answer path the room connects (and publishes the mic)
    /// while the LiveKit engine is gated OFF. Lifting the gate in didActivate
    /// is what starts capture: LiveKit honours the pending mic request itself
    /// once availability allows (AudioManager.setEngineAvailability). So this
    /// only fills real gaps:
    ///   - the user is NOT muted but the mic publication is missing or muted;
    ///   - the initial publish failed (micPublishFailed). It is retried here,
    ///     since an unusable audio session is the usual reason it failed and
    ///     CallKit has just handed us a usable one.
    /// It must NEVER cycle the mic off→on to "kick" capture, as it used to.
    /// Each cycle signalled mute+unmute to the SFU, left a gap in our audio,
    /// flipped the system voice-processing mute (the iOS mute chime), and on
    /// iOS 17+ came back from CallKit as CXSetMutedCallActions, which the old
    /// toggling handler turned into the repeated "auto-mute". didActivate fires
    /// again after every reactivation, so the cycle repeated within one call.
    /// The session can activate before connect() returns, so wait briefly for
    /// the room first.
    func ensureMicEnabled() async {
        var waited = 0
        while !isConnected && waited < 30 {
            try? await Task.sleep(nanoseconds: 100_000_000) // 0.1s, up to ~3s
            waited += 1
        }
        // Push-to-talk owns the mic through its reconcile loop, and deafen
        // keeps it shut; neither is ours to open.
        guard let room, isConnected, !isTearingDown, !pushToTalkEnabled, !isDeafened else { return }
        if !micPublishFailed {
            // The user's own mute stands, and a live publication needs nothing
            // (isMicrophoneEnabled is false while it is missing OR muted). If
            // the initial publish is still in flight, the call below queues
            // behind it in LiveKit's publish runner and lands as a no-op unmute.
            guard !isMuted, !room.localParticipant.isMicrophoneEnabled() else { return }
        } else if CallManager.shared.isAnsweredCallMuted {
            // Muted from CallKit/AirPods while force-muted: that mute is the user's
            // now. CallKit's unmute (setMuted(false)) retries the publish instead.
            return
        }
        do {
            try await room.localParticipant.setMicrophone(enabled: true)
        } catch {
            return // still unavailable: the forced mute and its message stand
        }
        // Lift the forced mute if the publish recovered: either the retry above,
        // or this call itself doing the publish after queueing behind an initial
        // publish that then failed. Re-checked after the await: a hangup, a
        // deafen, PTT, or the user's own successful unmute (which clears the
        // flag) may have landed meanwhile, and each of those owns the mic.
        guard micPublishFailed, !isTearingDown, room === self.room,
              !pushToTalkEnabled, !isDeafened else { return }
        micPublishFailed = false
        lastError = nil
        if CallManager.shared.isAnsweredCallMuted {
            // A CallKit mute landed during the retry and found us already muted,
            // so nothing queued a mute behind it: close the mic here.
            _ = try? await room.localParticipant.setMicrophone(enabled: false)
            return
        }
        isMuted = false
        onMuteChangedInternally?(false)
    }

    // ── Push-to-talk ──────────────────────────────────────────────────────
    //
    // When PTT mode is on, the mic is muted by default and opens only while
    // the talk button is held. Press/release just set `pttHeld`; the mic is
    // driven by a single reconcile loop so a rapid press→release can't land
    // its enable AFTER its disable and leave the mic stuck open.

    /// Flip the PTT preference and reconcile the in-call mic. Entering PTT
    /// mutes immediately; leaving it returns to a live (VAD) mic unless deaf.
    func setPushToTalk(_ on: Bool) {
        pushToTalkEnabled = on
        UserDefaults.standard.set(on, forKey: "zk.pushToTalk")
        pttHeld = false
        Task {
            guard isConnected, !isTearingDown, let room = self.room else { return }
            if on {
                _ = try? await room.localParticipant.setMicrophone(enabled: false)
                if !isTearingDown { isMuted = true }
            } else if !isDeafened {
                _ = try? await room.localParticipant.setMicrophone(enabled: true)
                if !isTearingDown { isMuted = false }
            }
        }
    }

    /// Called by the talk button on press (held=true) and release (held=false).
    func pttSetHeld(_ held: Bool) async {
        guard pushToTalkEnabled else { return }
        pttHeld = held
        await reconcilePttMic()
    }

    /// Drive the mic toward the desired PTT state, re-reading `pttHeld` after
    /// every await so coalesced rapid taps converge on the final state. A
    /// single in-flight loop owns the mic; concurrent callers just update
    /// `pttHeld` and return — the running loop picks up the new value.
    private func reconcilePttMic() async {
        if pttReconciling { return }
        pttReconciling = true
        defer { pttReconciling = false }
        var lastApplied: Bool? = nil
        while true {
            let desired = pushToTalkEnabled && pttHeld && !isDeafened && isConnected && !isTearingDown
            if lastApplied == desired { break }
            guard let room = self.room, !isTearingDown else { break }
            _ = try? await room.localParticipant.setMicrophone(enabled: desired)
            if isTearingDown { break }
            isMuted = !desired
            lastApplied = desired
            // Loop: if pttHeld flipped during the await, re-apply.
        }
    }

    /// Toggle deafen: mute/unmute every remote participant's audio for the local
    /// listener, and mute the mic while deafened (restoring it on undeafen).
    /// Per-user "muted for me" choices are preserved when undeafening.
    func toggleDeafen() async {
        guard let room, !isTearingDown else { return }
        let next = !isDeafened
        if next {
            wasMutedBeforeDeafen = isMuted
            // Snapshot before the awaits: a concurrent disconnect() clears
            // audioPubs (mid-iteration mutation is undefined / can skip entries).
            for pub in Array(audioPubs.values) { try? await pub.set(enabled: false) }
            _ = try? await room.localParticipant.setMicrophone(enabled: false)
            isMuted = true
        } else {
            for (uid, pub) in Array(audioPubs) { try? await pub.set(enabled: !mutedForMe.contains(uid)) }
            if !wasMutedBeforeDeafen {
                _ = try? await room.localParticipant.setMicrophone(enabled: true)
                isMuted = false
            }
        }
        isDeafened = next
    }

    /// Switch the publishing camera between front and back.
    func flipCamera() async {
        guard isCameraOn,
              let track = localVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        do {
            try await capturer.switchCameraPosition()
            // A flip swaps the AVCaptureDevice — re-apply the focus tuning to
            // the NEW device or the back camera runs whatever mode it was in.
            applyCameraFocusTuning()
        } catch { lastError = error.localizedDescription }
    }

    /// Put the capture hardware into its video-appropriate auto modes.
    ///
    /// WebRTC's camera capturer configures format/fps but never touches focus,
    /// so the lens runs whatever mode the device was left in. Two things matter:
    ///  - `isSmoothAutoFocusEnabled` is Apple's video autofocus (gradual,
    ///    invisible refocus instead of the stills-style hunting "pulse") and it
    ///    DEFAULTS OFF — this is the user-visible win;
    ///  - explicitly asserting continuous focus/exposure/white-balance guards
    ///    against a stale LOCKED mode surviving a previous session or format
    ///    change. A locked lens is permanent optical blur that no encoder
    ///    setting can fix — the class of blur the bitrate work can't touch.
    /// Android needs no twin: libwebrtc's Camera2Session.chooseFocusMode already
    /// selects continuous-video AF (verified in the shipped AAR's bytecode).
    ///
    /// Runs on the main actor DELIBERATELY: lockForConfiguration + property
    /// writes are fast, and hopping actors would capture the non-Sendable
    /// AVCaptureDevice — the diagnostic class that compiles as a warning in
    /// simulator builds but errors in the user's Xcode.
    private func applyCameraFocusTuning(retry: Bool = true) {
        guard isCameraOn,
              let track = localVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        guard let device = capturer.device else {
            // The capture session can still be spinning up in the beat after
            // publish, before the SDK exposes the device. One short retry —
            // no polling.
            if retry {
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    self?.applyCameraFocusTuning(retry: false)
                }
            }
            return
        }
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            if device.isSmoothAutoFocusSupported { device.isSmoothAutoFocusEnabled = true }
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                device.whiteBalanceMode = .continuousAutoWhiteBalance
            }
        } catch {
            // Fixed-focus front cameras (older iPhones) and config races land
            // here — non-fatal, the device keeps its current behaviour.
        }
    }

    /// Live camera-quality entitlement check, wired by AppStore.start() to
    /// the admin-configured monetization matrix (server config, or built-in
    /// defaults: 1080p free, 2K Guardian, 4K Legend) against the signed-in
    /// user's membership. Drives the premium camera-quality clamp below;
    /// nil (signed out / not wired yet) fails closed to the default free
    /// ceiling (1080p).
    var cameraQualityAllowed: ((CameraQuality) -> Bool)?

    /// Clamp to the HIGHEST quality the membership entitles, per the
    /// admin-configured matrix. Applied at PUBLISH time so a lapsed
    /// membership (or a hand-edited default) publishes at the entitled
    /// ceiling; the saved preference is untouched and simply re-activates if
    /// the tier comes back. Walks down the ladder (4K → 2K → 1080p) to the
    /// first allowed rung — e.g. a Guardian with 4K saved gets 2K (their
    /// ceiling) under the default matrix, not a hard drop to 1080p. If even
    /// 1080p is gated above the user's tier, clamps to 720p — 720p and
    /// below are always free.
    private func entitledCameraQuality(_ q: CameraQuality) -> CameraQuality {
        let ladder: [CameraQuality] = [.k4, .k2, .high]
        guard let start = ladder.firstIndex(of: q) else { return q } // ≤720p: free
        let allowed = cameraQualityAllowed ?? { $0 == .high } // unwired: defaults, no tier
        for rung in ladder[start...] where allowed(rung) { return rung }
        return .medium
    }

    /// The user's saved camera quality (Settings → Preferences), clamped to
    /// the membership entitlement. Defaults to high (1080p). Read at publish
    /// time, so a change applies on the next camera-on (matches web).
    private var savedCameraQuality: CameraQuality {
        entitledCameraQuality(
            CameraQuality(rawValue: UserDefaults.standard.string(forKey: "zk.cameraQuality") ?? "high") ?? .high
        )
    }

    /// Capture dimensions + fps for the chosen quality.
    private func cameraCaptureOptions(_ q: CameraQuality) -> CameraCaptureOptions {
        let dims: Dimensions
        let fps: Int
        switch q {
        case .low: dims = Dimensions(width: 640, height: 480); fps = 15
        case .medium, .auto: dims = .h720_169; fps = 30
        case .high: dims = .h1080_169; fps = 30
        case .k2: dims = .h1440_169; fps = 30   // 2560x1440
        case .k4: dims = .h2160_169; fps = 30   // 3840x2160
        }
        return CameraCaptureOptions(position: .front, dimensions: dims, fps: fps)
    }

    /// Publish the camera as VP8. We briefly used hardware H.264 (VideoToolbox)
    /// for sharper video, but an iOS-published H.264 stream did NOT render for
    /// WEB viewers in a guild voice channel — a well-known native→browser H.264
    /// interop problem (profile / simulcast). Browsers claim generic H.264
    /// support, so a VP8 *backup* codec wouldn't route to them either. VP8 is
    /// the universally-decodable WebRTC codec (it's what worked before the H.264
    /// change), so the camera shows everywhere — iOS↔iOS and iOS→web. Trade-off:
    /// VP8 is software-encoded and can soften under heavy CPU/thermal load; a
    /// visible camera beats a sharper invisible one. Simulcast stays on so the
    /// SFU can hand weaker viewers a lower layer; bitrate scales with quality.
    private func cameraPublishOptions(_ q: CameraQuality) -> VideoPublishOptions {
        let bitrate: Int
        switch q {
        case .low: bitrate = 600_000
        case .medium: bitrate = 2_000_000
        case .auto: bitrate = 2_500_000
        case .high: bitrate = 3_000_000
        // VP8 is software-encoded, so 4K is best-effort: under thermal load the
        // encoder degrades fps rather than failing, and SFU simulcast still
        // hands weak viewers a lower layer.
        case .k2: bitrate = 6_000_000
        case .k4: bitrate = 10_000_000
        }
        // degradationPreference MUST be explicit. Leaving it at its `.auto`
        // default maps to nil (DegradationPreference.toRTCType), and the SDK
        // then substitutes `.maintainResolution` (LocalParticipant.swift:672) —
        // an SDK-chosen fallback, not a WebRTC default and not our decision.
        //
        // maintain-resolution forbids the encoder from shedding pixels. With a
        // SOFTWARE VP8 encoder pushing 1080p30 (the default tier) on a phone
        // that throttles, it therefore holds 1920x1080 and dumps the shortfall
        // into the quantizer: a full-size, permanently smeared picture. And
        // because the resolution axis is switched off in BOTH directions, there
        // is no scale-back-up when the thermal/uplink pressure clears — which
        // is exactly the "blurry and never auto-corrects" report.
        //
        // .balanced restores the two-way adaptation loop. This does NOT touch
        // codec negotiation, so the documented H.264-invisible-to-web interop
        // regression above is not reintroduced — the two are orthogonal.
        return VideoPublishOptions(
            encoding: VideoEncoding(maxBitrate: bitrate, maxFps: q == .low ? 15 : 30),
            simulcast: true,
            simulcastLayers: cameraSimulcastLayers(q),
            preferredCodec: .vp8,
            degradationPreference: .balanced)
    }

    /// The two LOWER simulcast rungs to publish beneath the full-resolution
    /// one, per quality tier.
    ///
    /// Why this has to be spelled out: when `simulcastLayers` is empty the SDK
    /// falls back to `defaultSimulcastLayers`, which is the FIXED pair
    /// [180p@160k, 360p@450k] — those constants do not scale with what we are
    /// actually capturing. Utils.computeVideoEncodings then builds
    /// [low, mid, capture], so on the default 1080p tier the published ladder
    /// is 320x180 / 640x360 / 1920x1080 with NOTHING in between. A viewer whose
    /// link settles anywhere from roughly 0.5 to 3 Mbps cannot hold the top
    /// rung and drops to 640x360 — which the web client then upscales AND
    /// crops to fill a large object-cover tile. That is the reported blur, and
    /// it is a publisher-side gap, so no amount of viewer-side adaptation can
    /// fix it. 2K and 4K are worse still: the same 360p floor under a far
    /// bigger top rung.
    ///
    /// So each tier gets rungs proportional to ITS capture size, keeping the
    /// step between neighbours near 1.5–2x. Only the first two entries are
    /// read (Utils takes presets[0] and presets[1]); they are the SDK's own
    /// VideoParameters presets so the bitrates stay the SDK's tuned values.
    private func cameraSimulcastLayers(_ q: CameraQuality) -> [VideoParameters] {
        switch q {
        // 640x480 capture: max dimension is 640, which is < 960, so
        // computeVideoEncodings takes the two-rung branch and DISCARDS the mid
        // preset entirely. Supplying a ladder here would change nothing except
        // the floor, and the SDK's 4:3 default floor already matches this
        // 4:3-captured tier. Leave it to the defaults.
        case .low: return []
        // 1280x720 -> 320x180, 640x360, 1280x720. Same as the SDK default, but
        // pinned explicitly so a future SDK default change can't move it.
        case .medium, .auto: return [.presetH180_169, .presetH360_169]
        // 1920x1080 -> 640x360, 1280x720, 1920x1080.
        case .high: return [.presetH360_169, .presetH720_169]
        // 2560x1440 -> 960x540, 1920x1080, 2560x1440.
        case .k2: return [.presetH540_169, .presetH1080_169]
        // 3840x2160 -> 1280x720, 1920x1080, 3840x2160.
        case .k4: return [.presetH720_169, .presetH1080_169]
        }
    }

    /// Publish/unpublish the local camera (front camera, VP8 at the user's
    /// chosen quality).
    func toggleCamera() async {
        let next = !isCameraOn
        do {
            let q = savedCameraQuality
            // A quality change only reaches the wire on a FRESH publish.
            //
            // LocalParticipant.set(source:enabled:) short-circuits when a
            // publication already exists and we are enabling: it calls
            // publication.unmute() and returns, without ever LOOKING at the
            // captureOptions/publishOptions we passed. And camera-off only
            // MUTES (cameras and mics are special-cased there; everything else
            // gets unpublished). So the publication survives the whole call and
            // every re-enable silently reuses the dimensions, bitrate, codec
            // and simulcast ladder chosen on the FIRST camera-on. Changing the
            // quality in Settings mid-call therefore did nothing at all — while
            // the UI promised "Changes apply the next time you turn your camera
            // on".
            //
            // So when the live publication was built with a different quality,
            // tear it down first and let setCamera take its create-and-publish
            // branch. Unchanged quality keeps the cheap unmute path — this must
            // not turn the ordinary camera toggle into a renegotiation.
            //
            // A nil publishedCameraQuality counts as "different": either there
            // is no publication (the `existing` lookup then finds nothing and
            // this whole block is skipped) or a previous attempt failed partway
            // and we can no longer vouch for the live settings.
            if next, publishedCameraQuality != q, let lp = room?.localParticipant,
               let existing = lp.localVideoTracks.first(where: { $0.source != .screenShareVideo })
            {
                // The delegate's didUnpublishTrack would otherwise land during
                // the setCamera below and nil out the NEW track.
                isRepublishingCamera = true
                try await lp.unpublish(publication: existing)
                publishedCameraQuality = nil
                localVideoTrack = nil
            }
            // setCamera returns the publication on BOTH paths. The first
            // enable PUBLISHES a track (didPublishTrack fires, caching
            // localVideoTrack); but disable only MUTES the publication (it
            // is not unpublished), so a SECOND enable merely UNMUTES — no
            // didPublishTrack, so we must read the track back here. Without
            // this, localVideoTrack stayed nil after a re-enable: the local
            // tile never reappeared even though the camera was live and
            // publishing to peers (an invisible-but-broadcasting hazard).
            // The republish above lands on the publish path, so this read-back
            // covers it too.
            //
            // cameraPublishOptions still pins preferredCodec: .vp8, which is
            // load-bearing here: a fresh publish re-runs codec negotiation, and
            // that is exactly where the iOS-H.264-invisible-to-web regression
            // documented above lived.
            let pub = try await room?.localParticipant.setCamera(
                enabled: next,
                captureOptions: cameraCaptureOptions(q),
                publishOptions: cameraPublishOptions(q))
            isCameraOn = next
            if next {
                if let vt = pub?.track as? VideoTrack { localVideoTrack = vt }
                // Record what the live publication was actually built with, so
                // the next toggle can tell "same quality, just unmute" from
                // "user changed it, must republish".
                if pub != nil { publishedCameraQuality = q }
                // Covers fresh publish, unmute, AND the quality-change
                // republish — all of them land here on success.
                applyCameraFocusTuning()
            } else {
                localVideoTrack = nil
                // NOT cleared: camera-off leaves the publication in place
                // (muted), still carrying these encoder settings.
            }
            isRepublishingCamera = false
        } catch {
            isRepublishingCamera = false
            // The unpublish may already have succeeded before a later step
            // threw, so don't leave a stale quality claiming a publication that
            // no longer matches; the next toggle then republishes rather than
            // unmuting something that isn't there.
            if next { publishedCameraQuality = nil }
            lastError = error.localizedDescription
        }
    }

    /// The video track to render for a participant, if any.
    func videoTrack(for userId: String, isSelf: Bool) -> VideoTrack? {
        isSelf ? localVideoTrack : remoteVideoTracks[userId]
    }

    /// Mute (disable) or unmute a single remote user's audio for the local
    /// listener only. Uses set(enabled:) which keeps the subscription active
    /// so it can be toggled back on. The native stand-in for per-user volume
    /// (LiveKit Swift has no remote-volume API).
    func setMutedForMe(_ userId: String, _ muted: Bool) async {
        if muted { mutedForMe.insert(userId) } else { mutedForMe.remove(userId) }
        UserDefaults.standard.set(Array(mutedForMe), forKey: "zk.mutedForMe")
        if let pub = audioPubs[userId] {
            try? await pub.set(enabled: !muted)
        }
        // F10: sync the change to other devices (debounced).
        scheduleVoicePrefsPush()
    }

    /// F10 — fetch the shared voice-prefs blob at login and seed the per-user
    /// mute set from it. The server is authoritative for the cross-device set,
    /// so this REPLACES the local set (mutes AND unmutes propagate). Applies
    /// the result to any live remote audio (a no-op outside a call).
    func loadVoicePrefs() async {
        guard let blob = try? await APIClient.shared.getVoicePrefs() else { return }
        voicePrefsBlob = blob
        voicePrefsHydrated = true
        let perUser = (blob["perUser"] as? [String: Any]) ?? [:]
        var serverMuted = Set<String>()
        for (uid, v) in perUser {
            if let e = v as? [String: Any], (e["muted"] as? Bool) == true { serverMuted.insert(uid) }
        }
        // Migration: this device's pre-sync mutes lived only in UserDefaults.
        // On the FIRST hydrate, union them with the server set and push the
        // merge up so we don't silently drop them (the server has never seen
        // them). After that the server is authoritative, so a remote unmute
        // can actually remove an entry here.
        if UserDefaults.standard.bool(forKey: "zk.voicePrefsMigrated") {
            mutedForMe = serverMuted
        } else {
            let merged = serverMuted.union(mutedForMe)
            mutedForMe = merged
            UserDefaults.standard.set(true, forKey: "zk.voicePrefsMigrated")
            if merged != serverMuted { scheduleVoicePrefsPush() }
        }
        UserDefaults.standard.set(Array(mutedForMe), forKey: "zk.mutedForMe")
        if !isDeafened, !isTearingDown {
            for (uid, pub) in Array(audioPubs) { try? await pub.set(enabled: !mutedForMe.contains(uid)) }
        }
    }

    /// Debounced PATCH of the mute set into the shared blob (500ms, matching
    /// web). Coalesces rapid toggles into one request.
    private func scheduleVoicePrefsPush() {
        voicePrefsPushTask?.cancel()
        voicePrefsPushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.pushVoicePrefs()
        }
    }

    private func pushVoicePrefs() async {
        // Never PATCH from an empty cache — that would wipe web-owned fields.
        // Pull the current blob first if we haven't hydrated this session.
        if !voicePrefsHydrated {
            if let blob = try? await APIClient.shared.getVoicePrefs() {
                voicePrefsBlob = blob
                voicePrefsHydrated = true
            }
        }
        var blob = voicePrefsBlob
        var perUser = (blob["perUser"] as? [String: Any]) ?? [:]
        // Re-stamp `muted` on every existing entry (preserving its volume and
        // any other web fields), then add bare entries for muted users not yet
        // present. We never delete entries — that would drop web-set volumes.
        for (uid, v) in perUser {
            if var e = v as? [String: Any] {
                e["muted"] = mutedForMe.contains(uid)
                perUser[uid] = e
            }
        }
        for uid in mutedForMe where perUser[uid] == nil {
            perUser[uid] = ["muted": true]
        }
        blob["perUser"] = perUser
        voicePrefsBlob = blob
        try? await APIClient.shared.setVoicePrefs(blob)
    }

    /// Rebuild the remote track maps from the room's source of truth.
    private func syncRemoteTracks() {
        guard let room else { return }
        var video: [String: VideoTrack] = [:]
        var screens: [String: VideoTrack] = [:]
        var audio: [String: RemoteTrackPublication] = [:]
        for (_, participant) in room.remoteParticipants {
            guard let identity = participant.identity else { continue }
            let uid = "\(identity)"
            guard !uid.isEmpty else { continue }
            for pub in participant.trackPublications.values {
                guard let remotePub = pub as? RemoteTrackPublication else { continue }
                if let vt = remotePub.track as? VideoTrack {
                    // Skip a MUTED video publication (remote turned their camera
                    // off without unpublishing — LiveKit's default). Otherwise
                    // their last frame stays on screen as a frozen tile.
                    guard !remotePub.isMuted else { continue }
                    if remotePub.source == .screenShareVideo { screens[uid] = vt }
                    else { video[uid] = vt }
                } else if remotePub.track is AudioTrack {
                    audio[uid] = remotePub
                }
            }
        }
        // Skip no-op publishes: this runs on EVERY speaking-participants
        // update (several times a second mid-conversation), and each
        // @Published reassignment re-renders every observer of the track
        // maps even when nothing changed. Tracks are reference types, so
        // identity comparison is exact.
        func sameTracks(_ a: [String: VideoTrack], _ b: [String: VideoTrack]) -> Bool {
            a.count == b.count && a.allSatisfy { b[$0.key] === $0.value }
        }
        func sameAudio(_ a: [String: RemoteTrackPublication], _ b: [String: RemoteTrackPublication]) -> Bool {
            a.count == b.count && a.allSatisfy { b[$0.key] === $0.value }
        }
        if !sameTracks(remoteVideoTracks, video) { remoteVideoTracks = video }
        if !sameTracks(screenTracks, screens) { screenTracks = screens }
        // Preserve deafen/mute-for-me on newly discovered audio pubs.
        for (uid, pub) in audio where audioPubs[uid] == nil {
            audioPubs[uid] = pub
            if isDeafened || mutedForMe.contains(uid) {
                Task { try? await pub.set(enabled: false) }
            }
        }
        // Same skip-no-op guard as the track maps above: prune stale pubs but
        // only reassign when the set actually changed (pubs are reference
        // types, so === identity is exact). Newly discovered pubs are added in
        // the loop above, so this only ever removes — but reassigning an
        // unchanged dict still re-renders every audioPubs observer.
        let prunedAudio = audioPubs.filter { audio[$0.key] != nil }
        if !sameAudio(audioPubs, prunedAudio) { audioPubs = prunedAudio }
    }

    func disconnect() async {
        await serialized { [weak self] in await self?.performDisconnect() }
    }

    private func performDisconnect() async {
        // Single-shot, and clear the room ref + reset published state
        // SYNCHRONOUSLY before awaiting the SDK disconnect. Niling `room` first
        // closes the re-entrancy window: any concurrent disconnect()/toggleMute/
        // toggleDeafen/ensureMicEnabled now sees room==nil / isTearingDown and
        // no-ops instead of issuing Room ops against a transport that another
        // teardown is freeing (the LiveKit audio-worker UAF crash on call-end).
        guard let r = room, !isTearingDown else {
            room = nil
            // Defensive: this early-return path doesn't transition `state`, so
            // sync the derived flag directly in case state was left non-idle.
            Self.callAudioActive = false
            hasAnnouncedConnect = false
            // No Room, so no engine to disturb: settle the mic mute mode for
            // whatever comes next. This is the only restore a CallKit call gets
            // when it never had a Room (its join or connect failed), and every
            // connect passes through here first, so a leftover .inputMixer
            // can't carry into guild voice.
            if !isTearingDown { syncMicrophoneMuteMode() }
            return
        }
        isTearingDown = true
        room = nil
        // state = .idle releases the shared session (didSet clears
        // callAudioActive) so voice messages may use it again.
        state = .idle
        // The room is gone: the NEXT .connected is a genuine new join, not a
        // reconnect, so re-arm the CONNECT cue.
        hasAnnouncedConnect = false
        isMuted = false
        micPublishFailed = false
        isDeafened = false
        isCameraOn = false
        localVideoTrack = nil
        // The publication dies with the room, so the next call must publish
        // fresh rather than believing a stale quality still describes it.
        publishedCameraQuality = nil
        isRepublishingCamera = false
        remoteVideoTracks.removeAll()
        screenTracks.removeAll()
        speakingUserIds = []
        audioPubs.removeAll()
        await r.disconnect()
        // Restore the engine's resting state HERE — after the room is fully
        // gone. This is now the authoritative restore; CallManager.forget()
        // used to do it synchronously inside the CXEndCallAction handler, i.e.
        // BEFORE this teardown had even started, which re-enabled the LiveKit
        // audio engine against a Room that was about to be destroyed. A device
        // crash caught that mid-act: the main thread sat in
        // [AVAudioSession currentRoute] under a LiveKit route-change observer
        // while this teardown ran, and the WebRTC worker null-dereffed. (That
        // null dereference itself turned out to be LiveKit's #929, see
        // `sessionChain`; reopening the gate only once the Room is gone is
        // still the right order.)
        //
        // LiveKit's default mic mute mode comes back first, while the engine is
        // stopped: CallManager switches it to .inputMixer for the length of a
        // CallKit call (see its answer handler).
        //
        // Neither is reset while a CallKit call is answered and still live
        // (CallManager.hasAnsweredCall): the mode stays .inputMixer and the
        // gate is left to CallKit. Then this Room was not that call's:
        // typically guild voice being torn down because the user answered a
        // DM call from the lock screen, inside the call's own performConnect.
        // The answer handler had just closed the gate until CallKit's
        // didActivate and put the mic on .inputMixer; reopening the gate here
        // let LiveKit race CallKit's session activation, and restoring
        // .voiceProcessing put the call back on the system mute iOS couples to
        // CallKit's. The call's own teardown runs after CallManager has
        // forgotten it, so it still restores both.
        syncMicrophoneMuteMode()
        if !CallManager.shared.hasAnsweredCall {
            try? AudioManager.shared.setEngineAvailability(.default)
        }
        isTearingDown = false
    }

    /// LiveKit's mic mute mode for the call we're in or about to start:
    /// .inputMixer while CallKit owns an answered call (see CallManager's
    /// answer handler for why), LiveKit's default .voiceProcessing otherwise —
    /// guild voice, and 1:1 calls that never went through CallKit. Only call
    /// it with no Room running, so a change is bookkeeping in LiveKit's audio
    /// device rather than a reconfiguration of a live engine; and only
    /// written when it differs.
    private func syncMicrophoneMuteMode() {
        let mode: MicrophoneMuteMode = CallManager.shared.hasAnsweredCall ? .inputMixer : .voiceProcessing
        guard AudioManager.shared.microphoneMuteMode != mode else { return }
        try? AudioManager.shared.set(microphoneMuteMode: mode)
    }
}

extension VoiceManager: RoomDelegate {
    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            // Ignore late callbacks from a room we've already replaced
            // (rapid reconnect) — they'd clobber the live connection's state.
            guard room === self.room else { return }
            switch connectionState {
            case .connected: self.state = .connected; self.syncRemoteTracks()
            case .connecting: self.state = .connecting
            case .reconnecting: self.state = .reconnecting
            case .disconnected:
                // A room we still hold only reaches .disconnected when LiveKit
                // gave up on it (our own disconnect() drops `room` first), so
                // this is a failure, never .idle: the call screen renders .idle
                // as "Joining…", which is how a dead call used to sit there.
                if self.state != .failed {
                    self.lastError = self.lastError ?? "Connection lost"
                    self.state = .failed
                }
            case .disconnecting: break
            @unknown default: break
            }
        }
    }

    nonisolated func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        Task { @MainActor in
            guard room === self.room else { return }
            self.lastError = error?.localizedDescription ?? "Connection failed"
            self.state = .failed
        }
    }

    /// LiveKit ended a session that HAD connected: reconnect attempts ran out,
    /// the server removed us or deleted the room, or the signalling ping timed
    /// out. For a lost connection nothing else will end the call — the gateway
    /// socket is still up, so the server keeps our voice state, CallKit keeps
    /// its call, and the peer's 1:1 auto-end never fires — so hand it to the
    /// store to hang up.
    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        let errorType = error?.type
        let reason = error?.localizedDescription
        Task { @MainActor in
            // Our own disconnect() never passes this: performDisconnect sets
            // isTearingDown and drops `room` before it calls the SDK.
            guard room === self.room, !self.isTearingDown else { return }
            switch errorType {
            case .participantRemoved?, .roomDeleted?:
                // OUR server removed us, and its gateway says why. A moderator
                // move and the AFK sweep repoint our voice state at the new
                // channel, then remove us from the old LiveKit room, then
                // broadcast — so this arrives first. Hanging up here sent the
                // leave, which the server applies per user: it deleted the
                // voice state that already pointed at the new channel, and with
                // voiceChannelId cleared, handleVoiceSelfMove had nothing left
                // to rejoin from. Leave it to the VOICE_STATE_UPDATE: a move
                // rejoins the new channel, and a kick, decline or channel
                // delete comes as channelId nil and hangs up (READY
                // reconciliation covers a missed one). Hang up ourselves only
                // if, well after any broadcast, nothing has replaced or torn
                // down this dead Room.
                self.lastError = "Disconnected by the server"
                self.state = .failed
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard room === self.room, !self.isTearingDown else { return }
                self.onConnectionLost?(false, self.roomTag)
            default:
                self.lastError = reason.map { "Connection lost (\($0))" } ?? "Connection lost"
                self.state = .failed
                self.onConnectionLost?(errorType == .duplicateIdentity, self.roomTag)
            }
        }
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        Task { @MainActor in
            guard room === self.room else { return }
            var ids = Set<String>()
            for p in room.activeSpeakers {
                if let identity = p.identity { ids.insert("\(identity)") }
            }
            // didUpdateSpeakingParticipants fires on audio-LEVEL ticks (several
            // times a second) even when the speaker MEMBERSHIP is unchanged.
            // Only republish when the set actually changed — an unchanged
            // reassignment still re-renders every speakingUserIds observer.
            // Mirrors the sameTracks/sameAudio guards in syncRemoteTracks.
            if ids != self.speakingUserIds {
                self.speakingUserIds = ids
                self.onSpeakingChanged?(ids)
            }
            // Frequent during calls — doubles as the remote-track refresh.
            self.syncRemoteTracks()
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        let uid = participant.identity.map { "\($0)" }
        Task { @MainActor in
            guard room === self.room, let uid else { return }
            if publication.track is AudioTrack {
                self.audioPubs[uid] = publication
                if self.isDeafened || self.mutedForMe.contains(uid) {
                    try? await publication.set(enabled: false)
                }
            } else if let vt = publication.track as? VideoTrack {
                if publication.source == .screenShareVideo {
                    self.screenTracks[uid] = vt
                } else {
                    self.remoteVideoTracks[uid] = vt
                }
            }
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        let uid = participant.identity.map { "\($0)" }
        Task { @MainActor in
            guard room === self.room, let uid else { return }
            if publication.track is AudioTrack {
                self.audioPubs.removeValue(forKey: uid)
            } else if publication.source == .screenShareVideo {
                self.screenTracks.removeValue(forKey: uid)
            } else {
                self.remoteVideoTracks.removeValue(forKey: uid)
            }
        }
    }

    nonisolated func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        Task { @MainActor in
            guard room === self.room else { return }
            // Native only publishes the camera (screen share was removed).
            if let vt = publication.track as? VideoTrack, publication.source != .screenShareVideo {
                self.localVideoTrack = vt
            }
        }
    }

    nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        Task { @MainActor in
            guard room === self.room else { return }
            if publication.track is VideoTrack, publication.source != .screenShareVideo {
                // Suppressed during a deliberate quality republish: that
                // unpublish is immediately followed by a fresh publish, and
                // this notification can arrive after the replacement track has
                // already been cached — nilling it here would leave the camera
                // live but the self-tile blank.
                guard !self.isRepublishingCamera else { return }
                self.localVideoTrack = nil
            }
        }
    }

    /// A participant muted/unmuted a track. For a remote VIDEO publication
    /// this is how a camera-off arrives (LiveKit mutes rather than
    /// unpublishes), so re-sync to add/drop the tile — otherwise a remote's
    /// camera-off left a frozen tile and camera-back-on never reappeared.
    nonisolated func room(
        _ room: Room,
        participant: Participant,
        trackPublication: TrackPublication,
        didUpdateIsMuted isMuted: Bool
    ) {
        Task { @MainActor in
            guard room === self.room else { return }
            if trackPublication.kind == .video { self.syncRemoteTracks() }
        }
    }
}

/// The screen for a voice channel: connection status, roster, mute + leave.
struct VoiceChannelView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var voice: VoiceManager
    @EnvironmentObject private var session: Session
    let channel: Channel

    @State private var ringSpin = false

    /// Participants currently being "swallowed" by the black hole — a leave
    /// animation that drags the tile into the center while it shrinks and
    /// winds up (web .zk-blackhole-swallow).
    private struct SwallowedSeat: Identifiable {
        let id = UUID()
        let name: String
        let avatarUrl: String?
        let userId: String
        let index: Int
        let total: Int
    }
    @State private var swallowed: [SwallowedSeat] = []
    @State private var swallowProgress: Set<UUID> = []
    @State private var previousStates: [VoiceState] = []

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 12)]

    var body: some View {
        ZStack {
            // Full-bleed space background behind EVERYTHING (header + content +
            // controls + the safe-area edges) so there are no black gaps around
            // or under the starfield. The header/controls bars are translucent
            // (see below) so the stars show through them continuously.
            Color.black.ignoresSafeArea()
            StarfieldView().ignoresSafeArea()

            VStack(spacing: 0) {
                // Compute the live feeds ONCE per body pass and thread them into
                // videoStage/audioOnlyStrip — `feeds` re-runs both the
                // screenSharers and videoParticipants filters on every read, and
                // it was read 3× per render (hasAnyVideo + videoStage +
                // audioOnlyStrip). !feedItems.isEmpty == the old hasAnyVideo.
                let feedItems = feeds
                header
                ZStack {
                    if !feedItems.isEmpty {
                        VStack(spacing: 0) {
                            videoStage(items: feedItems)
                                .padding(.horizontal, 10)
                                .padding(.top, 10)
                            audioOnlyStrip(items: feedItems)
                        }
                    } else {
                        arena
                    }
                    VStack {
                        statusBanner
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                        if store.voiceStates.isEmpty {
                            Spacer()
                            Text("No one else here yet")
                                .font(.zkSans(13))
                                .foregroundColor(.white.opacity(0.5))
                            Spacer()
                        } else {
                            Spacer()
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                controls
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 60).repeatForever(autoreverses: false)) { ringSpin = true }
            previousStates = store.voiceStates
        }
        .onChange(of: store.voiceStates) { _, newStates in
            let old = previousStates
            previousStates = newStates
            let remaining = Set(newStates.map { $0.userId })
            for (idx, vs) in old.enumerated() where !remaining.contains(vs.userId) {
                // Don't swallow ourselves — leaving pops the whole screen.
                if vs.userId == session.currentUser?.id { continue }
                spawnSwallow(for: vs, index: idx, total: old.count)
            }
        }
    }

    /// Insert a leave tile at the seat's last orbital slot, then animate it
    /// into the singularity (1.2s ease-in: position -> center, scale -> 5%,
    /// two full turns of spaghettification, fade out) and clean it up.
    private func spawnSwallow(for vs: VoiceState, index: Int, total: Int) {
        let name: String = {
            if channel.isDM, let u = channel.recipients?.first(where: { $0.id == vs.userId }) { return u.name }
            return store.memberName(vs.userId) ?? "Member"
        }()
        let avatar: String? = {
            if channel.isDM { return channel.recipients?.first(where: { $0.id == vs.userId })?.avatarUrl }
            return store.memberUser(vs.userId)?.avatarUrl
        }()
        let seat = SwallowedSeat(name: name, avatarUrl: avatar, userId: vs.userId, index: index, total: total)
        swallowed.append(seat)
        // Two-phase: let the tile commit at its seat first, then animate.
        DispatchQueue.main.async {
            withAnimation(.easeIn(duration: 1.2)) {
                _ = swallowProgress.insert(seat.id)
            }
        }
        Task {
            try? await Task.sleep(nanoseconds: 1_350_000_000)
            swallowed.removeAll { $0.id == seat.id }
            swallowProgress.remove(seat.id)
        }
    }

    /// Participants whose camera is publishing right now (self included).
    private var videoParticipants: [VoiceState] {
        store.voiceStates.filter { vs in
            voice.videoTrack(for: vs.userId, isSelf: vs.userId == session.currentUser?.id) != nil
        }
    }

    /// Remote participants sharing their screen. Native can no longer publish
    /// a screen share, so the local user never appears here.
    private var screenSharers: [VoiceState] {
        store.voiceStates.filter { voice.screenTracks[$0.userId] != nil }
    }

    /// Every live feed in display order: screens first, then cameras (max 8).
    private var feeds: [(vs: VoiceState, isScreen: Bool)] {
        let screens = screenSharers.map { ($0, true) }
        let cams = videoParticipants.map { ($0, false) }
        return Array((screens + cams).prefix(8))
    }

    /// Full-screen feed grid replacing the arena: 1 fills the stage,
    /// 2 stack top/bottom, 3-4 form 2x2, 5-6 2x3, 7-8 2x4.
    /// Takes the per-render `feeds` snapshot so it isn't recomputed here.
    private func videoStage(items: [(vs: VoiceState, isScreen: Bool)]) -> some View {
        GeometryReader { geo in
            let cols = items.count <= 2 ? 1 : 2
            let rows = Int(ceil(Double(items.count) / Double(cols)))
            let spacing: CGFloat = 8
            // Clamp ≥ 1pt: tiny/transitional geometry must never produce a
            // negative frame (SwiftUI traps on invalid dimensions).
            let cellW = max(1, (geo.size.width - CGFloat(cols - 1) * spacing) / CGFloat(cols))
            let cellH = max(1, (geo.size.height - CGFloat(rows - 1) * spacing) / CGFloat(rows))
            VStack(spacing: spacing) {
                ForEach(0..<rows, id: \.self) { r in
                    HStack(spacing: spacing) {
                        ForEach(0..<cols, id: \.self) { c in
                            let idx = r * cols + c
                            if idx < items.count {
                                feedTile(items[idx].vs, isScreen: items[idx].isScreen)
                                    .frame(width: cellW, height: cellH)
                            } else {
                                Color.clear.frame(width: cellW, height: cellH)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Participants with no live feed: a static avatar row under the grid
    /// (no orbiting while video is on stage).
    @ViewBuilder
    private func audioOnlyStrip(items: [(vs: VoiceState, isScreen: Bool)]) -> some View {
        let feedIds = Set(items.map { $0.vs.userId })
        let rest = store.voiceStates.filter { !feedIds.contains($0.userId) }
        if !rest.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    ForEach(rest) { vs in
                        let isSelf = vs.userId == session.currentUser?.id
                        let name: String = {
                            if isSelf { return session.currentUser?.name ?? "You" }
                            if channel.isDM, let u = channel.recipients?.first(where: { $0.id == vs.userId }) { return u.name }
                            return store.memberName(vs.userId) ?? "Member"
                        }()
                        VStack(spacing: 4) {
                            Avatar(url: isSelf ? session.currentUser?.avatarUrl
                                       : (channel.isDM
                                          ? channel.recipients?.first(where: { $0.id == vs.userId })?.avatarUrl
                                          : store.memberUser(vs.userId)?.avatarUrl),
                                   name: name, size: 40,
                                   ringColor: Color.white.opacity(0.12), toneId: vs.userId)
                                .alienPulse(voice.speakingUserIds.contains(vs.userId))
                            Text(name)
                                .font(.zkSans(10, weight: .medium))
                                .foregroundColor(.white.opacity(0.85))
                                .lineLimit(1)
                        }
                        .frame(width: 64)
                    }
                }
                .padding(.horizontal, 14)
            }
            .frame(height: 76)
            .padding(.vertical, 6)
        }
    }

    /// One stage tile (camera fills, screens letterbox), name + speaking ring.
    @ViewBuilder
    private func feedTile(_ vs: VoiceState, isScreen: Bool) -> some View {
        if isScreen { screenTile(vs) } else { videoTile(vs) }
    }

    /// Screen-share tile: same square cell, but the content letterboxes
    /// (screens are landscape; cropping would cut content off).
    @ViewBuilder
    private func screenTile(_ vs: VoiceState) -> some View {
        // Native only ever shows REMOTE screen shares now (it can't publish one).
        let name = "\(store.memberName(vs.userId) ?? "Member")'s screen"
        ZStack(alignment: .bottomLeading) {
            if let track = voice.screenTracks[vs.userId] {
                SwiftUIVideoView(track, layoutMode: .fit)
            }
            HStack(spacing: 4) {
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 9, weight: .semibold))
                Text(name)
                    .font(.zkSans(12, weight: .medium))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.black.opacity(0.55))
            .clipShape(Capsule())
            .padding(8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg0)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.accent2.opacity(0.6), lineWidth: 1)
        )
    }

    @ViewBuilder
    private func videoTile(_ vs: VoiceState) -> some View {
        let isSelf = vs.userId == session.currentUser?.id
        let name: String = {
            if isSelf { return session.currentUser?.name ?? "You" }
            if channel.isDM, let u = channel.recipients?.first(where: { $0.id == vs.userId }) { return u.name }
            return store.memberName(vs.userId) ?? "Member"
        }()
        let speaking = voice.speakingUserIds.contains(vs.userId)
        ZStack(alignment: .bottomLeading) {
            if let vt = voice.videoTrack(for: vs.userId, isSelf: isSelf) {
                // Key the self-preview by the track's object identity so a fresh
                // VideoView is built whenever the local camera track (re)binds.
                // Re-enabling the camera UNMUTES the same LocalVideoTrack object
                // (same trackId), and LiveKit's pooled VideoView only re-attaches
                // its renderer when the track DIFFERS — so without a new identity
                // the sharer's own preview stayed blank on a re-share (the remote
                // saw it fine via a distinct subscribed track). Remote tiles keep
                // a stable per-user id (they already re-attach on resubscribe).
                SwiftUIVideoView(vt)
                    .id(isSelf ? "self-cam-\(ObjectIdentifier(vt).hashValue)" : "remote-\(vs.userId)")
            }
            Text(name)
                .font(.zkSans(12, weight: .medium))
                .foregroundColor(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.black.opacity(0.55))
                .clipShape(Capsule())
                .padding(8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg0)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(speaking ? Theme.accent.opacity(0.8) : Theme.line,
                              lineWidth: speaking ? 2 : 1)
        )
    }

    /// The galaxy arena: rotating rings, a central glow, the black hole, and
    /// participants laid out on a golden-angle spiral. Mirrors the web VoiceView.
    private var arena: some View {
        GeometryReader { geo in
            arenaContent(size: geo.size)
        }
    }

    private func arenaContent(size: CGSize) -> some View {
        // Clamp the LAYOUT canvas to a phone-sized reference. Orbit radii,
        // rings and the glow are all sized as a fraction of `side`, but the
        // satellites on them (black hole 22pt, avatars 54pt, tiles 92pt) are
        // fixed px — tuned for a ~phone canvas. On a large/resizable "Designed
        // for iPad on Mac" window an unclamped `side` flung the avatars far out
        // into tiny dots around a speck and hard-edged the glow. cx/cy still use
        // the REAL size so the galaxy stays centered; it just stops inflating.
        let side = min(min(size.width, size.height), 420)
        let cx = size.width / 2
        let cy = size.height / 2
        return ZStack {
            ringsView(side: side).position(x: cx, y: cy)

            Circle()
                .fill(RadialGradient(
                    colors: [Theme.accent.opacity(0.45), .clear],
                    center: .center, startRadius: 0, endRadius: side * 0.2))
                .frame(width: side * 0.55, height: side * 0.55)
                .blur(radius: side * 0.09)
                .position(x: cx, y: cy)

            BlackHoleView()
                .frame(width: 22, height: 22)
                .position(x: cx, y: cy)

            // The constellation slowly orbits the black hole as one rigid
            // body (web .zk-orbit: 90s/rev). The angle derives from the
            // wall clock each frame, and every seat counter-rotates by the
            // exact negation — so avatars stay upright, and a seat that
            // mounts mid-orbit is in perfect phase (no spin drift).
            //
            // 10fps cadence: the orbit moves 4°/second, so each tick is a
            // 0.4° step — visually indistinguishable from 30fps for this
            // animation, at a third of the per-frame seat re-evaluations
            // (the single biggest steady-state cost of an open call UI).
            TimelineView(.animation(minimumInterval: 1.0 / 10.0)) { timeline in
                let angle = Self.orbitAngle(at: timeline.date)
                ZStack {
                    ForEach(Array(store.voiceStates.enumerated()), id: \.element.id) { idx, vs in
                        participantSeat(vs)
                            .rotationEffect(.degrees(-angle))
                            .position(seatPosition(index: idx, total: store.voiceStates.count,
                                                   side: side, cx: cx, cy: cy))
                    }

                    // Leavers spiral into the singularity (their own 720°
                    // wind-up replaces the upright counter-rotation).
                    ForEach(swallowed) { seat in
                        let consumed = swallowProgress.contains(seat.id)
                        swallowTile(seat)
                            .rotationEffect(.degrees(consumed ? 720 : -angle))
                            .scaleEffect(consumed ? 0.05 : 1)
                            .opacity(consumed ? 0 : 1)
                            .position(consumed
                                      ? CGPoint(x: cx, y: cy)
                                      : seatPosition(index: seat.index, total: seat.total,
                                                     side: side, cx: cx, cy: cy))
                    }
                }
                .rotationEffect(.degrees(angle))
            }
        }
        .frame(width: size.width, height: size.height)
    }

    /// Shared orbit phase: 360° per 90s, derived from the wall clock so
    /// every view computes the identical angle.
    static func orbitAngle(at date: Date) -> Double {
        let t = date.timeIntervalSinceReferenceDate
        return (t.truncatingRemainder(dividingBy: 90) / 90) * 360
    }

    /// Simplified avatar-only tile used for the swallow animation.
    private func swallowTile(_ seat: SwallowedSeat) -> some View {
        Avatar(url: seat.avatarUrl, name: seat.name, size: 54,
               ringColor: Color.white.opacity(0.12), toneId: seat.userId)
            .shadow(color: Theme.accentGlow, radius: 10)
    }

    /// Concentric orbits (two solid, one dashed) that slowly counter-rotate.
    private func ringsView(side: CGFloat) -> some View {
        ZStack {
            Circle().stroke(Theme.lineSoft, lineWidth: 1)
                .frame(width: side * 0.78, height: side * 0.78)
                .rotationEffect(.degrees(ringSpin ? 360 : 0))
            Circle().stroke(Theme.lineSoft, style: StrokeStyle(lineWidth: 1, dash: [4, 7]))
                .frame(width: side * 0.55, height: side * 0.55)
                .rotationEffect(.degrees(ringSpin ? -360 : 0))
            Circle().stroke(Theme.lineSoft, lineWidth: 1)
                .frame(width: side * 0.32, height: side * 0.32)
                .rotationEffect(.degrees(ringSpin ? 360 : 0))
        }
        .opacity(0.32)
    }

    /// Galaxy/spiral placement using the golden angle, with a uniform shrink
    /// when the outermost tier would clip the arena (matches arenaScale).
    private func seatPosition(index: Int, total: Int, side: CGFloat, cx: CGFloat, cy: CGFloat) -> CGPoint {
        // Planetary spacing: each joiner sits on a clearly separated orbit —
        // first-in closest to the black hole (index = join order; the store
        // keeps voiceStates in stable join order and compacts on leave).
        let innerR: CGFloat = 16
        let tierStep: CGFloat = 13
        let goldenDeg: CGFloat = 137.5
        let maxR: CGFloat = 46
        let outerR = innerR + CGFloat(max(total - 1, 0)) * tierStep
        let scale: CGFloat = outerR > maxR ? maxR / outerR : 1
        let radiusPct = (innerR + CGFloat(index) * tierStep) * scale
        let angle = CGFloat(index) * goldenDeg * .pi / 180
        let r = radiusPct / 100 * side
        return CGPoint(x: cx + cos(angle) * r, y: cy + sin(angle) * r)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if !store.isWideLayout || store.stack.count > 1 {
                Button(action: goBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                        .padding(.leading, 14)
                        .frame(width: 44, height: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
            }
            Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 14))
                .foregroundColor(Theme.ink3)
            Text(channel.isDM ? channel.dmTitle : (channel.name ?? "Voice"))
                .font(.zkSans(16, weight: .semibold))
                .foregroundColor(Theme.ink1)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Theme.bg2.opacity(0.85))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .bottom)
    }

    @ViewBuilder
    private var statusBanner: some View {
        if store.voiceTokenMissing {
            label("Connected (presence only — voice isn't configured on the server)", color: Theme.accent3)
        } else if store.voiceConnecting && !voice.isConnected {
            label("Connecting…", color: Theme.ink3)
        } else {
            switch voice.state {
            // Steady-state "Connected" removed — being in the channel is
            // indication enough. Transient/diagnostic states stay.
            // Connected but something non-fatal went wrong — in practice a mic
            // that wouldn't open. The call is live and the user is in the
            // roster, but they're muted and need to know why; silence here is
            // what made "nobody can hear me" impossible to self-diagnose.
            case .connected:
                if let err = voice.lastError { label(err, color: Theme.danger) } else { EmptyView() }
            case .connecting: label("Connecting…", color: Theme.ink3)
            case .reconnecting: label("Reconnecting…", color: Theme.accent3)
            case .failed: label(voice.lastError ?? "Connection failed", color: Theme.danger)
            case .idle: label("Joining…", color: Theme.ink3)
            }
        }
    }

    private func label(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.zkSans(13, weight: .medium))
            .foregroundColor(color)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
    }

    private func participantSeat(_ vs: VoiceState) -> some View {
        let isSelf = vs.userId == session.currentUser?.id
        let isSpeaking = voice.speakingUserIds.contains(vs.userId)
        let displayName: String = {
            if isSelf { return session.currentUser?.name ?? "You" }
            if channel.isDM,
               let u = channel.recipients?.first(where: { $0.id == vs.userId }) { return u.name }
            return store.memberName(vs.userId) ?? "Member"
        }()
        let avatarURL: String? = {
            if isSelf { return session.currentUser?.avatarUrl }
            if channel.isDM { return channel.recipients?.first(where: { $0.id == vs.userId })?.avatarUrl }
            return store.memberUser(vs.userId)?.avatarUrl
        }()
        let tapUser: PublicUser? = {
            if isSelf { return nil }
            if channel.isDM { return channel.recipients?.first(where: { $0.id == vs.userId }) }
            return store.memberUser(vs.userId)
        }()
        return VStack(spacing: 5) {
            ZStack {
                Avatar(url: avatarURL, name: displayName, size: 54,
                       ringColor: Color.white.opacity(0.12), toneId: vs.userId)
            }
            // Web .zk-alien-pulse: plasma sonar ripple while speaking.
            .alienPulse(isSpeaking)
            .shadow(color: Color.black.opacity(0.4), radius: 6)
            // Mute/deafen status as corner badges — the name pill keeps its
            // full width so names never get shortened by the icons.
            .overlay(alignment: .bottomTrailing) {
                if vs.isMuted || voice.mutedForMe.contains(vs.userId) {
                    Image(systemName: voice.mutedForMe.contains(vs.userId)
                          ? "speaker.slash.fill" : "mic.slash.fill")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(vs.isMuted ? Theme.danger : Theme.ink2)
                        .frame(width: 16, height: 16)
                        .background(Color.black.opacity(0.75))
                        .clipShape(Circle())
                        .offset(x: 3, y: 3)
                }
            }

            Text(displayName)
                .font(.zkSans(11, weight: .medium))
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.black.opacity(0.55))
                .clipShape(Capsule())
        }
        .frame(width: 92)
        .contentShape(Rectangle())
        .onTapGesture { if let u = tapUser { store.openProfile(u) } }
        .contextMenu {
            if !isSelf {
                Button {
                    Task { await voice.setMutedForMe(vs.userId, !voice.mutedForMe.contains(vs.userId)) }
                } label: {
                    Label(voice.mutedForMe.contains(vs.userId) ? "Unmute for me" : "Mute for me",
                          systemImage: voice.mutedForMe.contains(vs.userId) ? "speaker.wave.2.fill" : "speaker.slash.fill")
                }
                if let u = tapUser {
                    Button { store.openProfile(u) } label: {
                        Label("View Profile", systemImage: "person.crop.circle")
                    }
                }
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 16) {
            MicControlButton(voice: voice, onToggle: { await store.toggleVoiceMute() })

            Button { Task { await store.toggleVoiceDeafen() } } label: {
                Image(systemName: voice.isDeafened ? "speaker.slash.fill" : "headphones")
                    .font(.system(size: 20))
                    .foregroundColor(voice.isDeafened ? Theme.danger : Theme.ink1)
                    .frame(width: 54, height: 54)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

            Button { Task { await store.toggleVoiceCamera() } } label: {
                Image(systemName: voice.isCameraOn ? "video.fill" : "video.slash.fill")
                    .font(.system(size: 19))
                    .foregroundColor(voice.isCameraOn ? Theme.accent : Theme.ink1)
                    .frame(width: 54, height: 54)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

            if voice.isCameraOn {
                Button { Task { await voice.flipCamera() } } label: {
                    Image(systemName: "arrow.triangle.2.circlepath.camera")
                        .font(.system(size: 18))
                        .foregroundColor(Theme.ink1)
                        .frame(width: 54, height: 54)
                        .background(Theme.bg3)
                        .clipShape(Circle())
                }
            }

            // Speaker (loudspeaker) vs earpiece. On by default so calls are
            // audible out loud; tap to switch to the earpiece.
            Button { voice.setSpeaker(!voice.isSpeakerOn) } label: {
                Image(systemName: voice.isSpeakerOn ? "speaker.wave.2.fill" : "ear.fill")
                    .font(.system(size: 19))
                    .foregroundColor(voice.isSpeakerOn ? Theme.accent : Theme.ink1)
                    .frame(width: 54, height: 54)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

            Button(action: leave) {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 20))
                    .foregroundColor(.white)
                    .frame(width: 54, height: 54)
                    .background(Theme.danger)
                    .clipShape(Circle())
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(Theme.bg2.opacity(0.85))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .top)
    }

    /// Return to the channel list WITHOUT leaving the call (the VoicePanel
    /// strip keeps mute/leave reachable). Only the red button disconnects.
    private func goBack() {
        store.pop()
    }

    private func leave() {
        store.pop()
        Task { await store.leaveCurrentVoice() }
    }
}

/// Full-screen incoming 1:1 DM call prompt (in-app ringing while foregrounded).
struct IncomingCallView: View {
    @EnvironmentObject private var store: AppStore
    let call: IncomingCall

    var body: some View {
        ZStack {
            Theme.bg0.opacity(0.97).ignoresSafeArea()
            VStack(spacing: 24) {
                Spacer()
                Avatar(
                    url: call.channel.dmAvatarUser?.avatarUrl,
                    name: call.callerName,
                    size: 96
                )
                VStack(spacing: 4) {
                    Text(call.callerName)
                        .font(.zkSans(22, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                    Text("Incoming call…")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                }
                Spacer()
                HStack(spacing: 56) {
                    VStack(spacing: 8) {
                        Button { store.declineCall() } label: {
                            Image(systemName: "phone.down.fill")
                                .font(.system(size: 26))
                                .foregroundColor(.white)
                                .frame(width: 66, height: 66)
                                .background(Theme.danger)
                                .clipShape(Circle())
                        }
                        Text("Decline").font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }
                    VStack(spacing: 8) {
                        Button { store.acceptCall() } label: {
                            Image(systemName: "phone.fill")
                                .font(.system(size: 26))
                                .foregroundColor(.white)
                                .frame(width: 66, height: 66)
                                .background(Theme.online)
                                .clipShape(Circle())
                        }
                        Text("Accept").font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }
                }
                .padding(.bottom, 64)
            }
        }
        .onAppear { Ringtone.start() }
        .onDisappear { Ringtone.stop() }
    }
}

/// In-app ringtone for incoming calls. Repeats a system alert tone (with
/// vibration) on a timer while the incoming-call screen is up — the native
/// counterpart to the web's sounds.ts ringtone. No bundled audio asset
/// needed; uses AudioToolbox's built-in alert sounds.
enum Ringtone {
    private static var timer: Timer?

    static func start() {
        stop()
        ring()
        timer = Timer.scheduledTimer(withTimeInterval: 2.6, repeats: true) { _ in ring() }
    }
    static func stop() {
        timer?.invalidate()
        timer = nil
    }
    private static func ring() {
        // 1151 is a ringtone-style alert; AlertSound also vibrates on supported devices.
        AudioServicesPlayAlertSound(SystemSoundID(1151))
    }
}

/// Mic control shared across the in-call surfaces. In push-to-talk mode it
/// becomes a press-and-hold "talk" button (hold to open the mic, release to
/// re-mute); otherwise it's the normal tap-to-toggle mute button. The hold
/// gesture lives here once so every surface behaves identically.
struct MicControlButton: View {
    @ObservedObject var voice: VoiceManager
    /// VAD-mode tap action (normally store.toggleVoiceMute()).
    let onToggle: () async -> Void
    var iconSize: CGFloat = 20
    var frameW: CGFloat = 54
    var frameH: CGFloat = 54
    var background: Color? = Theme.bg3
    var unmutedColor: Color = Theme.ink1
    @State private var pressing = false

    var body: some View {
        Group {
            if voice.pushToTalkEnabled {
                icon
                    .scaleEffect(voice.pttHeld ? 1.06 : 1.0)
                    .animation(.easeInOut(duration: 0.1), value: voice.pttHeld)
                    .contentShape(Rectangle())
                    .gesture(
                        // minimumDistance 0 = fires on touch-down. We latch on
                        // the first onChanged and unlatch on onEnded so press
                        // and release each fire exactly once.
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in
                                guard !pressing else { return }
                                pressing = true
                                Haptics.light()
                                Task { await voice.pttSetHeld(true) }
                            }
                            .onEnded { _ in
                                pressing = false
                                Task { await voice.pttSetHeld(false) }
                            }
                    )
                    .accessibilityLabel("Push to talk")
                    .accessibilityHint("Hold to transmit")
            } else {
                Button { Task { await onToggle() } } label: { icon }
            }
        }
        .disabled(!voice.isConnected)
        .opacity(voice.isConnected ? 1 : 0.5)
    }

    private var icon: some View {
        Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
            .font(.system(size: iconSize))
            .foregroundColor(voice.isMuted ? Theme.danger : unmutedColor)
            .frame(width: frameW, height: frameH)
            .background(background ?? Color.clear)
            .clipShape(Circle())
    }
}

/// Pinned strip at the bottom of the channel list while connected to a voice
/// channel — mirrors the web's VoicePanel so mute / leave stay reachable while
/// you browse other channels. Tap the label to re-open the voice screen.
struct VoicePanel: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var voice: VoiceManager

    private var channel: Channel? {
        let id = store.voiceChannelId
        return store.channels.first(where: { $0.id == id })
            ?? store.dms.first(where: { $0.id == id })
    }

    private var title: String {
        guard let channel else { return "Voice" }
        return channel.isDM ? channel.dmTitle : (channel.name ?? "Voice")
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if let channel { store.openVoice(channel) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "speaker.wave.2.fill")
                        .font(.system(size: 13))
                        .foregroundColor(Theme.online)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Voice Connected")
                            .font(.zkSans(11, weight: .semibold))
                            .foregroundColor(Theme.online)
                        Text(title)
                            .font(.zkSans(12))
                            .foregroundColor(Theme.ink2)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            MicControlButton(voice: voice, onToggle: { await store.toggleVoiceMute() },
                             iconSize: 15, frameW: 32, frameH: 32)

            Button { Task { await store.toggleVoiceDeafen() } } label: {
                Image(systemName: voice.isDeafened ? "speaker.slash.fill" : "headphones")
                    .font(.system(size: 15))
                    .foregroundColor(voice.isDeafened ? Theme.danger : Theme.ink1)
                    .frame(width: 32, height: 32)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

            Button { Task { await store.leaveCurrentVoice() } } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 15))
                    .foregroundColor(.white)
                    .frame(width: 32, height: 32)
                    .background(Theme.danger)
                    .clipShape(Circle())
            }
            .accessibilityLabel("Leave call")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .top)
    }
}

// MARK: - Stage channel

/// Stage channel UI: speakers grid + audience + raised-hands (for mods),
/// with audience/speaker controls. Mirrors the web StageChannelView. The
/// LiveKit publish grant is gated server-side by speaker status; promotion
/// or demotion triggers a token re-fetch + reconnect (see AppStore).
struct StageChannelView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var voice: VoiceManager
    let channel: Channel

    private let columns = [GridItem(.adaptive(minimum: 88), spacing: 12)]
    private var speakers: [StageParticipant] { store.stageParticipants.filter { $0.isSpeaker } }
    private var audience: [StageParticipant] { store.stageParticipants.filter { !$0.isSpeaker } }
    private var raisedHands: [StageParticipant] { audience.filter { $0.handRaised } }
    private var isMod: Bool { store.canManageChannels }
    private var amSpeaker: Bool { store.myStageSpeaker }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if store.stageConnecting && store.stageParticipants.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 20)
                    }
                    if store.stageTokenMissing {
                        Text("Voice isn't available for this stage right now.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                    sectionLabel("SPEAKERS · \(speakers.count)")
                    if speakers.isEmpty {
                        Text("No speakers yet.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(speakers) { p in participantTile(p, speaker: true) }
                        }
                    }
                    if isMod && !raisedHands.isEmpty {
                        sectionLabel("RAISED HANDS · \(raisedHands.count)")
                        ForEach(raisedHands) { p in raisedHandRow(p) }
                    }
                    sectionLabel("AUDIENCE · \(audience.count)")
                    if audience.isEmpty {
                        Text("No one in the audience.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(audience) { p in participantTile(p, speaker: false) }
                        }
                    }
                }
                .padding(16)
            }
            controls
        }
        .background(Theme.bg2)
        .task {
            await store.refreshStage()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { break }
                await store.refreshStage()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button { store.clearChannel() } label: {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()).padding(.leading, 6)
            }
            Image(systemName: "person.wave.2.fill").font(.system(size: 15)).foregroundColor(Theme.accent)
            VStack(alignment: .leading, spacing: 1) {
                Text(channel.name ?? "stage").font(.zkSans(16, weight: .semibold)).foregroundColor(Theme.ink1).lineLimit(1)
                Text("Stage").font(.zkSans(11)).foregroundColor(Theme.ink3)
            }
            Spacer()
        }
        .padding(.horizontal, 14).frame(height: 48).background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(t).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
    }

    private func participantTile(_ p: StageParticipant, speaker: Bool) -> some View {
        let user = store.memberUser(p.userId)
        let name = user?.name ?? "User"
        let isSpeaking = voice.speakingUserIds.contains(p.userId)
        return VStack(spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(url: user?.avatarUrl, name: name, size: 56, ringColor: Theme.bg2, toneId: p.userId)
                    .alienPulse(isSpeaking)
                if speaker {
                    Image(systemName: "mic.fill").font(.system(size: 10)).foregroundColor(.white)
                        .padding(4).background(Theme.accent).clipShape(Circle())
                } else if p.handRaised {
                    Text("✋").font(.zkSans(12)).padding(3).background(Theme.bg3).clipShape(Circle())
                }
            }
            Text(name).font(.zkSans(12)).foregroundColor(Theme.ink2).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .contextMenu { stageContext(p, speaker: speaker) }
    }

    @ViewBuilder
    private func stageContext(_ p: StageParticipant, speaker: Bool) -> some View {
        if isMod {
            if speaker {
                Button { Task { await store.setStageSpeaker(p.userId, isSpeaker: false) } } label: {
                    Label("Move to audience", systemImage: "arrow.down")
                }
            } else {
                Button { Task { await store.setStageSpeaker(p.userId, isSpeaker: true) } } label: {
                    Label("Make speaker", systemImage: "mic")
                }
            }
        }
        if let u = store.memberUser(p.userId) {
            Button { store.openProfile(u) } label: { Label("View profile", systemImage: "person.crop.circle") }
        }
    }

    private func raisedHandRow(_ p: StageParticipant) -> some View {
        let user = store.memberUser(p.userId)
        return HStack(spacing: 10) {
            Avatar(url: user?.avatarUrl, name: user?.name ?? "User", size: 30, ringColor: Theme.bg2)
            Text(user?.name ?? "User").font(.zkSans(14)).foregroundColor(Theme.ink1)
            Spacer()
            Button { Task { await store.setStageSpeaker(p.userId, isSpeaker: true) } } label: {
                Text("Invite").font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                    .padding(.horizontal, 12).padding(.vertical, 6).background(Theme.accent).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(10).background(Theme.bg3.opacity(0.5)).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var controls: some View {
        HStack(spacing: 12) {
            if amSpeaker {
                Button { Task { await store.toggleVoiceMute() } } label: {
                    // Match VoiceChannelView's mute button: keep the dark bg3
                    // button and redden the ICON when muted (don't flood the
                    // whole button Theme.danger — that was the off-theme look).
                    Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 18)).foregroundColor(voice.isMuted ? Theme.danger : Theme.ink1)
                        .frame(width: 52, height: 44)
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            } else {
                Button {
                    Task {
                        if store.myStageHandRaised { await store.lowerStageHand() }
                        else { await store.raiseStageHand() }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text("✋")
                        Text(store.myStageHandRaised ? "Lower hand" : "Raise hand").font(.zkSans(14, weight: .semibold))
                    }
                    .foregroundColor(store.myStageHandRaised ? .white : Theme.ink1)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(store.myStageHandRaised ? Theme.accent : Theme.bg3).clipShape(Capsule())
                }
            }
            Button { Task { await store.leaveStage(); store.clearChannel() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "phone.down.fill")
                    Text("Leave").font(.system(size: 14, weight: .semibold))
                }
                .foregroundColor(.white).padding(.horizontal, 16).padding(.vertical, 12)
                .background(Theme.danger).clipShape(Capsule())
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        // Match VoiceChannelView's control bar (was Theme.bg1).
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .top)
    }
}

// MARK: - Outgoing call (ringing out)

/// Full-screen ringing screen shown to the caller of a 1:1 DM while the
/// callee hasn't answered. Mirrors the web OutgoingCallModal. Disappears
/// automatically once the callee joins (call becomes active).
struct OutgoingCallView: View {
    @EnvironmentObject private var store: AppStore
    let channel: Channel
    let callee: PublicUser

    var body: some View {
        ZStack {
            Theme.bg0.opacity(0.97).ignoresSafeArea()
            VStack(spacing: 24) {
                Spacer()
                Avatar(url: callee.avatarUrl, name: callee.name, size: 96)
                VStack(spacing: 4) {
                    Text(callee.name)
                        .font(.zkSans(22, weight: .semibold)).foregroundColor(Theme.ink1)
                    Text("Calling…")
                        .font(.zkSans(14)).foregroundColor(Theme.ink3)
                }
                Spacer()
                VStack(spacing: 8) {
                    Button { Task { await store.leaveCurrentVoice() } } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 26)).foregroundColor(.white)
                            .frame(width: 66, height: 66).background(Theme.danger).clipShape(Circle())
                    }
                    Text("Cancel").font(.zkSans(12)).foregroundColor(Theme.ink3)
                }
                .padding(.bottom, 64)
            }
        }
    }
}

// MARK: - Global minimized call bar

/// A slim, always-present strip at the top of the content column whenever
/// we're connected to a voice or stage call but not currently viewing it.
/// Tap to return; mute/leave stay reachable from anywhere. Mirrors the web
/// GlobalCallOverlay's active-call bar.
struct MinimizedCallBar: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var voice: VoiceManager

    private var isStage: Bool { store.stageChannelId != nil }
    private var title: String {
        guard let ch = store.activeCallChannel else { return "Call" }
        return ch.isDM ? ch.dmTitle : (ch.name ?? (isStage ? "Stage" : "Voice"))
    }

    var body: some View {
        HStack(spacing: 10) {
            Button { store.returnToActiveCall() } label: {
                HStack(spacing: 10) {
                    Image(systemName: isStage ? "person.wave.2.fill" : "speaker.wave.2.fill")
                        .font(.system(size: 13)).foregroundColor(Theme.online)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(isStage ? "On Stage" : "Voice Connected")
                            .font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.online)
                        Text(title).font(.zkSans(12)).foregroundColor(Theme.ink1).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !isStage || store.myStageSpeaker {
                MicControlButton(voice: voice, onToggle: { await store.toggleVoiceMute() },
                                 iconSize: 15, frameW: 36, frameH: 32,
                                 background: nil, unmutedColor: Theme.ink2)
            }
            Button { Task { await store.leaveActiveCall() } } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 14)).foregroundColor(.white)
                    .frame(width: 36, height: 32).background(Theme.danger).clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
    }
}

/// The central singularity for the voice arena: a spinning accretion disk
/// (conic gradient through the theme accents), a pitch-black event horizon,
/// and a violet/cyan glow halo. Mirrors the web VoiceView black hole.
struct BlackHoleView: View {
    @State private var spin = false
    var body: some View {
        ZStack {
            Circle()
                .fill(AngularGradient(
                    gradient: Gradient(colors: [
                        Theme.accent2, Theme.accent2, Theme.accent,
                        Theme.accent, Theme.accent3, Theme.accent2
                    ]),
                    center: .center))
                .rotationEffect(.degrees(spin ? 360 : 0))
                .shadow(color: Theme.accent.opacity(0.55), radius: 14)
                .shadow(color: Theme.accent3.opacity(0.45), radius: 7)
            Circle()
                .fill(Color.black)
                .padding(4)
        }
        .onAppear {
            withAnimation(.linear(duration: 6).repeatForever(autoreverses: false)) { spin = true }
        }
    }
}

/// A faint, static starfield rendered deterministically so it doesn't
/// shimmer or reflow between view updates.
struct StarfieldView: View {
    var body: some View {
        Canvas { ctx, size in
            var rng = SeededRNG(seed: 0x5DEECE66D)
            for _ in 0..<70 {
                let x = CGFloat(rng.next()) * size.width
                let y = CGFloat(rng.next()) * size.height
                let r = CGFloat(rng.next()) * 1.3 + 0.4
                let op = rng.next() * 0.5 + 0.15
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r, height: r)),
                         with: .color(.white.opacity(op)))
            }
        }
        .allowsHitTesting(false)
    }
}

/// Tiny deterministic PRNG (LCG) for stable starfield placement.
struct SeededRNG {
    private var state: UInt64
    init(seed: UInt64) { state = seed == 0 ? 0x9E3779B9 : seed }
    mutating func next() -> Double {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Double(state >> 11) / Double(UInt64(1) << 53)
    }
}
