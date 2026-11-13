import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { dmsRouter } from '../src/routes/dms';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { achievementsForUser, syncAndNotifyAchievements } from '../src/services/achievements';
import { nextSnowflake } from '../src/snowflake';
import {
  createUser,
  createGuild,
  createChannel,
  createRole,
  createMessage,
  createDmChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping social achievement tests — no database reachable');
}

// Regular (days with a message), Crowd Pleaser (people reacting to one
// message), The People Have Spoken (people voting in one poll), Kindred
// Spirits (people you kept a 7-day streak with) and Now You See Me (turned a
// disappearing timer on): the source, the farm vector each one refuses, the
// ledger floor that keeps it when someone else removes the source, and the
// hook that records it when it happens.

const app = new Hono();
app.onError(errorHandler);
app.route('/users/@me/channels', dmsRouter);
app.route('/channels', messagesRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function call(method: string, path: string, userId: bigint, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${await tokenFor(userId)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function bot(): Promise<bigint> {
  const id = await createUser();
  await db.update(schema.users).set({ isBot: true }).where(eq(schema.users.id, id));
  return id;
}
async function ledger(userId: bigint): Promise<string[]> {
  const rows = await db
    .select({ id: schema.userAchievements.achievementId })
    .from(schema.userAchievements)
    .where(eq(schema.userAchievements.userId, userId));
  return rows.map((r) => r.id).sort();
}
const seeded = async (userId: bigint) =>
  (await db.select({ s: schema.users.achievementsSeeded }).from(schema.users).where(eq(schema.users.id, userId)))[0]!
    .s;
async function by(userId: bigint, id: string) {
  const a = (await achievementsForUser(userId)).find((x) => x.id === id);
  expect(a, `achievement ${id} missing from the shelf`).toBeDefined();
  return a!;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** A webhook's post: authored by the webhook's creator (services/webhooks.ts),
 *  shown under the webhook's name. messages.webhook_id has no FK. */
async function webhookPost(channelId: bigint, creatorId: bigint, createdAt = new Date()): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.messages).values({
    id,
    channelId,
    authorId: creatorId,
    content: 'Nightly digest',
    webhookId: nextSnowflake(),
    authorOverrideName: 'Digest',
    createdAt,
  });
  return id;
}

// dm_streaks has no FKs: the seed's cleanup doesn't reach it.
const streakChannels: bigint[] = [];
async function streak(
  u: bigint,
  other: bigint,
  s: { best: number; streak?: number; lastCountedDay?: string | null; lastDay?: string | null; channelId?: bigint },
) {
  const channelId = s.channelId ?? nextSnowflake();
  streakChannels.push(channelId);
  const [lo, hi] = u < other ? [u, other] : [other, u];
  await db.insert(schema.dmStreaks).values({
    channelId,
    userAId: lo,
    userBId: hi,
    streak: s.streak ?? 0,
    bestStreak: s.best,
    lastCountedDay: s.lastCountedDay ?? null,
    lastDayA: s.lastDay ?? null,
    lastDayB: s.lastDay ?? null,
  });
  return channelId;
}

describe.runIf(dbReady)('social achievements (integration)', () => {
  afterAll(async () => {
    if (streakChannels.length > 0) {
      await db.delete(schema.dmStreaks).where(inArray(schema.dmStreaks.channelId, streakChannels));
    }
    await cleanupAll();
    await closeDb();
  });

  it('Regular: distinct UTC days of your own posts; floored when the server holding them is deleted', async () => {
    const u = await createUser();
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    // Three days, one of them twice, either side of a UTC midnight.
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-01-01T23:59:59Z') });
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-01-02T00:00:01Z') });
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-01-02T18:00:00Z') });
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-01-05T08:00:00Z') });
    // A post deleted since was still sent that day: a fourth day for
    // Regular, though Chatterbox no longer counts it. Timer and pet notices
    // count for neither — and nor do other people's messages.
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-01-06T08:00:00Z'), deletedAt: new Date() });
    const dm = await createDmChannel([u, owner]);
    await createMessage(dm, {
      authorId: u,
      type: 'system_disappearing',
      createdAt: new Date('2026-01-07T08:00:00Z'),
      metadata: { kind: 'disappearing_timer', timerSeconds: 60, initiatorId: u.toString() },
    });
    await createMessage(dm, {
      authorId: u,
      type: 'system_pet',
      createdAt: new Date('2026-01-08T08:00:00Z'),
      metadata: { kind: 'pet', event: 'renamed', petName: 'Pip', stage: 'baby', actorId: u.toString() },
    });
    await createMessage(ch, { authorId: owner, createdAt: new Date('2026-01-09T08:00:00Z') });
    expect(await by(u, 'regular_30')).toMatchObject({ value: 4, earned: false, goal: 30 });
    expect((await by(u, 'chatterbox_100')).value).toBe(4);

    for (let i = 0; i < 26; i++) {
      await createMessage(ch, { authorId: u, createdAt: new Date(Date.UTC(2026, 1, 1 + i, 12)) });
    }
    expect(await by(u, 'regular_30')).toMatchObject({ value: 30, earned: true });
    expect((await by(u, 'regular_100')).earned).toBe(false);
    await syncAndNotifyAchievements(u);
    expect(await ledger(u)).toContain('regular_30');

    // The owner deletes the server: every one of those messages is gone.
    await db.delete(schema.guilds).where(eq(schema.guilds.id, g));
    expect((await by(u, 'chatterbox_100')).value).toBe(0);
    expect(await by(u, 'regular_30')).toMatchObject({ value: 30, earned: true });
  });

  it("Regular: a streak warning, a webhook's post or a server join is no day you sent anything; a post deleted since still is", async () => {
    const u = await createUser();
    const other = await createUser();
    const g = await createGuild(other);
    const ch = await createChannel(g);
    const dm = await createDmChannel([u, other]);
    // Rows under u's id on days u never sent a thing: the 18:00 sweep's
    // warning (posted under the DM's user A), a webhook u created posting its
    // digest, the welcome row of u joining a server.
    await createMessage(dm, {
      authorId: u,
      createdAt: new Date('2026-03-01T18:00:00Z'),
      content: '🔥 Your 5-day streak ends in about 6 hours — send a message to keep it alive!',
      metadata: { kind: 'streak_warning', streak: 5 },
    });
    await webhookPost(ch, u, new Date('2026-03-02T09:00:00Z'));
    await createMessage(ch, { authorId: u, type: 'system_join', createdAt: new Date('2026-03-03T09:00:00Z') });
    expect((await by(u, 'regular_30')).value).toBe(0);

    // Posts deleted since: a disappearing message the timer expired (the
    // sweep soft-deletes it) and one a moderator removed. Plus a live one.
    await createMessage(dm, {
      authorId: u,
      createdAt: new Date('2026-03-04T10:00:00Z'),
      expireAfterSeconds: 3600,
      viewedAt: new Date('2026-03-04T10:30:00Z'),
      expiresAt: new Date('2026-03-04T11:30:00Z'),
      deletedAt: new Date('2026-03-04T11:30:05Z'),
    });
    await createMessage(ch, { authorId: u, createdAt: new Date('2026-03-05T10:00:00Z'), deletedAt: new Date() });
    await createMessage(dm, { authorId: u, createdAt: new Date('2026-03-06T10:00:00Z') });
    expect((await by(u, 'regular_30')).value).toBe(3);
  });

  it("Crowd Pleaser counts posts only: a welcome row, a webhook's post, a reaction-roles message, a streak warning or a poke earns its 'author' nothing", async () => {
    const u = await createUser();
    const [r1, r2, r3, r4] = [await createUser(), await createUser(), await createUser(), await createUser()];
    const owner = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    const gdm = await createDmChannel([u, r1, r2, r3, r4], 'group_dm');
    const react = (messageId: bigint, userId: bigint) =>
      db.insert(schema.reactions).values({ messageId, userId, emoji: '👋' });

    // u joins: the welcome row is u's by author_id, but it is the server's.
    const welcome = await createMessage(ch, { authorId: u, type: 'system_join', content: '' });
    const hook = await webhookPost(ch, u);
    const roles = await createMessage(ch, { authorId: u, content: 'React to pick your role' });
    await db.insert(schema.reactionRoles).values({
      messageId: roles,
      emoji: '👋',
      guildId: g,
      channelId: ch,
      roleId: await createRole(g, 0n),
      createdBy: u,
    });
    const warning = await createMessage(gdm, { authorId: u, metadata: { kind: 'streak_warning', streak: 3 } });
    const poke = await createMessage(gdm, {
      authorId: u,
      metadata: { kind: 'poke', pokeType: 'wave', initiatorId: u.toString() },
    });
    for (const m of [welcome, hook, roles, warning, poke]) for (const r of [r1, r2, r3]) await react(m, r);
    expect(await by(u, 'crowd_pleaser_3')).toMatchObject({ value: 0, earned: false });

    // A reaction to one of those, through the route, doesn't even sync u.
    const path = `/channels/${gdm}/messages/${warning}/reactions/${encodeURIComponent('🎉')}/@me`;
    expect(await call('PUT', path, r4)).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await seeded(u)).toBe(false);

    // A post of u's own with the same three people on it.
    const post = await createMessage(gdm, { authorId: u, content: 'hello all' });
    for (const r of [r1, r2, r3]) await react(post, r);
    expect(await by(u, 'crowd_pleaser_3')).toMatchObject({ value: 3, earned: true });
  });

  it("Crowd Pleaser: distinct people on ONE message, never yourself or a bot; a reaction syncs the author; floored when they're cleared", async () => {
    const author = await createUser();
    const [r1, r2, r3, b] = [await createUser(), await createUser(), await createUser(), await bot()];
    const gdm = await createDmChannel([author, r1, r2, r3, b], 'group_dm');
    const m1 = await createMessage(gdm, { authorId: author, content: 'look at this' });
    const m2 = await createMessage(gdm, { authorId: author, content: 'and this' });
    const gone = await createMessage(gdm, { authorId: author, content: 'deleted', deletedAt: new Date() });
    const react = (messageId: bigint, userId: bigint, emoji = '👍') =>
      db.insert(schema.reactions).values({ messageId, userId, emoji });
    // m1: r1 twice (one person), r2, the author and a bot (neither counts).
    await react(m1, r1);
    await react(m1, r1, '🔥');
    await react(m1, r2);
    await react(m1, author);
    await react(m1, b);
    // Spread over messages they don't add up; a deleted message counts nothing.
    await react(m2, r3);
    for (const u of [r1, r2, r3]) await react(gone, u);
    expect(await by(author, 'crowd_pleaser_3')).toMatchObject({ value: 2, earned: false, goal: 3 });

    // The third person reacts through the route: the author is synced.
    const path = `/channels/${gdm}/messages/${m1}/reactions/${encodeURIComponent('🎉')}/@me`;
    expect(await call('PUT', path, r3)).toBe(200);
    await waitFor(async () => (await ledger(author)).includes('crowd_pleaser_3'));
    expect(await by(author, 'crowd_pleaser_3')).toMatchObject({ value: 3, earned: true });
    expect((await by(author, 'crowd_pleaser_5')).earned).toBe(false);

    // A moderator (or the reactors leaving) clears them: still earned.
    await db.delete(schema.reactions).where(eq(schema.reactions.messageId, m1));
    expect(await by(author, 'crowd_pleaser_3')).toMatchObject({ value: 3, earned: true });
    expect((await by(r3, 'crowd_pleaser_3')).value).toBe(0);
  });

  it('The People Have Spoken: distinct voters in ONE poll, never yourself or a bot; a vote syncs the author; floored when the poll is deleted', async () => {
    const author = await createUser();
    const [v1, v2, v3, b] = [await createUser(), await createUser(), await createUser(), await bot()];
    const gdm = await createDmChannel([author, v1, v2, v3, b], 'group_dm');
    const poll = async (opts: { deleted?: boolean } = {}) => {
      const messageId = await createMessage(gdm, {
        authorId: author,
        content: 'lunch?',
        ...(opts.deleted ? { deletedAt: new Date() } : {}),
      });
      const pollId = nextSnowflake();
      await db.insert(schema.polls).values({ id: pollId, messageId, question: 'Lunch?', multipleChoice: true });
      const options = [nextSnowflake(), nextSnowflake()];
      await db
        .insert(schema.pollOptions)
        .values(options.map((id, position) => ({ id, pollId, text: `Option ${position}`, position })));
      return { messageId, pollId, options };
    };
    const vote = (p: { pollId: bigint; options: bigint[] }, userId: bigint, option = 0) =>
      db.insert(schema.pollVotes).values({ pollId: p.pollId, optionId: p.options[option]!, userId });

    const p1 = await poll();
    // v1 picks both options (one person), v2 one; the author's own vote and a
    // bot's don't count.
    await vote(p1, v1, 0);
    await vote(p1, v1, 1);
    await vote(p1, v2, 0);
    await vote(p1, author, 1);
    await vote(p1, b, 1);
    // Another poll's voter doesn't add to this one's; a deleted poll counts nothing.
    const p2 = await poll();
    await vote(p2, v3);
    const p3 = await poll({ deleted: true });
    for (const u of [v1, v2, v3]) await vote(p3, u);
    expect(await by(author, 'pollster_3')).toMatchObject({ value: 2, earned: false, goal: 3 });

    // The third voter, through the route: the author is synced.
    const path = `/channels/${gdm}/polls/${p1.pollId}/options/${p1.options[0]}/vote`;
    expect(await call('POST', path, v3)).toBe(204);
    await waitFor(async () => (await ledger(author)).includes('pollster_3'));
    expect(await by(author, 'pollster_3')).toMatchObject({ value: 3, earned: true });

    // The poll's message is deleted outright (its poll and votes cascade).
    await db.delete(schema.messages).where(eq(schema.messages.id, p1.messageId));
    expect(await by(author, 'pollster_3')).toMatchObject({ value: 3, earned: true });
    expect((await by(author, 'pollster_5')).earned).toBe(false);
  });

  it('Kindred Spirits: distinct people with a 7-day best streak — not a bot, not a reopened DM twice; floored when a partner is hard-deleted', async () => {
    const u = await createUser();
    const [p1, p2, p3, p4] = [await createUser(), await createUser(), await createUser(), await createUser()];
    await streak(u, p1, { best: 7 });
    // The same person again in a reopened DM (a new channel): still one.
    await streak(u, p1, { best: 12 });
    await streak(u, p2, { best: 6 });
    await streak(u, await bot(), { best: 30 });
    // A partner whose account is gone for good (no users row): can't be
    // told from a bot, so it doesn't count.
    await streak(u, nextSnowflake(), { best: 9 });
    expect(await by(u, 'kindred_2')).toMatchObject({ value: 1, earned: false, goal: 2 });

    await streak(u, p3, { best: 7 });
    await streak(u, p4, { best: 100 });
    expect(await by(u, 'kindred_3')).toMatchObject({ value: 3, earned: true });
    expect((await by(u, 'kindred_5')).earned).toBe(false);
    // Each partner has one.
    expect((await by(p4, 'kindred_2')).value).toBe(1);
    await syncAndNotifyAchievements(u);

    // The inactivity sweep hard-deletes p4 (FKs fire; dm_streaks keeps a
    // dangling id): kindred_3 stays.
    await db.delete(schema.users).where(eq(schema.users.id, p4));
    expect(await by(u, 'kindred_3')).toMatchObject({ value: 3, earned: true });
  });

  it("a send that credits the DM's streak syncs BOTH people at once (Inseparable, Kindred Spirits)", async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const today = utcDay(new Date());
    const yesterday = utcDay(daysAgo(1));
    // Six days credited through yesterday; A already kept a 7-day streak with
    // someone else (so A has Inseparable, and one Kindred Spirit).
    await streak(a, b, { channelId: dm, best: 6, streak: 6, lastCountedDay: yesterday, lastDay: yesterday });
    await streak(a, await createUser(), { best: 7 });

    // A's hi today: no credit yet. Its own throttled sync seeds A (and arms
    // A's 60 s throttle) — wait for it, so only the credit's hook can record
    // anything for A after this.
    expect(await call('POST', `/channels/${dm}/messages`, a, { content: 'hi' })).toBe(201);
    await waitFor(() => seeded(a));
    expect(await ledger(a)).toContain('inseparable_7');
    expect(await ledger(a)).not.toContain('kindred_2');

    // B's hi credits today: the streak reaches 7 — B's first Inseparable, and
    // A's second Kindred Spirit, recorded for both by the credit's sync.
    expect(await call('POST', `/channels/${dm}/messages`, b, { content: 'hey' })).toBe(201);
    await waitFor(async () => (await ledger(a)).includes('kindred_2') && (await ledger(b)).includes('inseparable_7'));
    const [row] = await db.select().from(schema.dmStreaks).where(eq(schema.dmStreaks.channelId, dm));
    expect(row).toMatchObject({ lastCountedDay: today, streak: 7, bestStreak: 7 });
  });

  it('Now You See Me: turning a timer on (yours, not off) earns it at once; it stays when the notice is gone', async () => {
    const u = await createUser();
    const other = await createUser();
    const dm = await createDmChannel([u, other]);
    // Turning one off, and the other person turning one on, earn u nothing.
    await createMessage(dm, {
      authorId: u,
      type: 'system_disappearing',
      metadata: { kind: 'disappearing_timer', timerSeconds: 0, initiatorId: u.toString() },
    });
    await createMessage(dm, {
      authorId: other,
      type: 'system_disappearing',
      metadata: { kind: 'disappearing_timer', timerSeconds: 3600, initiatorId: other.toString() },
    });
    expect(await by(u, 'vanishing_act')).toMatchObject({ value: 0, earned: false, goal: 1 });
    expect((await by(other, 'vanishing_act')).earned).toBe(true);

    // u turns one on through the route: recorded straight away.
    const settings = `/users/@me/channels/${dm}/settings`;
    expect(await call('PATCH', settings, u, { ttlSecondsAfterRead: 300 })).toBe(200);
    await waitFor(async () => (await ledger(u)).includes('vanishing_act'));
    // Off again: still earned.
    expect(await call('PATCH', settings, u, { ttlSecondsAfterRead: null })).toBe(200);
    expect(await by(u, 'vanishing_act')).toMatchObject({ value: 1, earned: true });
    // Every notice of u's gone (an E2EE-off purge can take one): still earned.
    await db
      .delete(schema.messages)
      .where(and(eq(schema.messages.channelId, dm), eq(schema.messages.authorId, u)));
    expect(await by(u, 'vanishing_act')).toMatchObject({ value: 1, earned: true });
  });
});
