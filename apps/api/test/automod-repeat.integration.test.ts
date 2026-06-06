import { describe, it, expect, afterAll } from 'vitest';
import { checkMessage, createRule } from '../src/services/automod';
import { createUser, createGuild, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping automod-repeat tests — no database reachable');
}

describe.runIf(dbReady)('automod repeat_message rule (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function setup(threshold: number) {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    const ch = await createChannel(g);
    await createRule({
      guildId: g,
      actorId: owner,
      name: 'no-spam',
      ruleType: 'repeat_message',
      threshold,
      windowSeconds: 60,
    });
    return { owner, g, ch };
  }

  function check(g: bigint, ch: bigint, userId: bigint, content: string) {
    return checkMessage({ guildId: g, channelId: ch, userId, content, memberRoleIds: [] });
  }

  it('fires when identical content reaches the threshold (priors + current send)', async () => {
    const { owner, g, ch } = await setup(3);
    // Two prior identical sends within the window; the checked send is the 3rd.
    await createMessage(ch, { authorId: owner, content: 'buy now', createdAt: new Date() });
    await createMessage(ch, { authorId: owner, content: 'buy now', createdAt: new Date() });
    const hit = await check(g, ch, owner, 'buy now');
    expect(hit?.ruleType).toBe('repeat_message');
  });

  it('does not fire below the threshold', async () => {
    const { owner, g, ch } = await setup(3);
    await createMessage(ch, { authorId: owner, content: 'hello', createdAt: new Date() }); // only 1 prior
    expect(await check(g, ch, owner, 'hello')).toBeNull();
  });

  it('does not fire when the content differs', async () => {
    const { owner, g, ch } = await setup(2);
    await createMessage(ch, { authorId: owner, content: 'first thing', createdAt: new Date() });
    expect(await check(g, ch, owner, 'a totally different thing')).toBeNull();
  });

  it('ignores prior messages outside the time window', async () => {
    const { owner, g, ch } = await setup(2);
    // One identical prior, but 5 minutes ago — outside the 60s window.
    await createMessage(ch, { authorId: owner, content: 'stale', createdAt: new Date(Date.now() - 300_000) });
    expect(await check(g, ch, owner, 'stale')).toBeNull();
  });

  it('matches case-insensitively and trims surrounding whitespace', async () => {
    const { owner, g, ch } = await setup(2);
    await createMessage(ch, { authorId: owner, content: '  Buy NOW  ', createdAt: new Date() });
    const hit = await check(g, ch, owner, 'buy now');
    expect(hit?.ruleType).toBe('repeat_message');
  });
});
