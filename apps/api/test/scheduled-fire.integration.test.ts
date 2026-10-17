import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { createRule } from '../src/services/automod';
import { getConfig } from '../src/services/security';
import { failScheduled, fireScheduled, listForUser } from '../src/services/scheduledMessages';
import { createUser, createGuild, addMember, createChannel, addRelationship, createDmChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping scheduled-fire tests — no database reachable');
}

const MEMBER = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY;

function dobForAge(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fire(authorId: bigint, channelId: bigint, content: string) {
  const [channel] = await db.select().from(schema.channels).where(eq(schema.channels.id, channelId));
  const [author] = await db.select().from(schema.users).where(eq(schema.users.id, authorId));
  const row = {
    id: nextSnowflake(),
    authorId,
    channelId,
    content,
    attachments: [],
    replyToMessageId: null,
    scheduledFor: new Date(),
    attempts: 0,
    lastError: null,
    claimedAt: new Date(),
    createdAt: new Date(),
  } as unknown as schema.ScheduledMessage;
  return fireScheduled({ row, channel: channel!, author: author ?? null });
}

async function messagesIn(channelId: bigint) {
  return db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));
}

// A scheduled message used to re-check only SEND_MESSAGES at fire time, so a
// timed-out / un-onboarded member or automod-blocked text could be posted by
// scheduling it a minute out. fireScheduled now runs the live-send gates.
describe.runIf(dbReady)('scheduled message fire-time gates', () => {
  let child: bigint;
  let parent: bigint;

  beforeAll(async () => {
    // One supervised child for the whole file: the watch-word scan caches the
    // supervised-child set for 15 s, so it must exist before the first scan.
    parent = await createUser({ dateOfBirth: dobForAge(40) });
    child = await createUser({ dateOfBirth: dobForAge(15) });
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: child,
      status: 'active',
      initiatedBy: 'parent',
    });
    await db.insert(schema.childWatchWords).values({ childId: child, word: 'meetup' });
  });

  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function guildWith(member: bigint) {
    const owner = await createUser();
    const g = await createGuild(owner, MEMBER);
    await addMember(g, member);
    const ch = await createChannel(g);
    return { g, ch };
  }

  it('posts an allowed message and runs the watch-word scan', async () => {
    const { ch } = await guildWith(child);
    await fire(child, ch, 'want to meetup later?');
    const msgs = await messagesIn(ch);
    expect(msgs).toHaveLength(1);
    const flags = await db
      .select()
      .from(schema.flaggedMessages)
      .where(eq(schema.flaggedMessages.messageId, msgs[0]!.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.childId).toBe(child);
    expect(flags[0]!.matchedWord).toBe('meetup');
  });

  it('refuses a timed-out member', async () => {
    const u = await createUser();
    const { g, ch } = await guildWith(u);
    await db
      .update(schema.guildMembers)
      .set({ communicationDisabledUntil: new Date(Date.now() + 3600_000) })
      .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, u)));
    await expect(fire(u, ch, 'hello')).rejects.toMatchObject({ code: 'TIMED_OUT' });
    expect(await messagesIn(ch)).toHaveLength(0);
  });

  it('refuses a member who has not acknowledged the rules', async () => {
    const u = await createUser();
    const { g, ch } = await guildWith(u);
    await db
      .update(schema.guildMembers)
      .set({ membershipState: 'pending' })
      .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, u)));
    await expect(fire(u, ch, 'hello')).rejects.toMatchObject({ code: 'PENDING_ACKNOWLEDGMENT' });
    expect(await messagesIn(ch)).toHaveLength(0);
  });

  it('refuses text the guild automod blocks', async () => {
    const u = await createUser();
    const { g, ch } = await guildWith(u);
    await createRule({ guildId: g, actorId: u, name: 'no-x', ruleType: 'word_blocklist', patterns: ['forbiddenword'] });
    await expect(fire(u, ch, 'this has forbiddenword in it')).rejects.toMatchObject({
      code: 'AUTOMOD_BLOCKED',
    });
    expect(await messagesIn(ch)).toHaveLength(0);
  });

  it('refuses an instance-muted author', async () => {
    const u = await createUser();
    const { ch } = await guildWith(u);
    await db.update(schema.users).set({ mutedAt: new Date() }).where(eq(schema.users.id, u));
    await expect(fire(u, ch, 'hello')).rejects.toMatchObject({ code: 'INSTANCE_MUTED' });
    expect(await messagesIn(ch)).toHaveLength(0);
  });

  // A row queued before the create route refused these, into a forum or a
  // link channel, must not be inserted there at fire time.
  it('refuses a forum or link channel, like the live send', async () => {
    const u = await createUser();
    const { g } = await guildWith(u);
    const forum = nextSnowflake();
    const link = nextSnowflake();
    await db.insert(schema.channels).values([
      { id: forum, type: 'guild_forum', guildId: g, name: 'forum' },
      { id: link, type: 'guild_link', guildId: g, name: 'docs', linkUrl: 'https://example.com' },
    ]);
    await expect(fire(u, forum, 'scheduled into forum')).rejects.toThrow(/Forum channels only accept posts/);
    await expect(fire(u, link, 'scheduled into link')).rejects.toThrow(/Link channels are bookmarks/);
    expect(await messagesIn(forum)).toHaveLength(0);
    expect(await messagesIn(link)).toHaveLength(0);
  });

  it('still refuses ciphertext in a supervised DM', async () => {
    const pal = await createUser({ dateOfBirth: dobForAge(30) });
    await addRelationship(child, pal, 'friend');
    await addRelationship(pal, child, 'friend');
    const dm = await createDmChannel([child, pal]);
    await expect(fire(child, dm, 'zkE2EE/3:abcdef')).rejects.toThrow(/supervised/);
    expect(await messagesIn(dm)).toHaveLength(0);
  });

  // requireAuth refuses a live send from a banned or deleted account, but the
  // worker has no request: a banned spammer's queued messages used to post.
  describe('author account state', () => {
    async function ban(u: bigint, until: Date | null) {
      await db
        .update(schema.users)
        .set({ bannedAt: new Date(Date.now() - 60_000), bannedUntil: until })
        .where(eq(schema.users.id, u));
    }

    // The worker's per-row path (index.ts): fire, and on a throw record the
    // error with failScheduled, which keeps the row for the author to see.
    async function runWorkerOn(authorId: bigint, channelId: bigint, content: string) {
      const id = nextSnowflake();
      const [row] = await db
        .insert(schema.scheduledMessages)
        .values({ id, authorId, channelId, content, scheduledFor: new Date(), claimedAt: new Date() })
        .returning();
      const [channel] = await db.select().from(schema.channels).where(eq(schema.channels.id, channelId));
      const [author] = await db.select().from(schema.users).where(eq(schema.users.id, authorId));
      try {
        await fireScheduled({ row: row!, channel: channel!, author: author ?? null });
      } catch (err) {
        await failScheduled(id, (err as Error).message);
      }
      return id;
    }

    it('refuses a permanently banned author; the row fails and stays listed', async () => {
      const u = await createUser();
      const { ch } = await guildWith(u);
      await ban(u, null);
      const id = await runWorkerOn(u, ch, 'scheduled by a banned user');
      expect(await messagesIn(ch)).toHaveLength(0);
      const pending = await listForUser(u);
      const row = pending.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row!.attempts).toBe(1);
      expect(row!.lastError).toBe('Account unavailable');
      expect(row!.claimedAt).toBeNull();
    });

    it('refuses an author whose timed ban is still running', async () => {
      const u = await createUser();
      const { ch } = await guildWith(u);
      await ban(u, new Date(Date.now() + 3600_000));
      await expect(fire(u, ch, 'hello')).rejects.toThrow('Account unavailable');
      expect(await messagesIn(ch)).toHaveLength(0);
    });

    it('posts once a timed ban has expired, even before the sweep clears it', async () => {
      const u = await createUser();
      const { ch } = await guildWith(u);
      await ban(u, new Date(Date.now() - 1000));
      await fire(u, ch, 'back again');
      expect(await messagesIn(ch)).toHaveLength(1);
    });

    it('refuses a soft-deleted author', async () => {
      const u = await createUser();
      const { ch } = await guildWith(u);
      await db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, u));
      await expect(fire(u, ch, 'hello')).rejects.toThrow('Account unavailable');
      expect(await messagesIn(ch)).toHaveLength(0);
    });

    it('refuses a DM from a banned author too', async () => {
      const u = await createUser();
      const pal = await createUser();
      const dm = await createDmChannel([u, pal]);
      await ban(u, null);
      await expect(fire(u, dm, 'hello')).rejects.toThrow('Account unavailable');
      expect(await messagesIn(dm)).toHaveLength(0);
    });
  });

  // Deliberate: scheduling is not a way around the instance flood limit, so
  // fires count toward the author's throttle like live sends. A fire over the
  // limit is refused (the worker records it and retries on a later tick).
  it('counts fires toward the spam throttle and refuses one over the limit', async () => {
    const cfg = await getConfig();
    expect(cfg.spamEnabled).toBe(true);
    const u = await createUser();
    const { ch } = await guildWith(u);
    // spamMaxMessages + 1 send; that last one starts the cooldown.
    for (let i = 0; i <= cfg.spamMaxMessages; i++) await fire(u, ch, `m${i}`);
    await expect(fire(u, ch, 'one more')).rejects.toThrow(/too fast/);
    expect(await messagesIn(ch)).toHaveLength(cfg.spamMaxMessages + 1);
  });
});
