import { describe, it, expect, afterAll } from 'vitest';
import { enforceSlowmode } from '../src/services/messages';
import { createUser, createGuild, addMember, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping slowmode tests — no database reachable');
}

describe.runIf(dbReady)('slowmode enforcement (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function fixture() {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    const ch = await createChannel(g);
    return { owner, g, ch };
  }

  it('is a no-op when rateLimitPerUser <= 0', async () => {
    const { owner, ch } = await fixture();
    await createMessage(ch, { authorId: owner, createdAt: new Date() }); // recent
    await expect(enforceSlowmode(ch, owner, 0)).resolves.toBeUndefined();
  });

  it('allows the first message (no prior message by the user)', async () => {
    const { owner, ch } = await fixture();
    await expect(enforceSlowmode(ch, owner, 30)).resolves.toBeUndefined();
  });

  it('rejects a message sent within the rate window', async () => {
    const { owner, ch } = await fixture();
    await createMessage(ch, { authorId: owner, createdAt: new Date() }); // just now
    await expect(enforceSlowmode(ch, owner, 30)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('allows a message once enough time has elapsed', async () => {
    const { owner, ch } = await fixture();
    await createMessage(ch, { authorId: owner, createdAt: new Date(Date.now() - 60_000) }); // 60s ago
    await expect(enforceSlowmode(ch, owner, 30)).resolves.toBeUndefined();
  });

  it("only considers the caller's own messages", async () => {
    const { owner, g, ch } = await fixture();
    const other = await createUser();
    await addMember(g, other);
    await createMessage(ch, { authorId: other, createdAt: new Date() }); // someone else just posted
    await expect(enforceSlowmode(ch, owner, 30)).resolves.toBeUndefined();
  });
});
