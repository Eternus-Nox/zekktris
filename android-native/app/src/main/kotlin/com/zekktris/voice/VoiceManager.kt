package com.zekktris.voice

import android.content.Context
import android.media.AudioManager
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.RoomOptions
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.VideoPreset169
import livekit.org.webrtc.RtpParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock

/**
 * Thin wrapper over the LiveKit Android SDK for voice-only calls. Mirrors the
 * iOS `VoiceManager`: connect a Room, publish the mic, surface active-speaker +
 * connection state. The visible roster is driven by the server's voice states
 * (in [com.zekktris.AppStore]); LiveKit only provides audio + speaking state.
 *
 * Teardown ordering matters — null the room synchronously and cancel the event
 * collector BEFORE disconnect() so concurrent mute/mic ops bail (the analog of
 * the iOS `isTearingDown` guard that avoids a WebRTC use-after-free).
 */
class VoiceManager(private val appContext: Context, private val scope: CoroutineScope) {

    enum class ConnState { Idle, Connecting, Connected, Reconnecting, Failed }

    private val _connState = MutableStateFlow(ConnState.Idle)
    val connState: StateFlow<ConnState> = _connState.asStateFlow()

    private val _speaking = MutableStateFlow<Set<String>>(emptySet())
    /** User ids currently speaking (LiveKit active speakers, by participant identity). */
    val speaking: StateFlow<Set<String>> = _speaking.asStateFlow()

    private val _muted = MutableStateFlow(false)
    val muted: StateFlow<Boolean> = _muted.asStateFlow()

    /** Deafened = no remote audio plays for the local listener (mic muted too). */
    private val _deafened = MutableStateFlow(false)
    val deafened: StateFlow<Boolean> = _deafened.asStateFlow()

    /** Per-user "mute for me" (local only): their audio is silenced for you. */
    private val _mutedForMe = MutableStateFlow<Set<String>>(emptySet())
    val mutedForMe: StateFlow<Set<String>> = _mutedForMe.asStateFlow()

    /** Push-to-talk: while enabled the mic is closed unless the Talk button is held.
     *  NOT seeded here — this object is constructed in ZekApp.onCreate, so a
     *  disk read at this point is a main-thread hit on every cold start. The
     *  saved preference is loaded in performConnect() instead, which is what
     *  actually gates the mic; nothing renders this before a call (the Settings
     *  switch reads the pref directly). */
    private val _pttEnabled = MutableStateFlow(false)
    val pttEnabled: StateFlow<Boolean> = _pttEnabled.asStateFlow()
    private var pttHeld = false

    /** Local camera on/off + the published local video track (for self-preview). */
    private val _cameraOn = MutableStateFlow(false)
    val cameraOn: StateFlow<Boolean> = _cameraOn.asStateFlow()
    private val _localVideo = MutableStateFlow<VideoTrack?>(null)
    val localVideo: StateFlow<VideoTrack?> = _localVideo.asStateFlow()
    /** Local screen-share on/off + the published local screen track (self-preview). */
    private val _screenOn = MutableStateFlow(false)
    val screenOn: StateFlow<Boolean> = _screenOn.asStateFlow()
    private val _localScreen = MutableStateFlow<VideoTrack?>(null)
    val localScreen: StateFlow<VideoTrack?> = _localScreen.asStateFlow()
    /** userId → their subscribed remote camera track. */
    private val _remoteVideo = MutableStateFlow<Map<String, VideoTrack>>(emptyMap())
    val remoteVideo: StateFlow<Map<String, VideoTrack>> = _remoteVideo.asStateFlow()
    /** userId → their subscribed remote SCREEN-SHARE track (rendered separately). */
    private val _remoteScreen = MutableStateFlow<Map<String, VideoTrack>>(emptyMap())
    val remoteScreen: StateFlow<Map<String, VideoTrack>> = _remoteScreen.asStateFlow()

    // Authoritative mic intent (separate from the EFFECTIVE _muted the UI reads):
    // the user's explicit mute. The real mic state is DERIVED from userMuted +
    // deafen + PTT by reconcileMic(), so no path independently toggles the mic.
    private var userMuted = false
    // Serializes every mic-affecting op so concurrent toggles (esp. rapid PTT
    // press/release) can't resolve out of order and leave a hot mic.
    private val micLock = kotlinx.coroutines.sync.Mutex()

    /** Desired mic-open = not deafened, and (PTT ? held : not-user-muted). Applies
     *  it under the lock and republishes the effective muted state. */
    private suspend fun reconcileMic() {
        micLock.withLock {
            val r = room ?: return
            if (tearingDown) return
            val open = !_deafened.value && (if (_pttEnabled.value) pttHeld else !userMuted)
            runCatching { r.localParticipant.setMicrophoneEnabled(open) }
            _muted.value = !open
        }
    }

    private var room: Room? = null
    private var eventsJob: Job? = null
    @Volatile private var tearingDown = false

    /** Serializes connect vs disconnect so the two can NEVER overlap on one Room.
     *  [tearingDown] alone is not enough — it guards the INNER mic/track ops, but
     *  it cannot stop a leave/hangup that lands while connect() is still awaiting
     *  the SFU handshake: `room` is assigned BEFORE `r.connect(...)`, so that
     *  teardown runs against the very Room connect() is still building, and
     *  LiveKit reaches Room.cleanUpRTC -> TransportMode.close() while WebRTC is
     *  still using the transport.
     *
     *  This is not theoretical: iOS shipped the identical shape and it produced a
     *  reproducible EXC_BAD_ACCESS on the WebRTC worker thread (four device crash
     *  logs; worst when connect is slow — backgrounded, locked, VoIP-launched — so
     *  the user's decline/hangup lands mid-connect). Fixed there in 60d49da by
     *  serializing the two ops; this is the Kotlin analogue of that `sessionChain`.
     *
     *  Held across the WHOLE of connect and the WHOLE of disconnect. Nothing run
     *  under it ever waits on the other op — [performConnect] calls
     *  [performDisconnect] directly rather than going through the public
     *  disconnect(), which would deadlock on this non-reentrant lock — and the
     *  RoomEvent.Disconnected teardown is launched on `scope`, so it only queues
     *  behind an in-flight connect instead of blocking it. */
    private val sessionLock = kotlinx.coroutines.sync.Mutex()

    // ---- call sounds --------------------------------------------------------

    /** Synthesized connect/hangup/join/leave cues (see [VoiceSounds]). */
    private val sounds = VoiceSounds()

    /** True once this call actually reached Connected. Gates the HANGUP cue so a
     *  connect that FAILED (performConnect()'s catch tears down) doesn't play a
     *  "call ended" tone for a call that never began. */
    @Volatile private var callWasConnected = false

    /** Someone ELSE joined/left the voice channel we're in. Called by AppStore,
     *  which owns the "is this our channel / is this us" decision; deafen and the
     *  rate limit are enforced here so there is one gate, not several.
     *
     *  Deafened means NO audio — a blip that ignores it is a bug, so these are
     *  dropped outright rather than queued. */
    fun playPeerJoined() { if (!_deafened.value) sounds.play(VoiceSounds.Cue.JOIN) }
    fun playPeerLeft() { if (!_deafened.value) sounds.play(VoiceSounds.Cue.LEAVE) }

    /** The user's saved push-to-talk preference. Same SharedPreferences file +
     *  key the settings switch writes (SettingsScreen.kt), so the two cannot
     *  drift. */
    private fun savedPushToTalk(): Boolean =
        appContext.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE)
            .getBoolean("zk.pushToTalk", false)

    /** Live camera-quality entitlement check, assigned by AppStore from the
     *  admin-configured monetization matrix against the signed-in user's
     *  membership (the iOS `cameraQualityAllowed`). Takes a quality value
     *  ("high"/"k2"/"k4") and answers whether the user may publish it.
     *
     *  Null (not wired yet) is PERMISSIVE, not fail-closed: the clamp below now
     *  runs on every publish path, so a predicate that is merely unassigned
     *  would silently drop every paying user to 1080p forever. Until it is
     *  wired the Settings picker stays the gate, exactly as it was before. */
    @Volatile var cameraQualityAllowed: ((String) -> Boolean)? = null

    /** Clamp to the highest tier the membership entitles. The picker enforced
     *  this in the SETTINGS UI only, so a LAPSED membership kept publishing 4K
     *  forever — the snap-back only ran if the user happened to reopen
     *  Settings. Applied at PUBLISH time instead; the saved preference is
     *  untouched and simply re-activates if the tier comes back. Walks DOWN the
     *  ladder to the first allowed rung (a Guardian with 4K saved gets 2K, not
     *  a hard drop to 1080p); 720p and below are always free. */
    private fun entitledCameraQuality(q: String): String {
        val ladder = listOf("k4", "k2", "high")
        val start = ladder.indexOf(q)
        if (start < 0) return q
        val allowed: (String) -> Boolean =
            cameraQualityAllowed ?: { _ -> true } // unwired: never downgrade
        return ladder.drop(start).firstOrNull(allowed) ?: "medium"
    }

    /** The user's saved camera quality, clamped to the membership entitlement.
     *  Same SharedPreferences file + key the settings picker writes
     *  (SettingsScreen.kt), and the same "high" default, so the two cannot
     *  drift. Read at publish time — NOT cached at connect — so a change
     *  applies on the next camera-on, matching iOS. */
    private fun savedCameraQuality(): String =
        entitledCameraQuality(
            appContext.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE)
                .getString("zk.cameraQuality", "high") ?: "high"
        )

    /** Capture size + encoder budget for a quality tier, mirroring iOS
     *  (Voice.swift cameraCaptureOptions/cameraPublishOptions) so the two
     *  platforms publish the same thing for the same user choice. */
    private fun cameraPreset(q: String): Pair<VideoCaptureParameter, VideoEncoding> = when (q) {
        "low" -> VideoCaptureParameter(640, 480, 15) to VideoEncoding(600_000, 15)
        "medium" -> VideoPreset169.H720.capture to VideoEncoding(2_000_000, 30)
        "auto" -> VideoPreset169.H720.capture to VideoEncoding(2_500_000, 30)
        "k2" -> VideoPreset169.H1440.capture to VideoEncoding(6_000_000, 30)
        "k4" -> VideoPreset169.H2160.capture to VideoEncoding(10_000_000, 30)
        // "high" and anything unrecognised -> 1080p, the shipped default.
        else -> VideoPreset169.H1080.capture to VideoEncoding(3_000_000, 30)
    }

    /** Publish defaults for a tier.
     *
     *  simulcast stays ON: raising capture to 1080p+ on a software encoder means
     *  weak viewers MUST have a lower rung to fall back to.
     *
     *  degradationPreference BALANCED is the "auto correct itself" lever — it
     *  lets the encoder shed pixels under CPU/uplink pressure and climb back when
     *  it clears. Left unset the SDK picks for us, and on iOS the equivalent
     *  fallback pinned MAINTAIN_RESOLUTION, which forbids shedding pixels: a
     *  throttled encoder then holds full resolution and dumps everything into the
     *  quantizer, i.e. a full-size permanently smeared picture. Same class of bug,
     *  fixed the same way on all three platforms.
     *
     *  Codec is deliberately left at the SDK default — forcing H.264 reintroduces
     *  the documented native->browser non-render failure (see Voice.swift:388-397). */
    private fun cameraPublishDefaults(enc: VideoEncoding) = VideoTrackPublishDefaults(
        videoEncoding = enc,
        simulcast = true,
        degradationPreference = RtpParameters.DegradationPreference.BALANCED,
    )

    /** Connect to the SFU and publish the mic. Safe to call after a prior call.
     *  [publishMic] false = stage-audience mode: subscribe-only, mic stays closed
     *  (the server token has canPublish=false anyway — trying to publish would
     *  just fail at the SFU). A later promotion reconnects with publishMic=true.
     *
     *  Thin wrapper: the work runs under [sessionLock] so a leave/hangup arriving
     *  mid-connect waits instead of tearing down the transport under us. */
    suspend fun connect(url: String, token: String, publishMic: Boolean = true) {
        sessionLock.withLock { performConnect(url, token, publishMic) }
    }

    private suspend fun performConnect(url: String, token: String, publishMic: Boolean) {
        // Already inside the serialized section: call the raw teardown, NOT the
        // public disconnect() — that would deadlock on the lock we hold.
        performDisconnect()
        tearingDown = false
        // Clear the EFFECTIVE mute at the START of a join, not during teardown.
        // reconcileMic() only rewrites it on a successful connect, so a failed
        // join would otherwise inherit the previous call's mute and report it to
        // the server as this call's state. Doing it here rather than in
        // performDisconnect also avoids flipping the mic button back to unmuted
        // while the leave UI is still on screen awaiting the REST round-trip,
        // and covers the first-ever connect (performDisconnect bails on a null
        // room before it resets anything).
        _muted.value = false
        // Re-read PTT on every join: this object is a process singleton, so a
        // switch flipped in Settings after construction would otherwise never
        // reach the mic gate and the user joins with a live open mic.
        _pttEnabled.value = savedPushToTalk()
        _connState.value = ConnState.Connecting
        // Seed the room with the user's saved tier. Previously this was a bare
        // LiveKit.create(appContext) with NO RoomOptions, so the camera-quality
        // preference was DEAD CONFIG — a full-tree grep found it read nowhere
        // outside the settings screen, and every Android user published the SDK
        // default 720p @ 1.7 Mbps regardless of what they picked (or paid for).
        val (cap, enc) = cameraPreset(savedCameraQuality())
        val r = LiveKit.create(
            appContext,
            options = RoomOptions(
                videoTrackCaptureDefaults = LocalVideoTrackOptions(captureParams = cap),
                videoTrackPublishDefaults = cameraPublishDefaults(enc),
            ),
        )
        room = r
        eventsJob = scope.launch { r.events.collect { onEvent(it) } }
        try {
            r.connect(url, token)
            runCatching { CallService.start(appContext) }
            preferSpeakerphone(true)
            // Express INTENT (audience = muted, so any mic UI reads truthfully)
            // and let reconcileMic() derive the real mic under micLock. Writing
            // the mic state raw here CLOBBERED a mute/deafen the user tapped
            // during the "Connecting…" handshake: the UI showed deafened over a
            // LIVE mic. Reconciling means that intent either wins or is
            // re-applied, and PTT can't be opened by the join either.
            //
            // OR'd, not assigned: a plain assignment still erased a mute tapped
            // mid-handshake (setMuted ran while we awaited the SFU, then this
            // line reset it to false and reconcileMic opened the mic). Audience
            // mode still forces muted; the user's own mute now survives too.
            userMuted = userMuted || !publishMic
            // Publish the mic ONCE before reconciling, then let reconcileMic mute
            // it. LiveKit's disable path only mutes an EXISTING publication — with
            // none yet it is a pure no-op — so a push-to-talk user would otherwise
            // join with no audio track at all, and the first Talk press would have
            // to create and publish one mid-sentence, clipping their opening words.
            if (publishMic) runCatching { r.localParticipant.setMicrophoneEnabled(true) }
            reconcileMic()
            _connState.value = ConnState.Connected
            // CONNECT fires HERE — on a genuine join only. The Reconnected event
            // also drives connState to Connected, and deliberately does NOT play
            // it: a flapping network would otherwise machine-gun the sound.
            callWasConnected = true
            sounds.beginCall()
            if (!_deafened.value) sounds.play(VoiceSounds.Cue.CONNECT)
        } catch (t: Throwable) {
            // Raw teardown again — we still hold [sessionLock]. The state is
            // written AFTER it because performDisconnect() drives connState to
            // Idle: setting Failed first was silently overwritten, so a failed
            // connect showed no error and no Rejoin control and the user sat in
            // a dead call view. Same ordering as the Disconnected handler.
            performDisconnect()
            _connState.value = ConnState.Failed
        }
    }

    private fun onEvent(ev: RoomEvent) {
        when (ev) {
            is RoomEvent.ActiveSpeakersChanged ->
                _speaking.value = ev.speakers.mapNotNull { it.identity?.value }.toSet()
            is RoomEvent.Reconnecting -> _connState.value = ConnState.Reconnecting
            // Reconnected: the event-sourced remote maps can miss a subscribe that
            // raced the reconnect, so rebuild them from the room's truth.
            is RoomEvent.Reconnected -> { _connState.value = ConnState.Connected; syncRemoteTracks() }
            is RoomEvent.Disconnected -> {
                // A deliberate local teardown sets tearingDown first and drives its
                // own state. An UNEXPECTED drop (LiveKit gave up after exhausting
                // its own reconnects) leaves a DEAD Room — run the full teardown so
                // `room` is nulled, CallService is stopped and the audio mode is
                // restored, then surface Failed so the UI shows "Connection failed"
                // + a Rejoin control instead of a fake "N in voice" roster over
                // silence. Launched on `scope` (not the events collector) so
                // disconnect()'s eventsJob.cancel() can't cancel us mid-teardown.
                if (!tearingDown) {
                    tearingDown = true
                    // Remember WHICH room died. This teardown now queues behind an
                    // in-flight connect (sessionLock), so by the time it runs the
                    // live room may already be a different, healthy one — killing
                    // that would be exactly the use-after-free we're avoiding.
                    val dead = room
                    scope.launch {
                        sessionLock.withLock {
                            if (room !== dead) return@withLock
                            performDisconnect()
                            _connState.value = ConnState.Failed
                        }
                    }
                }
            }
            // A newly-subscribed remote track: reconcile audio (deafen/mute-for-me),
            // and register a remote CAMERA video track for its tile.
            is RoomEvent.TrackSubscribed -> {
                applyRemoteAudio()
                val track = ev.track
                // Same muted guard as syncRemoteTracks: subscribing to an
                // already-muted camera must NOT create a tile. `muted` only
                // fires TrackMuted on a CHANGE, so a peer whose camera was
                // already off when we subscribed never sends one — the tile
                // would sit black until some unrelated event re-synced.
                if (track is VideoTrack && !ev.publication.muted) {
                    ev.participant.identity?.value?.let { uid ->
                        if (ev.publication.source == Track.Source.SCREEN_SHARE)
                            _remoteScreen.value = _remoteScreen.value + (uid to track)
                        else
                            _remoteVideo.value = _remoteVideo.value + (uid to track)
                    }
                }
            }
            is RoomEvent.TrackUnsubscribed -> {
                val track = ev.track
                if (track is VideoTrack) {
                    ev.participant.identity?.value?.let { uid ->
                        if (_remoteVideo.value[uid] === track) _remoteVideo.value = _remoteVideo.value - uid
                        if (_remoteScreen.value[uid] === track) _remoteScreen.value = _remoteScreen.value - uid
                    }
                }
            }
            // A remote camera-off arrives as a MUTE, not an unsubscribe (LiveKit
            // keeps the publication), so without these the tile stayed on stage
            // frozen on their last frame forever — and camera-back-on had no
            // event to re-add it either. Re-sync drops/restores the tile.
            is RoomEvent.TrackMuted -> if (ev.publication.kind == Track.Kind.VIDEO) syncRemoteTracks()
            is RoomEvent.TrackUnmuted -> if (ev.publication.kind == Track.Kind.VIDEO) syncRemoteTracks()
            is RoomEvent.ParticipantDisconnected ->
                ev.participant.identity?.value?.let { uid ->
                    _remoteVideo.value = _remoteVideo.value - uid
                    _remoteScreen.value = _remoteScreen.value - uid
                }
            else -> {}
        }
    }

    /** Reconcile every remote audio publication's local playback against the
     *  current deafen + per-user-mute state. */
    private fun applyRemoteAudio() {
        val r = room ?: return
        if (tearingDown) return
        val deaf = _deafened.value
        val muteSet = _mutedForMe.value
        r.remoteParticipants.values.forEach { part ->
            val uid = part.identity?.value
            val enabled = !deaf && !(uid != null && muteSet.contains(uid))
            part.audioTrackPublications.forEach { (pub, _) ->
                (pub as? io.livekit.android.room.track.RemoteTrackPublication)?.let {
                    runCatching { it.setEnabled(enabled) }
                }
            }
        }
    }

    /** Rebuild the remote camera/screen-share maps from the room's current roster
     *  and re-apply audio. The event-sourced maps can miss a subscribe that raced
     *  a full reconnect, leaving stale/blank tiles; this self-heals on Reconnected
     *  (mirrors iOS syncRemoteTracks). */
    private fun syncRemoteTracks() {
        val r = room ?: return
        if (tearingDown) return
        val video = HashMap<String, VideoTrack>()
        val screen = HashMap<String, VideoTrack>()
        r.remoteParticipants.values.forEach { part ->
            val uid = part.identity?.value ?: return@forEach
            part.videoTrackPublications.forEach { (pub, track) ->
                // Skip a MUTED video publication — that is how a remote camera-off
                // arrives — or their last frame stays on screen as a frozen tile.
                if (pub.muted) return@forEach
                val vt = track as? VideoTrack ?: return@forEach
                if (pub.source == Track.Source.SCREEN_SHARE) screen[uid] = vt else video[uid] = vt
            }
        }
        _remoteVideo.value = video
        _remoteScreen.value = screen
        applyRemoteAudio()
    }

    /** The user's explicit mute toggle. Under PTT it only sets intent — the mic
     *  stays PTT-gated — so the mini-bar toggle can never open a hot mic. */
    suspend fun setMuted(mute: Boolean) {
        userMuted = mute
        reconcileMic()
    }

    /** Toggle deafen: silence all remote audio + mute the mic; restore on
     *  undeafen (the mic derives from the preserved userMuted/PTT state, so the
     *  user's explicit mute survives a deafen cycle). Mirrors iOS toggleDeafen. */
    suspend fun toggleDeafen() {
        if (room == null || tearingDown) return
        _deafened.value = !_deafened.value
        applyRemoteAudio()
        reconcileMic()
    }

    /** Silence (or un-silence) a single remote participant for the local listener. */
    fun setMutedForMe(userId: String, muted: Boolean) {
        _mutedForMe.value = if (muted) _mutedForMe.value + userId else _mutedForMe.value - userId
        applyRemoteAudio()
    }

    /** Enable/disable push-to-talk. Enabling closes the mic until Talk is held. */
    suspend fun setPttEnabled(on: Boolean) {
        _pttEnabled.value = on
        // Persisted to the same pref the Settings switch owns, so the in-call
        // toggle survives the call — otherwise the next join reopened the mic.
        appContext.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE)
            .edit().putBoolean("zk.pushToTalk", on).apply()
        if (on) pttHeld = false
        reconcileMic()
    }

    /** Press/release the Talk button (no-op unless PTT is enabled). Serialized via
     *  reconcileMic so a rapid tap can't leave the mic open after release. */
    suspend fun setPttHeld(held: Boolean) {
        if (!_pttEnabled.value) return
        pttHeld = held
        reconcileMic()
    }

    // ---- video / camera -----------------------------------------------------

    /** Attach the Room's EGL context to a renderer before a track draws into it. */
    fun initRenderer(view: TextureViewRenderer) {
        runCatching { room?.initVideoRenderer(view) }
    }

    /** Serializes camera publish/unpublish so rapid taps can't race on a stale
     *  read (mirrors the mic path). */
    private val camLock = kotlinx.coroutines.sync.Mutex()

    /** The tier the LIVE camera publication was actually built with (iOS
     *  `publishedCameraQuality`). Null = no publication we can vouch for. */
    private var publishedCameraQuality: String? = null

    /** Publish/unpublish the local camera; commits cameraOn ONLY when the publish
     *  actually succeeds so the UI never reports a camera that isn't live. */
    suspend fun toggleCamera() {
        camLock.withLock {
            val r = room ?: return
            if (tearingDown) return
            val next = !_cameraOn.value
            val q = savedCameraQuality()
            // Re-read the pref on every camera-ON and hand the tier to the SDK
            // explicitly, so changing quality in settings applies on the next
            // toggle instead of being frozen at whatever connect() seeded.
            if (next) {
                val (cap, enc) = cameraPreset(q)
                runCatching {
                    r.localParticipant.videoTrackCaptureDefaults =
                        LocalVideoTrackOptions(captureParams = cap)
                    r.localParticipant.videoTrackPublishDefaults = cameraPublishDefaults(enc)
                }
                // setCameraEnabled(true) SHORT-CIRCUITS to a bare unmute when a
                // publication already exists (camera-off only mutes it), so it
                // never looks at the defaults above: every re-enable silently
                // reused the tier chosen on the FIRST camera-on, and "Changes
                // apply the next time you turn your camera on" was a lie. So
                // when the live publication was built with a different tier,
                // unpublish it and let the enable below take the create-and-
                // publish path. The cached camera track is reused by the SDK, so
                // re-point its capture params too or the new publish would go
                // out at the new bitrate over the OLD capture size. Unchanged
                // tier keeps the cheap unmute path — this must not turn an
                // ordinary camera toggle into a renegotiation.
                if (publishedCameraQuality != q) {
                    runCatching {
                        val pub = r.localParticipant.getTrackPublication(Track.Source.CAMERA)
                        (pub?.track as? LocalVideoTrack)?.let { t ->
                            t.options = t.options.copy(captureParams = cap)
                            // OFF the main thread: unpublishTrack is not suspend
                            // and internally runBlocking-s on the RTC peer
                            // connection, so calling it from this Main.immediate
                            // coroutine freezes the UI until that thread drains
                            // — possibly across a renegotiation.
                            withContext(Dispatchers.IO) { r.localParticipant.unpublishTrack(t) }
                        }
                    }
                    publishedCameraQuality = null
                    _localVideo.value = null
                }
            }
            val ok = runCatching { r.localParticipant.setCameraEnabled(next) }.isSuccess
            // Failed to turn the camera ON → stay off (don't lie). Turning OFF
            // always commits even if the SDK call errors. The tier claim is
            // dropped on failure so the next toggle republishes rather than
            // unmuting something that may not be there.
            if (next && !ok) { publishedCameraQuality = null; return }
            _cameraOn.value = next
            // Camera-OFF deliberately keeps the claim: the publication survives
            // (muted), still carrying these encoder settings.
            if (next) publishedCameraQuality = q
            _localVideo.value = if (next) {
                runCatching { r.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack }.getOrNull()
            } else null
        }
    }

    /** Flip between the front and back camera (no-op when the camera is off). */
    suspend fun flipCamera() {
        val track = _localVideo.value as? LocalVideoTrack ?: return
        runCatching { track.switchCamera() }
    }

    /** Serializes screen-share publish/unpublish (mirrors camLock). */
    private val screenLock = kotlinx.coroutines.sync.Mutex()

    /** Publish the local screen using the MediaProjection permission result. The
     *  LiveKit SDK runs its own mediaProjection foreground service. Commits
     *  screenOn only when the publish actually succeeds. */
    suspend fun startScreenShare(resultData: android.content.Intent) {
        screenLock.withLock {
            val r = room ?: return
            if (tearingDown || _screenOn.value) return
            val params = io.livekit.android.room.track.screencapture.ScreenCaptureParams(resultData)
            val ok = runCatching { r.localParticipant.setScreenShareEnabled(true, params) }.isSuccess
            if (!ok) return
            _screenOn.value = true
            _localScreen.value = runCatching { r.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track as? VideoTrack }.getOrNull()
        }
    }

    suspend fun stopScreenShare() {
        screenLock.withLock {
            val r = room ?: return
            runCatching { r.localParticipant.setScreenShareEnabled(false) }
            _screenOn.value = false
            _localScreen.value = null
        }
    }

    fun setSpeaker(on: Boolean) = preferSpeakerphone(on)

    private fun preferSpeakerphone(on: Boolean) {
        runCatching {
            val am = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = on
        }
    }

    /** Thin wrapper — see [sessionLock]. Waits for any in-flight connect so the
     *  two never overlap on one Room. */
    suspend fun disconnect() {
        sessionLock.withLock { performDisconnect() }
    }

    private suspend fun performDisconnect() {
        val r = room ?: return
        tearingDown = true
        room = null
        // HANGUP — every call end funnels through here exactly once: the local
        // user leaving, the remote party ending it (handleSelfVoiceEnd /
        // maybeAutoHangup), and an unexpected drop (RoomEvent.Disconnected). The
        // `room ?: return` above makes the duplicate disconnect() that follows a
        // local leave a no-op, so it can't double-play.
        //
        // Played BEFORE the state reset below (which clears _deafened) so a
        // deafened user still hears nothing, and before AudioManager.mode goes
        // back to MODE_NORMAL so it still follows the in-call volume/route.
        if (callWasConnected && !_deafened.value) sounds.play(VoiceSounds.Cue.HANGUP)
        callWasConnected = false
        eventsJob?.cancel(); eventsJob = null
        _speaking.value = emptySet()
        _deafened.value = false
        _mutedForMe.value = emptySet()
        // _pttEnabled is NOT reset — it is a persisted user PREFERENCE, not call
        // state. Clearing it here meant the next join ignored the setting and
        // came up with a live open mic. Only the transient hold is dropped.
        pttHeld = false
        userMuted = false
        _cameraOn.value = false
        publishedCameraQuality = null
        _localVideo.value = null
        _screenOn.value = false
        _localScreen.value = null
        _remoteVideo.value = emptyMap()
        _remoteScreen.value = emptyMap()
        _connState.value = ConnState.Idle
        runCatching { r.disconnect() }
        // The mic foreground service is tied to a live call — a bare disconnect()
        // (leave, or connect()'s pre-teardown when switching) must stop it too, or
        // the ongoing "Voice call in progress" notification lingers with no call.
        runCatching { CallService.stop(appContext) }
        runCatching {
            val am = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_NORMAL
        }
        // Stop routing cues through the call stream and reclaim the AudioTracks
        // once the hangup tone has drained (the cached PCM is kept — a few KB).
        sounds.endCall()
    }
}
