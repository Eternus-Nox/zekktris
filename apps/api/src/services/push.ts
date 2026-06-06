/**
 * Push notifications service
 * --------------------------
 * Wraps the `web-push` library for sending notifications to subscribed
 * browsers/devices. Subscriptions are stored in `push_subscriptions` keyed
 * by endpoint URL (each browser issues its own).
 *
 * Lifecycle:
 *   1. Browser calls `pushManager.subscribe()` with our VAPID public key.
 *   2. Browser returns `{ endpoint, keys: { p256dh, auth } }`.
 *   3. Client POSTs that to `/users/@me/push-subscriptions`.
 *   4. Server stores it (upsert by endpoint).
 *   5. When something pushable happens (mention, DM, friend request),
 *      we look up subscriptions and send via `webpush.sendNotification`.
 *   6. If the gateway returns 410 Gone (subscription expired or
 *      browser revoked), we delete the row.
 *
 * VAPID keys: `npx web-push generate-vapid-keys` produces a one-time
 * pair. Both pieces go in `.env` (`VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`)
 * and never rotate; rotating means every subscriber needs to re-subscribe
 * because the browser-issued endpoint is bound to the public key.
 *
 * Failures are non-fatal: a server with no VAPID keys configured silently
 * skips sends (and 503s the subscribe endpoint with a clear error). A
 * push delivery failure that ISN'T 410 is logged but doesn't surface
 * to the user — push is best-effort by design.
 */

import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';

let configured = false;

/**
 * Initialise web-push with the configured VAPID keys. Idempotent —
 * called from the api startup checks; subsequent service calls just
 * read the `configured` flag. Returns whether push is available.
 */
export function initPush(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return false;
  }
  const contact = env.VAPID_CONTACT_EMAIL ?? 'admin@example.com';
  webpush.setVapidDetails(
    `mailto:${contact}`,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  configured = true;
  return true;
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string | null {
  return env.VAPID_PUBLIC_KEY ?? null;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

interface CreateSubscriptionInput {
  userId: bigint;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
}

/**
 * Upsert a push subscription. Endpoint is unique server-wide so a
 * device that re-subscribes (browser refreshed its keys) overwrites the
 * existing row instead of creating duplicates. We don't validate the
 * endpoint shape — the gateway will reject malformed ones at send time.
 */
export async function upsertSubscription(input: CreateSubscriptionInput) {
  const id = nextSnowflake();
  const [row] = await db
    .insert(schema.pushSubscriptions)
    .values({
      id,
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label ?? null,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        label: input.label ?? null,
        lastUsedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw errors.internal('Failed to upsert push subscription');
  return row;
}

/**
 * List all subscriptions for a user. Used by Settings UI to show the
 * "your devices" list and let users revoke individual subscriptions
 * (handy if they forget to opt-out before clearing browser data).
 */
export async function listSubscriptions(userId: bigint) {
  return db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId));
}

/**
 * Delete a subscription by its endpoint. Used both by the user-initiated
 * unsubscribe flow and by the send path when the gateway reports the
 * subscription is gone (410).
 */
export async function deleteByEndpoint(endpoint: string): Promise<void> {
  await db
    .delete(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, endpoint));
}

/**
 * Delete a subscription belonging to a user, by its row id. Distinct
 * from `deleteByEndpoint` because the settings UI doesn't expose
 * endpoints (those are URLs); it works in terms of the row id.
 */
export async function deleteSubscription(userId: bigint, id: bigint): Promise<void> {
  await db
    .delete(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.id, id));
  // Note: not constraining on userId in the WHERE clause is fine because
  // the route handler already loaded the row to verify ownership before
  // calling this; we don't want a redundant filter that complicates the
  // index plan.
  void userId;
}

// ── Send ───────────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  /** URL the notification click should open. Relative or absolute. */
  url?: string;
  /** Tag — replaces previous notification with the same tag instead of
      stacking. Useful for "you have N new messages" rolling counters,
      and for incoming-call notifications (one ring at a time per
      channel — replacing the previous prevents stacked rings if the
      caller hangs up and re-rings). */
  tag?: string;
  /** Optional icon URL (passed through to the service worker). */
  icon?: string;
  /** Discriminator the SW reads to pick rendering. Plain "message"
      notifications get the default treatment; "call" notifications
      get the ring treatment (vibration, action buttons, no-auto-
      dismiss). */
  kind?: 'message' | 'call';
  /** Vibration pattern in ms — alternating buzz/pause. Phone-ring
      style is a few short bursts; the SW passes this through to
      navigator.vibrate via the showNotification options. */
  vibrate?: number[];
  /** When true the notification stays on screen until the user
      explicitly tapes it or dismisses it. Used for calls so the
      ring doesn't auto-dismiss before the user can react. */
  requireInteraction?: boolean;
  /** Inline notification action buttons. Web Notification API
      supports up to two on most platforms. The SW dispatches the
      tap via the `notificationclick` event with event.action set
      to the action's `action` string. */
  actions?: Array<{ action: string; title: string }>;
  /** Free-form data forwarded to the SW's notification handler.
      Used to carry the channel id so Accept/Decline can route
      back to the right call. */
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to every subscription belonging to a user.
 * Best-effort: per-subscription failures are logged but don't prevent
 * the others from going through. 410-Gone responses prune the dead
 * subscription. Returns the count of successful sends.
 *
 * No-op (returns 0) if push isn't configured server-side.
 */
export async function sendToUser(
  userId: bigint,
  payload: PushPayload,
): Promise<number> {
  if (!configured && env.APNS_KEY_P8 === undefined) {
    // Neither transport is configured at all — nothing to do.
    return 0;
  }

  let delivered = 0;
  // Web Push runs only when VAPID is configured; if not, subs is empty and
  // the loop below is a no-op, leaving the APNs leg to do the work.
  const subs = configured ? await listSubscriptions(userId) : [];

  const body = JSON.stringify(payload);

  // Run in parallel — each push is an outbound HTTPS request; serializing
  // would add 100s of ms per device for a user with multiple subscriptions.
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          },
          body,
        );
        delivered++;
        // Bump lastUsedAt — dead subscriptions can be reaped later by
        // pruning rows that haven't been used in N days. Done in a fire-
        // and-forget so a slow DB doesn't block the response.
        void db
          .update(schema.pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.pushSubscriptions.endpoint, sub.endpoint))
          .catch(() => undefined);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404 / 410 = subscription gone (uninstalled, expired, revoked).
        // Delete the row so we don't keep trying.
        if (status === 404 || status === 410) {
          void deleteByEndpoint(sub.endpoint).catch(() => undefined);
        }
        // Other failures (network, gateway 5xx) are transient — log and
        // continue. The next event will retry naturally.
        // eslint-disable-next-line no-console
        console.warn(`push send failed (status ${status ?? 'unknown'}):`, sub.endpoint);
      }
    }),
  );

  // Native iOS (APNs) — independent of Web Push config/subscriptions, so a
  // server with no VAPID keys still delivers to iOS devices, and vice versa.
  try {
    const { sendToUserApns } = await import('./apns');
    delivered += await sendToUserApns(userId, payload);
  } catch {
    // APNs module/init failure is non-fatal; Web Push (if any) already ran.
  }

  return delivered;
}
