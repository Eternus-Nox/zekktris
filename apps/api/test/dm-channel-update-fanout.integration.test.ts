import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import { enableE2ee } from '../src/services/dms';
import { db, schema } from '../src/db';
import { dmsRouter } from '../src/routes/dms';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { createUser, createDmChannel, addRelationship, trackChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping DM channel-update fan-out tests — no database reachable');
}

// A DM channel DTO is viewer-relative: `recipients` lists the viewer's peers,
// never the viewer. These tests pin that every DM CHANNEL_CREATE /
// CHANNEL_UPDATE reaches each recipient with ITS OWN DTO — the actor's DTO
// sent to the whole DM would show the peer a conversation with themself.

const SALT = 'c2FsdHNhbHRzYWx0c2FsdA==';
const VERIFIER = 'Q29ycmVjdFZlcmlmaWVyMDAwMDAwMDAwMDAwMDAwMD0=';
const PROOF = 'UHVyZ2VQcm9vZktleUhvbGRlcjAwMDAwMDAwMDAwMDA9';

const app = new Hono();
app.onError(errorHandler);
app.route('/users/@me/channels', dmsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
function call(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const liveConns: Connection[] = [];

/** A registered gateway connection for `userId` with a captured send buffer. */
function connect(userId: bigint, dmIds: bigint[]): Array<{ t?: string; d?: Record<string, unknown> }> {
  const sent: Array<{ t?: string; d?: Record<string, unknown> }> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: () => undefined,
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [], dmIds, []);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return sent;
}

/** The recipient ids carried by every `type` frame for `channelId`. */
function recipientsOf(
  sent: Array<{ t?: string; d?: Record<string, unknown> }>,
  type: string,
  channelId: bigint,
): string[][] {
  return sent
    .filter((f) => f.t === type && f.d?.id === channelId.toString())
    .map((f) => ((f.d?.recipients ?? []) as Array<{ id: string }>).map((r) => r.id));
}

function lastOf(
  sent: Array<{ t?: string; d?: Record<string, unknown> }>,
  type: string,
  channelId: bigint,
): Record<string, unknown> | undefined {
  return sent.filter((f) => f.t === type && f.d?.id === channelId.toString()).at(-1)?.d;
}

describe.runIf(dbReady)('DM CHANNEL_UPDATE / CHANNEL_CREATE are per-recipient (integration)', () => {
  beforeAll(() => {
    registry.init();
  });
  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('purge-proof registration on a legacy encrypted DM: each side sees the OTHER as recipient', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    // Legacy enable — no purge proof registered (e2eePurgeProofSet false).
    await enableE2ee(dm, SALT, VERIFIER);
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);

    const res = await call('PUT', `/users/@me/channels/${dm}/e2ee-purge-proof`, await tokenFor(a), {
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(res.status).toBe(200);

    expect(recipientsOf(bSent, 'CHANNEL_UPDATE', dm)).toEqual([[a.toString()]]);
    expect(recipientsOf(aSent, 'CHANNEL_UPDATE', dm)).toEqual([[b.toString()]]);
    expect(lastOf(bSent, 'CHANNEL_UPDATE', dm)?.e2eePurgeProofSet).toBe(true);
    expect(lastOf(aSent, 'CHANNEL_UPDATE', dm)?.e2eePurgeProofSet).toBe(true);
  });

  it('enable then disable: each side sees the OTHER as recipient both times', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);
    const tokenA = await tokenFor(a);

    const en = await call('PUT', `/users/@me/channels/${dm}/e2ee-enable`, tokenA, {
      salt: SALT,
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(en.status).toBe(200);
    expect(recipientsOf(bSent, 'CHANNEL_UPDATE', dm)).toEqual([[a.toString()]]);
    expect(recipientsOf(aSent, 'CHANNEL_UPDATE', dm)).toEqual([[b.toString()]]);
    expect(lastOf(bSent, 'CHANNEL_UPDATE', dm)?.e2eeEnabled).toBe(true);

    const dis = await call('DELETE', `/users/@me/channels/${dm}/e2ee-disable`, tokenA, {
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(dis.status).toBe(200);
    expect(recipientsOf(bSent, 'CHANNEL_UPDATE', dm)).toEqual([[a.toString()], [a.toString()]]);
    expect(recipientsOf(aSent, 'CHANNEL_UPDATE', dm)).toEqual([[b.toString()], [b.toString()]]);
    expect(lastOf(bSent, 'CHANNEL_UPDATE', dm)?.e2eeEnabled).toBe(false);
  });

  it('a supervised pair\'s encrypted DM is flagged e2eeSuppressed on the list and on CHANNEL_UPDATE', async () => {
    const parent = await createUser();
    const child = await createUser();
    const peer = await createUser();
    const dm = await createDmChannel([child, peer]);
    // Encrypted before the guardian link (legacy enable, no purge proof).
    await enableE2ee(dm, SALT, VERIFIER);
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: child,
      status: 'active',
      initiatedBy: 'parent',
    });
    const childSent = connect(child, [dm]);
    const peerSent = connect(peer, [dm]);

    // Reported unencrypted, but marked as suppressed rather than disabled, so
    // clients keep the key that still reads the encrypted history.
    for (const viewer of [child, peer]) {
      const res = await call('GET', '/users/@me/channels', await tokenFor(viewer));
      expect(res.status).toBe(200);
      const { channels } = (await res.json()) as { channels: Array<Record<string, unknown>> };
      const entry = channels.find((ch) => ch.id === dm.toString());
      expect(entry?.e2eeEnabled).toBe(false);
      expect(entry?.e2eeSalt).toBeNull();
      expect(entry?.e2eeSuppressed).toBe(true);
    }

    // Any DM CHANNEL_UPDATE goes through the same per-recipient DTOs.
    const res = await call('PUT', `/users/@me/channels/${dm}/e2ee-purge-proof`, await tokenFor(peer), {
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(res.status).toBe(200);
    for (const sent of [childSent, peerSent]) {
      const update = lastOf(sent, 'CHANNEL_UPDATE', dm);
      expect(update?.e2eeEnabled).toBe(false);
      expect(update?.e2eeSuppressed).toBe(true);
    }
  });

  it('a supervised pair\'s DM whose encryption was really turned off is not flagged e2eeSuppressed', async () => {
    const parent = await createUser();
    const child = await createUser();
    const peer = await createUser();
    const dm = await createDmChannel([child, peer]);
    await enableE2ee(dm, SALT, VERIFIER, PROOF);
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: child,
      status: 'active',
      initiatedBy: 'parent',
    });
    const childSent = connect(child, [dm]);
    const peerSent = connect(peer, [dm]);

    // A peer client still showing the DM as encrypted turns it off: the
    // history is purged, so clients must treat it as a disable and drop the key.
    const res = await call('DELETE', `/users/@me/channels/${dm}/e2ee-disable`, await tokenFor(peer), {
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(res.status).toBe(200);
    for (const sent of [childSent, peerSent]) {
      const update = lastOf(sent, 'CHANNEL_UPDATE', dm);
      expect(update?.e2eeEnabled).toBe(false);
      expect(update).not.toHaveProperty('e2eeSuppressed');
    }
    for (const viewer of [child, peer]) {
      const list = await call('GET', '/users/@me/channels', await tokenFor(viewer));
      expect(list.status).toBe(200);
      const { channels } = (await list.json()) as { channels: Array<Record<string, unknown>> };
      const entry = channels.find((ch) => ch.id === dm.toString());
      expect(entry?.e2eeEnabled).toBe(false);
      expect(entry).not.toHaveProperty('e2eeSuppressed');
    }
  });

  it('an unsupervised DM carries no e2eeSuppressed flag', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, VERIFIER);
    const res = await call('GET', '/users/@me/channels', await tokenFor(a));
    expect(res.status).toBe(200);
    const { channels } = (await res.json()) as { channels: Array<Record<string, unknown>> };
    const entry = channels.find((ch) => ch.id === dm.toString());
    expect(entry?.e2eeEnabled).toBe(true);
    expect(entry).not.toHaveProperty('e2eeSuppressed');
  });

  it('a peer who closed the DM gets no CHANNEL_UPDATE for it', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const bSent = connect(b, []);
    expect((await call('DELETE', `/users/@me/channels/${dm}`, await tokenFor(b))).status).toBe(200);
    const aSent = connect(a, [dm]);

    const en = await call('PUT', `/users/@me/channels/${dm}/e2ee-enable`, await tokenFor(a), {
      salt: SALT,
      verifier: VERIFIER,
      purgeProof: PROOF,
    });
    expect(en.status).toBe(200);
    expect(recipientsOf(bSent, 'CHANNEL_UPDATE', dm)).toEqual([]);
    // The actor still gets theirs (no peers left in the DM).
    expect(recipientsOf(aSent, 'CHANNEL_UPDATE', dm)).toEqual([[]]);
  });

  it('opening a new DM: the peer CHANNEL_CREATE names the opener, the response names the peer', async () => {
    const a = await createUser();
    const b = await createUser();
    await addRelationship(a, b, 'friend');
    await addRelationship(b, a, 'friend');
    const aSent = connect(a, []);
    const bSent = connect(b, []);

    const res = await call('POST', '/users/@me/channels', await tokenFor(a), {
      recipientId: b.toString(),
    });
    expect(res.status).toBe(201);
    const { channel } = (await res.json()) as { channel: { id: string; recipients: Array<{ id: string }> } };
    const dm = BigInt(channel.id);
    trackChannel(dm);
    expect(channel.recipients.map((r) => r.id)).toEqual([b.toString()]);

    expect(recipientsOf(bSent, 'CHANNEL_CREATE', dm)).toEqual([[a.toString()]]);
    expect(recipientsOf(aSent, 'CHANNEL_CREATE', dm)).toEqual([[b.toString()]]);
  });
});
