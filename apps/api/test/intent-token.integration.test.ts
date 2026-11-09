/**
 * Intent tokens: the long-lived, narrowly scoped credential the native app
 * hands its Siri extensions, widgets and watch, behind the real createApp()
 * stack.
 *
 * What has to hold:
 *   - only a human Bearer session can mint one (not an intent token, not a bot);
 *   - it lists DMs, sends a JSON message into a DM / group DM, and pokes;
 *   - it opens nothing else: other routes, a guild channel send, a multipart
 *     send;
 *   - its send is never a read, notARead or not: no disappearing clock starts
 *     and the read marker stays below what is waiting;
 *   - it dies with its session (logout), even once the 15-minute blacklist
 *     entry is gone, and survives a refresh rotation (same session);
 *   - an expired, forged or wrong-audience token is a 401, and neither token
 *     kind is accepted under the other's scheme.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@zekktris/shared/permissions';
import { createApp } from '../src/server';
import { db, schema } from '../src/db';
import { createSession } from '../src/auth/sessions';
import { signAccessToken, signIntentToken, INTENT_TOKEN_TTL_SECONDS } from '../src/auth/tokens';
import { REFRESH_COOKIE_NAME } from '../src/auth/cookies';
import { blacklistSession, __resetBlacklistStoreToMemory } from '../src/auth/session-blacklist';
import { createBot } from '../src/services/bots';
import {
  createUser,
  createGuild,
  addMember,
  createChannel,
  createDmChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping intent-token tests — no database reachable');
}

const app = createApp();
const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

interface Signed {
  userId: bigint;
  sessionId: bigint;
  refreshToken: string;
  bearer: string;
}

async function signIn(userId: bigint): Promise<Signed> {
  const { session, refreshToken } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  const bearer = `Bearer ${await signAccessToken({ userId, sessionId: session.id })}`;
  return { userId, sessionId: session.id, refreshToken, bearer };
}

async function mint(authorization?: string) {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  const res = await app.request('/api/v1/auth/intent-token', { method: 'POST', headers });
  return { status: res.status, json: (await res.json()) as any };
}

/** Mint through the real route and return the `Intent …` header value. */
async function intentFor(s: Signed): Promise<string> {
  const r = await mint(s.bearer);
  expect(r.status).toBe(200);
  return `Intent ${r.json.token}`;
}

async function call(
  method: string,
  path: string,
  authorization: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { authorization };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await app.request(`/api/v1${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const send = (auth: string, channelId: bigint, content = 'sent by siri') =>
  call('POST', `/channels/${channelId}/messages`, auth, { content, notARead: true });

/** A JWT signed like an intent token, with any of its parts overridden. */
async function craft(opts: {
  sub: string;
  sid: string;
  aud?: string;
  exp?: number;
  key?: Uint8Array;
}): Promise<string> {
  return new SignJWT({ sid: opts.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(opts.sub)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .setIssuer('zekktris')
    .setAudience(opts.aud ?? 'zekktris-intents')
    .sign(opts.key ?? secret);
}

describe.runIf(dbReady)('intent tokens', () => {
  beforeEach(() => {
    __resetBlacklistStoreToMemory();
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  // ── Minting ───────────────────────────────────────────────────────────────

  it('a Bearer session mints a 30-day token bound to that session', async () => {
    const s = await signIn(await createUser());
    const before = Date.now();
    const r = await mint(s.bearer);

    expect(r.status).toBe(200);
    expect(typeof r.json.token).toBe('string');
    const claims = decodeJwt(r.json.token);
    expect(claims.sub).toBe(s.userId.toString());
    expect(claims.sid).toBe(s.sessionId.toString());
    expect(claims.iss).toBe('zekktris');
    expect(claims.aud).toBe('zekktris-intents');
    // expiresAt is the token's own exp, as an ISO string, 30 days out.
    expect(new Date(r.json.expiresAt).getTime()).toBe(claims.exp! * 1000);
    const ttlMs = new Date(r.json.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(INTENT_TOKEN_TTL_SECONDS * 1000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(INTENT_TOKEN_TTL_SECONDS * 1000 + 1_000);
  });

  it('minting needs a credential, and an intent token cannot mint another', async () => {
    const s = await signIn(await createUser());
    expect((await mint()).status).toBe(401);

    const intent = await intentFor(s);
    const r = await mint(intent);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('FORBIDDEN');
  });

  it('a bot token cannot mint one', async () => {
    const owner = await createUser();
    const { token } = await createBot({ ownerId: owner, username: `it_${owner}`, displayName: 'IT' });
    expect((await mint(`Bot ${token}`)).status).toBe(403);
  });

  it('a revoked session cannot mint one, even with the blacklist entry gone', async () => {
    const s = await signIn(await createUser());
    await db
      .update(schema.sessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.sessions.id, s.sessionId));
    // No blacklistSession here: the still-valid access token passes requireAuth
    // and the mint route's own session read has to catch it.
    const r = await mint(s.bearer);
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('TOKEN_INVALID');
  });

  it('minting is rate limited per user (30 an hour)', async () => {
    const s = await signIn(await createUser());
    for (let i = 0; i < 30; i++) expect((await mint(s.bearer)).status).toBe(200);
    const r = await mint(s.bearer);
    expect(r.status).toBe(429);
    // Another user has their own budget.
    expect((await mint((await signIn(await createUser())).bearer)).status).toBe(200);
  });

  // ── What it can do ──────────────────────────────────────────────────────────

  it('sends a DM, lists the DMs and pokes', async () => {
    const me = await signIn(await createUser());
    const peer = await createUser();
    const dm = await createDmChannel([me.userId, peer]);
    const intent = await intentFor(me);

    const sent = await send(intent, dm);
    expect(sent.status).toBe(201);
    expect(sent.json.message.content).toBe('sent by siri');
    expect(sent.json.message.author.id).toBe(me.userId.toString());
    const [row] = await db
      .select({ authorId: schema.messages.authorId, content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.id, BigInt(sent.json.message.id)));
    expect(row).toEqual({ authorId: me.userId, content: 'sent by siri' });

    const list = await call('GET', '/users/@me/channels', intent);
    expect(list.status).toBe(200);
    const listed = list.json.channels.find((ch: any) => ch.id === dm.toString());
    expect(listed).toBeDefined();
    expect(listed.recipients.map((u: any) => u.id)).toEqual([peer.toString()]);

    const poke = await call('POST', `/channels/${dm}/poke`, intent, { pokeType: 'wave' });
    expect(poke.status).toBe(200);
    expect(poke.json).toEqual({ ok: true });
  });

  it('sends into a group DM', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser(), await createUser()], 'group_dm');
    const r = await send(await intentFor(me), dm, 'to the group');
    expect(r.status).toBe(201);
    expect(r.json.message.content).toBe('to the group');
  });

  it('keeps the ordinary DM gates: a DM the caller is not in is still a 404', async () => {
    const me = await signIn(await createUser());
    const others = await createDmChannel([await createUser(), await createUser()]);
    expect((await send(await intentFor(me), others)).status).toBe(404);
  });

  // ── What it can't ───────────────────────────────────────────────────────────

  it('is refused on every other route', async () => {
    const me = await signIn(await createUser());
    const peer = await createUser();
    const dm = await createDmChannel([me.userId, peer]);
    const intent = await intentFor(me);

    const refused: Array<[string, string, unknown?]> = [
      ['GET', '/users/@me'],
      ['GET', '/users/@me/sessions'],
      ['GET', `/users/${peer}`],
      ['POST', '/users/@me/channels', { recipientId: peer.toString() }],
      ['GET', `/users/@me/channels/${dm}/settings`],
      ['DELETE', `/users/@me/channels/${dm}`],
      ['GET', `/channels/${dm}/messages`],
      ['GET', `/channels/${dm}`],
      ['POST', `/channels/${dm}/typing`],
      ['GET', `/channels/${dm}/pokes`],
      ['PATCH', `/channels/${dm}/messages/1`, { content: 'edited' }],
      ['GET', '/guilds'],
      ['POST', '/auth/quick-login/create'],
      // A trailing slash or an extra segment is not the allowed route.
      ['POST', `/channels/${dm}/messages/`, { content: 'x' }],
      ['GET', '/users/@me/channels/'],
    ];
    for (const [method, path, body] of refused) {
      const r = await call(method, path, intent, body);
      expect([method, path, r.status]).toEqual([method, path, 403]);
      expect(r.json.error.code).toBe('FORBIDDEN');
    }
    // The same Bearer session reaches them.
    expect((await call('GET', '/users/@me', me.bearer)).status).toBe(200);
  });

  it('cannot send into a guild channel', async () => {
    const me = await signIn(await createUser());
    const guildId = await createGuild(me.userId, DEFAULT_EVERYONE_PERMISSIONS);
    await addMember(guildId, me.userId);
    const channelId = await createChannel(guildId);

    const r = await send(await intentFor(me), channelId);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('FORBIDDEN');
    // The caller can send there: only the token's scope stops it.
    expect((await send(me.bearer, channelId)).status).toBe(201);
    const rows = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channelId));
    expect(rows).toHaveLength(1);
  });

  it('cannot forward a message into the DM', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser()]);
    const guildId = await createGuild(me.userId, DEFAULT_EVERYONE_PERMISSIONS);
    await addMember(guildId, me.userId);
    const channelId = await createChannel(guildId);
    const source = await send(me.bearer, channelId, 'guild only');
    expect(source.status).toBe(201);
    const body = { content: '', forwardFromMessageId: source.json.message.id };

    const r = await call('POST', `/channels/${dm}/messages`, await intentFor(me), body);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('FORBIDDEN');
    // The same forward with the Bearer session goes through.
    expect((await call('POST', `/channels/${dm}/messages`, me.bearer, body)).status).toBe(201);
  });

  it('cannot send a multipart message, however the content type is spelled', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser()]);
    const intent = await intentFor(me);
    const form = () => {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content: 'with a file' }));
      fd.append('files[0]', new File([new Uint8Array([1, 2, 3])], 'a.bin'));
      return fd;
    };

    const res = await app.request(`/api/v1/channels/${dm}/messages`, {
      method: 'POST',
      headers: { authorization: intent },
      body: form(),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('FORBIDDEN');

    const shouted = await app.request(`/api/v1/channels/${dm}/messages`, {
      method: 'POST',
      headers: { authorization: intent, 'content-type': 'Multipart/Form-Data; boundary=x' },
      body: '--x--\r\n',
    });
    expect(shouted.status).toBe(403);

    const rows = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, dm));
    expect(rows).toHaveLength(0);

    // The same upload with the Bearer session goes through.
    const bearer = await app.request(`/api/v1/channels/${dm}/messages`, {
      method: 'POST',
      headers: { authorization: me.bearer },
      body: form(),
    });
    expect(bearer.status).toBe(201);
  });

  it('a send without notARead is still not a read: no clock starts and the marker holds', async () => {
    const me = await signIn(await createUser());
    const peer = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, peer.userId]);
    const timer = await call('PATCH', `/users/@me/channels/${dm}/settings`, peer.bearer, {
      ttlSecondsAfterRead: 30,
    });
    expect(timer.status).toBe(200);
    const [notice] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, dm), eq(schema.messages.type, 'system_disappearing')));
    expect((await call('POST', `/channels/${dm}/messages/${notice!.id}/ack`, me.bearer)).status).toBe(200);
    const waiting = await call('POST', `/channels/${dm}/messages`, peer.bearer, { content: 'waiting for you' });
    expect(waiting.status).toBe(201);
    const waitingId = BigInt(waiting.json.message.id);
    const timed = async () => {
      const [r] = await db
        .select({
          expireAfterSeconds: schema.messages.expireAfterSeconds,
          expiresAt: schema.messages.expiresAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, waitingId));
      return r!;
    };
    const marker = async () => {
      const [r] = await db
        .select({ last: schema.readStates.lastMessageId })
        .from(schema.readStates)
        .where(and(eq(schema.readStates.userId, me.userId), eq(schema.readStates.channelId, dm)));
      return r?.last;
    };
    expect(await timed()).toEqual({ expireAfterSeconds: 30, expiresAt: null });

    // No notARead in the body: the token's scope decides, not the client.
    const r = await call('POST', `/channels/${dm}/messages`, await intentFor(me), { content: 'hi' });
    expect(r.status).toBe(201);
    expect((await timed()).expiresAt).toBeNull();
    expect(await marker()).toBe(notice!.id);

    // The same body with the Bearer session is a read.
    const read = await call('POST', `/channels/${dm}/messages`, me.bearer, { content: 'read it' });
    expect(read.status).toBe(201);
    expect((await timed()).expiresAt).not.toBeNull();
    expect(await marker()).toBe(BigInt(read.json.message.id));
  });

  // ── Revocation ──────────────────────────────────────────────────────────────

  it('dies with its session on logout, and stays dead once the blacklist entry has lapsed', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser()]);
    const intent = await intentFor(me);
    expect((await send(intent, dm)).status).toBe(201);

    const out = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${me.refreshToken}` },
    });
    expect(out.status).toBe(200);

    const r = await send(intent, dm);
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('TOKEN_INVALID');

    // The blacklist only spans the 15-minute access window. Past it, the
    // sessions row alone keeps a 30-day token out.
    __resetBlacklistStoreToMemory();
    expect((await send(intent, dm)).status).toBe(401);
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(401);
    expect((await call('POST', `/channels/${dm}/poke`, intent, { pokeType: 'poke' })).status).toBe(401);
  });

  it('honours the revocation blacklist', async () => {
    const me = await signIn(await createUser());
    const intent = await intentFor(me);
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(200);
    await blacklistSession(me.sessionId);
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(401);
  });

  it('logging out ANOTHER device leaves it working; revoking all sessions ends it', async () => {
    const uid = await createUser();
    const phone = await signIn(uid);
    const laptop = await signIn(uid);
    const intent = await intentFor(phone);

    // "Sign out this other session" from the phone: the laptop goes, the
    // phone's intent token stays.
    expect((await call('DELETE', `/users/@me/sessions/${laptop.sessionId}`, phone.bearer)).status).toBeLessThan(300);
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(200);

    // Sign out everywhere from the laptop's side (service call, as a password
    // reset or a ban does).
    const { revokeAllUserSessions } = await import('../src/auth/sessions');
    await revokeAllUserSessions(uid);
    __resetBlacklistStoreToMemory();
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(401);
  });

  it('survives a refresh rotation (the session id stays the same)', async () => {
    const me = await signIn(await createUser());
    const intent = await intentFor(me);
    const refreshed = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${me.refreshToken}`, 'user-agent': 'test' },
    });
    expect(refreshed.status).toBe(200);
    expect((await call('GET', '/users/@me/channels', intent)).status).toBe(200);
  });

  it('is refused once its session has expired, or its user is banned or deleted', async () => {
    const expired = await signIn(await createUser());
    const expiredIntent = await intentFor(expired);
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.id, expired.sessionId));
    expect((await call('GET', '/users/@me/channels', expiredIntent)).status).toBe(401);

    const banned = await signIn(await createUser());
    const bannedIntent = await intentFor(banned);
    await db.update(schema.users).set({ bannedAt: new Date() }).where(eq(schema.users.id, banned.userId));
    expect((await call('GET', '/users/@me/channels', bannedIntent)).status).toBe(401);

    // A timed ban that has run out is not a ban.
    await db
      .update(schema.users)
      .set({ bannedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.users.id, banned.userId));
    expect((await call('GET', '/users/@me/channels', bannedIntent)).status).toBe(200);

    const deleted = await signIn(await createUser());
    const deletedIntent = await intentFor(deleted);
    await db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, deleted.userId));
    expect((await call('GET', '/users/@me/channels', deletedIntent)).status).toBe(401);
  });

  // ── Bad tokens ──────────────────────────────────────────────────────────────

  it('an expired, forged, wrong-audience or mismatched token is a 401', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser()]);
    const sub = me.userId.toString();
    const sid = me.sessionId.toString();

    const expired = await call(
      'GET',
      '/users/@me/channels',
      `Intent ${await craft({ sub, sid, exp: Math.floor(Date.now() / 1000) - 10 })}`,
    );
    expect(expired.status).toBe(401);
    expect(expired.json.error.code).toBe('TOKEN_EXPIRED');

    const forged = await craft({ sub, sid, key: new TextEncoder().encode('x'.repeat(48)) });
    const wrongAud = await craft({ sub, sid, aud: 'zekktris-elsewhere' });
    // Signed with the real key, but for a session that isn't this user's.
    const other = await signIn(await createUser());
    const mismatched = await craft({ sub, sid: other.sessionId.toString() });
    const unknownSession = await craft({ sub, sid: '1' });
    for (const t of [forged, wrongAud, mismatched, unknownSession, 'not-a-jwt']) {
      const r = await send(`Intent ${t}`, dm);
      expect(r.status).toBe(401);
      expect(['TOKEN_INVALID', 'UNAUTHENTICATED']).toContain(r.json.error.code);
    }
    expect((await send('Intent ', dm)).status).toBe(401);

    // The crafted shape itself is right: with the real key, sub and sid it works.
    expect((await send(`Intent ${await craft({ sub, sid })}`, dm)).status).toBe(201);
  });

  it('neither token kind passes under the other scheme', async () => {
    const me = await signIn(await createUser());
    const dm = await createDmChannel([me.userId, await createUser()]);
    const accessJwt = me.bearer.slice('Bearer '.length);
    const intentJwt = (await signIntentToken({ userId: me.userId, sessionId: me.sessionId })).token;

    // An access token under `Intent`.
    const a = await send(`Intent ${accessJwt}`, dm);
    expect(a.status).toBe(401);
    expect(a.json.error.code).toBe('TOKEN_INVALID');

    // An intent token under `Bearer`, on an allowed route and on any other.
    const b = await send(`Bearer ${intentJwt}`, dm);
    expect(b.status).toBe(401);
    expect(b.json.error.code).toBe('TOKEN_INVALID');
    expect((await call('GET', '/users/@me', `Bearer ${intentJwt}`)).status).toBe(401);

    // Each works under its own.
    expect((await send(me.bearer, dm)).status).toBe(201);
    expect((await send(`Intent ${intentJwt}`, dm)).status).toBe(201);
  });
});
