import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { messagesRouter } from '../src/routes/messages';
import { guildsRouter } from '../src/routes/guilds';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createRule } from '../src/services/automod';
import { addBannedWord, removeBannedWord } from '../src/services/security';
import {
  createBot,
  addBotToGuild,
  registerBotCommand,
  setBotEventConfig,
} from '../src/services/bots';
import { createUser, createGuild, addMember, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping send-gates-parity tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/channels', messagesRouter);
app.route('/guilds', guildsRouter);

const MEMBER = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY;
// Unique to this file so the instance-wide list never matches another suite.
const BANNED = 'zkgatebannedword';
const AUTOMOD = 'zkgateautomodword';

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return `Bearer ${await signAccessToken({ userId, sessionId: session.id })}`;
}
async function req(method: string, path: string, userId: bigint, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: await tokenFor(userId), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return { status: res.status, code: json?.error?.code, json };
}
function dobForAge(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function setTimeout_(g: bigint, u: bigint) {
  await db
    .update(schema.guildMembers)
    .set({ communicationDisabledUntil: new Date(Date.now() + 3600_000) })
    .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, u)));
}
async function setPending(g: bigint, u: bigint) {
  await db
    .update(schema.guildMembers)
    .set({ membershipState: 'pending' })
    .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, u)));
}
async function threadsUnder(parentId: bigint) {
  return db.select().from(schema.channels).where(eq(schema.channels.parentId, parentId));
}
async function messagesIn(channelId: bigint) {
  return db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));
}
async function timeoutOf(g: bigint, u: bigint) {
  const [row] = await db
    .select({ until: schema.guildMembers.communicationDisabledUntil })
    .from(schema.guildMembers)
    .where(and(eq(schema.guildMembers.guildId, g), eq(schema.guildMembers.userId, u)));
  return row!.until;
}

/** A guild with an automod word rule, a text channel and a forum, plus a
 *  plain member. */
async function fixture(opts: { forumSlowmode?: number } = {}) {
  const owner = await createUser();
  const g = await createGuild(owner, MEMBER);
  await addMember(g, owner);
  const member = await createUser();
  await addMember(g, member);
  const text = await createChannel(g);
  const forum = nextSnowflake();
  await db.insert(schema.channels).values({
    id: forum,
    type: 'guild_forum',
    guildId: g,
    name: 'forum',
    rateLimitPerUser: opts.forumSlowmode ?? 0,
  });
  await createRule({
    guildId: g,
    actorId: owner,
    name: 'no-word',
    ruleType: 'word_blocklist',
    patterns: [AUTOMOD],
  });
  return { owner, g, member, text, forum };
}

// Forum posts and message-anchored threads used to check only VIEW_CHANNEL +
// SEND_MESSAGES (+ forum slowmode), so a timed-out, un-onboarded or
// supervision-restricted member could still post, and banned words / automod
// were never run over the post or the thread name. They now go through
// enforceGuildSendGates like the live send.
describe.runIf(dbReady)('send gates on every guild send path', () => {
  let wordAdder: bigint;

  beforeAll(async () => {
    wordAdder = await createUser();
    await addBannedWord(BANNED, 'blocked', wordAdder);
  });

  afterAll(async () => {
    await removeBannedWord(BANNED);
    await cleanupAll();
    await closeDb();
  });

  describe('POST /channels/:forumId/posts', () => {
    it('creates a post for a member in good standing', async () => {
      const { member, forum } = await fixture();
      const res = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'hello',
        content: 'first post',
      });
      expect(res.status).toBe(201);
      expect(await threadsUnder(forum)).toHaveLength(1);
    });

    it('refuses a timed-out member with TIMED_OUT, like the live send', async () => {
      const { g, member, text, forum } = await fixture();
      await setTimeout_(g, member);
      const live = await req('POST', `/channels/${text}/messages`, member, { content: 'hi' });
      expect(live).toMatchObject({ status: 403, code: 'TIMED_OUT' });
      const res = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'hello',
        content: 'body',
      });
      expect(res).toMatchObject({ status: 403, code: 'TIMED_OUT' });
      expect(await threadsUnder(forum)).toHaveLength(0);
    });

    it('refuses a member who has not acknowledged the rules', async () => {
      const { g, member, forum } = await fixture();
      await setPending(g, member);
      const res = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'hello',
        content: 'body',
      });
      expect(res).toMatchObject({ status: 403, code: 'PENDING_ACKNOWLEDGMENT' });
      expect(await threadsUnder(forum)).toHaveLength(0);
    });

    it('refuses a supervision-restricted (unlinked minor) member', async () => {
      const { g, forum } = await fixture();
      const minor = await createUser({ dateOfBirth: dobForAge(15) });
      await addMember(g, minor);
      const res = await req('POST', `/channels/${forum}/posts`, minor, {
        title: 'hello',
        content: 'body',
      });
      expect(res).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(await threadsUnder(forum)).toHaveLength(0);
    });

    it('blocks an automod word in the content and in the title', async () => {
      const { member, forum } = await fixture();
      const inBody = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'hello',
        content: `this has ${AUTOMOD}`,
      });
      expect(inBody).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      const inTitle = await req('POST', `/channels/${forum}/posts`, member, {
        title: `about ${AUTOMOD}`,
        content: 'clean body',
      });
      expect(inTitle).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      expect(await threadsUnder(forum)).toHaveLength(0);
    });

    it('blocks an instance banned word in the content and in the title', async () => {
      const { member, forum } = await fixture();
      const inBody = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'hello',
        content: `this has ${BANNED}`,
      });
      expect(inBody).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
      const inTitle = await req('POST', `/channels/${forum}/posts`, member, {
        title: `about ${BANNED}`,
        content: 'clean body',
      });
      expect(inTitle).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
      expect(await threadsUnder(forum)).toHaveLength(0);
    });

    it('keeps the forum-specific slowmode, after the participation gates', async () => {
      const { g, member, forum } = await fixture({ forumSlowmode: 600 });
      const first = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'one',
        content: 'body',
      });
      expect(first.status).toBe(201);
      const second = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'two',
        content: 'body',
      });
      expect(second).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
      // Same throw order as the live send: a timeout outranks slowmode.
      await setTimeout_(g, member);
      const third = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'three',
        content: 'body',
      });
      expect(third).toMatchObject({ status: 403, code: 'TIMED_OUT' });
    });
  });

  describe('POST /channels/:id/messages/:mid/threads', () => {
    it('starts a thread for a member in good standing', async () => {
      const { member, text } = await fixture();
      const anchor = await createMessage(text, { authorId: member, content: 'anchor' });
      const res = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {
        name: 'a thread',
      });
      expect(res.status).toBe(201);
      expect(await threadsUnder(text)).toHaveLength(1);
    });

    it('refuses a timed-out member', async () => {
      const { g, owner, member, text } = await fixture();
      const anchor = await createMessage(text, { authorId: owner, content: 'anchor' });
      await setTimeout_(g, member);
      const res = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {});
      expect(res).toMatchObject({ status: 403, code: 'TIMED_OUT' });
      expect(await threadsUnder(text)).toHaveLength(0);
    });

    it('refuses a member who has not acknowledged the rules', async () => {
      const { g, owner, member, text } = await fixture();
      const anchor = await createMessage(text, { authorId: owner, content: 'anchor' });
      await setPending(g, member);
      const res = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {});
      expect(res).toMatchObject({ status: 403, code: 'PENDING_ACKNOWLEDGMENT' });
    });

    it('blocks an automod or banned word in the thread name', async () => {
      const { owner, member, text } = await fixture();
      const anchor = await createMessage(text, { authorId: owner, content: 'anchor' });
      const automod = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {
        name: `talk ${AUTOMOD}`,
      });
      expect(automod).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      const banned = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {
        name: `talk ${BANNED}`,
      });
      expect(banned).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
      expect(await threadsUnder(text)).toHaveLength(0);
    });

    it('does not hold the anchor author\'s words against the caller when no name is given', async () => {
      const { owner, member, text } = await fixture();
      // Written before the rule existed (or by someone exempt): the default
      // name is the anchor's text, which the caller didn't type.
      const anchor = await createMessage(text, { authorId: owner, content: `old ${AUTOMOD}` });
      const res = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {});
      expect(res.status).toBe(201);
    });
  });

  describe('other user text on the live send and edit paths', () => {
    it('moderates a poll\'s question and answers', async () => {
      const { member, text } = await fixture();
      const inQuestion = await req('POST', `/channels/${text}/messages`, member, {
        poll: { question: `pick ${AUTOMOD}`, options: ['a', 'b'], durationHours: 1 },
      });
      expect(inQuestion).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      const inAnswer = await req('POST', `/channels/${text}/messages`, member, {
        poll: { question: 'pick one', options: ['a', `b ${BANNED}`], durationHours: 1 },
      });
      expect(inAnswer).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
      expect(await messagesIn(text)).toHaveLength(0);
      const clean = await req('POST', `/channels/${text}/messages`, member, {
        poll: { question: 'pick one', options: ['a', 'b'], durationHours: 1 },
      });
      expect(clean.status).toBe(201);
    });

    it('moderates forwarded text against the destination guild\'s rules', async () => {
      const { member, text } = await fixture();
      // A server with no such rule, where the text was fine to post.
      const otherOwner = await createUser();
      const other = await createGuild(otherOwner, MEMBER);
      await addMember(other, member);
      const otherText = await createChannel(other);
      const source = await createMessage(otherText, {
        authorId: otherOwner,
        content: `quoted ${AUTOMOD}`,
      });
      const res = await req('POST', `/channels/${text}/messages`, member, {
        forwardFromMessageId: source.toString(),
      });
      expect(res).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      expect(await messagesIn(text)).toHaveLength(0);
    });

    it('refuses an edit by a supervision-restricted member', async () => {
      const { g, text } = await fixture();
      const minor = await createUser({ dateOfBirth: dobForAge(15) });
      await addMember(g, minor);
      const mid = await createMessage(text, { authorId: minor, content: 'before' });
      const res = await req('PATCH', `/channels/${text}/messages/${mid}`, minor, {
        content: 'after',
      });
      expect(res).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, mid));
      expect(row!.content).toBe('before');
    });
  });

  // The scheduled create route checked only SEND_MESSAGES, so a message
  // could be queued into a forum (or link channel) the live send refuses,
  // and the worker inserted it there as an invisible row.
  describe('POST /channels/:id/scheduled-messages', () => {
    const later = () => new Date(Date.now() + 3600_000).toISOString();

    it('refuses forum and link channels with the live send\'s 400s', async () => {
      const { g, member, forum } = await fixture();
      const link = nextSnowflake();
      await db.insert(schema.channels).values({
        id: link,
        type: 'guild_link',
        guildId: g,
        name: 'docs',
        linkUrl: 'https://example.com',
      });
      for (const ch of [forum, link]) {
        const live = await req('POST', `/channels/${ch}/messages`, member, { content: 'hi' });
        const scheduled = await req('POST', `/channels/${ch}/scheduled-messages`, member, {
          content: 'hi',
          scheduledFor: later(),
        });
        expect(live).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
        expect(scheduled).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
        expect(scheduled.json).toEqual(live.json);
      }
      const queued = await db
        .select()
        .from(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.authorId, member));
      expect(queued).toHaveLength(0);
    });

    it('still queues into a text channel', async () => {
      const { member, text } = await fixture();
      const res = await req('POST', `/channels/${text}/scheduled-messages`, member, {
        content: 'hi',
        scheduledFor: later(),
      });
      expect(res.status).toBe(200);
    });
  });

  // repeat_message compares against the author's stored messages. A title,
  // thread name or poll text is not stored as one, so restating a message
  // there must not count as a repeat (under block_and_timeout it also timed
  // the member out).
  describe('repeat_message only counts text stored as a message', () => {
    async function repeatFixture() {
      const f = await fixture();
      await createRule({
        guildId: f.g,
        actorId: f.owner,
        name: 'no-repeats',
        ruleType: 'repeat_message',
        threshold: 2,
        windowSeconds: 300,
        action: 'block_and_timeout',
        timeoutSeconds: 600,
      });
      const earlier = await createMessage(f.text, {
        authorId: f.member,
        content: 'Login crash on Android',
      });
      return { ...f, earlier };
    }

    it('lets a forum post title, a thread name and a poll restate an earlier message', async () => {
      const { g, owner, member, text, forum, earlier } = await repeatFixture();
      const post = await req('POST', `/channels/${forum}/posts`, member, {
        title: 'Login crash on Android',
        content: 'Steps: open the app, tap sign in.',
      });
      expect(post.status).toBe(201);
      const anchor = await createMessage(text, { authorId: owner, content: 'anchor' });
      const thread = await req('POST', `/channels/${text}/messages/${anchor}/threads`, member, {
        name: 'Login crash on Android',
      });
      expect(thread.status).toBe(201);
      const poll = await req('POST', `/channels/${text}/messages`, member, {
        poll: { question: 'Login crash on Android', options: ['yes', 'no'], durationHours: 1 },
      });
      expect(poll.status).toBe(201);
      // Forwarding your own message elsewhere: the snapshot is not stored as
      // the new message's content.
      const elsewhere = await createChannel(g);
      const fwd = await req('POST', `/channels/${elsewhere}/messages`, member, {
        forwardFromMessageId: earlier.toString(),
      });
      expect(fwd.status).toBe(201);
      expect(await timeoutOf(g, member)).toBeNull();
    });

    it('still blocks a repeated message body', async () => {
      const { g, member, text } = await repeatFixture();
      const again = await req('POST', `/channels/${text}/messages`, member, {
        content: 'Login crash on Android',
      });
      expect(again).toMatchObject({ status: 400, code: 'AUTOMOD_BLOCKED' });
      expect(await timeoutOf(g, member)).not.toBeNull();
    });
  });

  // A bot command makes the bot post into the channel for the invoker, often
  // echoing argText. It used to need only membership + VIEW_CHANNEL.
  describe('POST /guilds/:guildId/commands/invoke', () => {
    async function botFixture(everyonePerms: bigint = MEMBER) {
      const owner = await createUser();
      const g = await createGuild(owner, everyonePerms);
      await addMember(g, owner);
      const member = await createUser();
      await addMember(g, member);
      const text = await createChannel(g);
      const { bot } = await createBot({ ownerId: owner, username: `sg_${owner}`, displayName: 'SayBot' });
      await addBotToGuild({ botId: bot.id, guildId: g, actorId: owner });
      await registerBotCommand({ botId: bot.id, ownerId: owner, guildId: null, name: 'say', description: 'says' });
      // Unreachable callback: delivery is fire-and-forget inside the service.
      await setBotEventConfig(bot.id, owner, 'https://bot.invalid/events');
      await createRule({
        guildId: g,
        actorId: owner,
        name: 'no-word',
        ruleType: 'word_blocklist',
        patterns: [AUTOMOD],
      });
      const invoke = (userId: bigint, argText?: string) =>
        req('POST', `/guilds/${g}/commands/invoke`, userId, {
          channelId: text.toString(),
          name: 'say',
          ...(argText !== undefined ? { argText } : {}),
        });
      return { owner, g, member, text, invoke };
    }

    it('invokes for a member in good standing', async () => {
      const { member, invoke } = await botFixture();
      expect((await invoke(member, 'hello')).status).toBe(200);
    });

    it('refuses a timed-out member with TIMED_OUT, like the live send', async () => {
      const { g, member, invoke } = await botFixture();
      await setTimeout_(g, member);
      expect(await invoke(member, 'hello')).toMatchObject({ status: 403, code: 'TIMED_OUT' });
    });

    it('refuses a member who has not acknowledged the rules', async () => {
      const { g, member, invoke } = await botFixture();
      await setPending(g, member);
      expect(await invoke(member, 'hello')).toMatchObject({
        status: 403,
        code: 'PENDING_ACKNOWLEDGMENT',
      });
    });

    it('refuses a supervision-restricted (unlinked minor) member', async () => {
      const { g, invoke } = await botFixture();
      const minor = await createUser({ dateOfBirth: dobForAge(15) });
      await addMember(g, minor);
      expect(await invoke(minor, 'hello')).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    it('refuses an instance-muted member', async () => {
      const { member, invoke } = await botFixture();
      await db
        .update(schema.users)
        .set({ mutedAt: new Date(), mutedUntil: null })
        .where(eq(schema.users.id, member));
      expect(await invoke(member, 'hello')).toMatchObject({ status: 403, code: 'INSTANCE_MUTED' });
    });

    it('requires SEND_MESSAGES, not just VIEW_CHANNEL', async () => {
      const { member, invoke } = await botFixture(P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
      expect(await invoke(member, 'hello')).toMatchObject({
        status: 403,
        code: 'MISSING_PERMISSIONS',
      });
    });

    it('blocks an automod or banned word in the arguments', async () => {
      const { member, invoke } = await botFixture();
      expect(await invoke(member, `say ${AUTOMOD}`)).toMatchObject({
        status: 400,
        code: 'AUTOMOD_BLOCKED',
      });
      expect(await invoke(member, `say ${BANNED}`)).toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });
  });
});
