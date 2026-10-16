import { describe, it, expect, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createBot, resolveBotByToken } from '../src/services/bots';
import { createWebhook, executeWebhook } from '../src/services/webhooks';
import { authRouter } from '../src/routes/auth';
import { errorHandler } from '../src/middleware';
import { __setRateLimitRedis } from '../src/lib/rateLimit';
import { createUser, createGuild, createChannel, addMember, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

// Forgot-password only proceeds with mail configured; stub the transport.
vi.mock('../src/services/email', () => ({
  isEmailConfigured: () => true,
  sendPasswordResetEmail: vi.fn(async () => {}),
}));

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping ban-predicate tests — no database reachable');
}

// One ban predicate everywhere (services/instanceBans.isCurrentlyBanned): a
// timed ban whose banned_until has passed is NOT a ban, even before the hourly
// sweep clears the columns — for bots, webhooks and password reset exactly as
// for REST login and the gateway.

const HOUR = 3_600_000;

async function ban(userId: bigint, bannedUntil: Date | null): Promise<void> {
  await db
    .update(schema.users)
    .set({ bannedAt: new Date(Date.now() - 60_000), bannedUntil })
    .where(eq(schema.users.id, userId));
}
const expired = () => new Date(Date.now() - 1000);
const active = () => new Date(Date.now() + HOUR);

describe.runIf(dbReady)('ban predicate: expired timed bans no longer block (integration)', () => {
  afterAll(async () => {
    __setRateLimitRedis(undefined);
    await cleanupAll();
    await closeDb();
  });

  it('bot tokens: expired ban (bot or owner) authenticates; active ban does not', async () => {
    const owner = await createUser();
    const { bot, token } = await createBot({
      ownerId: owner,
      username: `bot_${owner}`,
      displayName: 'Ban Bot',
    });
    try {
      await ban(owner, expired());
      expect((await resolveBotByToken(token))?.id).toBe(bot.id);
      await ban(bot.id, expired());
      expect((await resolveBotByToken(token))?.id).toBe(bot.id);

      await ban(owner, active());
      expect(await resolveBotByToken(token)).toBeNull();
      await ban(owner, expired());
      await ban(bot.id, active());
      expect(await resolveBotByToken(token)).toBeNull();
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, bot.id));
    }
  });

  it('webhook execute: expired owner ban posts; active owner ban is rejected', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    await addMember(guildId, owner); // the guild owner, with every permission
    const channelId = await createChannel(guildId);
    const wh = await createWebhook({ channelId, actorId: owner, name: 'hook' });

    await ban(owner, expired());
    const msg = await executeWebhook({ webhookId: wh.id, token: wh.token, content: 'hello' });
    expect(msg.channelId).toBe(channelId);

    await ban(owner, active());
    await expect(
      executeWebhook({ webhookId: wh.id, token: wh.token, content: 'blocked' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('forgot-password: expired ban gets a reset token; active ban does not', async () => {
    __setRateLimitRedis(null); // in-memory limiter, independent of REDIS_URL
    const app = new Hono();
    app.route('/auth', authRouter);
    app.onError(errorHandler);

    const resetRows = async (userId: bigint) =>
      db.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, userId));
    const forgot = async (userId: bigint) => {
      const res = await app.request('/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `u-${userId}@test.local` }),
      });
      expect(res.status).toBe(200);
    };

    const lapsed = await createUser();
    await ban(lapsed, expired());
    await forgot(lapsed);
    // The lookup + mint runs detached from the response; wait for it.
    await vi.waitFor(async () => expect(await resetRows(lapsed)).toHaveLength(1), {
      timeout: 5000,
    });

    const banned = await createUser();
    await ban(banned, active());
    await forgot(banned);
    await new Promise((r) => setTimeout(r, 300));
    expect(await resetRows(banned)).toHaveLength(0);
  });
});
