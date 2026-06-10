import SwiftUI
import LiveKit
import AudioToolbox

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

    @Published private(set) var state: State = .idle
    @Published private(set) var isMuted = false
    /// When deafened, all remote audio is muted for the local listener (and the
    /// mic is muted too, mirroring Discord). Restored on undeafen.
    @Published private(set) var isDeafened = false
    private var wasMutedBeforeDeafen = false
    /// Whether the local camera is publishing.
    @Published private(set) var isCameraOn = false
    /// Whether the local screen-share track is publishing (in-app capture).
    @Published private(set) var isScreenSharing = false
    /// Remote screen-share tracks keyed by user id (kept separate from
    /// camera tracks so one doesn't clobber the other).
    @Published private(set) var screenTracks: [String: VideoTrack] = [:]
    @Published private(set) var localScreenTrack: VideoTrack?
    /// The local camera track (captured on publish) and remote video tracks
    /// keyed by user id, so the arena can render video tiles.
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var remoteVideoTracks: [String: VideoTrack] = [:]
    @Published var lastError: String?
    /// LiveKit identities (== user snowflakes) currently speaking. Drives the
    /// green ring in the voice/stage UI.
    @Published private(set) var speakingUserIds: Set<String> = []
    /// User ids the local user has muted for themselves only (persisted).
    @Published private(set) var mutedForMe: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "zk.mutedForMe") ?? [])

    /// Captured remote audio publications, keyed by user id, so we can
    /// enable/disable them per-user. Cleared on disconnect to release refs.
    private var audioPubs: [String: RemoteTrackPublication] = [:]

    private var room: Room?

    var isConnected: Bool { state == .connected }

    func connect(url: String, token: String, e2eeKey: Data? = nil, publishMic: Bool = true) async {
        await disconnect()
        state = .connecting
        isMuted = !publishMic
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
            r = Room(delegate: self, roomOptions: RoomOptions(encryptionOptions: encryption))
        } else {
            r = Room(delegate: self)
        }
        room = r
        do {
            try await r.connect(url: url, token: token)
            if publishMic { try await r.localParticipant.setMicrophone(enabled: true) }
            state = .connected
        } catch {
            lastError = error.localizedDescription
            state = .failed
            room = nil
        }
    }

    func toggleMute() async {
        guard let room else { return }
        let next = !isMuted
        do {
            try await room.localParticipant.setMicrophone(enabled: !next)
            isMuted = next
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Toggle deafen: mute/unmute every remote participant's audio for the local
    /// listener, and mute the mic while deafened (restoring it on undeafen).
    /// Per-user "muted for me" choices are preserved when undeafening.
    func toggleDeafen() async {
        let next = !isDeafened
        if next {
            wasMutedBeforeDeafen = isMuted
            for pub in audioPubs.values { try? await pub.set(enabled: false) }
            _ = try? await room?.localParticipant.setMicrophone(enabled: false)
            isMuted = true
        } else {
            for (uid, pub) in audioPubs { try? await pub.set(enabled: !mutedForMe.contains(uid)) }
            if !wasMutedBeforeDeafen {
                _ = try? await room?.localParticipant.setMicrophone(enabled: true)
                isMuted = false
            }
        }
        isDeafened = next
    }

    /// Toggle in-app screen sharing. Captures THIS app's screen via
    /// ReplayKit; sharing the whole device (other apps / home screen)
    /// requires a Broadcast Upload Extension target, which has to be
    /// added in Xcode (separate follow-up).
    func toggleScreenShare() async {
        let next = !isScreenSharing
        do {
            try await room?.localParticipant.setScreenShare(enabled: next)
            isScreenSharing = next
            if !next { localScreenTrack = nil }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Switch the publishing camera between front and back.
    func flipCamera() async {
        guard isCameraOn,
              let track = localVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        do { try await capturer.switchCameraPosition() }
        catch { lastError = error.localizedDescription }
    }

    /// Publish/unpublish the local camera (front camera, default options).
    func toggleCamera() async {
        let next = !isCameraOn
        do {
            try await room?.localParticipant.setCamera(enabled: next)
            isCameraOn = next
            if !next { localVideoTrack = nil }
        } catch {
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
        if !sameTracks(remoteVideoTracks, video) { remoteVideoTracks = video }
        if !sameTracks(screenTracks, screens) { screenTracks = screens }
        // Preserve deafen/mute-for-me on newly discovered audio pubs.
        for (uid, pub) in audio where audioPubs[uid] == nil {
            audioPubs[uid] = pub
            if isDeafened || mutedForMe.contains(uid) {
                Task { try? await pub.set(enabled: false) }
            }
        }
        audioPubs = audioPubs.filter { audio[$0.key] != nil }

    }

    func disconnect() async {
        if let room { await room.disconnect() }
        room = nil
        state = .idle
        isMuted = false
        isDeafened = false
        isCameraOn = false
        isScreenSharing = false
        localVideoTrack = nil
        localScreenTrack = nil
        remoteVideoTracks.removeAll()
        screenTracks.removeAll()
        speakingUserIds = []
        audioPubs.removeAll()
    }
}

extension VoiceManager: RoomDelegate {
    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .connected: self.state = .connected; self.syncRemoteTracks()
            case .connecting: self.state = .connecting
            case .reconnecting: self.state = .reconnecting
            case .disconnected: if self.state != .failed { self.state = .idle }
            case .disconnecting: break
            @unknown default: break
            }
        }
    }

    nonisolated func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) {
        Task { @MainActor in
            self.lastError = error?.localizedDescription ?? "Connection failed"
            self.state = .failed
        }
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        Task { @MainActor in
            var ids = Set<String>()
            for p in room.activeSpeakers {
                if let identity = p.identity { ids.insert("\(identity)") }
            }
            self.speakingUserIds = ids
            // Frequent during calls — doubles as the remote-track refresh.
            self.syncRemoteTracks()
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        let uid = participant.identity.map { "\($0)" }
        Task { @MainActor in
            guard let uid else { return }
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
            guard let uid else { return }
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
            if let vt = publication.track as? VideoTrack {
                if publication.source == .screenShareVideo {
                    self.localScreenTrack = vt
                } else {
                    self.localVideoTrack = vt
                }
            }
        }
    }

    nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        Task { @MainActor in
            if publication.track is VideoTrack {
                if publication.source == .screenShareVideo {
                    self.localScreenTrack = nil
                } else {
                    self.localVideoTrack = nil
                }
            }
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
        VStack(spacing: 0) {
            header
            ZStack {
                Color.black
                StarfieldView()
                if hasAnyVideo {
                    VStack(spacing: 0) {
                        videoStage
                            .padding(.horizontal, 10)
                            .padding(.top, 10)
                        audioOnlyStrip
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
        .background(Color.black)
        .onAppear {
            withAnimation(.linear(duration: 60).repeatForever(autoreverses: false)) { ringSpin = true }
            previousStates = store.voiceStates
        }
        .onChange(of: store.voiceStates) { newStates in
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

    /// Participants sharing their screen (self included).
    private var screenSharers: [VoiceState] {
        store.voiceStates.filter { vs in
            let isSelf = vs.userId == session.currentUser?.id
            return (isSelf ? voice.localScreenTrack : voice.screenTracks[vs.userId]) != nil
        }
    }

    private var hasAnyVideo: Bool {
        !videoParticipants.isEmpty || !screenSharers.isEmpty
    }

    /// Every live feed in display order: screens first, then cameras (max 8).
    private var feeds: [(vs: VoiceState, isScreen: Bool)] {
        let screens = screenSharers.map { ($0, true) }
        let cams = videoParticipants.map { ($0, false) }
        return Array((screens + cams).prefix(8))
    }

    /// Full-screen feed grid replacing the arena: 1 fills the stage,
    /// 2 stack top/bottom, 3-4 form 2x2, 5-6 2x3, 7-8 2x4.
    private var videoStage: some View {
        GeometryReader { geo in
            let items = feeds
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
    private var audioOnlyStrip: some View {
        let feedIds = Set(feeds.map { $0.vs.userId })
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
        let isSelf = vs.userId == session.currentUser?.id
        let name = isSelf ? "Your screen" : "\(store.memberName(vs.userId) ?? "Member")'s screen"
        ZStack(alignment: .bottomLeading) {
            if let track = isSelf ? voice.localScreenTrack : voice.screenTracks[vs.userId] {
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
                SwiftUIVideoView(vt)
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
        let side = min(size.width, size.height)
        let cx = size.width / 2
        let cy = size.height / 2
        return ZStack {
            ringsView(side: side).position(x: cx, y: cy)

            Circle()
                .fill(RadialGradient(
                    colors: [Theme.accent.opacity(0.45), .clear],
                    center: .center, startRadius: 0, endRadius: side * 0.2))
                .frame(width: side * 0.55, height: side * 0.55)
                .blur(radius: 34)
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
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(Theme.ink2)
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
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
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
            case .connected: EmptyView()
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
            Button { Task { await store.toggleVoiceMute() } } label: {
                Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 20))
                    .foregroundColor(voice.isMuted ? Theme.danger : Theme.ink1)
                    .frame(width: 54, height: 54)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

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

            Button { Task { await voice.toggleScreenShare() } } label: {
                Image(systemName: voice.isScreenSharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
                    .font(.system(size: 18))
                    .foregroundColor(voice.isScreenSharing ? Theme.accent : Theme.ink1)
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
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .top)
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

            Button { Task { await store.toggleVoiceMute() } } label: {
                Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 15))
                    .foregroundColor(voice.isMuted ? Theme.danger : Theme.ink1)
                    .frame(width: 32, height: 32)
                    .background(Theme.bg3)
                    .clipShape(Circle())
            }
            .disabled(!voice.isConnected)
            .opacity(voice.isConnected ? 1 : 0.5)

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
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundColor(Theme.ink2)
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
                    Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 18)).foregroundColor(voice.isMuted ? .white : Theme.ink1)
                        .frame(width: 52, height: 44)
                        .background(voice.isMuted ? Theme.danger : Theme.bg3)
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
        .background(Theme.bg1)
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
                Button { Task { await store.toggleVoiceMute() } } label: {
                    Image(systemName: voice.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 15)).foregroundColor(voice.isMuted ? Theme.danger : Theme.ink2)
                        .frame(width: 36, height: 32)
                }
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
