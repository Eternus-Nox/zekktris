/* Hang-up vs. a join in flight (src/lib/voice.ts).
 *
 * Connect and disconnect share one serial chain, and the Room being connected
 * only becomes the module `room` once r.connect resolves. So a Leave used to
 * queue behind the whole join — LiveKit's 15 s + 15 s connect timeouts, a slow
 * mic publish, or a mic-permission prompt left open — and nothing could abort
 * it. hangUpVoice() cancels the join instead, through LiveKit's own cancel
 * (Room.disconnect() on the Room being built).
 *
 * These drive the REAL voice.ts against a fake livekit-client whose connect,
 * mic capture + publish and getUserMedia probe are deferreds the test
 * controls. The fake follows livekit-client 2.18.9's ordering where it
 * matters: Room.disconnect() rejects a pending connect first and only then
 * closes the engine (a second call waits for that close, as on LiveKit's
 * disconnect lock); setMicrophoneEnabled(true) opens its OWN capture
 * (createTracks), which a disconnect doesn't abort, and a publish that then
 * finds the engine closed is parked in LocalParticipant.pendingPublishPromises
 * — live — until LiveKit's 15 s publish timeout. Node environment, so the DOM
 * globals voice.ts touches are stubbed. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  type D<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
  const deferred = <T = void>(): D<T> => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  type FakeStream = { stopped: boolean; getTracks: () => Array<{ stop: () => void }> };
  const fakeStream = (): FakeStream => {
    const s: FakeStream = {
      stopped: false,
      getTracks: () => [
        {
          stop: () => {
            s.stopped = true;
          },
        },
      ],
    };
    return s;
  };
  /** A mic track LiveKit captured (createTracks): live until stopped. */
  type MicTrack = { room: number; live: boolean; liveAt: number; stoppedAt: number; stop: () => void };
  const state = {
    t0: Date.now(),
    log: [] as string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rooms: [] as any[],
    /** How many OTHER Rooms were still live (connecting, connected, or
        closing their engine) when each Room was built. The serial chain
        exists to keep this at 0: two live Rooms share one LiveKit identity
        (DUPLICATE_IDENTITY). */
    liveAtConstruction: [] as number[],
    micCalls: [] as Array<{ room: number; on: boolean }>,
    micTracks: [] as MicTrack[],
    gumCalls: 0,
    counts: { connectChime: 0, endChime: 0, bgEnter: 0, bgExit: 0 },
    onHangup: null as null | (() => void),
    ctl: {
      connect: (): Promise<void> => Promise.resolve(),
      /** LiveKit's own capture inside setMicrophoneEnabled (createTracks). */
      capture: (): Promise<void> => Promise.resolve(),
      /** The publish of that capture, once the engine is still up. */
      mic: (): Promise<unknown> => Promise.resolve(),
      /** LiveKit's 15 s timeout on a publish parked for a closed engine. */
      publishTimeout: (): Promise<void> => new Promise<void>(() => {}),
      gum: (): Promise<unknown> => Promise.resolve(fakeStream()),
      switchOutput: (): Promise<void> => Promise.resolve(),
      /** How long Room.disconnect() takes to close the engine (sendLeave +
          engine.close()) AFTER it has rejected a pending connect. */
      closeMs: 0,
    },
  };
  const mark = (s: string) => state.log.push(`${String(Date.now() - state.t0).padStart(5)}ms  ${s}`);
  const micTrack = (room: number): MicTrack => {
    const t: MicTrack = {
      room,
      live: true,
      liveAt: Date.now(),
      stoppedAt: -1,
      stop: () => {
        if (!t.live) return;
        t.live = false;
        t.stoppedAt = Date.now();
        mark(`Room#${room} mic track stopped`);
      },
    };
    state.micTracks.push(t);
    mark(`Room#${room} mic track LIVE`);
    return t;
  };
  return { deferred, sleep, fakeStream, state, mark, micTrack };
});

// ── fake livekit-client ───────────────────────────────────────────────────
vi.mock('livekit-client', () => {
  const names = new Proxy({}, { get: (_t, k) => String(k) });
  class Room {
    id: number;
    createdAt: number;
    state = 'disconnected';
    /** Connecting, connected, or still closing its engine. */
    live = false;
    engineClosed = false;
    connectCalls = 0;
    disconnectCalls = 0;
    remoteParticipants = new Map();
    listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    abortConnect?: (why: string) => void;
    abortPublish?: (why: string) => void;
    closing?: Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    localParticipant: any;
    constructor(_opts: unknown) {
      h.state.liveAtConstruction.push(h.state.rooms.filter((r) => r.live).length);
      this.id = h.state.rooms.length + 1;
      this.createdAt = Date.now();
      h.state.rooms.push(this);
      h.mark(`new Room#${this.id}`);
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const lpListeners = new Map<string, Set<() => void>>();
      const lp = {
        identity: 'me',
        connectionQuality: 'unknown',
        trackPublications: new Map<string, { kind: string; track: { stop: () => void } }>(),
        /** LiveKit's internal LocalParticipant.pendingPublishPromises. */
        pendingPublishPromises: new Map<{ stop: () => void }, Promise<unknown>>(),
        on(ev: string, cb: () => void) {
          if (!lpListeners.has(ev)) lpListeners.set(ev, new Set());
          lpListeners.get(ev)!.add(cb);
        },
        off(ev: string, cb: () => void) {
          lpListeners.get(ev)?.delete(cb);
        },
        async setMicrophoneEnabled(on: boolean) {
          h.state.micCalls.push({ room: self.id, on });
          if (!on) return;
          // createTracks: LiveKit's OWN getUserMedia. A disconnect doesn't
          // abort it.
          await h.state.ctl.capture();
          const track = h.micTrack(self.id);
          for (const cb of [...(lpListeners.get('AudioStreamAcquired') ?? [])]) cb();
          // publishOrRepublishTrack runs a few microtasks later.
          await Promise.resolve();
          await Promise.resolve();
          if (self.engineClosed) {
            // Signal not CONNECTED: the publish is deferred until it is —
            // never, on a closed engine — under a 15 s timeout that stops
            // the track. Room.disconnect() doesn't touch it.
            h.mark(`Room#${self.id} publish parked: signal not connected`);
            const parked = h.state.ctl.publishTimeout().then(() => {
              track.stop();
              throw new Error('publishing rejected as engine not connected within timeout');
            });
            lp.pendingPublishPromises.set(track, parked);
            try {
              return await parked;
            } finally {
              lp.pendingPublishPromises.delete(track);
            }
          }
          // The publish proper: engine.close() rejects it (cleanupClient),
          // and setTrackEnabled then stops the track.
          const abort = h.deferred<never>();
          self.abortPublish = (why) => abort.reject(new Error(why));
          try {
            await Promise.race([h.state.ctl.mic(), abort.promise]);
          } catch (e) {
            track.stop();
            throw e;
          } finally {
            self.abortPublish = undefined;
          }
          const publication = { kind: 'audio', track };
          lp.trackPublications.set(`mic-${self.id}`, publication);
          return publication;
        },
        async setCameraEnabled() {},
        async setScreenShareEnabled() {},
      };
      this.localParticipant = lp;
    }
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev)!.add(cb);
      return this;
    }
    off(ev: string, cb: (...a: unknown[]) => void) {
      this.listeners.get(ev)?.delete(cb);
      return this;
    }
    emit(ev: string, ...a: unknown[]) {
      for (const cb of [...(this.listeners.get(ev) ?? [])]) cb(...a);
    }
    async connect(_url: string, _token: string) {
      this.connectCalls++;
      this.state = 'connecting';
      this.live = true;
      h.mark(`Room#${this.id}.connect() pending`);
      // The real SDK (Room.ts disconnect): a disconnect while Connecting aborts
      // the attempt and rejects the pending connect.
      const abort = h.deferred<never>();
      this.abortConnect = (why) => abort.reject(new Error(why));
      try {
        await Promise.race([h.state.ctl.connect(), abort.promise]);
      } catch (e) {
        this.state = 'disconnected';
        h.mark(`Room#${this.id}.connect() rejected: ${(e as Error).message}`);
        // A genuine failure is over here; a cancel stays live until
        // disconnect() has closed the engine.
        if (!this.closing) {
          this.live = false;
          this.emit('Disconnected');
        }
        throw e;
      } finally {
        this.abortConnect = undefined;
      }
      this.state = 'connected';
      h.mark(`Room#${this.id}.connect() resolved`);
    }
    disconnect(): Promise<void> {
      this.disconnectCalls++;
      h.mark(`Room#${this.id}.disconnect() (state=${this.state})`);
      // A second call waits for the first's close (LiveKit's disconnect lock).
      if (!this.closing) this.closing = this.close();
      return this.closing;
    }
    private async close() {
      if (!this.live) return;
      // Room.disconnect(): the pending connect is rejected FIRST...
      if (this.state === 'connecting') this.abortConnect?.('Client initiated disconnect');
      // ...then sendLeave + engine.close(): Closing rejects a pending publish.
      this.engineClosed = true;
      this.abortPublish?.('engine closed');
      if (h.state.ctl.closeMs) await h.sleep(h.state.ctl.closeMs);
      // handleDisconnect: stops PUBLISHED local tracks only.
      for (const publication of this.localParticipant.trackPublications.values()) publication.track.stop();
      this.localParticipant.trackPublications.clear();
      this.state = 'disconnected';
      this.live = false;
      h.mark(`Room#${this.id} closed`);
      this.emit('Disconnected');
    }
    async switchActiveDevice() {
      await h.state.ctl.switchOutput();
    }
    async setE2EEEnabled() {}
  }
  return {
    Room,
    RoomEvent: names,
    ParticipantEvent: names,
    ExternalE2EEKeyProvider: class {},
    isE2EESupported: () => true,
    ScreenSharePresets: { h720fps15: {} },
    VideoPresets: {},
  };
});

// ── voice.ts's sibling modules ─────────────────────────────────────────────
vi.mock('../src/lib/sounds', () => ({
  playCallConnect: () => {
    h.state.counts.connectChime++;
    h.mark('CONNECT chime');
  },
  playCallEnd: () => {
    h.state.counts.endChime++;
    h.mark('HANGUP chime');
  },
}));
vi.mock('../src/lib/callBackground', () => ({
  enterCallBackgroundMode: async (opts: { onHangup: () => void }) => {
    h.state.counts.bgEnter++;
    h.state.onHangup = opts.onHangup;
  },
  exitCallBackgroundMode: async () => {
    h.state.counts.bgExit++;
  },
}));
vi.mock('../src/lib/e2ee', () => ({ getCallKeyString: async () => null }));
vi.mock('../src/lib/mediaSupport', () => ({
  isMediaCaptureAvailable: () => true,
  mediaUnavailableMessage: () => 'no media',
}));
vi.mock('../src/lib/voiceQuality', () => ({
  getCurrentPreset: () => ({
    audioChannels: 1,
    audioBitrate: 32000,
    videoWidth: 1280,
    videoHeight: 720,
    videoBitrate: 1_500_000,
  }),
}));
vi.mock('../src/lib/voicePrefs', () => ({
  getVoicePrefs: () => ({ echoCancellation: true, noiseSuppression: true, gainMode: 'agc' }),
  computeUserGain: () => 1,
  subscribeVoicePrefs: () => () => {},
}));
vi.mock('../src/lib/native', () => ({
  isNative: () => false,
  reportOutgoingCall: async () => {},
  endNativeCall: async () => {},
}));
vi.mock('../src/lib/manualGain', () => ({ activateManualGain: async () => {}, deactivateManualGain: () => {} }));
vi.mock('../src/lib/audioProcessor', () => ({ createNoiseCompressor: () => ({}) }));

// ── helpers ────────────────────────────────────────────────────────────────
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`until() timed out\n${h.state.log.join('\n')}`);
    await h.sleep(2);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tracked = { settled: boolean; ok?: boolean; err?: any; at: number };
function track(p: Promise<unknown>, label: string): Tracked {
  const s: Tracked = { settled: false, at: -1 };
  p.then(
    () => {
      Object.assign(s, { settled: true, ok: true, at: Date.now() });
      h.mark(`${label} resolved`);
    },
    (e) => {
      Object.assign(s, { settled: true, ok: false, err: e, at: Date.now() });
      h.mark(`${label} rejected: ${e?.code ? `[${e.code}] ` : ''}${e?.message}`);
    },
  );
  return s;
}
const ARGS = {
  token: 't',
  wsUrl: 'wss://example.invalid/livekit',
  sessionId: 'sess-1',
  channelId: 'chan-1',
  isDmCall: true,
};

async function freshVoice() {
  vi.resetModules();
  return import('../src/lib/voice');
}
type Voice = Awaited<ReturnType<typeof freshVoice>>;

/** Nothing left behind: no module room (setMicMuted no-ops on a null room,
    so a recorded mic call means one is still set), no live fake Room, no
    live mic capture, no session state. */
async function expectNoLeftovers(voice: Voice) {
  const before = h.state.micCalls.length;
  await voice.setMicMuted(true);
  expect(h.state.micCalls.length).toBe(before);
  expect(voice.getConnectionState()).toBe('disconnected');
  expect(voice.getConnectedChannelId()).toBeNull();
  expect(voice.getActiveVoiceSessionId()).toBeNull();
  expect(h.state.rooms.filter((r) => r.live || r.state !== 'disconnected')).toEqual([]);
  expect(h.state.micTracks.filter((t) => t.live)).toEqual([]);
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  // Node timers return objects; voice.ts guards clearInterval on a number id.
  vi.stubGlobal('window', {
    setInterval: (fn: () => void, ms: number) => Number(setInterval(fn, ms)),
    clearInterval: (id: number) => clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
    clearTimeout: (id: number) => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('document', {
    body: { appendChild() {} },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  });
  vi.stubGlobal('navigator', {
    userAgent: 'node',
    mediaDevices: {
      getUserMedia: () => {
        h.state.gumCalls++;
        return h.state.ctl.gum();
      },
      enumerateDevices: async () => [],
    },
  });
  h.state.t0 = Date.now();
  h.state.log = [];
  h.state.rooms = [];
  h.state.liveAtConstruction = [];
  h.state.micCalls = [];
  h.state.micTracks = [];
  h.state.gumCalls = 0;
  h.state.counts = { connectChime: 0, endChime: 0, bgEnter: 0, bgExit: 0 };
  h.state.onHangup = null;
  h.state.ctl = {
    connect: () => Promise.resolve(),
    capture: () => Promise.resolve(),
    mic: () => Promise.resolve(),
    publishTimeout: () => new Promise<void>(() => {}),
    gum: () => Promise.resolve(h.fakeStream()),
    switchOutput: () => Promise.resolve(),
    closeMs: 0,
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hangUpVoice cancels a join in flight instead of queuing behind it', () => {
  it('during r.connect: settles at once through LiveKit’s own cancel, with no chime and nothing left behind', async () => {
    const voice = await freshVoice();
    const connectD = h.deferred<void>(); // never settled by the test
    h.state.ctl.connect = () => connectD.promise;
    voice.claimVoiceChannel('chan-1');
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.rooms[0]?.connectCalls === 1);

    const pressed = Date.now();
    const d = track(voice.hangUpVoice(), 'hangUpVoice');
    await until(() => c.settled && d.settled);
    expect(Date.now() - pressed).toBeLessThan(100);

    // LiveKit's cancel reached the Room being connected...
    expect(h.state.rooms[0].disconnectCalls).toBeGreaterThanOrEqual(1);
    // ...and the join was cancelled, not failed.
    expect(c.ok).toBe(false);
    expect(c.err?.code).toBe('cancelled');
    expect(voice.isVoiceCancelled(c.err)).toBe(true);
    expect(d.ok).toBe(true);
    // A cancelled join narrates nothing and sets up nothing.
    expect(h.state.counts.connectChime).toBe(0);
    expect(h.state.counts.endChime).toBe(0);
    expect(h.state.counts.bgEnter).toBe(0);
    expect(h.state.micCalls).toEqual([]);
    // Its claim died with it.
    expect(voice.isSelfVoiceTarget('chan-1')).toBe(false);
    expect(voice.isVoiceJoinCancelled('chan-1')).toBe(false);
    await expectNoLeftovers(voice);
  });

  it('during the mic publish: the pending publish is rejected and the join cancelled at once', async () => {
    const voice = await freshVoice();
    const micD = h.deferred<unknown>(); // never settled by the test
    h.state.ctl.mic = () => micD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.micCalls.length === 1);
    expect(voice.getConnectionState()).toBe('connected');

    const pressed = Date.now();
    const d = track(voice.hangUpVoice(), 'hangUpVoice');
    // The call is over for everyone who asks from the click on.
    expect(voice.getConnectedChannelId()).toBeNull();
    await until(() => c.settled && d.settled);
    expect(Date.now() - pressed).toBeLessThan(100);

    expect(c.err?.code).toBe('cancelled');
    expect(h.state.counts.connectChime).toBe(0);
    expect(h.state.counts.endChime).toBe(0);
    expect(h.state.counts.bgEnter).toBe(0);
    await expectNoLeftovers(voice);
  });

  it('during LiveKit’s own mic capture: nothing waits out the parked publish, its capture is stopped as it lands, and a rejoin is left alone', async () => {
    const voice = await freshVoice();
    const captureD = h.deferred<void>();
    h.state.ctl.capture = () => captureD.promise;
    // LiveKit's 15 s timeout on the parked publish: released only at the
    // end, so anything that waited for it would show.
    const timeoutD = h.deferred<void>();
    h.state.ctl.publishTimeout = () => timeoutD.promise;
    voice.claimVoiceChannel('chan-1');
    const a = track(voice.connectToVoice(ARGS), 'join A');
    await until(() => h.state.micCalls.length === 1);
    expect(voice.getActiveVoiceSessionId()).toBe('sess-1');

    const pressed = Date.now();
    void voice.hangUpVoice();
    // This device stops owning the session at the click, so Shell's takeover
    // watcher can't hold a rejoin's fresh session id against this one.
    expect(voice.getActiveVoiceSessionId()).toBeNull();
    await until(() => a.settled);
    expect(Date.now() - pressed).toBeLessThan(100);
    expect(a.err?.code).toBe('cancelled');

    // Straight back into the same channel, while LiveKit is still opening
    // the first capture.
    h.state.ctl.capture = () => Promise.resolve();
    voice.claimVoiceChannel('chan-1');
    const b = track(voice.connectToVoice({ ...ARGS, sessionId: 'sess-2' }), 'join B');
    await until(() => b.settled);
    expect(b.ok).toBe(true);
    expect(Date.now() - pressed).toBeLessThan(200);

    // The first capture lands on a closed engine: LiveKit parks it, live,
    // for its publish timeout. It is stopped as it lands instead.
    captureD.resolve();
    await until(() => h.state.micTracks.some((t) => t.room === 1));
    const stray = h.state.micTracks.find((t) => t.room === 1)!;
    await until(() => !stray.live);
    expect(stray.stoppedAt - stray.liveAt).toBeLessThan(50);
    timeoutD.resolve();
    await h.sleep(10);

    // The rejoin is untouched: still the live session, mic up, one chime.
    expect(voice.getConnectionState()).toBe('connected');
    expect(voice.getConnectedChannelId()).toBe('chan-1');
    expect(voice.getActiveVoiceSessionId()).toBe('sess-2');
    expect(h.state.micTracks.filter((t) => t.live).map((t) => t.room)).toEqual([2]);
    expect(h.state.liveAtConstruction).toEqual([0, 0]);
    expect(h.state.counts.connectChime).toBe(1);
    expect(h.state.counts.endChime).toBe(0);

    await voice.hangUpVoice();
    expect(h.state.counts.endChime).toBe(1);
    await expectNoLeftovers(voice);
  });

  it('during the getUserMedia probe (permission prompt open): no Room is ever built, and a late stream is stopped', async () => {
    const voice = await freshVoice();
    const gumD = h.deferred<unknown>();
    h.state.ctl.gum = () => gumD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.gumCalls === 1);

    const pressed = Date.now();
    const d = track(voice.hangUpVoice(), 'hangUpVoice');
    await until(() => c.settled && d.settled);
    expect(Date.now() - pressed).toBeLessThan(100);
    expect(c.err?.code).toBe('cancelled');
    expect(h.state.rooms).toEqual([]);

    // The user answers the prompt after all: that stream is not ours to keep.
    const late = h.fakeStream();
    gumD.resolve(late);
    await until(() => late.stopped);
    expect(h.state.rooms).toEqual([]);
    expect(h.state.counts.connectChime).toBe(0);
    expect(h.state.counts.endChime).toBe(0);
    await expectNoLeftovers(voice);
  });

  it('a mic denial that races the hang-up still reads as cancelled, not as a mic error', async () => {
    const voice = await freshVoice();
    const gumD = h.deferred<unknown>();
    h.state.ctl.gum = () => gumD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.gumCalls === 1);
    void voice.hangUpVoice();
    gumD.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    await until(() => c.settled);
    expect(c.err?.code).toBe('cancelled');
  });

  it('a hang-up after the claim but before connectToVoice is called cancels that join too', async () => {
    const voice = await freshVoice();
    voice.claimVoiceChannel('chan-1'); // the join site, before its REST join
    void voice.hangUpVoice(); // Leave pressed while that REST call is out
    expect(voice.isVoiceJoinCancelled('chan-1')).toBe(true);

    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => c.settled);
    expect(c.err?.code).toBe('cancelled');
    expect(h.state.rooms).toEqual([]);
    expect(h.state.gumCalls).toBe(0);
    expect(voice.isSelfVoiceTarget('chan-1')).toBe(false);
    // A claim made after the hang-up belongs to the new generation.
    voice.claimVoiceChannel('chan-2');
    expect(voice.isVoiceJoinCancelled('chan-2')).toBe(false);
  });

  it('the next join still waits for the cancelled one to settle, then connects normally: never two live Rooms', async () => {
    const voice = await freshVoice();
    // LiveKit rejects the pending connect at once but takes a while to send
    // its leave and close the engine: a join let through on the rejection
    // alone would build its Room while A's still holds the identity.
    h.state.ctl.closeMs = 60;
    const connectA = h.deferred<void>();
    h.state.ctl.connect = () => connectA.promise;
    voice.claimVoiceChannel('chan-1');
    const a = track(voice.connectToVoice(ARGS), 'join A');
    await until(() => h.state.rooms[0]?.connectCalls === 1);

    void voice.hangUpVoice();
    // Straight back in, somewhere else.
    h.state.ctl.connect = () => Promise.resolve();
    voice.claimVoiceChannel('chan-2');
    const b = track(
      voice.connectToVoice({ ...ARGS, channelId: 'chan-2', sessionId: 'sess-2' }),
      'join B',
    );
    await until(() => a.settled && b.settled);

    expect(a.err?.code).toBe('cancelled');
    expect(b.ok).toBe(true);
    expect(h.state.rooms.length).toBe(2);
    // B's Room was built only after A had settled — and A settled only once
    // its Room had closed...
    expect(h.state.rooms[1].createdAt).toBeGreaterThanOrEqual(a.at);
    expect(a.at - h.state.rooms[0].createdAt).toBeGreaterThanOrEqual(55);
    // ...so no Room ever overlapped another.
    expect(h.state.liveAtConstruction).toEqual([0, 0]);
    expect(h.state.rooms[0].state).toBe('disconnected');
    expect(h.state.rooms[1].state).toBe('connected');
    expect(voice.getConnectedChannelId()).toBe('chan-2');
    expect(voice.getActiveVoiceSessionId()).toBe('sess-2');
    // Only B's join chimed, and the cancelled A never armed a hangup chime.
    expect(h.state.counts.connectChime).toBe(1);
    expect(h.state.counts.endChime).toBe(0);

    // B ends normally, with its one hangup chime.
    await voice.hangUpVoice();
    expect(h.state.counts.endChime).toBe(1);
    await expectNoLeftovers(voice);
  });

  it('during the post-publish setup (after the connect chime): the call ends with exactly one hangup chime', async () => {
    const voice = await freshVoice();
    localStorage.setItem('zekktris.audio.output', 'speaker-1');
    const switchD = h.deferred<void>();
    h.state.ctl.switchOutput = () => switchD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.counts.connectChime === 1);

    void voice.hangUpVoice();
    // The media goes at the click, not when the setup finishes.
    expect(h.state.rooms[0].disconnectCalls).toBe(1);
    switchD.resolve();
    await until(() => c.settled);

    expect(c.err?.code).toBe('cancelled');
    expect(h.state.counts.endChime).toBe(1);
    // No wake lock / media session for a call that is already over.
    expect(h.state.counts.bgEnter).toBe(0);
    await until(() => voice.getConnectionState() === 'disconnected');
    await expectNoLeftovers(voice);
    expect(h.state.counts.endChime).toBe(1);
  });

  it('a real connect failure (no hang-up) is still connect_failed', async () => {
    const voice = await freshVoice();
    const connectD = h.deferred<void>();
    h.state.ctl.connect = () => connectD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.rooms[0]?.connectCalls === 1);
    connectD.reject(new Error('could not establish pc connection'));
    await until(() => c.settled);
    expect(c.err?.code).toBe('connect_failed');
    expect(voice.isVoiceCancelled(c.err)).toBe(false);
    await expectNoLeftovers(voice);
  });
});

describe('what hangUpVoice must not change', () => {
  it('disconnectVoice({ silent }) — an internal teardown — waits for a pending join and does not cancel it', async () => {
    const voice = await freshVoice();
    const connectD = h.deferred<void>();
    h.state.ctl.connect = () => connectD.promise;
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => h.state.rooms[0]?.connectCalls === 1);

    const gen = voice.getHangupGeneration();
    const d = track(voice.disconnectVoice({ silent: true }), 'disconnectVoice(silent)');
    await h.sleep(100);
    expect(d.settled).toBe(false);
    expect(c.settled).toBe(false);
    expect(h.state.rooms[0].disconnectCalls).toBe(0);
    expect(voice.getHangupGeneration()).toBe(gen);

    connectD.resolve();
    await until(() => c.settled && d.settled);
    // The join completed (a move's rejoin must survive its own teardown)...
    expect(c.ok).toBe(true);
    expect(h.state.counts.connectChime).toBe(1);
    expect(c.at).toBeLessThanOrEqual(d.at);
    // ...and the queued silent teardown then ran, without a hangup chime.
    expect(h.state.counts.endChime).toBe(0);
    await expectNoLeftovers(voice);
  });

  it('hangUpVoice with nothing in flight is a cheap no-op', async () => {
    const voice = await freshVoice();
    voice.claimVoiceChannel('chan-old');
    const gen = voice.getHangupGeneration();
    const t = Date.now();
    await voice.hangUpVoice();
    expect(Date.now() - t).toBeLessThan(50);
    expect(voice.getHangupGeneration()).toBe(gen + 1);
    expect(h.state.rooms).toEqual([]);
    expect(h.state.counts).toEqual({ connectChime: 0, endChime: 0, bgEnter: 0, bgExit: 0 });
    // It voids joins claimed before it, not joins started after it.
    expect(voice.isVoiceJoinCancelled('chan-old')).toBe(true);
    voice.claimVoiceChannel('chan-new');
    expect(voice.isVoiceJoinCancelled('chan-new')).toBe(false);
  });

  it('a settled call: torn down with exactly one hangup chime, and reported over at once', async () => {
    const voice = await freshVoice();
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => c.settled);
    expect(c.ok).toBe(true);
    expect(voice.getConnectedChannelId()).toBe('chan-1');

    const p = voice.hangUpVoice();
    expect(voice.getConnectedChannelId()).toBeNull();
    await p;
    expect(h.state.rooms[0].disconnectCalls).toBe(1);
    expect(h.state.counts.connectChime).toBe(1);
    expect(h.state.counts.endChime).toBe(1);
    await expectNoLeftovers(voice);
    // A second press has nothing left to do.
    await voice.hangUpVoice();
    expect(h.state.counts.endChime).toBe(1);
  });
});

describe('isVoiceJoinInFlight (VoiceView skips its 1:1 swallow animation on it)', () => {
  it('is true from the claim until the join has settled, whichever way it settles', async () => {
    const voice = await freshVoice();
    expect(voice.isVoiceJoinInFlight()).toBe(false);
    voice.claimVoiceChannel('chan-1'); // its REST join is out
    expect(voice.isVoiceJoinInFlight()).toBe(true);
    const micD = h.deferred<unknown>();
    h.state.ctl.mic = () => micD.promise;
    const c = track(voice.connectToVoice(ARGS), 'join');
    await until(() => h.state.micCalls.length === 1);
    // Connected (its claim released) but still publishing: still in flight.
    expect(voice.getConnectedChannelId()).toBe('chan-1');
    expect(voice.isVoiceJoinInFlight()).toBe(true);
    micD.resolve(undefined);
    await until(() => c.settled);
    expect(c.ok).toBe(true);
    expect(voice.isVoiceJoinInFlight()).toBe(false);
    await voice.hangUpVoice();

    // A cancelled join is in flight until it has unwound.
    const connectD = h.deferred<void>();
    h.state.ctl.connect = () => connectD.promise;
    voice.claimVoiceChannel('chan-2');
    const c2 = track(voice.connectToVoice({ ...ARGS, channelId: 'chan-2' }), 'join 2');
    await until(() => h.state.rooms[1]?.connectCalls === 1);
    expect(voice.isVoiceJoinInFlight()).toBe(true);
    void voice.hangUpVoice();
    await until(() => c2.settled);
    expect(voice.isVoiceJoinInFlight()).toBe(false);
    await expectNoLeftovers(voice);
  });
});

describe('the OS / browser media controls’ Hang Up', () => {
  it('goes through the hang-up helper the app registered, with the call’s channel; without one it still hangs up', async () => {
    const voice = await freshVoice();
    const c = track(voice.connectToVoice(ARGS), 'connectToVoice');
    await until(() => c.settled);
    expect(h.state.counts.bgEnter).toBe(1);
    const onHangup = h.state.onHangup!;

    const asked: string[] = [];
    voice.setSystemHangupHandler((channelId) => asked.push(channelId));
    onHangup();
    expect(asked).toEqual(['chan-1']);
    // The registered helper owns the hang-up; nothing was torn down behind it.
    expect(h.state.rooms[0].state).toBe('connected');

    voice.setSystemHangupHandler(null);
    onHangup();
    await until(() => voice.getConnectionState() === 'disconnected');
    expect(h.state.counts.endChime).toBe(1);
    await expectNoLeftovers(voice);
  });
});
