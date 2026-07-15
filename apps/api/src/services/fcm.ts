/**
 * Firebase Cloud Messaging (FCM HTTP v1) — push for the native Android app
 * -----------------------------------------------------------------------
 * The Android Capacitor shell registers an FCM registration token (Web Push
 * can't run in the Android System WebView, same constraint APNs solves on
 * iOS). This module mints an OAuth access token from a Firebase service
 * account and delivers to the user's Android device tokens. It is the Android
 * sibling of services/apns.ts and plugs into push.ts the same way.
 *
 * Config (all three required; missing any disables FCM — send is a no-op):
 *   FCM_PROJECT_ID    — Firebase project id.
 *   FCM_CLIENT_EMAIL  — service-account email.
 *   FCM_PRIVATE_KEY   — service-account PEM private key (raw PEM, or base64 of
 *                       it; literal "\n" sequences are unescaped).
 * Generate these in Firebase console → Project settings → Service accounts →
 * "Generate new private key" (a JSON file with project_id / client_email /
 * private_key).
 *
 * Auth model: a short-lived RS256 JWT signed with the service-account key is
 * exchanged at oauth2.googleapis.com for a ~1h bearer token, which is cached
 * and reused. Sends go to
 *   POST https://fcm.googleapis.com/v1/projects/<id>/messages:send
 */

import { importPKCS8, SignJWT } from 'jose';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { runBounded, PUSH_FANOUT_CONCURRENCY } from '../lib/concurrency';
import type { PushPayload } from './push';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ACCESS_TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before expiry

let configured = false;
let signingKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
let accessTokenCache: { token: string; expiresAt: number } | null = null;

/** Normalise the env private key — accept raw PEM or base64-of-PEM, and
    unescape literal "\n" (common when pasting Firebase's JSON value into an
    env file). */
function normalizePrivateKey(raw: string): string {
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return raw;
  }
}

/** Initialise FCM from env. Idempotent. Returns whether FCM is available. */
export async function initFcm(): Promise<boolean> {
  if (configured) return true;
  if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
    return false;
  }
  try {
    signingKey = await importPKCS8(normalizePrivateKey(env.FCM_PRIVATE_KEY), 'RS256');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('FCM: cannot load FCM_PRIVATE_KEY:', (err as Error).message);
    return false;
  }
  configured = true;
  // eslint-disable-next-line no-console
  console.log(`FCM: configured (project ${env.FCM_PROJECT_ID})`);
  return true;
}

/** Mint (or reuse a cached) OAuth access token for the FCM REST API. */
async function accessToken(): Promise<string> {
  const now = Date.now();
  if (accessTokenCache && now < accessTokenCache.expiresAt - ACCESS_TOKEN_SKEW_MS) {
    return accessTokenCache.token;
  }
  if (!signingKey) throw new Error('FCM signing key not loaded');
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.FCM_CLIENT_EMAIL as string)
    .setAudience(TOKEN_ENDPOINT)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(signingKey);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM token exchange failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('FCM token exchange returned no access_token');
  accessTokenCache = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

/** Map our cross-platform PushPayload onto an FCM v1 message for one token. */
function buildFcmMessage(payload: PushPayload, token: string): Record<string, unknown> {
  // DATA-ONLY message — deliberately NO top-level `notification` block. With a
  // notification block the OS draws the banner itself and the app's
  // onMessageReceived never runs while backgrounded/killed; data-only makes it
  // run in every state, which is what lets the Android client offer inline
  // quick-reply, ring a full-screen incoming call, and decrypt an E2EE DM
  // preview on-device. The client rebuilds the visible notification from these
  // `data` fields. (This builder is Android-only — iOS keeps its APNs path — so
  // going data-only here can't affect iOS delivery.)
  //
  // FCM `data` values MUST be strings. Carry routing data (channelId, url, kind,
  // e2ee ciphertext) plus the notification content the client needs to render.
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.data ?? {})) {
    if (v !== undefined && v !== null) data[k] = typeof v === 'string' ? v : String(v);
  }
  if (payload.url) data.url = payload.url;
  if (payload.kind) data.kind = payload.kind;
  // Notification content now travels in `data` for the client to render.
  data.title = payload.title;
  data.body = payload.body;
  if (payload.tag) data.tag = payload.tag;
  if (payload.badge !== undefined) data.badge = String(payload.badge);

  return {
    token,
    android: {
      // High priority so a data-only push reliably wakes a backgrounded or
      // swipe-killed app to run onMessageReceived promptly (a 'normal' data
      // push can be deferred by Doze). Calls were already high; messages now
      // match so their banner isn't delayed.
      priority: 'high',
    },
    data,
  };
}

/** Android device tokens for a user (platform 'android'). Kept separate from
    APNs so an FCM token is never sent to Apple (which would 400 + get the row
    deleted as a bad APNs token). */
async function listAndroidTokens(userId: bigint): Promise<Array<{ token: string }>> {
  return db
    .select({ token: schema.apnsDeviceTokens.token })
    .from(schema.apnsDeviceTokens)
    .where(
      and(
        eq(schema.apnsDeviceTokens.userId, userId),
        eq(schema.apnsDeviceTokens.platform, 'android'),
      ),
    );
}

/**
 * Deliver a push to all of a user's Android (FCM) devices. Returns the number
 * of successful sends. Non-fatal: any failure is logged; permanently-invalid
 * tokens (UNREGISTERED / INVALID_ARGUMENT) are pruned.
 */
export async function sendToUserFcm(userId: bigint, payload: PushPayload): Promise<number> {
  if (!configured && !(await initFcm())) return 0;

  const tokens = await listAndroidTokens(userId);
  if (tokens.length === 0) return 0;

  let bearer: string;
  try {
    bearer = await accessToken();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('FCM: could not obtain access token:', (err as Error).message);
    return 0;
  }

  const url = fcmSendUrl();
  let delivered = 0;

  await Promise.all(
    tokens.map(async (row) => {
      if (await sendFcmOne(row.token, payload, bearer, url)) delivered++;
    }),
  );

  return delivered;
}

function fcmSendUrl(): string {
  return `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID as string}/messages:send`;
}

/**
 * Deliver one FCM message to one Android token. Returns true on success.
 * Prunes permanently-dead tokens (404/UNREGISTERED/NOT_FOUND/INVALID_ARGUMENT)
 * and bumps lastUsedAt on success. Shared by the single-user and bulk paths so
 * the prune semantics can't drift between them.
 */
async function sendFcmOne(
  token: string,
  payload: PushPayload,
  bearer: string,
  url: string,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: buildFcmMessage(payload, token) }),
    });
    if (res.ok) {
      void db
        .update(schema.apnsDeviceTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apnsDeviceTokens.token, token))
        .catch(() => undefined);
      return true;
    }
    // 404 (NOT_FOUND/UNREGISTERED) or 400 (INVALID_ARGUMENT) = the token is
    // dead (app uninstalled / token rotated). Prune so we stop trying.
    let reason = '';
    try {
      const body = (await res.json()) as { error?: { status?: string; message?: string } };
      reason = body.error?.status ?? body.error?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    const permanent =
      res.status === 404 ||
      reason === 'UNREGISTERED' ||
      reason === 'NOT_FOUND' ||
      (res.status === 400 && reason === 'INVALID_ARGUMENT');
    if (permanent) {
      void db
        .delete(schema.apnsDeviceTokens)
        .where(eq(schema.apnsDeviceTokens.token, token))
        .catch(() => undefined);
    }
    // eslint-disable-next-line no-console
    console.warn(`FCM send failed (status ${res.status}${reason ? `, ${reason}` : ''})`);
    return false;
  } catch (err) {
    // Network/transport — transient; the next event retries naturally.
    // eslint-disable-next-line no-console
    console.warn('FCM send error:', (err as Error).message);
    return false;
  }
}

/** Android (FCM) tokens for many users in ONE query, as {userId, token} rows. */
async function listAndroidTokensForUsers(
  userIds: bigint[],
): Promise<Array<{ userId: bigint; token: string }>> {
  if (userIds.length === 0) return [];
  return db
    .select({ userId: schema.apnsDeviceTokens.userId, token: schema.apnsDeviceTokens.token })
    .from(schema.apnsDeviceTokens)
    .where(
      and(
        inArray(schema.apnsDeviceTokens.userId, userIds),
        eq(schema.apnsDeviceTokens.platform, 'android'),
      ),
    );
}

/**
 * Bulk FCM fan-out: deliver a per-recipient payload to MANY users' Android
 * devices, fetching all tokens in ONE query and bounding the in-flight sends.
 * Returns the successful-delivery count. No-op (0) if FCM isn't configured.
 */
export async function sendToUsersFcm(
  userIds: bigint[],
  payloadFor: (userId: bigint) => PushPayload,
): Promise<number> {
  if (!configured && !(await initFcm())) return 0;
  if (userIds.length === 0) return 0;

  const rows = await listAndroidTokensForUsers(userIds);
  if (rows.length === 0) return 0;

  let bearer: string;
  try {
    bearer = await accessToken();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('FCM: could not obtain access token:', (err as Error).message);
    return 0;
  }

  const url = fcmSendUrl();
  // One payload per user; its tokens reuse it (buildFcmMessage re-embeds the token).
  const payloadByUser = new Map<string, PushPayload>();
  let delivered = 0;
  const tasks = rows.map((row) => async () => {
    const key = row.userId.toString();
    let p = payloadByUser.get(key);
    if (p === undefined) {
      p = payloadFor(row.userId);
      payloadByUser.set(key, p);
    }
    if (await sendFcmOne(row.token, p, bearer, url)) delivered++;
  });
  await runBounded(tasks, PUSH_FANOUT_CONCURRENCY);

  return delivered;
}
