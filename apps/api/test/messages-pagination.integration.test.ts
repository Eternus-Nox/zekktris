import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { listMessages } from '../src/services/messages';
import { nextSnowflake } from '../src/snowflake';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping message-pagination tests — no database reachable');
}

describe.runIf(dbReady)('message pagination cursor (integration)', () => {
  let channelId: bigint;
  // Five messages with strictly increasing snowflake ids: m[0] oldest … m[4] newest.
  const m: bigint[] = [];
  const ids = (rows: Array<{ id: bigint }>) => rows.map((r) => r.id);

  beforeAll(async () => {
    channelId = nextSnowflake();
    await db.insert(schema.channels).values({ id: channelId, type: 'guild_text' });
    for (let i = 0; i < 5; i++) m.push(nextSnowflake());
    await db.insert(schema.messages).values(m.map((id) => ({ id, channelId })));
  });

  afterAll(async () => {
    await db.delete(schema.messages).where(eq(schema.messages.channelId, channelId));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
    await closeDb();
  });

  it('defaults to newest-first (id desc)', async () => {
    const rows = await listMessages(channelId, { limit: 3 });
    expect(ids(rows)).toEqual([m[4], m[3], m[2]]);
  });

  it('respects the limit', async () => {
    const rows = await listMessages(channelId, { limit: 2 });
    expect(ids(rows)).toEqual([m[4], m[3]]);
  });

  it('before: returns older messages, newest-first', async () => {
    const rows = await listMessages(channelId, { before: m[2], limit: 10 });
    expect(ids(rows)).toEqual([m[1], m[0]]);
  });

  it('after: flips to oldest-first and walks forward', async () => {
    const rows = await listMessages(channelId, { after: m[2], limit: 10 });
    expect(ids(rows)).toEqual([m[3], m[4]]);
  });

  it('around: returns a chronological window centered on the target (inclusive)', async () => {
    // half = floor(4/2) = 2 → older (≤ m2, desc, 2) = [m2,m1] reversed → [m1,m2];
    // newer (> m2, asc, 2) = [m3,m4]. Merged chronological: [m1,m2,m3,m4].
    const rows = await listMessages(channelId, { around: m[2], limit: 4 });
    expect(ids(rows)).toEqual([m[1], m[2], m[3], m[4]]);
  });
});
