import { describe, it, expect, afterAll } from 'vitest';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { loadAttachments, listChannelAttachments } from '../src/services/messages';
import { saveUploadedFile } from '../src/services/uploads';
import { createUser, createGuild, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping attachment-thumbnail tests — no database reachable');
}

// A thumbnail is its OWN attachments row (so the CDN can serve it + GC keeps it),
// but it's a preview of another attachment — it must NEVER appear as a standalone
// item in a message's attachment list or the media gallery, and the main row must
// carry its thumbnail_url.
describe.runIf(dbReady)('attachment thumbnails', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('excludes thumbnail rows from message + gallery listings; main carries thumbnailUrl', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const msgId = await createMessage(ch, { authorId: owner, content: 'pic' });

    const mainId = nextSnowflake();
    const thumbId = nextSnowflake();
    await db.insert(schema.attachments).values([
      {
        id: mainId,
        messageId: msgId,
        filename: 'photo.webp',
        contentType: 'image/webp',
        size: 1000,
        url: `/cdn/${mainId}/photo.webp`,
        width: 800,
        height: 600,
        thumbnailUrl: `/cdn/${thumbId}/thumb.webp`,
        isThumbnail: false,
      },
      {
        id: thumbId,
        messageId: msgId,
        filename: 'thumb.webp',
        contentType: 'image/webp',
        size: 80,
        url: `/cdn/${thumbId}/thumb.webp`,
        isThumbnail: true,
      },
    ]);

    // Per-message hydration: only the main, with its thumbnail_url.
    const loaded = await loadAttachments([msgId]);
    const atts = loaded.get(msgId) ?? [];
    expect(atts).toHaveLength(1);
    expect(atts[0]!.id).toBe(mainId);
    expect(atts[0]!.thumbnailUrl).toBe(`/cdn/${thumbId}/thumb.webp`);

    // Media gallery: the main shows, the thumbnail does not.
    const gallery = await listChannelAttachments(ch, { limit: 50, kind: 'media' });
    const ids = gallery.map((r) => r.attachment.id);
    expect(ids).toContain(mainId);
    expect(ids).not.toContain(thumbId);
  });

  it('saveUploadedFile stores a provided encrypted thumbnail as its own attachment', async () => {
    const main = new File([new Uint8Array([1, 2, 3, 4])], 'p.zke', {
      type: 'application/octet-stream',
    });
    const thumb = new File([new Uint8Array([9, 9, 9])], 'thumb.zke', {
      type: 'application/octet-stream',
    });
    const saved = await saveUploadedFile(main, { encryptedThumb: thumb });
    expect(saved.thumbnail).not.toBeNull();
    expect(saved.thumbnail!.attachmentId).not.toBe(saved.attachmentId);
    expect(saved.thumbnail!.url).toContain(`/cdn/${saved.thumbnail!.attachmentId}/`);
  });
});
