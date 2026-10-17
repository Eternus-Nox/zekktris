import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { createRule } from '../src/services/automod';
import { createWebhook, executeWebhook } from '../src/services/webhooks';
import { createUser, createGuild, addMember, createChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping webhook-moderation tests — no database reachable');
}

// Webhook executes used to call createMessage directly, skipping the guild's
// banned-word / automod gate that every other send runs.
describe.runIf(dbReady)('webhook execute content moderation', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function fixture(action: 'block' | 'block_and_timeout') {
    const owner = await createUser();
    const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
    await addMember(g, owner);
    const ch = await createChannel(g);
    await createRule({
      guildId: g,
      actorId: owner,
      name: 'no-x',
      ruleType: 'word_blocklist',
      patterns: ['forbiddenword'],
      action,
      timeoutSeconds: action === 'block_and_timeout' ? 600 : undefined,
    });
    const wh = await createWebhook({ channelId: ch, actorId: owner, name: 'Hook' });
    return { owner, g, ch, wh };
  }
  const count = async (ch: bigint) =>
    (await db.select().from(schema.messages).where(eq(schema.messages.channelId, ch))).length;

  it('blocks automod-matched content and rich-embed text; clean posts still go through', async () => {
    const { ch, wh } = await fixture('block');
    await expect(
      executeWebhook({ webhookId: wh.id, token: wh.token, content: 'has forbiddenword' }),
    ).rejects.toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    await expect(
      executeWebhook({
        webhookId: wh.id,
        token: wh.token,
        content: 'innocent',
        embeds: [{ url: '', kind: 'rich', description: 'sneaky forbiddenword here' }],
      }),
    ).rejects.toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    expect(await count(ch)).toBe(0);

    await executeWebhook({ webhookId: wh.id, token: wh.token, content: 'all fine' });
    expect(await count(ch)).toBe(1);
  });

  it('a block_and_timeout rule blocks the post without timing out the webhook creator', async () => {
    const { owner, g, wh } = await fixture('block_and_timeout');
    await expect(
      executeWebhook({ webhookId: wh.id, token: wh.token, content: 'forbiddenword' }),
    ).rejects.toMatchObject({ code: 'AUTOMOD_BLOCKED' });
    const [member] = await db
      .select({ until: schema.guildMembers.communicationDisabledUntil })
      .from(schema.guildMembers)
      .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, owner)));
    expect(member!.until).toBeNull();
  });
});
