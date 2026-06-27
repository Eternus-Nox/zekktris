import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { runAttachmentRetentionSweep } from '../src/services/uploads';
import { createUser, createGuild, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping attachment-retention tests — no database reachable');
}

const OLD = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // older than any cutoff
const NOW = new Date();

async function addAttachment(messageId: bigint, size = 1000): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.attachments).values({
    id,
    messageId,
    filename: 'f.bin',
    contentType: 'application/octet-stream',
    size,
    url: `/cdn/${id}/f.bin`,
  });
  return id;
}
async function attExists(id: bigint): Promise<boolean> {
  const rows = await db.select({ id: schema.attachments.id }).from(schema.attachments).where(eq(schema.attachments.id, id)).limit(1);
  return rows.length > 0;
}

describe.runIf(dbReady)('attachment retention sweep (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('dry run reports candidates but deletes nothing', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const m = await createMessage(ch, { authorId: owner, createdAt: OLD, content: 'hi' });
    const a = await addAttachment(m);

    const res = await runAttachmentRetentionSweep({ days: 30, dryRun: true });
    expect(res.candidates).toBeGreaterThanOrEqual(1);
    expect(res.deleted).toBe(0);
    expect(await attExists(a)).toBe(true); // untouched
  });

  it('live run deletes ONLY old, non-pinned, non-E2EE media; tombstones the emptied message', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);

    // Eligible: old, not pinned, normal channel, media-only (empty body).
    const mEligible = await createMessage(ch, { authorId: owner, createdAt: OLD, content: '' });
    const aEligible = await addAttachment(mEligible);

    // Excluded — too recent.
    const mRecent = await createMessage(ch, { authorId: owner, createdAt: NOW, content: '' });
    const aRecent = await addAttachment(mRecent);

    // Excluded — pinned.
    const mPinned = await createMessage(ch, { authorId: owner, createdAt: OLD, content: '' });
    await db.update(schema.messages).set({ pinned: true }).where(eq(schema.messages.id, mPinned));
    const aPinned = await addAttachment(mPinned);

    // Excluded — E2EE channel.
    const e2ch = await createChannel(g);
    await db.update(schema.channels).set({ e2eeEnabled: true }).where(eq(schema.channels.id, e2ch));
    const mE2ee = await createMessage(e2ch, { authorId: owner, createdAt: OLD, content: '' });
    const aE2ee = await addAttachment(mE2ee);

    await runAttachmentRetentionSweep({ days: 30, dryRun: false });

    expect(await attExists(aEligible)).toBe(false); // reclaimed
    expect(await attExists(aRecent)).toBe(true);
    expect(await attExists(aPinned)).toBe(true);
    expect(await attExists(aE2ee)).toBe(true);

    // The media-only message it emptied is tombstoned (no blank bubble).
    const [om] = await db
      .select({ d: schema.messages.deletedAt })
      .from(schema.messages)
      .where(eq(schema.messages.id, mEligible))
      .limit(1);
    expect(om?.d).toBeTruthy();
  });

  it('is a no-op when disabled (days = 0)', async () => {
    const res = await runAttachmentRetentionSweep({ days: 0, dryRun: false });
    expect(res).toEqual({ candidates: 0, deleted: 0, bytes: 0 });
  });
});
