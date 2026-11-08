import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { sweepExpiredDmMessages } from '../src/services/dms';
import { listMessages } from '../src/services/messages';
import { createUser, createDmChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping disappearing-sweep tests — no database reachable');
}

// The sweep soft-deletes by each message's own deadline (expires_at) — never
// by the old "viewed_at + the conversation's CURRENT timer" rule, which wiped
// history viewed before a timer was even turned on. One MESSAGE_DELETE per
// row (installed apps predate MESSAGE_DELETE_BULK), and the unread watermark
// rolls back like a manual delete.
//
// The sweep is instance-wide, so assertions are about THIS file's rows only
// (other suites may leave expired rows of their own behind).

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
const deletesFor = (sent: Frame[], dm: bigint) =>
  sent
    .filter((f) => f.t === 'MESSAGE_DELETE' && f.d?.channel_id === dm.toString())
    .map((f) => f.d!.id as string);

async function deletedAt(id: bigint): Promise<Date | null> {
  const [r] = await db.select({ d: schema.messages.deletedAt }).from(schema.messages).where(eq(schema.messages.id, id));
  return r!.d;
}
async function watermark(dm: bigint): Promise<bigint | null> {
  const [r] = await db.select({ w: schema.channels.lastMessageId }).from(schema.channels).where(eq(schema.channels.id, dm));
  return r!.w;
}
async function setWatermark(dm: bigint, id: bigint): Promise<void> {
  await db.update(schema.channels).set({ lastMessageId: id }).where(eq(schema.channels.id, dm));
}
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

describe.runIf(dbReady)('disappearing-messages sweep (integration)', () => {
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

  it('deletes only rows past expires_at, never a NULL one; one MESSAGE_DELETE per row to every recipient', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    // The conversation's CURRENT timer is short — the old rule would have
    // swept every row viewed more than 30 s ago.
    await db.insert(schema.dmSettings).values({ channelId: dm, ttlSecondsAfterRead: 30 });
    const longAgo = ago(86_400_000);
    const expired1 = await createMessage(dm, { authorId: a, content: 'x1', expireAfterSeconds: 30, viewedAt: longAgo, expiresAt: ago(5_000) });
    const expired2 = await createMessage(dm, { authorId: b, content: 'x2', expireAfterSeconds: 30, viewedAt: longAgo, expiresAt: ago(1_000) });
    const pending = await createMessage(dm, { authorId: a, content: 'p', expireAfterSeconds: 30, viewedAt: longAgo, expiresAt: ahead(60_000) });
    // Regression: viewed long ago, but its clock never started (read before
    // this model / sent before the timer was on) — must survive.
    const neverStarted = await createMessage(dm, { authorId: a, content: 'n', expireAfterSeconds: 30, viewedAt: longAgo });
    const noTimer = await createMessage(dm, { authorId: b, content: 'plain', viewedAt: longAgo });
    const alreadyDeleted = await createMessage(dm, { authorId: a, content: 'd', expireAfterSeconds: 30, expiresAt: ago(10_000), deletedAt: ago(9_000) });
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);

    const n = await sweepExpiredDmMessages();
    expect(n).toBeGreaterThanOrEqual(2);

    expect(await deletedAt(expired1)).not.toBeNull();
    expect(await deletedAt(expired2)).not.toBeNull();
    expect(await deletedAt(pending)).toBeNull();
    expect(await deletedAt(neverStarted)).toBeNull();
    expect(await deletedAt(noTimer)).toBeNull();
    // An already-deleted row keeps its original deletion time.
    expect((await deletedAt(alreadyDeleted))!.getTime()).toBeLessThan(Date.now() - 8_000);

    for (const sent of [aSent, bSent]) {
      expect(deletesFor(sent, dm).sort()).toEqual([expired1, expired2].map(String).sort());
    }

    // Idempotent: nothing more to do for this channel.
    await sweepExpiredDmMessages();
    expect(deletesFor(aSent, dm).length).toBe(2);
  });

  it('rolls the watermark back to the newest surviving message, or NULL when none is left', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const keep = await createMessage(dm, { authorId: a, content: 'keep' });
    const lastGone = await createMessage(dm, { authorId: b, content: 'gone', expireAfterSeconds: 5, expiresAt: ago(1_000) });
    await setWatermark(dm, lastGone);
    // A row whose deadline passed but the sweep hasn't reached yet must not
    // become the new watermark either.
    const other = await createDmChannel([a, b]);
    const o1 = await createMessage(other, { authorId: a, content: 'o1', expireAfterSeconds: 5, expiresAt: ago(2_000) });
    const o2 = await createMessage(other, { authorId: a, content: 'o2', expireAfterSeconds: 5, expiresAt: ago(1_000) });
    await setWatermark(other, o2);
    // A mid-history expiry leaves the watermark alone.
    const third = await createDmChannel([a, b]);
    const mid = await createMessage(third, { authorId: a, content: 'mid', expireAfterSeconds: 5, expiresAt: ago(1_000) });
    const newest = await createMessage(third, { authorId: b, content: 'newest' });
    await setWatermark(third, newest);

    await sweepExpiredDmMessages();
    expect(await watermark(dm)).toBe(keep);
    expect(await deletedAt(o1)).not.toBeNull();
    expect(await watermark(other)).toBeNull();
    expect(await deletedAt(mid)).not.toBeNull();
    expect(await watermark(third)).toBe(newest);
  });

  it('drains more than one batch per call', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    // 1200 expired rows: three 500-row batches in one call.
    await db.execute(sql`
      INSERT INTO messages (id, channel_id, author_id, content, expire_after_seconds, expires_at)
      SELECT ${BigInt(Date.now()) * 1_000_000n} + g, ${dm}, ${a}, 'bulk', 5, now() - interval '1 minute'
        FROM generate_series(1, 1200) AS g
    `);
    const bSent = connect(b, [dm]);
    const n = await sweepExpiredDmMessages();
    expect(n).toBeGreaterThanOrEqual(1200);
    const [counted] = (await db.execute(
      sql`SELECT count(*)::int AS left FROM messages WHERE channel_id = ${dm} AND deleted_at IS NULL`,
    )) as unknown as Array<{ left: number }>;
    expect(counted!.left).toBe(0);
    expect(deletesFor(bSent, dm).length).toBe(1200);
  });

  it('is a soft delete: the supervision reader (includeDeleted) still sees the content', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const m = await createMessage(dm, { authorId: a, content: 'kept for the guardian', expireAfterSeconds: 5, expiresAt: ago(1_000) });
    await sweepExpiredDmMessages();
    const normal = await listMessages(dm, { limit: 50 });
    expect(normal.map((r) => r.id)).not.toContain(m);
    const guardian = await listMessages(dm, { limit: 50, includeDeleted: true });
    const row = guardian.find((r) => r.id === m)!;
    expect(row.content).toBe('kept for the guardian');
    expect(row.deletedAt).not.toBeNull();
  });

  it('even before the sweep, the supervision reader still sees an expired row', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const m = await createMessage(dm, { authorId: a, content: 'expired, unswept', expireAfterSeconds: 5, expiresAt: ago(1_000) });
    expect((await listMessages(dm, { limit: 50 })).map((r) => r.id)).not.toContain(m);
    expect((await listMessages(dm, { limit: 50, includeDeleted: true })).map((r) => r.id)).toContain(m);
    // Clean up so a later sweep in another suite doesn't count it.
    await db.update(schema.messages).set({ deletedAt: new Date() }).where(inArray(schema.messages.id, [m]));
  });
});
