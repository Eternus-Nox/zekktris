import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { dmsRouter } from '../src/routes/dms';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { nextSnowflake } from '../src/snowflake';
import {
  createSystemMessage,
  listChannelAttachments,
  listPinned,
  listUserMentions,
  searchDirectMessages,
} from '../src/services/messages';
import { listSavedMessages, saveMessage } from '../src/services/savedMessages';
import { addReaction } from '../src/services/reactions';
import { resolveAndPersistEmbeds } from '../src/services/embeds';
import { fireScheduled } from '../src/services/scheduledMessages';
import {
  createUser,
  createGuild,
  addMember,
  createChannel,
  createDmChannel,
  createMessage,
  cleanupAll,
  Permissions,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping disappearing-timer tests — no database reachable');
}

// Per-message disappearing timers: a message keeps the timer it was SENT with,
// its clock starts on a recipient's read ACK (not a page fetch), and from its
// deadline it is gone on every read path — and expiresAt, which minus the
// timer is the read time, reaches the author only when the reader's receipts
// are on.

const app = new Hono();
app.onError(errorHandler);
app.route('/users/@me/channels', dmsRouter);
app.route('/channels', messagesRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function call(method: string, path: string, userId: bigint, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${await tokenFor(userId)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}
type MessageJson = Record<string, unknown> & { id: string };
const setTimer = (userId: bigint, ch: bigint, ttl: number | null) =>
  call('PATCH', `/users/@me/channels/${ch}/settings`, userId, { ttlSecondsAfterRead: ttl });
async function send(userId: bigint, ch: bigint, body: Record<string, unknown>): Promise<MessageJson> {
  const r = await call('POST', `/channels/${ch}/messages`, userId, body);
  expect(r.status).toBe(201);
  return r.json!.message as MessageJson;
}
async function list(userId: bigint, ch: bigint, query = ''): Promise<MessageJson[]> {
  const r = await call('GET', `/channels/${ch}/messages${query}`, userId);
  expect(r.status).toBe(200);
  return r.json!.messages as MessageJson[];
}
const ack = (userId: bigint, ch: bigint, mid: bigint | string) =>
  call('POST', `/channels/${ch}/messages/${mid}/ack`, userId);
async function row(id: bigint | string) {
  const [r] = await db.select().from(schema.messages).where(eq(schema.messages.id, BigInt(id)));
  return r!;
}
async function receiptsOff(userId: bigint) {
  await db.update(schema.users).set({ dmReadReceiptsEnabled: false }).where(eq(schema.users.id, userId));
}

type Frame = { t?: string; d?: Record<string, unknown> };
const liveConns: Connection[] = [];
function connect(userId: bigint, dmIds: bigint[]): Frame[] {
  const sent: Frame[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: () => undefined,
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [], dmIds, []);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return sent;
}
const framesOf = (sent: Frame[], t: string) => sent.filter((f) => f.t === t).map((f) => f.d!);
async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 3_600_000);

describe.runIf(dbReady)('disappearing messages: per-message timer + read paths (integration)', () => {
  beforeAll(() => {
    registry.init();
  });
  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('each message keeps the timer it was sent with, across a change and after Off', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const before = await send(a, dm, { content: 'no timer yet' });
    expect(before.expireAfterSeconds).toBeNull();

    expect((await setTimer(a, dm, 3600)).status).toBe(200);
    const hour = await send(a, dm, { content: 'one hour' });
    expect(hour.expireAfterSeconds).toBe(3600);
    expect(hour).not.toHaveProperty('expiresAt');

    expect((await setTimer(b, dm, 60)).status).toBe(200);
    const minute = await send(b, dm, { content: 'one minute' });
    expect(minute.expireAfterSeconds).toBe(60);
    // A forward INTO the DM is a new message: it takes the DM's timer.
    const fwd = await send(b, dm, { forwardFromMessageId: before.id });
    expect(fwd.expireAfterSeconds).toBe(60);

    expect((await setTimer(a, dm, null)).status).toBe(200);
    const after = await send(a, dm, { content: 'off again' });
    expect(after.expireAfterSeconds).toBeNull();

    // Turning it off does not save what was sent with a timer.
    expect((await row(before.id)).expireAfterSeconds).toBeNull();
    expect((await row(hour.id)).expireAfterSeconds).toBe(3600);
    expect((await row(minute.id)).expireAfterSeconds).toBe(60);
    expect((await row(after.id)).expireAfterSeconds).toBeNull();
    // The list carries the per-message value too.
    const page = await list(b, dm);
    const byId = new Map(page.map((m) => [m.id, m]));
    expect(byId.get(hour.id)!.expireAfterSeconds).toBe(3600);
    expect(byId.get(after.id)!.expireAfterSeconds).toBeNull();
  });

  it('a scheduled message takes the timer in force when it FIRES', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    // Scheduled while the timer was off; it is on by the time it fires.
    expect((await setTimer(b, dm, 28800)).status).toBe(200);
    const [channel] = await db.select().from(schema.channels).where(eq(schema.channels.id, dm));
    const [author] = await db.select().from(schema.users).where(eq(schema.users.id, a));
    const scheduled = {
      id: nextSnowflake(),
      authorId: a,
      channelId: dm,
      content: 'from the past',
      attachments: [],
      replyToMessageId: null,
      scheduledFor: new Date(),
      attempts: 0,
      lastError: null,
      claimedAt: new Date(),
      createdAt: new Date(Date.now() - 86_400_000),
    } as unknown as schema.ScheduledMessage;
    await fireScheduled({ row: scheduled, channel: channel!, author: author ?? null });
    const fired = (await db.select().from(schema.messages).where(eq(schema.messages.channelId, dm))).find(
      (m) => m.content === 'from the past',
    );
    expect(fired!.expireAfterSeconds).toBe(28800);
  });

  it('system rows never get a timer, and guild messages never do', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await setTimer(a, dm, 30)).status).toBe(200);
    const call1 = await createSystemMessage({
      channelId: dm,
      guildId: null,
      authorId: a,
      content: '',
      type: 'system_call',
      mentionedUserIds: [],
      metadata: { kind: 'call', missed: true, durationMs: 0, initiatorId: a.toString() },
    });
    expect(call1.expireAfterSeconds).toBeNull();

    const owner = await createUser();
    const guild = await createGuild(owner, Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.READ_MESSAGE_HISTORY);
    await addMember(guild, owner);
    const text = await createChannel(guild);
    const g = await send(owner, text, { content: 'guild text' });
    expect(g.expireAfterSeconds).toBeNull();
  });

  it('a page fetch does not start the clock; the read ack does (1:1), for the reader and — receipts on — the author', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await setTimer(a, dm, 300)).status).toBe(200);
    const m1 = await send(a, dm, { content: 'first' });
    const m2 = await send(a, dm, { content: 'second' });
    const mine = await send(b, dm, { content: "reader's own" });
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);

    await list(b, dm);
    // The page fetch stamps viewed_at (receipts) but starts no timer.
    await waitFor(async () => (await row(m1.id)).viewedAt !== null);
    expect((await row(m1.id)).expiresAt).toBeNull();

    const t0 = Date.now();
    const r = await ack(b, dm, m2.id);
    expect(r.status).toBe(200);
    for (const m of [m1, m2]) {
      const stored = await row(m.id);
      expect(stored.expiresAt).not.toBeNull();
      expect(Math.abs(stored.expiresAt!.getTime() - (t0 + 300_000))).toBeLessThan(5_000);
    }
    // The reader's own message never counts down from their own read.
    expect((await row(mine.id)).expiresAt).toBeNull();

    const bExp = framesOf(bSent, 'MESSAGE_EXPIRY');
    expect(bExp.length).toBe(1);
    expect(bExp[0]!.channel_id).toBe(dm.toString());
    const expiries = bExp[0]!.expiries as Array<{ id: string; expires_at: string }>;
    expect(expiries.map((e) => e.id).sort()).toEqual([m1.id, m2.id].sort());
    const serverNow = Date.parse(bExp[0]!.server_now as string);
    for (const e of expiries) {
      expect(e.expires_at).toBe((await row(e.id)).expiresAt!.toISOString());
      // server_now is the stamp's own clock: deadline - server_now = the timer.
      expect(Date.parse(e.expires_at) - serverNow).toBe(300_000);
    }
    // B has receipts on, so A (the author) learns the deadline too.
    const aExp = framesOf(aSent, 'MESSAGE_EXPIRY');
    expect(aExp.length).toBe(1);
    expect((aExp[0]!.expiries as Array<{ id: string }>).map((e) => e.id).sort()).toEqual([m1.id, m2.id].sort());

    // MESSAGE_VIEWED from the list fetch carried the STORED stamp.
    await waitFor(() => framesOf(aSent, 'MESSAGE_VIEWED').length > 0);
    expect(framesOf(aSent, 'MESSAGE_VIEWED')[0]!.viewed_at).toBe((await row(m1.id)).viewedAt!.toISOString());
    // A second ack starts nothing new and sends nothing.
    await ack(b, dm, m2.id);
    expect(framesOf(bSent, 'MESSAGE_EXPIRY').length).toBe(1);
    expect(framesOf(aSent, 'MESSAGE_EXPIRY').length).toBe(1);
  });

  it('MESSAGE_VIEWED from the ack carries the stored viewed_at', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const m = await send(a, dm, { content: 'read me' });
    const aSent = connect(a, [dm]);
    await ack(b, dm, m.id);
    await waitFor(() => framesOf(aSent, 'MESSAGE_VIEWED').length === 1);
    const viewed = framesOf(aSent, 'MESSAGE_VIEWED')[0]!;
    expect(viewed.viewed_at).toBe((await row(m.id)).viewedAt!.toISOString());
  });

  it('receipts off: the clock still starts, the reader is told, the author is not', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await receiptsOff(b);
    expect((await setTimer(a, dm, 60)).status).toBe(200);
    const m = await send(a, dm, { content: 'quietly read' });
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);
    await ack(b, dm, m.id);
    expect((await row(m.id)).expiresAt).not.toBeNull();
    expect(framesOf(bSent, 'MESSAGE_EXPIRY').length).toBe(1);
    expect(framesOf(aSent, 'MESSAGE_EXPIRY').length).toBe(0);
  });

  it('group DM: the first reader starts one shared clock; only the reader is told', async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    const gdm = await createDmChannel([a, b, c], 'group_dm');
    expect((await setTimer(a, gdm, 120)).status).toBe(200);
    const m = await send(a, gdm, { content: 'group secret' });
    expect(m.expireAfterSeconds).toBe(120);
    const aSent = connect(a, [gdm]);
    const bSent = connect(b, [gdm]);
    const cSent = connect(c, [gdm]);
    const t0 = Date.now();
    expect((await ack(b, gdm, m.id)).status).toBe(200);
    const first = (await row(m.id)).expiresAt!;
    expect(Math.abs(first.getTime() - (t0 + 120_000))).toBeLessThan(5_000);
    expect(framesOf(bSent, 'MESSAGE_EXPIRY').length).toBe(1);
    expect(framesOf(aSent, 'MESSAGE_EXPIRY').length).toBe(0);
    expect(framesOf(cSent, 'MESSAGE_EXPIRY').length).toBe(0);
    // A second reader doesn't restart it.
    await ack(c, gdm, m.id);
    expect((await row(m.id)).expiresAt!.getTime()).toBe(first.getTime());
    expect(framesOf(cSent, 'MESSAGE_EXPIRY').length).toBe(0);

    // expiresAt in REST: every non-author sees it; the group-DM author never.
    const asA = (await list(a, gdm)).find((x) => x.id === m.id)!;
    expect(asA).not.toHaveProperty('expiresAt');
    const asC = (await list(c, gdm)).find((x) => x.id === m.id)!;
    expect(asC.expiresAt).toBe(first.toISOString());
  });

  it('expiresAt reaches the author in REST only while the 1:1 reader has receipts on', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await setTimer(a, dm, 3600)).status).toBe(200);
    const m = await send(a, dm, { content: 'timed' });
    const unread = await send(a, dm, { content: 'not read yet' });
    await ack(b, dm, m.id);
    const deadline = (await row(m.id)).expiresAt!.toISOString();

    // The reader always sees it (they need it to hide the message on time).
    const bList = await list(b, dm);
    expect(bList.find((x) => x.id === m.id)!.expiresAt).toBe(deadline);
    expect(bList.find((x) => x.id === unread.id)!.expiresAt).toBeNull();
    const bOne = await call('GET', `/channels/${dm}/messages/${m.id}`, b);
    expect((bOne.json!.message as MessageJson).expiresAt).toBe(deadline);

    // Receipts on: the author sees it in the list and the single GET, in
    // every list shape.
    for (const q of ['', `?before=${BigInt(unread.id) + 1n}`, `?after=${BigInt(m.id) - 1n}`, `?around=${m.id}`]) {
      expect((await list(a, dm, q)).find((x) => x.id === m.id)!.expiresAt, q).toBe(deadline);
    }
    const aOne = await call('GET', `/channels/${dm}/messages/${m.id}`, a);
    expect((aOne.json!.message as MessageJson).expiresAt).toBe(deadline);

    // Receipts off: the key is gone for the author — even on the unread row,
    // where a null would itself say "not read yet".
    await receiptsOff(b);
    const aList = await list(a, dm);
    expect(aList.find((x) => x.id === m.id)!).not.toHaveProperty('expiresAt');
    expect(aList.find((x) => x.id === unread.id)!).not.toHaveProperty('expiresAt');
    const aOne2 = await call('GET', `/channels/${dm}/messages/${m.id}`, a);
    expect(aOne2.json!.message as MessageJson).not.toHaveProperty('expiresAt');
    // …while the receipts-off reader still gets it on rows they didn't write.
    expect((await list(b, dm)).find((x) => x.id === m.id)!.expiresAt).toBe(deadline);
  });

  it('read paths hide a message past its deadline before the sweep runs', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const ids: bigint[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await createMessage(dm, { authorId: a, content: `zkdisappear keep ${i}`, expireAfterSeconds: 60, expiresAt: FUTURE() }));
    }
    const gone = await createMessage(dm, {
      authorId: a,
      content: 'zkdisappear gone',
      expireAfterSeconds: 60,
      expiresAt: PAST(),
    });
    ids.push(await createMessage(dm, { authorId: a, content: 'zkdisappear keep last' }));
    const goneStr = gone.toString();
    const hasGone = (page: MessageJson[]) => page.some((m) => m.id === goneStr);

    // Every list shape, and pages stay full (the filter is in SQL).
    const latest = await list(b, dm, '?limit=7');
    expect(hasGone(latest)).toBe(false);
    expect(latest.length).toBe(7);
    expect(hasGone(await list(b, dm, `?before=${ids[6]! + 1n}&limit=7`))).toBe(false);
    expect(hasGone(await list(b, dm, `?after=${ids[0]! - 1n}&limit=7`))).toBe(false);
    // Jumping to the gone message lands on its neighbours (3 older, then the
    // one newer row there is), like a jump to a deleted one.
    const around = await list(b, dm, `?around=${gone}&limit=6`);
    expect(around.map((m) => m.id)).toEqual([ids[3]!, ids[4]!, ids[5]!, ids[6]!].map(String));
    expect((await call('GET', `/channels/${dm}/messages/${gone}`, b)).status).toBe(404);

    // Search, per channel and across DMs.
    const search = await call('GET', `/channels/${dm}/messages/search?q=zkdisappear`, b);
    expect(hasGone(search.json!.messages as MessageJson[])).toBe(false);
    expect((search.json!.messages as MessageJson[]).length).toBe(7);
    expect((await searchDirectMessages(b, 'zkdisappear')).some((m) => m.id === gone)).toBe(false);

    // Saved: can't save it now; a bookmark made earlier stops showing it.
    await expect(saveMessage(b, gone)).rejects.toThrow();
    await db.insert(schema.savedMessages).values({ userId: b, messageId: gone });
    await db.insert(schema.savedMessages).values({ userId: b, messageId: ids[0]! });
    const saved = await listSavedMessages(b);
    expect(saved.items.map((i) => i.message.id)).toEqual([ids[0]!]);

    // Mentions inbox.
    await db.insert(schema.messageUserMentions).values([
      { messageId: gone, userId: b },
      { messageId: ids[1]!, userId: b },
    ]);
    expect((await listUserMentions(b, { limit: 50 })).map((m) => m.id)).toEqual([ids[1]!]);

    // Media / files gallery.
    for (const mid of [gone, ids[2]!]) {
      await db.insert(schema.attachments).values({
        id: nextSnowflake(),
        messageId: mid,
        filename: 'a.png',
        contentType: 'image/png',
        size: 10,
        url: `https://cdn.test/${mid}.png`,
      });
    }
    expect((await listChannelAttachments(dm, { limit: 50 })).map((r) => r.messageId)).toEqual([ids[2]!]);

    // Pins.
    await db.update(schema.messages).set({ pinned: true }).where(eq(schema.messages.id, gone));
    await db.update(schema.messages).set({ pinned: true }).where(eq(schema.messages.id, ids[3]!));
    expect((await listPinned(dm)).map((m) => m.id)).toEqual([ids[3]!]);

    // Nor can it be reacted to, forwarded, replied to or edited.
    await expect(addReaction(gone, b, '👍')).rejects.toThrow();
    expect(await addReaction(ids[3]!, b, '👍')).toBe(true);
    const fwd = await call('POST', `/channels/${dm}/messages`, b, { forwardFromMessageId: goneStr });
    expect(fwd.status).toBe(400);
    const reply = await call('POST', `/channels/${dm}/messages`, b, { content: 're', replyToId: goneStr });
    expect(reply.status).toBe(400);
    expect((await call('PATCH', `/channels/${dm}/messages/${gone}`, a, { content: 'x' })).status).toBe(404);
  });

  it('the embeds pipeline does not re-broadcast a message that expired or was deleted meanwhile', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const live = await createMessage(dm, { authorId: a, content: 'see http://127.0.0.1/x' });
    const expired = await createMessage(dm, {
      authorId: a,
      content: 'see http://127.0.0.1/y',
      expireAfterSeconds: 1,
      expiresAt: PAST(),
    });
    const deleted = await createMessage(dm, { authorId: a, content: 'see http://127.0.0.1/z', deletedAt: new Date() });
    const bSent = connect(b, [dm]);
    for (const [id, url] of [[live, 'x'], [expired, 'y'], [deleted, 'z']] as const) {
      await resolveAndPersistEmbeds({ messageId: id, channelId: dm, guildId: null, content: `see http://127.0.0.1/${url}` });
    }
    const updates = framesOf(bSent, 'MESSAGE_UPDATE').map((d) => d.id);
    expect(updates).toEqual([live.toString()]);
    expect((await row(expired)).embeds).toBeNull();
    expect((await row(deleted)).embeds).toBeNull();
  });
});
