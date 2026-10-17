import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { Hono } from 'hono';

// Multi-device presence, end to end: a real gateway on a real http.Server,
// driven by real ws clients ("devices"), plus the REST status picker. The
// user's effective status (users.status) must follow the device actually in
// use — see apps/api/src/gateway/presence.ts and the acceptance scenarios it
// was built against. Grace periods are shortened through attachGateway's
// test options; the op-3 rate limit runs at its real 2 s.

process.env.TRUST_PROXY = 'true';

const { default: WebSocket } = await import('ws');
const { eq } = await import('drizzle-orm');
const { GatewayOp } = await import('@zekktris/shared/events');
const { db, schema } = await import('../src/db');
const { attachGateway, detachGateway } = await import('../src/gateway/server');
const { usersRouter } = await import('../src/routes/users');
const { authRouter } = await import('../src/routes/auth');
const { errorHandler } = await import('../src/middleware');
const { createSession } = await import('../src/auth/sessions');
const { signAccessToken } = await import('../src/auth/tokens');
const { createUser, createGuild, addMember, addRelationship, cleanupAll } = await import('./seed');
const { probeDb, closeDb } = await import('./db-available');

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping multi-device presence tests — no database reachable');
}

const CLOSE_GRACE_MS = 300;
const VOICE_GRACE_MS = 700;

const app = new Hono();
app.onError(errorHandler);
app.route('/users', usersRouter);
app.route('/auth', authRouter);

const freshIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = { op: number; t?: string; d?: Record<string, unknown> };

/** One device: a gateway socket with every received frame recorded. */
class Device {
  frames: Frame[] = [];
  closedCode: number | null = null;
  /** The refresh token of the sign-in session this device connected with. */
  refreshToken = '';
  constructor(readonly ws: InstanceType<typeof WebSocket>) {
    ws.on('message', (raw) => this.frames.push(JSON.parse(raw.toString()) as Frame));
    ws.on('close', (code) => {
      this.closedCode = code;
    });
  }
  send(op: number, d: unknown): void {
    this.ws.send(JSON.stringify({ op, d }));
  }
  setActive(active: boolean): void {
    this.send(GatewayOp.PRESENCE_UPDATE, { active });
  }
  ready(): Frame | undefined {
    return this.frames.find((f) => f.t === 'READY');
  }
  /** PRESENCE_UPDATE statuses received about `userId` (one per frame). */
  presenceOf(userId: bigint): string[] {
    return this.frames
      .filter((f) => f.t === 'PRESENCE_UPDATE' && f.d?.user_id === userId.toString())
      .map((f) => f.d!.status as string);
  }
  async close(): Promise<void> {
    if (this.closedCode !== null) return;
    await new Promise<void>((r) => {
      this.ws.once('close', () => r());
      this.ws.close(1000);
    });
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 4000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function row(userId: bigint) {
  const [u] = await db
    .select({
      status: schema.users.status,
      chosenStatus: schema.users.chosenStatus,
      chosenStatusAuto: schema.users.chosenStatusAuto,
      lastSeenAt: schema.users.lastSeenAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u!;
}

async function statusOf(userId: bigint): Promise<string> {
  return (await row(userId)).status;
}

async function expectStatus(userId: bigint, status: string): Promise<void> {
  await waitFor(async () => (await statusOf(userId)) === status, `status ${status}`);
  expect(await statusOf(userId)).toBe(status);
}

describe.runIf(dbReady)('multi-device presence (integration)', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer();
    attachGateway(server, {
      presenceCloseGraceMs: CLOSE_GRACE_MS,
      voiceEvictGraceMs: VOICE_GRACE_MS,
      resetPresenceOnBoot: false,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
  });

  afterAll(async () => {
    detachGateway();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupAll();
    await closeDb();
  });

  async function signIn(userId: bigint): Promise<{ token: string; refreshToken: string }> {
    const { session, refreshToken } = await createSession({
      userId,
      userAgent: 'vitest',
      ipAddress: null,
    });
    return { token: await signAccessToken({ userId, sessionId: session.id }), refreshToken };
  }

  async function tokenFor(userId: bigint): Promise<string> {
    return (await signIn(userId)).token;
  }

  /** Connect a device (its own sign-in session) and IDENTIFY; `presence`
   *  omitted = a legacy client. */
  async function connect(userId: bigint, presence?: { active: boolean }): Promise<Device> {
    const { token, refreshToken } = await signIn(userId);
    const ws = new WebSocket(url, { headers: { 'x-real-ip': freshIp() } });
    const dev = new Device(ws);
    dev.refreshToken = refreshToken;
    ws.on('error', () => {});
    await waitFor(() => dev.frames.some((f) => f.op === GatewayOp.HELLO), 'HELLO');
    dev.send(GatewayOp.IDENTIFY, { token, ...(presence ? { presence } : {}) });
    await waitFor(() => dev.ready() !== undefined, 'READY');
    return dev;
  }

  /** PATCH a status. `source` omitted = a pre-update client (no marker);
   *  'manual' = an updated client's status picker (packages/client patchMe). */
  function patchStatus(token: string, status: string, source?: 'manual' | 'auto') {
    return app.request('/users/@me', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(source ? { status, statusSource: source } : { status }),
    });
  }

  it('READY advertises features.presence_activity and returns chosenStatus', async () => {
    const u = await createUser();
    const dev = await connect(u, { active: true });
    const ready = dev.ready()!.d!;
    expect(ready.features).toEqual({ presence_activity: true });
    expect(ready.user).toMatchObject({
      chosenStatus: 'online',
      // Older native builds read the self user's `status` as their pick.
      status: 'online',
    });
    await dev.close();
  });

  it('scenarios 1-5: the status follows the device in use, then goes offline after the graces', async () => {
    const u = await createUser();
    const lastSeenStart = (await row(u)).lastSeenAt;

    // 1. A ("Mac") connected but idle, B not connected → idle.
    const mac = await connect(u, { active: false });
    await expectStatus(u, 'idle');

    // 2. B ("phone") connects in use → online.
    const phone = await connect(u, { active: true });
    await expectStatus(u, 'online');
    // Each device hears the user's own effective status.
    await waitFor(
      () => mac.presenceOf(u).includes('online'),
      'self PRESENCE_UPDATE online on the Mac',
    );

    // 3. B goes idle/background (A still connected, still idle) → idle, NOT online.
    phone.setActive(false);
    await expectStatus(u, 'idle');
    await waitFor(
      () => mac.presenceOf(u).at(-1) === 'idle',
      'self PRESENCE_UPDATE idle on the Mac',
    );

    // B in use again → online; then B disconnects.
    await sleep(2100); // past op 3's per-connection 2 s spacing
    phone.setActive(true);
    await expectStatus(u, 'online');
    await phone.close();
    // 4. Not immediately (a reconnect blip mustn't flap the dot)…
    await sleep(CLOSE_GRACE_MS / 3);
    expect(await statusOf(u)).toBe('online');
    // …but after the short grace: idle, since only the idle Mac remains.
    await expectStatus(u, 'idle');

    // 5. A disconnects → still idle through the voice grace, then offline.
    await mac.close();
    await sleep(VOICE_GRACE_MS / 3);
    expect(await statusOf(u)).toBe('idle');
    await expectStatus(u, 'offline');
    // "Last online" stamped on the way out.
    const lastSeen = (await row(u)).lastSeenAt;
    expect(lastSeen).not.toBeNull();
    expect(lastSeen!.getTime()).toBeGreaterThan(lastSeenStart?.getTime() ?? 0);
    expect((await row(u)).chosenStatus).toBe('online');
  });

  it('two devices closing within the short grace still wait for the voice grace', async () => {
    const u = await createUser();
    const a = await connect(u, { active: true });
    const b = await connect(u, { active: true });
    await expectStatus(u, 'online');
    await b.close();
    await a.close();
    // b's short-grace recompute runs while a's full-disconnect grace holds.
    await sleep(CLOSE_GRACE_MS + 150);
    expect(await statusOf(u)).toBe('online');
    await expectStatus(u, 'offline');
  });

  it('scenario 6: a chosen dnd survives a full disconnect and reconnect', async () => {
    const u = await createUser();
    const dev = await connect(u, { active: true });
    await expectStatus(u, 'online');
    const res = await patchStatus(await tokenFor(u), 'dnd');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { status: string; chosenStatus: string } };
    expect(body.user).toMatchObject({ status: 'dnd', chosenStatus: 'dnd', effectiveStatus: 'dnd' });
    await expectStatus(u, 'dnd');

    await dev.close();
    await expectStatus(u, 'offline');
    expect((await row(u)).chosenStatus).toBe('dnd');

    const again = await connect(u, { active: true });
    await expectStatus(u, 'dnd');
    expect((again.ready()!.d!.user as { chosenStatus: string }).chosenStatus).toBe('dnd');
    // Device activity doesn't override dnd.
    again.setActive(false);
    await sleep(200);
    expect(await statusOf(u)).toBe('dnd');
    await again.close();
  });

  it('scenario 7: a chosen invisible user reads offline to others throughout', async () => {
    const u = await createUser();
    const watcher = await createUser();
    const g = await createGuild(u);
    await addMember(g, u);
    await addMember(g, watcher);
    await addRelationship(u, watcher, 'friend');
    await addRelationship(watcher, u, 'friend');
    await db
      .update(schema.users)
      .set({ chosenStatus: 'invisible', status: 'invisible' })
      .where(eq(schema.users.id, u));
    const frozenLastSeen = (await row(u)).lastSeenAt;
    const w = await connect(watcher, { active: true });

    const a = await connect(u, { active: false });
    const b = await connect(u, { active: true });
    await sleep(100);
    b.setActive(false);
    await sleep(200);
    await b.close();
    await sleep(CLOSE_GRACE_MS + 100);
    expect(await statusOf(u)).toBe('invisible');
    await a.close();
    await sleep(VOICE_GRACE_MS + 300);

    expect(await statusOf(u)).toBe('invisible');
    const seen = w.presenceOf(u);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['offline']));
    // lastSeenAt privacy: frozen while invisible.
    expect((await row(u)).lastSeenAt).toEqual(frozenLastSeen);
    await w.close();
  });

  it('scenario 8: a legacy connection that never reports counts as active', async () => {
    const u = await createUser();
    const mac = await connect(u, { active: false });
    await expectStatus(u, 'idle');
    const legacy = await connect(u); // no presence field, never sends op 3
    await expectStatus(u, 'online');
    await legacy.close();
    await expectStatus(u, 'idle');
    await mac.close();
  });

  it('PATCH status writes the CHOSEN status; the self user carries it as status / chosenStatus and the effective one as effectiveStatus', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // Not connected: choosing online leaves them offline.
    let res = await patchStatus(token, 'online', 'manual');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'offline',
    });
    expect(await statusOf(u)).toBe('offline');

    const dev = await connect(u, { active: false });
    await expectStatus(u, 'idle');
    // Away by hand stays Away whatever the device does.
    res = await patchStatus(token, 'idle', 'manual');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'idle',
      chosenStatus: 'idle',
      effectiveStatus: 'idle',
    });
    // Back to online while the only device is idle → effective idle. An old
    // native build reads `status` as its pick: Online, not the Mac's idle.
    res = await patchStatus(token, 'online', 'manual');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'idle',
    });
    let me = await app.request('/users/@me', { headers: { authorization: `Bearer ${token}` } });
    expect(((await me.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'idle',
    });
    res = await patchStatus(token, 'invisible', 'manual');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'invisible',
      chosenStatus: 'invisible',
      effectiveStatus: 'invisible',
    });
    // 'offline' is not a status anyone can choose.
    res = await patchStatus(token, 'offline', 'manual');
    expect(res.status).toBe(400);
    // Nor is an unknown source.
    res = await patchStatus(token, 'idle', 'robot' as 'manual');
    expect(res.status).toBe(400);

    me = await app.request('/users/@me', { headers: { authorization: `Bearer ${token}` } });
    expect(((await me.json()) as { user: unknown }).user).toMatchObject({
      status: 'invisible',
      chosenStatus: 'invisible',
      effectiveStatus: 'invisible',
    });
    await dev.close();
  });

  it("a pre-update client's automatic idle (unmarked PATCH) ends when the user's last device disconnects", async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // An old iOS build, in use, auto-aways after 5 minutes without input.
    const phone = await connect(u);
    await expectStatus(u, 'online');
    const res = await patchStatus(token, 'idle');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'idle',
      chosenStatus: 'idle',
      effectiveStatus: 'idle',
    });
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: true });
    await expectStatus(u, 'idle');

    // It is killed before it can PATCH 'online' back (that flag lived in its
    // memory). The full disconnect ends the automatic away in the same write
    // that offlines the user — as the old server's disconnect/reconnect did.
    await phone.close();
    await expectStatus(u, 'offline');
    expect(await row(u)).toMatchObject({ chosenStatus: 'online', chosenStatusAuto: false });

    // On the next connect — any device — they read online, not Away.
    const mac = await connect(u, { active: true });
    await expectStatus(u, 'online');
    expect(mac.ready()!.d!.user).toMatchObject({ status: 'online', chosenStatus: 'online' });
    await mac.close();
    await expectStatus(u, 'offline');
  });

  it('an updated device reporting itself in use ends a legacy automatic away; a picked Away stays', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // The owner's setup during an upgrade: an old iPhone build plus an
    // always-on Mac running the updated client, idle for now.
    const oldPhone = await connect(u);
    const mac = await connect(u, { active: false });
    await patchStatus(token, 'idle'); // the old build's automatic away
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: true });
    // The old app is killed before it can PATCH 'online' back; the Mac stays.
    await oldPhone.close();
    await sleep(300);
    expect(await statusOf(u)).toBe('idle');
    // The owner comes back to the Mac: the status follows it, not the dead
    // phone's away — no need to repick Online or for every device to leave.
    mac.setActive(true);
    await expectStatus(u, 'online');
    expect(await row(u)).toMatchObject({ chosenStatus: 'online', chosenStatusAuto: false });

    // A device connecting in use ends one too. (The Mac is swapped for an
    // idle one first, so nothing updated is in use when the away lands.)
    const idleMac = await connect(u, { active: false });
    await mac.close();
    await expectStatus(u, 'idle');
    const oldPhone2 = await connect(u);
    await patchStatus(token, 'idle');
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: true });
    await oldPhone2.close();
    await sleep(300);
    expect(await row(u)).toMatchObject({ status: 'idle', chosenStatus: 'idle', chosenStatusAuto: true });
    const laptop = await connect(u, { active: true });
    await expectStatus(u, 'online');
    expect(await row(u)).toMatchObject({ chosenStatus: 'online', chosenStatusAuto: false });

    // A PICKED Away is never ended by device activity.
    await patchStatus(token, 'idle', 'manual');
    await expectStatus(u, 'idle');
    laptop.setActive(false);
    await sleep(2_300); // op 3 changes apply at most every 2 s per connection
    laptop.setActive(true);
    await sleep(2_300);
    expect(await row(u)).toMatchObject({ status: 'idle', chosenStatus: 'idle', chosenStatusAuto: false });
    await idleMac.close();
    await laptop.close();
  });

  it('a legacy automatic away that lands while an updated device is ALREADY in use ends on the next recompute', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // The Mac (updated) is in use; an old phone build sits open, untouched.
    const mac = await connect(u, { active: true });
    const oldPhone = await connect(u);
    await expectStatus(u, 'online');
    // The old build's automatic away. Its own PATCH response keeps it, or the
    // old app would read Online and PATCH Away again on its next tick.
    const res = await patchStatus(token, 'idle');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'idle',
      chosenStatus: 'idle',
    });
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: true });
    // The old app is killed before it can PATCH 'online' back. No device
    // reports a CHANGE of activity — the Mac was in use all along — yet the
    // status follows it.
    await oldPhone.close();
    await expectStatus(u, 'online');
    expect(await row(u)).toMatchObject({ chosenStatus: 'online', chosenStatusAuto: false });
    await mac.close();
    await expectStatus(u, 'offline');
  });

  it('an automatic idle PATCHed with no device connected that offlines a stale row is reported as already ended', async () => {
    const u = await createUser();
    // A row still reading online although nothing is connected (stale).
    await db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, u));
    const res = await patchStatus(await tokenFor(u), 'idle');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'offline',
    });
    expect(await row(u)).toMatchObject({
      status: 'offline',
      chosenStatus: 'online',
      chosenStatusAuto: false,
    });
  });

  it('an automatic idle PATCHed while the row already reads offline ends at once; a picked Away stays', async () => {
    // An old app whose socket was down sends its automatic away: nothing is
    // connected and the row already reads offline (no transition happens).
    const auto = await createUser();
    const manual = await createUser();
    expect((await row(auto)).status).toBe('offline');
    const res = await patchStatus(await tokenFor(auto), 'idle');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'offline',
    });
    expect(await row(auto)).toMatchObject({
      status: 'offline',
      chosenStatus: 'online',
      chosenStatusAuto: false,
      // Only the chosen status changed — no visible moment to stamp.
      lastSeenAt: null,
    });
    await patchStatus(await tokenFor(manual), 'idle', 'manual');
    expect(await row(manual)).toMatchObject({
      status: 'offline',
      chosenStatus: 'idle',
      chosenStatusAuto: false,
    });
  });

  it('the single-replica boot reset ends an automatic idle too (the process died with it connected)', async () => {
    const auto = await createUser();
    const manual = await createUser();
    await db
      .update(schema.users)
      .set({ status: 'idle', chosenStatus: 'idle', chosenStatusAuto: true })
      .where(eq(schema.users.id, auto));
    await db
      .update(schema.users)
      .set({ status: 'idle', chosenStatus: 'idle', chosenStatusAuto: false })
      .where(eq(schema.users.id, manual));
    const { presence, resetPresenceOnBoot } = await import('../src/gateway/presence');
    expect(presence().clustered).toBe(false);
    await resetPresenceOnBoot(presence(), { userIds: [auto, manual] });
    expect(await row(auto)).toMatchObject({
      status: 'offline',
      chosenStatus: 'online',
      chosenStatusAuto: false,
    });
    expect(await row(manual)).toMatchObject({
      status: 'offline',
      chosenStatus: 'idle',
      chosenStatusAuto: false,
    });
  });

  it('a manually picked Away survives a full disconnect and reconnect', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    const dev = await connect(u, { active: true });
    await expectStatus(u, 'online');
    // An automatic idle first, then the user picks Away by hand: the manual
    // pick clears the automatic flag.
    await patchStatus(token, 'idle');
    expect((await row(u)).chosenStatusAuto).toBe(true);
    await patchStatus(token, 'idle', 'manual');
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: false });

    await dev.close();
    await expectStatus(u, 'offline');
    expect(await row(u)).toMatchObject({ chosenStatus: 'idle', chosenStatusAuto: false });
    const again = await connect(u, { active: true });
    await expectStatus(u, 'idle');
    expect(again.ready()!.d!.user).toMatchObject({ status: 'idle', chosenStatus: 'idle' });
    await again.close();
  });

  it('an unmarked PATCH of online / dnd / invisible is a plain pick: never flagged, survives a full disconnect', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // An automatic idle, then the old app's own auto-return to online clears it.
    let dev = await connect(u);
    await patchStatus(token, 'idle');
    expect((await row(u)).chosenStatusAuto).toBe(true);
    await patchStatus(token, 'online');
    expect(await row(u)).toMatchObject({ chosenStatus: 'online', chosenStatusAuto: false });
    await expectStatus(u, 'online');

    for (const pick of ['dnd', 'invisible'] as const) {
      await patchStatus(token, pick);
      expect(await row(u)).toMatchObject({ chosenStatus: pick, chosenStatusAuto: false });
      await dev.close();
      await expectStatus(u, pick === 'invisible' ? 'invisible' : 'offline');
      expect((await row(u)).chosenStatus).toBe(pick);
      dev = await connect(u);
      await expectStatus(u, pick);
    }
    await dev.close();
  });

  it("a status pick reaches the user's other devices (chosen_status on their own frame only)", async () => {
    const u = await createUser();
    const watcher = await createUser();
    const g = await createGuild(u);
    await addMember(g, u);
    await addMember(g, watcher);
    await addRelationship(u, watcher, 'friend');
    await addRelationship(watcher, u, 'friend');
    const w = await connect(watcher, { active: true });
    const mac = await connect(u, { active: true });
    const phone = await connect(u, { active: true });
    await expectStatus(u, 'online');

    // Picked on the phone: the Mac learns the pick, not just the masked dot.
    const res = await patchStatus(await tokenFor(u), 'invisible');
    expect(res.status).toBe(200);
    const selfFrame = (d: Device) =>
      d.frames.find(
        (f) =>
          f.t === 'PRESENCE_UPDATE' &&
          f.d?.user_id === u.toString() &&
          f.d?.chosen_status === 'invisible',
      );
    await waitFor(() => selfFrame(mac) !== undefined, "chosen_status on the Mac's self frame");
    expect(selfFrame(mac)!.d).toMatchObject({
      status: 'offline',
      guild_id: null,
      chosen_status: 'invisible',
    });
    await waitFor(() => selfFrame(phone) !== undefined, "chosen_status on the phone's self frame");

    // Everyone else sees plain 'offline' and never the chosen status.
    await waitFor(() => w.presenceOf(u).includes('offline'), 'the watcher sees offline');
    const watcherFrames = w.frames.filter(
      (f) => f.t === 'PRESENCE_UPDATE' && f.d?.user_id === u.toString(),
    );
    expect(watcherFrames.length).toBeGreaterThan(0);
    for (const f of watcherFrames) expect(f.d).not.toHaveProperty('chosen_status');

    await Promise.all([w.close(), mac.close(), phone.close()]);
  });

  it("the page-hide beacon closes only that browser's sockets, not the user's other devices", async () => {
    const u = await createUser();
    const phone = await connect(u, { active: true });
    const browser = await connect(u, { active: false });
    await expectStatus(u, 'online');
    const res = await app.request('/auth/disconnect-beacon', {
      method: 'POST',
      headers: { cookie: `zekktris_refresh=${browser.refreshToken}` },
    });
    expect(res.status).toBe(204);
    await waitFor(() => browser.closedCode !== null, 'browser socket closed');
    await sleep(CLOSE_GRACE_MS + 150);
    expect(phone.closedCode).toBeNull();
    expect(await statusOf(u)).toBe('online');
    await phone.close();
  });

  it('dropping Invisible while disconnected reads offline and does not stamp "last online"', async () => {
    const u = await createUser();
    const frozen = new Date('2026-01-02T03:04:05Z');
    await db
      .update(schema.users)
      .set({ chosenStatus: 'invisible', status: 'invisible', lastSeenAt: frozen })
      .where(eq(schema.users.id, u));
    const res = await patchStatus(await tokenFor(u), 'online', 'manual');
    expect(((await res.json()) as { user: unknown }).user).toMatchObject({
      status: 'online',
      chosenStatus: 'online',
      effectiveStatus: 'offline',
    });
    expect((await row(u)).lastSeenAt).toEqual(frozen);
  });

  it('op 3: ignored before IDENTIFY, coalesced at 2 s per connection, never closes the socket', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    const ws = new WebSocket(url, { headers: { 'x-real-ip': freshIp() } });
    ws.on('error', () => {});
    const dev = new Device(ws);
    await waitFor(() => dev.frames.some((f) => f.op === GatewayOp.HELLO), 'HELLO');
    // Before IDENTIFY: ignored, socket stays open.
    dev.setActive(false);
    dev.send(GatewayOp.IDENTIFY, { token, presence: { active: true } });
    await waitFor(() => dev.ready() !== undefined, 'READY');
    await expectStatus(u, 'online');

    // First change applies at once.
    dev.setActive(false);
    await expectStatus(u, 'idle');
    // A burst inside the 2 s window: nothing applies until it reopens, and
    // the burst collapses to its LAST value.
    dev.setActive(true);
    dev.setActive(false);
    dev.setActive(true);
    dev.setActive(true);
    // Malformed payloads are ignored too.
    dev.send(GatewayOp.PRESENCE_UPDATE, { active: 'yes' });
    dev.send(GatewayOp.PRESENCE_UPDATE, null);
    await sleep(1000);
    expect(await statusOf(u)).toBe('idle');
    await expectStatus(u, 'online');

    // A burst that ends where it started applies nothing.
    await sleep(2100);
    dev.setActive(false);
    await expectStatus(u, 'idle');
    dev.setActive(true);
    dev.setActive(false);
    await sleep(2300);
    expect(await statusOf(u)).toBe('idle');

    expect(dev.closedCode).toBeNull();
    await dev.close();
  });

  it('RESUME carries the device activity', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    const dev = await connect(u, { active: true });
    await expectStatus(u, 'online');
    const sessionId = dev.ready()!.d!.session_id as string;
    const lastSeq = Math.max(...dev.frames.map((f) => (f as { s?: number }).s ?? 0));
    // Drop the socket without a clean handshake, then resume on a new one,
    // reporting the device now idle.
    dev.ws.terminate();
    await sleep(100);
    const ws = new WebSocket(url, { headers: { 'x-real-ip': freshIp() } });
    ws.on('error', () => {});
    const next = new Device(ws);
    await waitFor(() => next.frames.some((f) => f.op === GatewayOp.HELLO), 'HELLO');
    next.send(GatewayOp.RESUME, {
      token,
      session_id: sessionId,
      seq: lastSeq,
      presence: { active: false },
    });
    await waitFor(() => next.frames.some((f) => f.t === 'RESUMED'), 'RESUMED');
    await expectStatus(u, 'idle');
    await next.close();
  });
});
