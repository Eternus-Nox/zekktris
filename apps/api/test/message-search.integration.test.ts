import { describe, it, expect, afterAll } from 'vitest';
import { searchMessages, searchDirectMessages } from '../src/services/messages';
import {
  createUser,
  createGuild,
  addMember,
  createChannel,
  createMessage,
  createDmChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping message-search tests — no database reachable');
}

// Regression guard: both search services were rewritten from a hand-composed
// db.execute(sql`…`) (which 500'd with postgres-js UNDEFINED_VALUE and returned
// snake_case rows hydrateMessages couldn't read) to the drizzle query builder.
// These assert the FTS predicate + recipient scoping actually return rows.
describe.runIf(dbReady)('message search (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  describe('searchMessages (per-channel)', () => {
    it('matches a keyword and respects the channel scope', async () => {
      const owner = await createUser();
      const guild = await createGuild(owner, 0n);
      const ch = await createChannel(guild);
      const other = await createChannel(guild);
      await createMessage(ch, { authorId: owner, content: 'charlie delta echo' });
      await createMessage(other, { authorId: owner, content: 'charlie in another channel' });

      const hits = await searchMessages(ch, 'delta');
      expect(hits.length).toBe(1);
      expect(hits[0]!.channelId).toBe(ch);
      expect(hits[0]!.content).toContain('delta');

      expect((await searchMessages(ch, 'zzznotpresent')).length).toBe(0);
    });
  });

  describe('searchDirectMessages (cross-DM)', () => {
    it('matches across the caller’s DMs and excludes non-recipients', async () => {
      const a = await createUser();
      const b = await createUser();
      const stranger = await createUser();
      const dm = await createDmChannel([a, b]);
      await createMessage(dm, { authorId: a, content: 'alpha bravo charlie' });

      const asA = await searchDirectMessages(a, 'bravo');
      expect(asA.length).toBe(1);
      expect(asA[0]!.channelId).toBe(dm);
      expect(asA[0]!.content).toContain('bravo');

      // The other recipient sees it too.
      expect((await searchDirectMessages(b, 'bravo')).length).toBe(1);
      // A stranger (not a recipient) gets nothing.
      expect((await searchDirectMessages(stranger, 'bravo')).length).toBe(0);
      // No keyword match.
      expect((await searchDirectMessages(a, 'zzznotpresent')).length).toBe(0);
    });
  });
});
