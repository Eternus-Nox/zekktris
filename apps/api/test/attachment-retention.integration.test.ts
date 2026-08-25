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

/** Insert an attachment row. `thumb: true` also inserts the thumbnail row it
 *  points at, mirroring how uploads store a main + its own thumbnail row. */
async function addAttachment(
  messageId: bigint,
  opts: { size?: number; thumb?: boolean } = {},
): Promise<{ id: bigint; thumbId: bigint | null }> {
  const id = nextSnowflake();
  let thumbId: bigint | null = null;
  if (opts.thumb) {
    thumbId = nextSnowflake();
    await db.insert(schema.attachments).values({
      id: thumbId,
      messageId,
      filename: 'thumb.webp',
      contentType: 'image/webp',
      size: 50,
      url: `/cdn/${thumbId}/thumb.webp`,
      isThumbnail: true,
    });
  }
  await db.insert(schema.attachments).values({
    id,
    messageId,
    filename: 'f.bin',
    contentType: 'application/octet-stream',
    size: opts.size ?? 1000,
    url: `/cdn/${id}/f.bin`,
    thumbnailUrl: thumbId ? `/cdn/${thumbId}/thumb.webp` : null,
  });
  return { id, thumbId };
}

async function att(id: bigint) {
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

describe.runIf(dbReady)('attachment retention sweep (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('dry run reports what it would reclaim and touches nothing', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const m = await createMessage(ch, { authorId: owner, createdAt: OLD, content: 'hi' });
    const { id } = await addAttachment(m, { thumb: true });

    const res = await runAttachmentRetentionSweep({ days: 30, dryRun: true });
    expect(res.candidates).toBeGreaterThanOrEqual(1);
    expect(res.expired).toBe(0);
    expect(res.bytes).toBeGreaterThanOrEqual(1000);
    expect((await att(id))?.blobExpiredAt).toBeNull(); // untouched
  });

  it('expires the blob but keeps the row, the thumbnail and the message', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);

    // Eligible: old, not pinned, has a thumbnail, media-only (empty body).
    const mEligible = await createMessage(ch, { authorId: owner, createdAt: OLD, content: '' });
    const eligible = await addAttachment(mEligible, { thumb: true });

    // Eligible even though E2EE — encrypted originals are the point of this
    // sweep, and their client-encrypted thumbnail survives independently.
    const e2ch = await createChannel(g);
    await db.update(schema.channels).set({ e2eeEnabled: true }).where(eq(schema.channels.id, e2ch));
    const mE2ee = await createMessage(e2ch, { authorId: owner, createdAt: OLD, content: '' });
    const e2ee = await addAttachment(mE2ee, { thumb: true });

    // Skipped — too recent.
    const mRecent = await createMessage(ch, { authorId: owner, createdAt: NOW, content: '' });
    const recent = await addAttachment(mRecent, { thumb: true });

    // Skipped — pinned.
    const mPinned = await createMessage(ch, { authorId: owner, createdAt: OLD, content: '' });
    await db.update(schema.messages).set({ pinned: true }).where(eq(schema.messages.id, mPinned));
    const pinned = await addAttachment(mPinned, { thumb: true });

    // Skipped — NO thumbnail: the original is the only copy (S1).
    const mNoThumb = await createMessage(ch, { authorId: owner, createdAt: OLD, content: '' });
    const noThumb = await addAttachment(mNoThumb);

    const res = await runAttachmentRetentionSweep({ days: 30, dryRun: false });

    // Expired: bytes gone, row + thumbnail + message all still there.
    const a = await att(eligible.id);
    expect(a?.blobExpiredAt).toBeTruthy();
    expect(a?.filename).toBe('f.bin'); // row kept so the expired state renders
    expect(a?.thumbnailUrl).toBeTruthy();
    expect(await att(eligible.thumbId!)).not.toBeNull(); // thumbnail preserved
    const [msg] = await db
      .select({ d: schema.messages.deletedAt, c: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.id, mEligible))
      .limit(1);
    expect(msg?.d).toBeNull(); // NOT tombstoned — it still renders a thumbnail
    expect((await att(e2ee.id))?.blobExpiredAt).toBeTruthy(); // E2EE included
    expect(await att(e2ee.thumbId!)).not.toBeNull(); // its encrypted thumb survives

    // Untouched.
    expect((await att(recent.id))?.blobExpiredAt).toBeNull();
    expect((await att(pinned.id))?.blobExpiredAt).toBeNull();
    expect((await att(noThumb.id))?.blobExpiredAt).toBeNull();
    // Thumbnail rows are never candidates themselves.
    expect((await att(eligible.thumbId!))?.blobExpiredAt).toBeNull();

    expect(res.skippedNoThumbnail).toBeGreaterThanOrEqual(1);
    expect(res.skippedNoThumbnailBytes).toBeGreaterThanOrEqual(1000);
  });

  it('only reaps un-thumbnailed originals when explicitly opted in', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const m = await createMessage(ch, { authorId: owner, createdAt: OLD, content: 'keep me' });
    const { id } = await addAttachment(m);

    const off = await runAttachmentRetentionSweep({ days: 30, dryRun: false });
    expect(off.skippedNoThumbnail).toBeGreaterThanOrEqual(1);
    expect((await att(id))?.blobExpiredAt).toBeNull();

    const on = await runAttachmentRetentionSweep({ days: 30, dryRun: false, reapUnthumbed: true });
    expect(on.skippedNoThumbnail).toBe(0);
    expect((await att(id))?.blobExpiredAt).toBeTruthy();
    // Message text is never touched, even by the destructive opt-in.
    const [msg] = await db
      .select({ d: schema.messages.deletedAt, c: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.id, m))
      .limit(1);
    expect(msg?.d).toBeNull();
    expect(msg?.c).toBe('keep me');
  });

  it('does not re-process rows it already expired', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const m = await createMessage(ch, { authorId: owner, createdAt: OLD, content: 'x' });
    await addAttachment(m, { thumb: true });

    await runAttachmentRetentionSweep({ days: 30, dryRun: false });
    const second = await runAttachmentRetentionSweep({ days: 30, dryRun: false });
    expect(second.expired).toBe(0);
  });

  it('is a no-op when disabled (days = 0)', async () => {
    const res = await runAttachmentRetentionSweep({ days: 0, dryRun: false });
    expect(res).toEqual({
      candidates: 0,
      expired: 0,
      bytes: 0,
      skippedNoThumbnail: 0,
      skippedNoThumbnailBytes: 0,
    });
  });
});
