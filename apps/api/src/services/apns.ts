/**
 * APNs (Apple Push Notification service) — native iOS push.
 * ---------------------------------------------------------
 * Token-based (.p8) auth over HTTP/2. This is the iOS counterpart to
 * services/push.ts (browser Web Push / VAPID): a Capacitor app can't
 * receive Web Push inside its WKWebView, so the native iOS app registers
 * an APNs device token which we deliver to here.
 *
 * Auth: a short-lived ES256 JWT signed with the .p8 key, sent as a bearer
 * token. Apple lets one provider token be reused for up to 60 minutes and
 * rate-limits regenerating it, so we cache + refresh ~every 45 minutes.
 *
 * Transport: a persistent HTTP/2 session to Apple, recreated on error.
 *   - api.push.apple.com          (production — TestFlight + App Store)
 *   - api.sandbox.push.apple.com  (sandbox — only Xcode debug "Run" builds)
 * Set APNS_PRODUCTION accordingly. A token-based .p8 works for BOTH hosts;
 * only the host differs.
 *
 * Config (all four key fields required to enable; missing any → no-op):
 *   APNS_KEY_P8     — the .p8 private key (PEM text, or base64 of the file)
 *   APNS_KEY_ID     — the 10-char Key ID from the Apple developer portal
 *   APNS_TEAM_ID    — your 10-char Apple Team ID
 *   APNS_BUNDLE_ID  — the app bundle id (== apns-topic), e.g. com.zekktris.app
 *   APNS_PRODUCTION — true for TestFlight/App Store (default), false for debug
 */

import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import type { PushPayload } from './push';

let configured = false;
let signingKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
/** Key ID actually in use: env override, or derived from AuthKey_<ID>.p8. */
let resolvedKeyId: string | null = null;
let jwtCache: { token: string; mintedAt: number } | null = null;
let session: http2.ClientHttp2Session | null = null;

const JWT_TTL_MS = 45 * 60 * 1000; // refresh well under Apple's 60-min cap
const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

function apnsHost(): string {
  return env.APNS_PRODUCTION ? PROD_HOST : SANDBOX_HOST;
}

/**
 * Normalize the configured key into PEM. Accepts raw PEM (contains "BEGIN")
 * or base64-of-PEM, and unescapes literal "\n" sequences that some env
 * systems inject into multi-line values.
 */
function normalizeP8(raw: string): string {
  const s = raw.trim();
  if (s.includes('BEGIN')) return s.replace(/\\n/g, '\n');
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return s;
  }
}

/**
 * Initialise APNs from env. Idempotent. Returns whether APNs is available.
 * Called from startup-checks and lazily re-checked by the send/register
 * paths so it works regardless of startup ordering.
 */
export async function initApns(): Promise<boolean> {
  if (configured) return true;
  // Key material, in priority order:
  //   1. APNS_KEY_P8       — inline PEM/base64 env value.
  //   2. APNS_KEY_P8_FILE  — a file path, OR a directory to scan. The
  //      directory form is the drag-and-drop path: mount ./secrets at
  //      /keys and drop AuthKey_<KEYID>.p8 in it. The Key ID is read
  //      from the filename when APNS_KEY_ID isn't set.
  let keyMaterial = env.APNS_KEY_P8 ?? null;
  let keyIdFromFilename: string | null = null;
  if (!keyMaterial && env.APNS_KEY_P8_FILE) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      let filePath = env.APNS_KEY_P8_FILE;
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        const entries = (await fs.readdir(filePath)).filter((f) => /\.p8$/i.test(f)).sort();
        if (entries.length === 0) {
          // No key dropped in yet — not an error, just unconfigured.
          return false;
        }
        filePath = path.join(filePath, entries[0]!);
      }
      const base = filePath.split('/').pop() ?? '';
      const m = /^AuthKey_([A-Z0-9]{10})\.p8$/i.exec(base);
      if (m) keyIdFromFilename = m[1]!.toUpperCase();
      keyMaterial = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('APNs: cannot read APNS_KEY_P8_FILE:', (err as Error).message);
      return false;
    }
  }
  const keyId = env.APNS_KEY_ID ?? keyIdFromFilename;
  if (!keyMaterial || !keyId || !env.APNS_TEAM_ID || !env.APNS_BUNDLE_ID) {
    return false;
  }
  try {
    signingKey = await importPKCS8(normalizeP8(keyMaterial), 'ES256');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('APNs: failed to load .p8 signing key:', (err as Error).message);
    return false;
  }
  resolvedKeyId = keyId;
  configured = true;
  // eslint-disable-next-line no-console
  console.log(`APNs: configured (key ${keyId}, topic ${env.APNS_BUNDLE_ID}, ${env.APNS_PRODUCTION ? 'production' : 'sandbox'})`);
  return true;
}

export function isApnsConfigured(): boolean {
  return configured;
}

/** Mint (or reuse a cached) ES256 provider JWT for the bearer header. */
async function providerToken(): Promise<string> {
  const now = Date.now();
  if (jwtCache && now - jwtCache.mintedAt < JWT_TTL_MS) return jwtCache.token;
  if (!signingKey) throw new Error('APNs signing key not loaded');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: (resolvedKeyId ?? env.APNS_KEY_ID) as string })
    .setIssuer(env.APNS_TEAM_ID as string)
    .setIssuedAt()
    .sign(signingKey);
  jwtCache = { token, mintedAt: now };
  return token;
}

/** Lazily create / reuse the HTTP/2 session to Apple. */
function getSession(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const s = http2.connect(apnsHost());
  const drop = (): void => {
    if (session === s) session = null;
  };
  s.on('error', drop);
  s.on('close', drop);
  s.on('goaway', drop);
  session = s;
  return s;
}

interface ApnsResult {
  ok: boolean;
  /** HTTP status from APNs (200 = delivered). 0 = transport failure. */
  status: number;
  /** Apple's failure reason string when present (e.g. "BadDeviceToken"). */
  reason?: string;
}

/** Send one notification to one device token over the shared session. */
function sendOne(
  deviceToken: string,
  payloadJson: string,
  jwt: string,
  opts?: { topic?: string; pushType?: 'alert' | 'voip'; expiration?: number },
): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let s: http2.ClientHttp2Session;
    try {
      s = getSession();
    } catch {
      resolve({ ok: false, status: 0 });
      return;
    }
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': opts?.topic ?? (env.APNS_BUNDLE_ID as string),
      'apns-push-type': opts?.pushType ?? 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (opts?.expiration !== undefined) {
      headers['apns-expiration'] = String(opts.expiration);
    }
    const req = s.request(headers);
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      if (status === 200) {
        resolve({ ok: true, status });
        return;
      }
      let reason: string | undefined;
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        /* non-JSON body */
      }
      resolve({ ok: false, status, reason });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(10_000, () => {
      req.close();
      resolve({ ok: false, status: 0 });
    });
    req.end(payloadJson);
  });
}

/** Map our cross-platform PushPayload onto an APNs `aps` payload. */
function buildApnsPayload(payload: PushPayload): string {
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: 'default',
  };
  // Mutable content lets the app's Notification Service Extension rewrite the
  // notification before it's displayed — used to decrypt an E2EE message
  // preview on-device (the ciphertext rides along in the custom data below).
  if (payload.mutableContent) aps['mutable-content'] = 1;
  // Collapse rapid repeats (e.g. one channel) into a thread on the lock screen.
  if (payload.tag) aps['thread-id'] = payload.tag;
  // Call rings get the "call" category so the native client renders its
  // inline Answer / Decline actions (registered as a UNNotificationCategory).
  if (payload.kind === 'call') aps.category = 'call';
  // Carry routing data at the top level so the app's tap handler can read it
  // (Capacitor surfaces non-`aps` keys as notification.data).
  const data: Record<string, unknown> = { ...(payload.data ?? {}) };
  if (payload.url) data.url = payload.url;
  if (payload.kind) data.kind = payload.kind;
  return JSON.stringify({ aps, ...data });
}

/**
 * VoIP push (PushKit) — rings the native iOS app even when it's closed
 * or force-quit. The app MUST report a CallKit call on receipt (Apple
 * requirement), which is exactly what our handler does. Sent only to
 * tokens registered with platform 'ios_voip'; topic is the bundle id
 * with the `.voip` suffix. Expires after 40s — a stale ring delivered
 * minutes later would be worse than none.
 */
/** Whether the user has any PushKit VoIP tokens registered. */
export async function hasVoipTokens(userId: bigint): Promise<boolean> {
  const rows = await db
    .select({ token: schema.apnsDeviceTokens.token })
    .from(schema.apnsDeviceTokens)
    .where(
      and(
        eq(schema.apnsDeviceTokens.userId, userId),
        eq(schema.apnsDeviceTokens.platform, 'ios_voip'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function sendVoipToUser(
  userId: bigint,
  data: { channelId: string; callerName: string },
): Promise<void> {
  if (!(await initApns())) return;
  const rows = await db
    .select({ token: schema.apnsDeviceTokens.token })
    .from(schema.apnsDeviceTokens)
    .where(
      and(
        eq(schema.apnsDeviceTokens.userId, userId),
        eq(schema.apnsDeviceTokens.platform, 'ios_voip'),
      ),
    );
  if (rows.length === 0) return;
  const jwt = await providerToken();
  const payload = JSON.stringify({ kind: 'call', ...data });
  const expiration = Math.floor(Date.now() / 1000) + 40;
  await Promise.all(
    rows.map(async (r) => {
      const res = await sendOne(r.token, payload, jwt, {
        topic: `${env.APNS_BUNDLE_ID as string}.voip`,
        pushType: 'voip',
        expiration,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `APNs: voip send failed (status ${res.status}${res.reason ? `, ${res.reason}` : ''})`,
        );
        if (
          res.status === 410 ||
          res.reason === 'BadDeviceToken' ||
          res.reason === 'Unregistered' ||
          res.reason === 'DeviceTokenNotForTopic'
        ) {
          await db
            .delete(schema.apnsDeviceTokens)
            .where(eq(schema.apnsDeviceTokens.token, r.token));
        }
      }
    }),
  );
}

// ── CRUD ───────────────────────────────────────────────────────────────────

interface UpsertTokenInput {
  userId: bigint;
  token: string;
  platform?: string;
  label?: string | null;
}

/** Upsert a device token. Token is unique server-wide so a device that
    re-registers (token reissued) overwrites the existing row. */
export async function upsertDeviceToken(input: UpsertTokenInput) {
  const id = nextSnowflake();
  const [row] = await db
    .insert(schema.apnsDeviceTokens)
    .values({
      id,
      userId: input.userId,
      token: input.token,
      platform: input.platform ?? 'ios',
      label: input.label ?? null,
    })
    .onConflictDoUpdate({
      target: schema.apnsDeviceTokens.token,
      set: {
        userId: input.userId,
        platform: input.platform ?? 'ios',
        label: input.label ?? null,
        lastUsedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw errors.internal('Failed to upsert device token');
  return row;
}

export async function listDeviceTokens(userId: bigint) {
  return db
    .select()
    .from(schema.apnsDeviceTokens)
    .where(eq(schema.apnsDeviceTokens.userId, userId));
}

/** Delete by the token value (used by the send path on permanent failure
    and by the client unregister-on-logout flow). */
export async function deleteDeviceTokenValue(token: string): Promise<void> {
  await db.delete(schema.apnsDeviceTokens).where(eq(schema.apnsDeviceTokens.token, token));
}

// ── Send ───────────────────────────────────────────────────────────────────

/**
 * Send to every iOS device token for a user. Best-effort and parallel.
 * Prunes tokens APNs reports as permanently invalid (410 / BadDeviceToken /
 * Unregistered / DeviceTokenNotForTopic). Returns successful-delivery count.
 * No-op (0) if APNs isn't configured.
 */
export async function sendToUserApns(userId: bigint, payload: PushPayload): Promise<number> {
  if (!configured && !(await initApns())) return 0;

  const tokens = await listDeviceTokens(userId);
  if (tokens.length === 0) return 0;

  let jwt: string;
  try {
    jwt = await providerToken();
  } catch {
    return 0;
  }
  const body = buildApnsPayload(payload);
  let delivered = 0;

  await Promise.all(
    tokens.map(async (row) => {
      const res = await sendOne(row.token, body, jwt);
      if (!res.ok) {
        // Make delivery failures visible in `docker logs` — silent
        // BadDeviceToken/TopicDisallowed made "notifications don't
        // arrive" undiagnosable. Common causes: APNS_PRODUCTION
        // mismatched with the build (Xcode runs need sandbox=false),
        // or APNS_BUNDLE_ID not matching the app's bundle id.
        // eslint-disable-next-line no-console
        console.warn(
          `APNs: send failed (status ${res.status}${res.reason ? `, ${res.reason}` : ''})`,
        );
      }
      if (res.ok) {
        delivered++;
        void db
          .update(schema.apnsDeviceTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.apnsDeviceTokens.token, row.token))
          .catch(() => undefined);
        return;
      }
      const permanent =
        res.status === 410 ||
        res.reason === 'BadDeviceToken' ||
        res.reason === 'Unregistered' ||
        res.reason === 'DeviceTokenNotForTopic';
      if (permanent) {
        void deleteDeviceTokenValue(row.token).catch(() => undefined);
      }
      // eslint-disable-next-line no-console
      console.warn(
        `APNs send failed (status ${res.status}${res.reason ? `, ${res.reason}` : ''})`,
      );
    }),
  );

  return delivered;
}
