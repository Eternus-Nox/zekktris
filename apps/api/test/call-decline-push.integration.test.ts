import { describe, it, expect, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createApp } from '../src/server';
import { joinVoice, leaveVoice } from '../src/services/voice';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import {
  signCallDeclineToken,
  verifyCallDeclineToken,
  CALL_DECLINE_TOKEN_TTL_SECONDS,
} from '../src/auth/callDeclineToken';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

// Capture the ring push instead of sending it.
const pushed: Array<{ userId: bigint; payload: { kind?: string; data?: Record<string, unknown> } }> =
  [];
vi.mock('../src/services/push', async (orig) => ({
  ...(await orig<typeof import('../src/services/push')>()),
  sendToUser: vi.fn(async (userId: bigint, payload: never) => {
    pushed.push({ userId, payload });
    return 1;
  }),
}));

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping call-decline-push tests — no database reachable');
}

// The full app, so the test also proves the route isn't swallowed by a
// requireAuth catch-all from a sibling router.
const app = createApp();

function declineWith(token: string) {
  return app.request('/api/v1/call-decline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function inVoice(userId: bigint, channelId: bigint): Promise<boolean> {
  const [row] = await db
    .select({ channelId: schema.voiceStates.channelId })
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, userId))
    .limit(1);
  return row?.channelId === channelId;
}

async function callStartedAtMs(channelId: bigint): Promise<number> {
  const [row] = await db
    .select({ started: schema.channels.dmActiveCallStartedAt })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  return row!.started!.getTime();
}

async function friendsDm() {
  const caller = await createUser();
  const callee = await createUser();
  await addRelationship(caller, callee, 'friend');
  await addRelationship(callee, caller, 'friend');
  const dm = await createDmChannel([caller, callee]);
  return { caller, callee, dm };
}

describe('call-decline token', () => {
  const claims = { userId: 1n, channelId: 2n, callerId: 3n, callStartedAtMs: 1_700_000_000_123 };

  it('round-trips its claims', () => {
    expect(verifyCallDeclineToken(signCallDeclineToken(claims))).toEqual(claims);
  });

  it('rejects a token whose claims were edited', () => {
    const t = signCallDeclineToken(claims).split('.');
    t[1] = '99'; // different callee
    expect(verifyCallDeclineToken(t.join('.'))).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const t = signCallDeclineToken(claims, now);
    expect(verifyCallDeclineToken(t, now + (CALL_DECLINE_TOKEN_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(verifyCallDeclineToken(t, now + (CALL_DECLINE_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyCallDeclineToken('')).toBeNull();
    expect(verifyCallDeclineToken('v1.1.2.3.4.5')).toBeNull();
    expect(verifyCallDeclineToken('v1.a.b.c.d.e.f')).toBeNull();
  });
});

describe.runIf(dbReady)('POST /call-decline (push notification Decline, no bearer)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('the ring push carries a decline token that ends the call without a bearer token', async () => {
    const { caller, callee, dm } = await friendsDm();
    const { session } = await createSession({ userId: caller, userAgent: 'test', ipAddress: null });
    const bearer = await signAccessToken({ userId: caller, sessionId: session.id });

    const res = await app.request(`/api/v1/channels/${dm}/voice/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(pushed.some((p) => p.userId === callee && p.payload.kind === 'call')).toBe(true);
    });
    const ring = pushed.find((p) => p.userId === callee && p.payload.kind === 'call')!;
    const token = ring.payload.data?.declineToken;
    expect(typeof token).toBe('string');
    expect(verifyCallDeclineToken(token as string)).toEqual({
      userId: callee,
      channelId: dm,
      callerId: caller,
      callStartedAtMs: await callStartedAtMs(dm),
    });

    expect(await inVoice(caller, dm)).toBe(true);
    const decline = await declineWith(token as string);
    expect(decline.status).toBe(200);
    expect(await inVoice(caller, dm)).toBe(false);
    // Idempotent: a second tap is a no-op success.
    expect((await declineWith(token as string)).status).toBe(200);
  });

  it('rejects a forged token (401) and leaves the call ringing', async () => {
    const { caller, callee, dm } = await friendsDm();
    await joinVoice(caller, dm);
    const parts = signCallDeclineToken({
      userId: callee,
      channelId: dm,
      callerId: caller,
      callStartedAtMs: await callStartedAtMs(dm),
    }).split('.');
    parts[6] = parts[6]!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await declineWith(parts.join('.'));
    expect(res.status).toBe(401);
    expect(await inVoice(caller, dm)).toBe(true);
    await leaveVoice(caller);
  });

  it('does not end a LATER call in the same DM', async () => {
    const { caller, callee, dm } = await friendsDm();
    await joinVoice(caller, dm);
    const firstCall = signCallDeclineToken({
      userId: callee,
      channelId: dm,
      callerId: caller,
      callStartedAtMs: await callStartedAtMs(dm),
    });
    await leaveVoice(caller); // hang up
    await new Promise((r) => setTimeout(r, 5));
    await joinVoice(caller, dm); // ring again
    const res = await declineWith(firstCall);
    expect(res.status).toBe(200);
    expect(await inVoice(caller, dm)).toBe(true);
    await leaveVoice(caller);
  });

  it('does not hang up a call that was already answered', async () => {
    const { caller, callee, dm } = await friendsDm();
    await joinVoice(caller, dm);
    const token = signCallDeclineToken({
      userId: callee,
      channelId: dm,
      callerId: caller,
      callStartedAtMs: await callStartedAtMs(dm),
    });
    await joinVoice(callee, dm); // answered on another device
    expect((await declineWith(token)).status).toBe(200);
    expect(await inVoice(caller, dm)).toBe(true);
    await leaveVoice(callee);
    await leaveVoice(caller);
  });

  it('404s for a user who is not in the DM, even with a validly signed token', async () => {
    const { caller, dm } = await friendsDm();
    const stranger = await createUser();
    await joinVoice(caller, dm);
    const token = signCallDeclineToken({
      userId: stranger,
      channelId: dm,
      callerId: caller,
      callStartedAtMs: await callStartedAtMs(dm),
    });
    expect((await declineWith(token)).status).toBe(404);
    expect(await inVoice(caller, dm)).toBe(true);
    await leaveVoice(caller);
  });

  it('the bearer-authenticated decline also 404s for a non-recipient', async () => {
    const { caller, dm } = await friendsDm();
    const stranger = await createUser();
    const { session } = await createSession({ userId: stranger, userAgent: 'test', ipAddress: null });
    const bearer = await signAccessToken({ userId: stranger, sessionId: session.id });
    await joinVoice(caller, dm);
    const res = await app.request(`/api/v1/channels/${dm}/voice/decline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.status).toBe(404);
    expect(await inVoice(caller, dm)).toBe(true);
    await leaveVoice(caller);
  });
});
