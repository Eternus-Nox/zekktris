import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createRule } from '../src/services/automod';
import { addBannedWord, removeBannedWord } from '../src/services/security';
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
});
