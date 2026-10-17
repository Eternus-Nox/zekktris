import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { messagesRouter } from '../src/routes/messages';
import { channelsRouter } from '../src/routes/channels';
import { guildsRouter } from '../src/routes/guilds';
import { invitesRouter } from '../src/routes/invites';
import { discoveryRouter } from '../src/routes/discovery';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createBot } from '../src/services/bots';
import { createInvite } from '../src/services/invites';
import {
  createUser,
  createGuild,
  addMember,
  createChannel,
  createMessage,
  addOverride,
  addRelationship,
  createDmChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping authz-parity tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/channels', channelsRouter);
app.route('/channels', messagesRouter);
app.route('/guilds', guildsRouter);
app.route('/invites', invitesRouter);
app.route('/', discoveryRouter);

const MEMBER = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY;

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return `Bearer ${await signAccessToken({ userId, sessionId: session.id })}`;
}
function req(method: string, path: string, auth: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function dobForAge(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
async function until<T>(fn: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe.runIf(dbReady)('authorization parity between parallel paths', () => {
  let child: bigint;
  let pal: bigint;

  beforeAll(async () => {
    // One supervised child for the file (the watch-word scan caches the
    // supervised-child set for 15 s, so it must exist before the first scan).
    const parent = await createUser({ dateOfBirth: dobForAge(40) });
    child = await createUser({ dateOfBirth: dobForAge(15) });
    pal = await createUser({ dateOfBirth: dobForAge(30) });
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: child,
      status: 'active',
      initiatedBy: 'parent',
    });
    await db.insert(schema.childWatchWords).values({ childId: child, word: 'meetup' });
    await addRelationship(child, pal, 'friend');
    await addRelationship(pal, child, 'friend');
  });

  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  // ── #12 message edits ────────────────────────────────────────────────────

  describe('message edit', () => {
    it('rejects editing a supervised DM message into ciphertext', async () => {
      const dm = await createDmChannel([child, pal]);
      const tok = await tokenFor(child);
      const sent = await req('POST', `/channels/${dm}/messages`, tok, { content: 'hi there' });
      expect(sent.status).toBe(201);
      const { message } = (await sent.json()) as { message: { id: string } };

      const edit = await req('PATCH', `/channels/${dm}/messages/${message.id}`, tok, {
        content: 'zkE2EE/3:Y2lwaGVydGV4dA==',
      });
      expect(edit.status).toBe(403);
      const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, BigInt(message.id)));
      expect(row!.content).toBe('hi there');
    });

    it('flags a watch word edited in after posting (once)', async () => {
      const dm = await createDmChannel([child, pal]);
      const tok = await tokenFor(child);
      const sent = await req('POST', `/channels/${dm}/messages`, tok, { content: 'see you' });
      const { message } = (await sent.json()) as { message: { id: string } };
      const messageId = BigInt(message.id);

      const edit = await req('PATCH', `/channels/${dm}/messages/${message.id}`, tok, {
        content: 'see you at the meetup',
      });
      expect(edit.status).toBe(200);
      const flags = () =>
        db.select().from(schema.flaggedMessages).where(eq(schema.flaggedMessages.messageId, messageId));
      const flagged = await until(async () => ((await flags()).length > 0 ? true : null));
      expect(flagged).toBe(true);

      // Re-editing while keeping the same word doesn't flag it a second time.
      await req('PATCH', `/channels/${dm}/messages/${message.id}`, tok, {
        content: 'see you at the meetup!',
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await flags()).toHaveLength(1);
    });
  });

  // ── #13 thread archive / resolve ─────────────────────────────────────────

  describe('thread lifecycle', () => {
    async function threadFixture() {
      const owner = await createUser();
      const g = await createGuild(owner, MEMBER);
      await addMember(g, owner);
      const parentCh = await createChannel(g);
      const thread = nextSnowflake();
      await db.insert(schema.channels).values({
        id: thread,
        type: 'public_thread',
        guildId: g,
        parentId: parentCh,
        name: 'secret plans',
      });
      return { owner, g, parentCh, thread };
    }

    it('reveals nothing to a caller who cannot see the thread, even on a no-op transition', async () => {
      const { g, parentCh, thread } = await threadFixture();
      const outsider = await createUser();
      for (const path of ['unarchive', 'unresolve']) {
        const res = await req('POST', `/channels/${thread}/${path}`, await tokenFor(outsider));
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('secret plans');
      }

      // A member who can't view the parent channel is treated the same way.
      const member = await createUser();
      await addMember(g, member);
      await addOverride(parentCh, 'member', member, 0n, P.VIEW_CHANNEL);
      expect((await req('POST', `/channels/${thread}/unarchive`, await tokenFor(member))).status).toBe(404);
    });

    it('requires MANAGE_THREADS or authorship before the idempotent response', async () => {
      const { owner, g, thread } = await threadFixture();
      const member = await createUser();
      await addMember(g, member);
      expect((await req('POST', `/channels/${thread}/unarchive`, await tokenFor(member))).status).toBe(403);
      expect((await req('POST', `/channels/${thread}/unresolve`, await tokenFor(member))).status).toBe(403);
      const ok = await req('POST', `/channels/${thread}/unarchive`, await tokenFor(owner));
      expect(ok.status).toBe(200);
    });
  });

  // ── #14 search / joins ───────────────────────────────────────────────────

  describe('guild search', () => {
    it('excludes channels whose history the caller cannot read', async () => {
      const owner = await createUser();
      const g = await createGuild(owner, MEMBER);
      const open = await createChannel(g);
      const noHistory = await createChannel(g);
      const reader = await createUser();
      await addMember(g, reader);
      await addOverride(noHistory, 'role', g, 0n, P.READ_MESSAGE_HISTORY);
      await createMessage(open, { authorId: owner, content: 'zebracorn public note' });
      await createMessage(noHistory, { authorId: owner, content: 'zebracorn hidden history' });

      const tok = await tokenFor(reader);
      const res = await req('GET', `/guilds/${g}/messages/search?q=zebracorn`, tok);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ channelId: string }> };
      expect(body.messages.map((m) => m.channelId)).toEqual([open.toString()]);

      const scoped = await req('GET', `/guilds/${g}/messages/search?q=zebracorn&channelId=${noHistory}`, tok);
      expect(((await scoped.json()) as { messages: unknown[] }).messages).toHaveLength(0);
    });
  });

  describe('guild joins', () => {
    async function discoverableGuild() {
      const owner = await createUser();
      const g = await createGuild(owner, MEMBER);
      await addMember(g, owner);
      const ch = await createChannel(g);
      await db.update(schema.guilds).set({ discoverable: true }).where(eq(schema.guilds.id, g));
      return { owner, g, ch };
    }
    async function isMember(g: bigint, u: bigint) {
      const rows = await db.select().from(schema.guildMembers).where(eq(schema.guildMembers.userId, u));
      return rows.some((r) => r.guildId === g);
    }

    it("enforces a guardian's per-server block on discovery joins", async () => {
      const { g } = await discoverableGuild();
      await db.insert(schema.childBlockedGuilds).values({ childId: child, guildId: g });
      const res = await req('POST', `/guilds/${g}/discovery/join`, await tokenFor(child));
      expect(res.status).toBe(403);
      expect(await isMember(g, child)).toBe(false);
    });

    it('does not let a bot token join through an invite or discovery', async () => {
      const { owner, g, ch } = await discoverableGuild();
      const botOwner = await createUser();
      const { bot, token } = await createBot({ ownerId: botOwner, username: `j_${botOwner}`, displayName: 'J' });
      const invite = await createInvite({ guildId: g, channelId: ch, inviterId: owner });
      const auth = `Bot ${token}`;
      expect((await req('POST', `/invites/${invite.code}`, auth)).status).toBe(403);
      expect((await req('POST', `/guilds/${g}/discovery/join`, auth)).status).toBe(403);
      expect(await isMember(g, bot.id)).toBe(false);

      // A human can still use both.
      const human = await createUser();
      expect((await req('POST', `/invites/${invite.code}`, await tokenFor(human))).status).toBe(200);
      const other = await createUser();
      expect((await req('POST', `/guilds/${g}/discovery/join`, await tokenFor(other))).status).toBe(200);
    });
  });

  // ── #15 EMBED_LINKS ──────────────────────────────────────────────────────

  describe('link previews', () => {
    it('only unfurls links for authors with EMBED_LINKS', async () => {
      const owner = await createUser();
      const g = await createGuild(owner, MEMBER | P.EMBED_LINKS);
      const ch = await createChannel(g);
      const allowed = await createUser();
      const denied = await createUser();
      await addMember(g, allowed);
      await addMember(g, denied);
      await addOverride(ch, 'member', denied, 0n, P.EMBED_LINKS);

      async function send(u: bigint): Promise<bigint> {
        // A literal private IP: the resolver refuses it without network I/O
        // and persists [] — the "resolution ran" marker.
        const res = await req('POST', `/channels/${ch}/messages`, await tokenFor(u), {
          content: 'look http://127.0.0.1/page',
        });
        expect(res.status).toBe(201);
        return BigInt(((await res.json()) as { message: { id: string } }).message.id);
      }
      const embedsOf = async (id: bigint) =>
        (await db.select({ e: schema.messages.embeds }).from(schema.messages).where(eq(schema.messages.id, id)))[0]!.e;

      const a = await send(allowed);
      expect(await until(() => embedsOf(a))).toEqual([]);

      const d = await send(denied);
      await new Promise((r) => setTimeout(r, 500));
      expect(await embedsOf(d)).toBeNull();
    });
  });
});
