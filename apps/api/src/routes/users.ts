/**
 * Users routes
 * ------------
 * GET    /api/v1/users/@me                  read own profile
 * PATCH  /api/v1/users/@me                  update own profile
 * POST   /api/v1/users/@me/password         change password
 * GET    /api/v1/users/@me/sessions         list active sessions
 * DELETE /api/v1/users/@me/sessions/:id     revoke specific session
 * DELETE /api/v1/users/@me/sessions         revoke all *other* sessions
 * GET    /api/v1/users/:id                  public profile lookup
 */

import { Hono } from 'hono';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { z } from 'zod';
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors, AppError } from '../errors';
import { log } from '../log';
import {
  requireAuth,
  requireUserId,
  requireSessionId,
  requireHumanSession,
} from '../auth/middleware';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { consumeStepUp, assertStepUpPassword } from '../auth/stepUp';
import { registry } from '../gateway/registry';
import { clearRefreshCookie } from '../auth/cookies';
import {
  listUserSessions,
  getSession,
  revokeSession,
  revokeAllUserSessions,
} from '../auth/sessions';
import { toSelfUser, toPublicUser, toSession, toReadState } from '../lib/dto';
import { ageOnDate, MIN_SIGNUP_AGE } from '../lib/age';
import * as readStates from '../services/readStates';
import * as supervision from '../services/supervision';
import * as messages from '../services/messages';
import { containsListedWord } from '../services/security';
import {
  bioSchema,
  cdnPathOrNullSchema,
  customStatusSchema,
  displayNameSchema,
  emailSchema,
  nicknameSchema,
  passwordSchema,
  settableStatusSchema,
  snowflakeSchema,
  usernameSchema,
} from '../lib/validation';

export const usersRouter = new Hono();

// ───────────────────────────────────────────────────────────────────────────
// GET /@me
// ───────────────────────────────────────────────────────────────────────────

usersRouter.get('/@me', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const rows = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);
  const user = rows[0];
  if (!user) {
    // The token was valid but the user was deleted. Treat as auth failure.
    throw errors.unauthenticated('Account no longer exists');
  }
  // Effective membership (own or inherited from a supervising parent) rides
  // the self DTO so the client can gate the Appearance UI + show the tier.
  const subs = await import('../services/subscriptions');
  const membership = await subs.getEffectiveSubscription(userId);
  return c.json({ user: toSelfUser(user, membership) });
});

// ───────────────────────────────────────────────────────────────────────────
// Achievements — computed on demand; see services/achievements.
// ───────────────────────────────────────────────────────────────────────────

// The shelf is ~7 uncached aggregate queries over the target user's history,
// and ANY authed user can request ANY user's shelf — a cheap request that
// amplifies into heavy DB work. Throttle per requester so one client can't
// hammer the directory of profiles. Generous (a real user opens profiles
// occasionally); inherits the Redis fail-open contract (degrades to no-limit,
// never blocks reads, on a Redis outage).
const achievementsRl = new RateLimiter(60, 60_000, 'achievements');
async function consumeAchievements(requesterId: bigint): Promise<void> {
  const r = await achievementsRl.consume(requesterId.toString());
  if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
}

usersRouter.get('/@me/achievements', requireAuth, async (c) => {
  const userId = requireUserId(c);
  await consumeAchievements(userId);
  // The visibility flag is a single, cheap column read — keep it OUTSIDE the
  // try/catch so a failure to COMPUTE the achievement list (the heavier,
  // multi-query path below) never silently reports `public: false` for a user
  // who actually enabled it. Otherwise the Settings toggle appears to "not
  // persist" on reload whenever the shelf computation hiccups.
  const [me] = await db
    .select({ pub: schema.users.achievementsPublic })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const isPublic = me?.pub ?? false;
  try {
    const { achievementsForUser } = await import('../services/achievements');
    return c.json({
      achievements: await achievementsForUser(userId),
      public: isPublic,
    });
  } catch {
    // Shelf computation failed (e.g. migration 0073 not applied) — degrade to
    // an empty list but still report the real visibility flag.
    return c.json({ achievements: [], public: isPublic });
  }
});

usersRouter.get(
  '/:userId/achievements',
  requireAuth,
  validate('param', z.object({ userId: snowflakeSchema })),
  async (c) => {
    await consumeAchievements(requireUserId(c));
    const targetId = BigInt(c.req.valid('param').userId);
    const [target] = await db
      .select({ pub: schema.users.achievementsPublic })
      .from(schema.users)
      .where(eq(schema.users.id, targetId))
      .limit(1);
    if (!target) throw errors.notFound('User');
    if (!target.pub && targetId !== requireUserId(c)) {
      // Private: act as empty rather than revealing the toggle state.
      return c.json({ achievements: [], public: false });
    }
    const { achievementsForUser } = await import('../services/achievements');
    const all = await achievementsForUser(targetId);
    const isOwner = targetId === requireUserId(c);
    // The owner sees their full shelf with real progress. Other viewers of a
    // PUBLIC profile see the same set of badges (earned + in-progress, so the
    // shelf isn't silently empty for anyone who hasn't crossed a threshold yet)
    // but with the raw `value` progress counter scrubbed to 0 — that field
    // leaks exact totals (message counts, friend counts, call hours). `goal`
    // and `earned` are kept so in-progress badges still render "x/goal" as 0/goal.
    // value is set to 0 rather than omitted: the native model decodes it as a
    // non-optional Int, so omitting it would break the client decode.
    return c.json({
      achievements: isOwner ? all : all.map((a) => ({ ...a, value: 0 })),
      public: target.pub,
    });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// PATCH /@me
// ───────────────────────────────────────────────────────────────────────────
//
// Allowed fields. Email/username/password changes go through their own
// dedicated endpoints (each has different security requirements).

const patchMeSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    bio: bioSchema.optional(),
    status: settableStatusSchema.optional(),
    customStatus: customStatusSchema.optional(),
    /** Optional emoji alongside the custom status text. Either or
        both may be set. Pass null to clear. */
    customStatusEmoji: z.union([z.string().max(32), z.null()]).optional(),
    /** Optional auto-clear timestamp. The client treats any past
        timestamp as "no status," so setting this in the past is
        equivalent to clearing the status entirely. */
    customStatusExpiresAt: z.union([z.string().datetime(), z.null()]).optional(),
    locale: z.string().min(2).max(35).optional(),
    /** Cosmetic avatar decoration id (a preset CSS ring/glow chosen on the
        client). A short id string, or null/'none' to clear. The client
        validates it against its registry; the server only bounds length. */
    avatarDecoration: z.union([z.string().max(32), z.null()]).optional(),
    /** Avatar URL — set via POST /@me/avatar after a file upload
        (which produces a /cdn/ path), or null to clear. Arbitrary
        external URLs are rejected — see cdnPathOrNullSchema for
        the security rationale. */
    avatarUrl: cdnPathOrNullSchema.optional(),
    /** Banner URL — same shape as avatarUrl. POST /@me/banner is
        the upload path; PATCH accepts a /cdn/ reference or null. */
    bannerUrl: cdnPathOrNullSchema.optional(),
    /** Achievements visibility: when true, anyone can view this user's
        achievements; when false (default) only the owner sees them. */
    achievementsPublic: z.boolean().optional(),
    /** Account-level toggle for achievement-unlock notifications. */
    notifyAchievements: z.boolean().optional(),
    /** Account-level toggle for reaction notifications. */
    notifyReactions: z.boolean().optional(),
    /** Whether the supporter tier title shows on the profile popup. */
    showSubscriptionTier: z.boolean().optional(),
    /** DM read-receipts opt-out. When false, the server skips
        delivered_at/viewed_at stamping for messages this user
        receives — so senders to this user see "Sent" forever and
        this user's reads stay private. Reciprocal: incoming
        receipt timestamps from senders are also suppressed in
        this user's own message renders when this is off, so the
        privacy is symmetric. */
    dmReadReceiptsEnabled: z.boolean().optional(),
    /** Privacy: when true, users sharing a guild with this user can
        open a DM and ring them. When false (default), only mutual
        friends can. Block list always wins. Affects future DMs/calls
        only — existing DMs continue to function regardless. */
    allowDmsFromServerMembers: z.boolean().optional(),
    /** E2EE identity public key (X25519, base64-encoded). 32 bytes →
        44 chars in base64. Client generates the keypair locally; only
        the public half ever reaches the server. Setting to null
        clears the server's record — used when the user toggles E2EE
        off in settings. Other users will no longer be able to
        encrypt new messages to this user once cleared. */
    publicKey: z
      .union([
        z.string().min(40).max(64).regex(/^[A-Za-z0-9+/=]+$/),
        z.null(),
      ])
      .optional(),
    /** Custom name tag ("clan tag"), label-only. Both optional +
        independently clearable with null. tagLabel is capped at 4 chars;
        tagColor must be a #rrggbb hex. */
    tagLabel: z.union([z.string().max(4), z.null()]).optional(),
    tagColor: z
      .union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.null()])
      .optional(),
    /** Staff "shimmer" color; #rrggbb or null (off). Only rendered for instance
        staff (enforced in the DTO), so a non-staff value is inert. */
    staffColor: z
      .union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.null()])
      .optional(),
    /** Optional soft glow layered on the staff shimmer. Staff-only, like color. */
    staffGlow: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required',
  });

usersRouter.patch('/@me', requireAuth, validate('json', patchMeSchema), async (c) => {
  const userId = requireUserId(c);
  const body = c.req.valid('json');

  // Membership hard lock: SETTING an Appearance cosmetic (avatar frame, clan
  // tag) requires an active supporter membership (own or inherited from a
  // supervising parent). CLEARING is always allowed so a lapsed member can
  // tidy up. Themes are client-local and gated in the UI only.
  const wantsCosmetic =
    (body.avatarDecoration !== undefined &&
      !!body.avatarDecoration &&
      body.avatarDecoration !== 'none') ||
    (body.tagLabel !== undefined && (body.tagLabel?.trim() ?? '') !== '') ||
    (body.tagColor !== undefined && body.tagColor !== null);
  // Cache the effective membership for this request. The cosmetic gate below
  // and the toSelfUser response both need it; the PATCH between them only
  // writes users.* (never subscriptions or supervision links), so one read is
  // safe to reuse. undefined = not computed yet (keeps non-cosmetic PATCHes at
  // exactly one read, at the response builder).
  let effectiveSub: import('../services/subscriptions').EffectiveSubscription | null | undefined;
  if (wantsCosmetic) {
    // Admin-configurable gate (instance_settings via the monetization
    // service). 'none' = Appearance is free on this instance; otherwise the
    // user's effective tier (own or inherited, founder rows = scout) must
    // meet the configured minimum. Default 'scout' preserves the original
    // any-membership behavior.
    const monetization = await import('../services/monetization');
    // Fail-open ON PURPOSE: a settings read hiccup must degrade to the
    // shipped default gate ('scout' = any membership, i.e. today's
    // behavior), never 500 a cosmetic PATCH /@me.
    let required = monetization.DEFAULTS.appearance;
    try {
      required = (await monetization.getConfig()).appearance;
    } catch (err) {
      console.error(
        '[users] appearance gate config lookup failed; falling back to default:',
        err,
      );
    }
    if (required !== 'none') {
      const subs = await import('../services/subscriptions');
      effectiveSub = await subs.getEffectiveSubscription(userId);
      if (!monetization.isAllowed(monetization.tierRank(effectiveSub?.tier ?? null), required)) {
        const tierName = required.charAt(0).toUpperCase() + required.slice(1);
        throw new AppError(
          'FORBIDDEN',
          `Appearance options are a supporter perk (${tierName} or higher). Supporting helps Zekktris stay alive and strong!`,
          { membershipRequired: true },
        );
      }
    }
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.displayName !== undefined) {
    // Identity fields must not contain vulgar words (blocked OR watch) — a
    // display name shows next to everyone everywhere.
    const bad = await containsListedWord(body.displayName);
    if (bad) throw errors.badRequest('That display name contains a word that isn’t allowed.');
    update.displayName = body.displayName;
  }
  if (body.bio !== undefined) update.bio = body.bio;
  if (body.status !== undefined) update.status = body.status;
  if (body.customStatus !== undefined) update.customStatus = body.customStatus;
  if (body.customStatusEmoji !== undefined) {
    update.customStatusEmoji = body.customStatusEmoji;
  }
  if (body.customStatusExpiresAt !== undefined) {
    update.customStatusExpiresAt = body.customStatusExpiresAt
      ? new Date(body.customStatusExpiresAt)
      : null;
  }
  if (body.locale !== undefined) update.locale = body.locale;
  if (body.avatarDecoration !== undefined) {
    // Normalize 'none'/'' to null so the column stays clean.
    update.avatarDecoration =
      body.avatarDecoration && body.avatarDecoration !== 'none' ? body.avatarDecoration : null;
  }
  if (body.avatarUrl !== undefined) update.avatarUrl = body.avatarUrl;
  if (body.bannerUrl !== undefined) update.bannerUrl = body.bannerUrl;
  if (body.achievementsPublic !== undefined) {
    update.achievementsPublic = body.achievementsPublic;
  }
  if (body.notifyAchievements !== undefined) {
    update.notifyAchievements = body.notifyAchievements;
  }
  if (body.notifyReactions !== undefined) {
    update.notifyReactions = body.notifyReactions;
  }
  if (body.showSubscriptionTier !== undefined) {
    update.showSubscriptionTier = body.showSubscriptionTier;
  }
  if (body.dmReadReceiptsEnabled !== undefined) {
    update.dmReadReceiptsEnabled = body.dmReadReceiptsEnabled;
  }
  if (body.allowDmsFromServerMembers !== undefined) {
    update.allowDmsFromServerMembers = body.allowDmsFromServerMembers;
  }
  if (body.publicKey !== undefined) {
    update.publicKey = body.publicKey;
  }
  // Name tag (label-only). Empty/whitespace label collapses to null so the
  // tag disappears cleanly rather than rendering an empty pill.
  if (body.tagLabel !== undefined) {
    const v = body.tagLabel?.trim();
    // Block vulgar tags — the name tag renders next to the username
    // everywhere, so it must clear the identity profanity bar (blocked OR
    // watch words). DB-backed so admin edits to the lists take effect.
    if (v && (await containsListedWord(v))) {
      throw errors.badRequest('That name tag contains a word that isn’t allowed.');
    }
    update.tagLabel = v ? v : null;
  }
  if (body.tagColor !== undefined) update.tagColor = body.tagColor;
  // Staff shimmer color. Only instance staff may SET a color; clearing (null)
  // is always allowed. The DTO also gates rendering to staff, so a stray value
  // never shows — this just keeps the column clean for regular members.
  if (body.staffColor !== undefined || body.staffGlow !== undefined) {
    // Clearing the color needs no staff check.
    if (body.staffColor === null) update.staffColor = null;
    // Setting a color or toggling the glow does — only staff render either.
    const needsStaffCheck =
      (body.staffColor !== undefined && body.staffColor !== null) ||
      body.staffGlow !== undefined;
    if (needsStaffCheck) {
      const [me] = await db
        .select({ isAdmin: schema.users.isAdmin, isModerator: schema.users.isModerator })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (me?.isAdmin || me?.isModerator) {
        if (body.staffColor !== undefined && body.staffColor !== null) {
          update.staffColor = body.staffColor;
        }
        if (body.staffGlow !== undefined) update.staffGlow = body.staffGlow;
      }
    }
  }

  // Whether THIS patch touches the avatar/banner columns — used to gate
  // the prior-URL capture (avoids an unnecessary SELECT FOR UPDATE for
  // patches that only touch displayName/status/etc).
  const touchingAvatar = body.avatarUrl !== undefined;
  const touchingBanner = body.bannerUrl !== undefined;

  // Wrap in a transaction with SELECT FOR UPDATE when we need to know
  // the prior URLs, so two concurrent patches that both rotate the
  // avatar can't both miss the cleanup (one row wins the UPDATE; the
  // other captured the same prior id and we'd lose track of the
  // intermediate file). Mirrors the pattern in POST /@me/avatar.
  const { deleteAttachmentFile, parseCdnAttachmentId } = await import(
    '../services/uploads'
  );
  let priorAvatarId: bigint | null = null;
  let priorBannerId: bigint | null = null;
  const user = await db.transaction(async (tx) => {
    if (touchingAvatar || touchingBanner) {
      const [prior] = await tx
        .select({
          avatarUrl: schema.users.avatarUrl,
          bannerUrl: schema.users.bannerUrl,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
        .limit(1);
      if (!prior) throw errors.notFound('User');
      if (touchingAvatar) priorAvatarId = parseCdnAttachmentId(prior.avatarUrl);
      if (touchingBanner) priorBannerId = parseCdnAttachmentId(prior.bannerUrl);
    }
    const [u] = await tx
      .update(schema.users)
      .set(update)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .returning();
    if (!u) throw errors.notFound('User');
    return u;
  });

  // Best-effort cleanup AFTER commit. If the patch nulled or replaced
  // the avatar/banner URL and the previous value was a /cdn/ reference,
  // delete the previous file. parseCdnAttachmentId returns null for
  // external URLs (gravatar, admin SQL fix-ups) so those are skipped.
  // Also defensive: if the new URL parses to the same id (shouldn't
  // happen for the clearing case where new=null, but possible if
  // someone PATCHes with the same URL), skip the delete.
  if (touchingAvatar && priorAvatarId !== null) {
    const newAvatarId = parseCdnAttachmentId(user.avatarUrl);
    if (newAvatarId !== priorAvatarId) {
      void deleteAttachmentFile(priorAvatarId);
    }
  }
  if (touchingBanner && priorBannerId !== null) {
    const newBannerId = parseCdnAttachmentId(user.bannerUrl);
    if (newBannerId !== priorBannerId) {
      void deleteAttachmentFile(priorBannerId);
    }
  }

  // Broadcast the new status to every guild the user is in so other
  // members see the dot color change in their MemberList live, and so
  // the user's own MemberList row updates too. We collect the guild ids
  // by querying membership; this is a small read but keeps the dispatch
  // honest (no "they're in 50 guilds and we forgot one" bug). Skipped
  // entirely if the patch didn't include status — bio/displayName don't
  // need a presence event.
  if (body.status !== undefined) {
    const memberRows = await db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId));
    const dmRows = await db
      .select({ channelId: schema.dmRecipients.channelId })
      .from(schema.dmRecipients)
      .where(eq(schema.dmRecipients.userId, userId));
    // Accepted friends receive the status change too, even when they share no
    // guild and no DM channel with this user — otherwise a manual status flip
    // (e.g. Online → Invisible) would never reach a friends-only relationship.
    const { listAcceptedFriendIds } = await import('../services/relationships');
    const friendIds = await listAcceptedFriendIds(userId);
    if (memberRows.length > 0 || dmRows.length > 0 || friendIds.length > 0) {
      const { presenceUpdate } = await import('../gateway/dispatch');
      // 'invisible' is a private setting — to other users it appears as
      // 'offline'. We broadcast offline rather than leaking the
      // distinction. The user's own client knows the difference (it
      // sees the actual status from the patchMe response).
      const broadcastStatus = body.status === 'invisible' ? 'offline' : body.status;
      presenceUpdate({
        userId,
        status: broadcastStatus,
        guildIds: memberRows.map((r) => r.guildId),
        dmChannelIds: dmRows.map((r) => r.channelId),
        userIds: friendIds,
      });
    }
  }

  // USER_UPDATE — fire whenever a profile field that's visible to
  // other clients has changed (display name, avatar, bio, custom
  // status). Status changes are already covered by the dedicated
  // PRESENCE_UPDATE event above, so we skip the userUpdate emission
  // for status-only patches. Locale is private (server-side personalization
  // hint) and doesn't go on the wire.
  const profileFieldChanged =
    body.displayName !== undefined ||
    body.avatarUrl !== undefined ||
    body.bannerUrl !== undefined ||
    body.bio !== undefined ||
    body.customStatus !== undefined;
  if (profileFieldChanged) {
    const { listDmPeers } = await import('../services/dms');
    const [memberRows, dmPeerIds] = await Promise.all([
      db
        .select({ guildId: schema.guildMembers.guildId })
        .from(schema.guildMembers)
        .where(eq(schema.guildMembers.userId, userId)),
      listDmPeers(userId),
    ]);
    const { userUpdate } = await import('../gateway/dispatch');
    userUpdate({
      userId,
      user: {
        id: user.id.toString(),
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        customStatus: user.customStatus,
        // Broadcast the same offline-for-invisible mask as presence.
        status:
          user.status === 'invisible' ? 'offline' : (user.status as 'online' | 'idle' | 'dnd' | 'offline'),
      },
      guildIds: memberRows.map((r) => r.guildId),
      userIds: dmPeerIds,
    });
  }

  // A cosmetic change may unlock tagged / framed / signature_look. Only sync
  // when a relevant field was actually touched (not for e.g. a notify toggle).
  if (
    body.tagLabel !== undefined ||
    body.avatarDecoration !== undefined ||
    body.avatarUrl !== undefined ||
    body.bannerUrl !== undefined ||
    body.bio !== undefined
  ) {
    void import('../services/achievements')
      .then((m) => m.syncAndNotifyAchievements(userId))
      .catch(() => {});
  }

  // Include the effective membership so the client's stored self-user doesn't
  // lose the tier fields when it replaces itself with this response.
  {
    const subs = await import('../services/subscriptions');
    // Reuse the value computed by the cosmetic gate above when it ran; only
    // read here on the (common) non-cosmetic path where it stayed undefined.
    const membership =
      effectiveSub !== undefined
        ? effectiveSub
        : await subs.getEffectiveSubscription(userId);
    return c.json({ user: toSelfUser(user, membership) });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /@me/date-of-birth — one-time self-service DOB set / correction
// ───────────────────────────────────────────────────────────────────────────
// Allowed only while the account is UNLOCKED (canChangeDob). It succeeds once
// and then re-locks (dob_locked=true); further changes need an admin reset.
// Legacy accounts were unlocked by migration 0096 (and defaulted to 18); new
// accounts are locked at signup. Setting a minor age here immediately engages
// supervision via the effective-restrictions chokepoint — no extra wiring.
const selfDobSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Enter a valid date of birth.')
  .refine((s) => Number(s.slice(0, 4)) >= 1900, 'Enter a valid date of birth.')
  .refine((s) => ageOnDate(s, new Date()) >= MIN_SIGNUP_AGE, {
    message: `You must be at least ${MIN_SIGNUP_AGE} years old to use Zekktris.`,
  });

usersRouter.patch(
  '/@me/date-of-birth',
  requireAuth,
  validate('json', z.object({ dateOfBirth: selfDobSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { dateOfBirth } = c.req.valid('json');
    const [me] = await db
      .select({ dobLocked: schema.users.dobLocked })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!me) throw errors.notFound('User');
    if (me.dobLocked) {
      throw new AppError(
        'FORBIDDEN',
        'Your date of birth is locked. Ask an admin to reset it if you need to change it.',
        { dobLocked: true },
      );
    }
    const [user] = await db
      .update(schema.users)
      .set({ dateOfBirth, dobLocked: true, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!user) throw errors.internal('Date of birth update returned no row');
    // DOB is an input to getEffectiveRestrictions, so this write can move the
    // account between adult / supervised-minor / unlinked-STRICT. The caller's
    // own tab learns that from the response, but their OTHER connected devices
    // would keep the pre-change gates until a cold start.
    await supervision.notifySupervisionChanged(userId);
    const subs = await import('../services/subscriptions');
    const membership = await subs.getEffectiveSubscription(userId);
    return c.json({ user: toSelfUser(user, membership) });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// PATCH /@me/guild-order
// ───────────────────────────────────────────────────────────────────────────
// Persist the user's preferred guild rail ordering. The body is the
// FULL ordered list of guild ids — partial updates aren't supported
// because the list is small and the client always knows the canonical
// order it wants. Stored in users.guild_order as JSONB.
//
// Validation:
//   - Each id must be a numeric snowflake string (parseable as bigint)
//   - Duplicates are removed (first occurrence wins)
//   - Ids that don't correspond to a current guildMembers row for this
//     user are filtered out — keeps stale orderings clean. The client
//     resends the whole list on every reorder so this self-corrects.
//   - Caps the list at 500 entries; far above any realistic membership
//     count and protects against malicious payloads.
//
// Returns the SANITIZED order so the client can reconcile any
// filter-outs on its side. Missing memberships (guilds the user has
// joined since the client last loaded) are NOT auto-appended here —
// the client appends them in render order.

const setGuildOrderSchema = z.object({
  guildIds: z
    .array(z.string().regex(/^[0-9]+$/, 'guild id must be numeric'))
    .max(500, 'too many guilds in order'),
});

usersRouter.patch(
  '/@me/guild-order',
  requireAuth,
  validate('json', setGuildOrderSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildIds } = c.req.valid('json');

    // Look up the user's actual memberships once. Use a Set of
    // bigint-as-string for O(1) membership tests on the incoming list.
    const memberRows = await db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId));
    const validIds = new Set(memberRows.map((r) => r.guildId.toString()));

    // De-dup + filter to actual memberships, in the user's submitted
    // order. We do NOT validate that the array contains every guild;
    // that's intentional — the client may submit a subset and our read
    // path appends unknown memberships to the tail.
    const seen = new Set<string>();
    const sanitized: string[] = [];
    for (const id of guildIds) {
      if (seen.has(id)) continue;
      if (!validIds.has(id)) continue;
      seen.add(id);
      sanitized.push(id);
    }

    await db
      .update(schema.users)
      .set({ guildOrder: sanitized, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));

    return c.json({ guildOrder: sanitized });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// PATCH /@me/guild-folders
// ───────────────────────────────────────────────────────────────────────────
// Replace the user's full set of rail folders. Folders are stored as
// a single JSONB array on users.guild_folders. The request shape:
//
//   { folders: [{ id, name, color, guildIds }, ...] }
//
// We sanitize:
//   - Folder id format (allow client-generated stable ids; we don't
//     mint server-side because the client needs ids immediately at
//     creation time without a round-trip)
//   - Name length / trim
//   - Color is a 6-digit hex with leading # (e.g. "#5865f2") OR null
//   - guildIds filtered to the user's actual memberships and
//     deduplicated *across the whole folder list* — a guild can
//     belong to at most one folder
//   - Up to 50 folders, 500 guildIds total — generous caps that
//     bound payload size without constraining real use
const FOLDER_ID_RE = /^fldr_[A-Za-z0-9_-]{4,40}$/;
const FOLDER_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const setFoldersSchema = z.object({
  folders: z
    .array(
      z.object({
        id: z.string().regex(FOLDER_ID_RE, 'folder id must match fldr_…'),
        name: z.string().min(1).max(40),
        color: z.string().regex(FOLDER_COLOR_RE).nullable(),
        guildIds: z
          .array(z.string().regex(/^[0-9]+$/, 'guild id must be numeric'))
          .max(500),
      }),
    )
    .max(50, 'too many folders'),
});

usersRouter.patch(
  '/@me/guild-folders',
  requireAuth,
  validate('json', setFoldersSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { folders } = c.req.valid('json');

    // One DB round-trip to learn the user's actual memberships, used
    // to filter out stale guild ids the client may have sent (e.g.
    // a guild the user just left but still appears in a folder).
    const memberRows = await db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId));
    const validIds = new Set(memberRows.map((r) => r.guildId.toString()));

    // First-write-wins across folders: a guild id appearing in two
    // folders gets dropped from the second. Folder names are trimmed
    // and any folder with zero valid guild ids is dropped (an empty
    // folder is a UI footgun — users would see them and wonder why
    // they're there).
    const usedGuildIds = new Set<string>();
    const sanitized: typeof folders = [];
    const seenFolderIds = new Set<string>();
    for (const f of folders) {
      if (seenFolderIds.has(f.id)) continue;
      seenFolderIds.add(f.id);
      const name = f.name.trim();
      if (!name) continue;
      const gids: string[] = [];
      for (const gid of f.guildIds) {
        if (usedGuildIds.has(gid)) continue;
        if (!validIds.has(gid)) continue;
        usedGuildIds.add(gid);
        gids.push(gid);
      }
      // Drop empty folders — see comment above.
      if (gids.length === 0) continue;
      sanitized.push({ id: f.id, name, color: f.color, guildIds: gids });
    }

    await db
      .update(schema.users)
      .set({ guildFolders: sanitized, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));

    return c.json({ folders: sanitized });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// GET /@me/mentions
// ───────────────────────────────────────────────────────────────────────────
// Returns recent messages that @-mention the authenticated user across
// every channel they currently have access to. Used by the inbox UI
// (top-bar bell → mentions panel).
//
// Query:
//   - before?: snowflake — paginate older. When omitted, returns the
//     most recent N mentions.
//   - limit?:  1..50, default 25
//
// Response: `{ mentions: Message[] }` — full hydrated DTOs identical
// to listMessages, so the client can render them with the existing
// MessageItem component without special-casing.

const mentionsListQuery = z.object({
  before: z.string().regex(/^[0-9]+$/, 'before must be a numeric snowflake').optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

usersRouter.get(
  '/@me/mentions',
  requireAuth,
  validate('query', mentionsListQuery),
  async (c) => {
    const userId = requireUserId(c);
    const q = c.req.valid('query');

    const rows = await messages.listUserMentions(userId, {
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit ?? 25,
    });
    if (rows.length === 0) return c.json({ mentions: [] });

    const hydrated = await messages.hydrateMessages(rows, userId);

    // Resolve channel context for each mention so the client can build
    // navigation links without an additional round-trip per row. Bulk
    // fetch via inArray on the distinct channel ids; map back to each
    // message. For DM channels, guildId stays null and the client
    // routes under `@me`.
    const channelIds = Array.from(new Set(rows.map((r) => r.channelId)));
    const channels = await db
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        guildId: schema.channels.guildId,
      })
      .from(schema.channels)
      .where(inArray(schema.channels.id, channelIds));
    const channelMap = new Map(channels.map((c) => [c.id.toString(), c]));

    // Tack guild context onto each message via a separate `context`
    // sibling rather than mutating the DTO shape — keeps Message
    // typing consistent everywhere else in the API.
    const enriched = hydrated.map((m) => {
      const msg = m as { channelId: string };
      const ch = channelMap.get(msg.channelId);
      return {
        ...(m as object),
        guildId: ch?.guildId ? ch.guildId.toString() : null,
        channelName: ch?.name ?? null,
      };
    });

    // Resolve mention tokens in the preview text so the inbox shows readable
    // names, not raw snowflakes. User mentions (<@id> / <@!id>) → "@displayName"
    // (bulk-fetched); role/channel tokens → a clean generic. The real message
    // view (on tap) re-fetches raw content and renders proper chips — this only
    // prettifies the inbox preview, server-side, so web + iOS both benefit.
    const mentionedIds = new Set<string>();
    for (const m of enriched) {
      const content = (m as { content?: string | null }).content ?? '';
      for (const match of content.matchAll(/<@!?(\d+)>/g)) {
        if (match[1]) mentionedIds.add(match[1]);
      }
    }
    const nameById = new Map<string, string>();
    if (mentionedIds.size > 0) {
      const mentionedUsers = await db
        .select({ id: schema.users.id, displayName: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, [...mentionedIds].map((id) => BigInt(id))));
      for (const u of mentionedUsers) nameById.set(u.id.toString(), u.displayName);
    }
    const resolved = enriched.map((m) => {
      const content = (m as { content?: string | null }).content ?? '';
      const pretty = content
        .replace(/<@!?(\d+)>/g, (_full, id: string) => `@${nameById.get(id) ?? 'user'}`)
        .replace(/<@&\d+>/g, '@role')
        .replace(/<#\d+>/g, '#channel');
      return { ...(m as object), content: pretty };
    });

    return c.json({ mentions: resolved });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// POST /@me/mentions/clear
// ───────────────────────────────────────────────────────────────────────────
//
// Bulk-zero every channel's mention_count for the caller. Powers the
// "Clear all mentions" affordance on the Mentions inbox — one tap
// dismisses every pending @-ping without having to visit each
// channel individually.
//
// Returns the affected channel ids so the client can drop their
// badges immediately rather than waiting on the gateway dispatch.
// We also dispatch CHANNEL_ACK to the caller's own connections so
// other tabs / devices stay in sync.
//
// `lastMessageId` is intentionally NOT advanced — that's the
// "where did I leave off reading" marker, which is a separate
// concern from the mention chip. Channels with new non-mention
// messages still show the general unread indicator after this.

usersRouter.post('/@me/mentions/clear', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const { clearAllMentions } = await import('../services/readStates');
  const { toReadState } = await import('../lib/dto');
  const dispatch = await import('../gateway/dispatch');

  const affected = await clearAllMentions(userId);
  for (const row of affected) {
    const dto = toReadState({
      channelId: row.channelId,
      lastMessageId: row.lastMessageId,
      mentionCount: 0,
    });
    dispatch.channelAck({ userId, readState: dto });
  }
  return c.json({ cleared: affected.length });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /@me/mentions/:messageId
// ───────────────────────────────────────────────────────────────────────────
//
// Dismiss ONE mention from the inbox (the single-row counterpart to
// "Clear all"). Removes the (messageId, userId) row from
// message_user_mentions so it no longer appears in the list. The
// per-channel mention_count is left alone (it resets on channel ack) —
// this is an inbox-list dismissal, not a read-receipt. Idempotent.

usersRouter.delete(
  '/@me/mentions/:messageId',
  requireAuth,
  validate('param', z.object({ messageId: z.string().regex(/^\d+$/) })),
  async (c) => {
    const userId = requireUserId(c);
    const { messageId } = c.req.valid('param');
    await messages.deleteUserMention(userId, BigInt(messageId));
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// POST /@me/password
// ───────────────────────────────────────────────────────────────────────────

// Step-up re-verification (rate-limited password/TOTP re-checks on an already-
// authed request) lives in ../auth/stepUp so the passkey routes in auth.ts can
// share the same per-user budget. `consumeStepUp` is imported at the top.

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
  /** Default true — almost always what the user actually wants after a password change. */
  revokeOtherSessions: z.boolean().default(true),
});

usersRouter.post(
  '/@me/password',
  requireAuth,
  validate('json', passwordChangeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const sessionId = requireSessionId(c);
    const body = c.req.valid('json');
    await consumeStepUp(userId);

    const rows = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1);
    const user = rows[0];
    if (!user) throw errors.unauthenticated('Account no longer exists');

    const ok = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!ok) throw errors.invalidCredentials();

    if (body.currentPassword === body.newPassword) {
      throw errors.badRequest('New password must differ from current password');
    }

    const newHash = await hashPassword(body.newPassword);
    await db
      .update(schema.users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));

    if (body.revokeOtherSessions) {
      await revokeAllUserSessions(userId, sessionId);
      // Close any live gateway WebSockets too. Session revocation
      // alone leaves them readable up to the access-token TTL
      // (~15min); for the user changing their password (often
      // *because* they suspect a compromise) we want the other
      // devices to lose access immediately.
      //
      // We close all of this user's connections — including the
      // current one — because the gateway doesn't currently track
      // which auth session a WebSocket belongs to. The user's
      // current frontend will reconnect transparently with its
      // (still-valid) access token; the brief reconnect hiccup is
      // a better trade than leaving stale gateway connections
      // open on the now-revoked sessions.
      //
      // Use dispatch.forceDisconnectUser (not the node-local
      // registry.byUserId loop) so the close reaches sockets held by
      // OTHER replicas via the internal force-disconnect bus, not just
      // this node's connections.
      try {
        const dispatch = await import('../gateway/dispatch');
        dispatch.forceDisconnectUser(userId);
      } catch (err) {
        log.error('change-password: failed to close gateway connections', { err });
      }
    }

    log.info('password changed', { userId: userId.toString() });
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// GET /@me/sessions
// ───────────────────────────────────────────────────────────────────────────

usersRouter.get('/@me/sessions', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const currentSessionId = requireSessionId(c);
  const sessions = await listUserSessions(userId);
  return c.json({
    sessions: sessions.map((s) => toSession(s, currentSessionId)),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /@me/read-states
// ───────────────────────────────────────────────────────────────────────────
//
// Returns the user's full read-state set. The same data ships in the READY
// gateway frame, but a REST endpoint is useful for explicit refreshes and
// for clients that haven't connected the gateway yet.

usersRouter.get('/@me/read-states', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const rows = await readStates.listMy(userId);
  return c.json({ readStates: rows.map(toReadState) });
});

// ───────────────────────────────────────────────────────────────────────────
// My upcoming events (cross-guild)
// ───────────────────────────────────────────────────────────────────────────
//
// Personal-dashboard view: every event the caller has RSVP'd to with
// status going-or-maybe, across all guilds they're currently a member
// of. Filters out canceled / completed events and events where the
// user has since left the guild (RSVPs persist after leave by design,
// but surfacing them would be misleading).
//
// Sorted by start_at ASC. Capped at 50 — events past that mark are
// far enough out that the user can use the per-guild Events modal
// for the deep view.
//
// Backed by the event_rsvps_user_idx for the initial user_id filter,
// joined to scheduled_events on event_id and guild_members on
// (guild_id, user_id) to enforce current membership.
usersRouter.get('/@me/events', requireAuth, async (c) => {
  const userId = requireUserId(c);
  // Pull joined rows: rsvp + event + guild minimal. INNER JOIN with
  // guild_members enforces "current member" without an extra
  // round-trip. ORDER BY on the event's start_at gives chronological
  // order across all guilds the user is in.
  const rows = await db
    .select({
      event: schema.scheduledEvents,
      guildName: schema.guilds.name,
      guildIconUrl: schema.guilds.iconUrl,
      rsvpStatus: schema.eventRsvps.status,
    })
    .from(schema.eventRsvps)
    .innerJoin(
      schema.scheduledEvents,
      eq(schema.scheduledEvents.id, schema.eventRsvps.eventId),
    )
    .innerJoin(
      schema.guilds,
      eq(schema.guilds.id, schema.scheduledEvents.guildId),
    )
    .innerJoin(
      schema.guildMembers,
      and(
        eq(schema.guildMembers.guildId, schema.scheduledEvents.guildId),
        eq(schema.guildMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.eventRsvps.userId, userId),
        inArray(schema.eventRsvps.status, ['going', 'maybe']),
        inArray(schema.scheduledEvents.status, ['scheduled', 'active']),
        isNull(schema.guilds.deletedAt),
      ),
    )
    .orderBy(schema.scheduledEvents.startAt)
    .limit(50);

  if (rows.length === 0) return c.json({ events: [] });

  // Batch-load creators in a single IN-clause query. Aggregates +
  // own-rsvp resolution happen in parallel per event below.
  const events = await import('../services/events');
  const { toScheduledEvent } = await import('../lib/dto');
  const creatorIds = Array.from(
    new Set(
      rows
        .map((r) => r.event.creatorId)
        .filter((id): id is bigint => id !== null),
    ),
  );
  let creatorMap = new Map<bigint, typeof schema.users.$inferSelect>();
  if (creatorIds.length > 0) {
    const creatorRows = await db
      .select()
      .from(schema.users)
      .where(inArray(schema.users.id, creatorIds));
    creatorMap = new Map(creatorRows.map((u) => [u.id, u]));
  }

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const ev = row.event;
      const creator = ev.creatorId ? creatorMap.get(ev.creatorId) ?? null : null;
      // rsvpCounts via the shared service helper; myRsvp comes
      // straight from the JOIN so we don't need a second lookup.
      const rsvpCounts = await events.countRsvpsByStatus(ev.id);
      const dto = toScheduledEvent(ev, creator, {
        rsvpCounts,
        myRsvp: row.rsvpStatus,
      });
      return {
        event: dto,
        guildName: row.guildName,
        guildIconUrl: row.guildIconUrl,
      };
    }),
  );

  return c.json({ events: enriched });
});

// ───────────────────────────────────────────────────────────────────────────
// Two-factor authentication
// ───────────────────────────────────────────────────────────────────────────
//
// Three-step lifecycle:
//   POST /@me/totp/begin    -> { secret, otpauthUri }
//   POST /@me/totp/confirm  body: { code }  -> { recoveryCodes[] }
//   POST /@me/totp/disable  body: { code }  -> { ok: true }
//
// `begin` is idempotent on accounts without 2FA enabled — calling it
// again before `confirm` simply rotates the pending secret. After
// `confirm`, `begin` rejects until `disable` is called first.

usersRouter.post('/@me/totp/begin', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const twoFactor = await import('../services/twoFactor');
  const userRow = await db
    .select({ username: schema.users.username, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!userRow[0]) throw errors.notFound('User');
  const r = await twoFactor.beginEnrollment({
    userId,
    accountName: userRow[0].username || userRow[0].email,
    issuer: 'Zekktris',
  });
  return c.json(r);
});

usersRouter.post(
  '/@me/totp/confirm',
  requireAuth,
  validate(
    'json',
    z.object({
      code: z.string().min(1).max(32),
      // Enrolling 2FA is a login-factor mutation: a transient stolen token
      // could otherwise bind attacker-controlled 2FA and lock the owner out.
      // Re-verify the account password (step-up) before arming it.
      currentPassword: z.string().min(1).max(1024),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { code, currentPassword } = c.req.valid('json');
    await assertStepUpPassword(userId, currentPassword);
    const twoFactor = await import('../services/twoFactor');
    const r = await twoFactor.confirmEnrollment({ userId, code });
    return c.json(r);
  },
);

usersRouter.post(
  '/@me/totp/disable',
  requireAuth,
  validate('json', z.object({ code: z.string().min(1).max(32) })),
  async (c) => {
    const userId = requireUserId(c);
    const { code } = c.req.valid('json');
    await consumeStepUp(userId);
    const twoFactor = await import('../services/twoFactor');
    await twoFactor.disable({ userId, code });
    return c.json({ ok: true });
  },
);

usersRouter.get('/@me/totp', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const twoFactor = await import('../services/twoFactor');
  const userRow = await db
    .select({ enabled: schema.users.totpEnabled, verifiedAt: schema.users.totpVerifiedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!userRow[0]) throw errors.notFound('User');
  const recoveryRemaining = userRow[0].enabled
    ? await twoFactor.remainingRecoveryCodes(userId)
    : 0;
  return c.json({
    enabled: userRow[0].enabled,
    verifiedAt: userRow[0].verifiedAt?.toISOString() ?? null,
    recoveryRemaining,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /@me/sessions  (revoke all *other* sessions)
// ───────────────────────────────────────────────────────────────────────────

usersRouter.delete('/@me/sessions', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const sessionId = requireSessionId(c);
  await revokeAllUserSessions(userId, sessionId);
  // The gateway only re-checks session revocation at IDENTIFY/RESUME, so
  // already-open sockets belonging to now-revoked sessions would keep
  // streaming live events indefinitely. Force-close the user's sockets
  // cluster-wide (matching the ban path); the legit current client
  // reconnects transparently with its still-valid access token.
  const { forceDisconnectUser } = await import('../gateway/dispatch');
  forceDisconnectUser(userId);
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /@me/sessions/:id  (revoke one)
// ───────────────────────────────────────────────────────────────────────────

usersRouter.delete(
  '/@me/sessions/:id',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const targetSessionId = BigInt(c.req.valid('param').id);

    const session = await getSession(targetSessionId);
    if (!session || session.userId !== userId) {
      // 404 to avoid leaking session ids belonging to other users.
      throw errors.notFound('Session');
    }
    await revokeSession(targetSessionId);
    // The gateway never re-checks revocation on the live dispatch path, so the
    // revoked device's open socket would keep streaming events until it drops.
    // Force-close the user's sockets cluster-wide (the connection can't be
    // mapped to a single auth session); only the revoked session fails to
    // re-IDENTIFY, the legit devices reconnect with their still-valid tokens.
    const { forceDisconnectUser } = await import('../gateway/dispatch');
    forceDisconnectUser(userId);
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// GET /:id  (public profile)
// ───────────────────────────────────────────────────────────────────────────
//
// Note: viewers don't have to be authenticated. We still don't expose the
// email or admin flag (see toPublicUser).

usersRouter.get(
  '/:id',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const targetId = BigInt(c.req.valid('param').id);
    const viewerId = requireUserId(c);
    const rows = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)))
      .limit(1);
    const user = rows[0];
    if (!user) throw errors.notFound('User');
    // Whether the viewer is allowed to DM / ring this user under the
    // target's privacy policy (friend, or server-member opt-in + a shared
    // guild). The client uses this to show/hide the Message + Call actions
    // so it never offers contact the server would reject.
    const { canReachByDmOrCall } = await import('../services/relationships');
    const canMessage = await canReachByDmOrCall(viewerId, targetId);
    // Supporter tier title for the profile popup. Hidden when the user opted
    // out (show_subscription_tier=false) and for UNTITLED (founder) rows —
    // grandfathered members carry the perks but no title until they choose a
    // tier. Inherited (family pass-down) titles show like owned ones.
    const subs = await import('../services/subscriptions');
    const showTier = user.showSubscriptionTier || targetId === viewerId;
    const membership = showTier ? await subs.getEffectiveSubscription(targetId) : null;
    return c.json({
      user: {
        ...toPublicUser(user),
        canMessage,
        subscriptionTier: membership && membership.titled ? membership.tier : null,
      },
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Cross-DM message search
// ═══════════════════════════════════════════════════════════════════════════
//
// Searches across every DM/group_dm channel the caller is a recipient
// in — answers "where did I read that thing about X?" without having
// to remember which DM it was in. Guild messages are NOT included
// here: that path stays per-channel because guild visibility is
// per-channel permission-gated and a cross-guild query would have to
// resolve permissions for an unknown set of channels, which defeats
// the FTS index.
//
// Query shape mirrors GET /channels/:cid/messages/search — same q,
// limit, author_id, before, after — so the client can reuse its
// search filter UI between the two surfaces. Returns the same
// hydrated MessageDTO shape too, so search-result rendering is one
// code path.

usersRouter.get(
  '/@me/dms/search',
  requireAuth,
  validate(
    'query',
    z.object({
      q: z.string().max(200).optional().default(''),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      author_id: snowflakeSchema.optional(),
      before: snowflakeSchema.optional(),
      after: snowflakeSchema.optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { q, limit, author_id, before, after } = c.req.valid('query');
    const rows = await messages.searchDirectMessages(userId, q, limit, {
      authorId: author_id ? BigInt(author_id) : undefined,
      before: before ? BigInt(before) : undefined,
      after: after ? BigInt(after) : undefined,
    });
    const hydrated = await messages.hydrateMessages(rows, userId);
    return c.json({ messages: hydrated });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Voice preferences sync
// ═══════════════════════════════════════════════════════════════════════════
//
// The web client stores voice prefs (master/mic gain, processing flags,
// gain mode, per-user mute/volume overrides) in localStorage so they
// survive reloads. These endpoints lift that blob into the user row so
// the same preferences follow them across devices.
//
// We treat the blob as opaque: the API neither validates the structure
// nor knows the field names. The web client's VoicePrefsState type
// owns the schema; the server just persists whatever JSON the client
// sends. This keeps the API stable as the client adds/removes prefs.
//
// Conflict model: last-write-wins per-key on the client side. The
// client merges the server payload into its local state on boot,
// then sends a full-replacement PATCH whenever any pref changes. Two
// devices that change different prefs at the same time can produce
// inconsistent results until the next change re-syncs — acceptable
// for the data class (preferences, not critical state). The 32 KB
// cap on the body keeps a malicious or buggy client from storing
// unbounded blobs.

usersRouter.get('/@me/voice-prefs', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const [row] = await db
    .select({ voicePrefs: schema.users.voicePrefs })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);
  return c.json({ voicePrefs: row?.voicePrefs ?? {} });
});

const voicePrefsSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 32_768, {
    message: 'Voice prefs payload too large (max 32 KB)',
  });

usersRouter.patch(
  '/@me/voice-prefs',
  requireAuth,
  validate('json', z.object({ voicePrefs: voicePrefsSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { voicePrefs } = c.req.valid('json');
    await db
      .update(schema.users)
      .set({ voicePrefs, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    return c.json({ voicePrefs });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Push notifications
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return the server's VAPID public key. Browsers need it to call
 * `pushManager.subscribe()`. No auth required — the public key is, by
 * definition, public.
 */
usersRouter.get('/push/public-key', async (c) => {
  const { getVapidPublicKey, isPushConfigured } = await import('../services/push');
  if (!isPushConfigured()) {
    return c.json({ key: null, enabled: false });
  }
  return c.json({ key: getVapidPublicKey(), enabled: true });
});

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  /** Optional, user-set device label; surfaces in the manage-devices list. */
  label: z.string().max(120).optional(),
});

/**
 * Register a push subscription for the current user. Idempotent — same
 * endpoint upserts the row so a browser refresh that re-subscribes
 * doesn't create duplicates. Returns 503 if push isn't configured.
 */
usersRouter.post(
  '/@me/push-subscriptions',
  requireAuth,
  validate('json', subscribeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { isPushConfigured, upsertSubscription } = await import('../services/push');
    if (!isPushConfigured()) {
      throw errors.serviceUnavailable('Push notifications are not configured on this server');
    }
    const body = c.req.valid('json');
    const sub = await upsertSubscription({
      userId,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      label: body.label,
    });
    return c.json({
      subscription: {
        id: sub.id.toString(),
        label: sub.label,
        createdAt: sub.createdAt.toISOString(),
      },
    });
  },
);

/**
 * List the current user's push subscriptions. Returns shape suitable
 * for a "your devices" list — never returns the auth secret or p256dh
 * key (those are sensitive material the client doesn't need to see).
 */
usersRouter.get('/@me/push-subscriptions', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const { listSubscriptions } = await import('../services/push');
  const list = await listSubscriptions(userId);
  return c.json({
    subscriptions: list.map((s) => ({
      id: s.id.toString(),
      label: s.label,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
    })),
  });
});

/**
 * Revoke a specific push subscription by its row id. Used by the
 * settings UI's per-device "remove" button. Returns 404 if the row
 * doesn't belong to the caller — same pattern as session revocation,
 * to avoid disclosing existence of other users' subscription ids.
 */
usersRouter.delete(
  '/@me/push-subscriptions/:id',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const id = BigInt(c.req.valid('param').id);
    const { listSubscriptions, deleteSubscription } = await import('../services/push');
    const list = await listSubscriptions(userId);
    if (!list.some((s) => s.id === id)) {
      throw errors.notFound('Subscription');
    }
    await deleteSubscription(userId, id);
    return c.json({ ok: true });
  },
);

// ── Native iOS push (APNs device tokens) ────────────────────────────────────

const deviceTokenSchema = z.object({
  /** APNs device token (iOS) or FCM registration token (Android) from the
      native push-registration event. */
  token: z.string().min(1).max(512),
  platform: z.enum(['ios', 'ios_voip', 'android']).default('ios'),
  /** Optional device label for the manage-devices list. */
  label: z.string().max(120).optional(),
});

/**
 * Register (upsert) a native push token for the current user's device — an
 * APNs token (platform 'ios'/'ios_voip') or an FCM token (platform 'android').
 * Idempotent on token. Returns 503 if the matching transport isn't configured
 * server-side so the client can fail quietly rather than retry forever.
 */
usersRouter.post(
  '/@me/device-tokens',
  requireAuth,
  validate('json', deviceTokenSchema),
  async (c) => {
    const userId = requireUserId(c);
    const body = c.req.valid('json');

    // Guard against a token filed under the wrong transport. `platform`
    // defaults to 'ios' when absent, which is convenient until a client omits
    // it BY ACCIDENT — the Android client did for months, because
    // kotlinx.serialization drops a property equal to its default even when
    // the call site sets it explicitly. Every FCM token was then stored as an
    // APNs one: it never matched listAndroidTokens so no Android push could be
    // sent at all, and APNs kept 400ing it and pruning the row. A silent 2xx
    // the whole time.
    //
    // The two token formats are unmistakable. An APNs device token is 64 hex
    // characters; an FCM registration token is far longer and always contains
    // a ':' separating the instance id. So a mismatch is detectable here, and
    // failing loudly beats storing a row that can never work.
    const looksLikeFcm = body.token.includes(':');
    if (body.platform !== 'android' && looksLikeFcm) {
      throw errors.badRequest(
        `token looks like an FCM registration token but platform is '${body.platform}' — ` +
          "send platform:'android' for Android devices",
      );
    }
    if (body.platform === 'android' && !looksLikeFcm) {
      throw errors.badRequest(
        "token does not look like an FCM registration token but platform is 'android'",
      );
    }

    const { upsertDeviceToken } = await import('../services/apns');
    if (body.platform === 'android') {
      const { initFcm } = await import('../services/fcm');
      if (!(await initFcm())) {
        throw errors.serviceUnavailable(
          'Android push notifications are not configured on this server',
        );
      }
    } else {
      // Best-effort config probe, NOT a gate: storing the row needs no APNs
      // config, and 503ing here silently discarded the client's fire-and-
      // forget (re)registration during a transient key-load hiccup — for
      // 'ios_voip' that left the account with ZERO voip rows, so incoming
      // calls stopped ringing CallKit until a luckier foreground. Sends
      // already no-op safely when APNs is unconfigured.
      const { initApns } = await import('../services/apns');
      if (!(await initApns())) {
        // eslint-disable-next-line no-console
        console.warn(
          `APNs not configured/loadable at ${body.platform} token registration — storing anyway`,
        );
      }
    }
    const row = await upsertDeviceToken({
      userId,
      token: body.token,
      platform: body.platform,
      label: body.label,
    });
    return c.json({
      deviceToken: {
        id: row.id.toString(),
        platform: row.platform,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
      },
    });
  },
);

/**
 * Unregister an APNs device token (e.g. on logout). Idempotent — deleting a
 * token that doesn't exist is a no-op success. Token is passed in the path,
 * matching the push-subscription delete style.
 */
usersRouter.delete(
  '/@me/device-tokens/:token',
  requireAuth,
  validate('param', z.object({ token: z.string().min(1).max(256) })),
  async (c) => {
    const userId = requireUserId(c);
    const { deleteDeviceTokenValue } = await import('../services/apns');
    await deleteDeviceTokenValue(c.req.valid('param').token, userId);
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Relationships (friends, requests, blocks)
// ═══════════════════════════════════════════════════════════════════════════

const targetSchema = z.object({ targetId: snowflakeSchema });

// Friend request accepts EITHER a user id (when initiated from a profile
// card / member list, where we already know the id) OR a username (when
// typed into the "Add friend" box in the Friends view). At least one must
// be present; targetId wins if both are sent.
const friendRequestSchema = z
  .object({
    targetId: snowflakeSchema.optional(),
    username: z.string().trim().min(1).max(64).optional(),
  })
  .refine((d) => d.targetId !== undefined || d.username !== undefined, {
    message: 'Provide a user id or username',
  });

/**
 * List every relationship the current user has — friends, pending
 * requests (in both directions), and blocked users. Single endpoint
 * because the client renders all of them in one settings panel and
 * making a separate call per category just churns round-trips.
 */
usersRouter.get('/@me/relationships', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const { listRelationships } = await import('../services/relationships');
  const rows = await listRelationships(userId);
  return c.json({
    relationships: rows.map((r) => ({
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      user: {
        id: r.target.id.toString(),
        username: r.target.username,
        displayName: r.target.displayName,
        avatarUrl: r.target.avatarUrl,
        // 'invisible' is a private setting — it reads as plain 'offline' to
        // everyone else (same mask toPublicUser and every presence broadcast
        // apply). Emitting it raw here handed any friend the one bit that
        // Invisible exists to hide: "offline in the UI, but actually
        // connected right now."
        status: r.target.status === 'invisible' ? 'offline' : r.target.status,
        customStatus: r.target.status === 'invisible' ? null : r.target.customStatus,
        // "Last online" — FRIENDS ONLY. Someone with a pending request in
        // either direction, or someone you've blocked, has no presence
        // relationship with you and gets null. (Invisible needs no extra
        // mask here: the column stops advancing the moment its owner goes
        // invisible, so it already reads as their last visible moment.)
        lastSeenAt:
          r.type === 'friend' && r.target.lastSeenAt
            ? r.target.lastSeenAt.toISOString()
            : null,
      },
    })),
  });
});

/**
 * Personal DM nicknames — a viewer-private label for another user, shown in
 * place of their name in DIRECT MESSAGES only (Discord-style friend nicknames).
 * One-directional: only the setter sees it, and it's independent of any DM
 * channel. The client fetches the full map once at login (like relationships)
 * and applies it wherever a DM peer renders.
 */
usersRouter.get('/@me/dm-nicknames', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const dms = await import('../services/dms');
  const nicknames = await dms.getNicknameMap(userId);
  return c.json({ nicknames });
});

usersRouter.put(
  '/@me/dm-nicknames/:targetId',
  requireAuth,
  validate('param', z.object({ targetId: snowflakeSchema })),
  validate('json', z.object({ nickname: nicknameSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const targetId = BigInt(c.req.valid('param').targetId);
    if (targetId === userId) throw errors.badRequest('You can’t nickname yourself.');
    const nickname = c.req.valid('json').nickname.trim();
    if (!nickname) throw errors.badRequest('Enter a nickname, or remove it to clear.');
    // Identity gate: a nickname stands in for a name, so hold it to the same
    // profanity bar as guild nicknames / display names.
    if (await containsListedWord(nickname)) {
      throw errors.badRequest('That nickname contains a word that isn’t allowed.');
    }
    const dms = await import('../services/dms');
    await dms.setNickname(userId, targetId, nickname);
    return c.json({ nickname });
  },
);

usersRouter.delete(
  '/@me/dm-nicknames/:targetId',
  requireAuth,
  validate('param', z.object({ targetId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const targetId = BigInt(c.req.valid('param').targetId);
    const dms = await import('../services/dms');
    await dms.clearNickname(userId, targetId);
    return c.json({ ok: true });
  },
);

/**
 * Send a friend request. Idempotent — repeating with an already-pending
 * request returns the existing row. If the target already has an
 * incoming request from the actor, this counts as accepting that
 * request and flips both rows to friend.
 */
const friendRequestRl = new RateLimiter(30, 10 * 60_000, 'friend-request');

usersRouter.post(
  '/@me/relationships/friends',
  requireAuth,
  validate('json', friendRequestSchema),
  async (c) => {
    const userId = requireUserId(c);
    // Per-user rate limit. Without this a single user can spam-send
    // friend requests to hundreds of strangers; each target's
    // incoming-request inbox swells and we churn relationship
    // rows. 30 / 10min is far above legitimate use (you don't
    // friend 30 people in 10 minutes) but shuts down the abuse
    // pattern. Keyed by userId — IP would over-block users sharing
    // a NAT.
    const rl = await friendRequestRl.consume(userId.toString());
    if (!rl.ok) {
      throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    }
    const body = c.req.valid('json');

    // Resolve the target. A typed username is matched case-insensitively
    // against live (non-deleted) accounts. We deliberately return the
    // same "not found" for a missing user as for a deleted one so the
    // endpoint can't be used to probe which usernames exist vs. were
    // deleted.
    let targetId: bigint;
    if (body.targetId !== undefined) {
      targetId = BigInt(body.targetId);
    } else {
      const uname = body.username!.replace(/^@/, '').trim();
      const [found] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            sql`lower(${schema.users.username}) = ${uname.toLowerCase()}`,
            isNull(schema.users.deletedAt),
          ),
        )
        .limit(1);
      if (!found) throw errors.notFound('No user with that username');
      targetId = found.id;
    }

    // Can't friend yourself.
    if (targetId === userId) {
      throw errors.badRequest("You can't add yourself");
    }
    // Parental controls: a supervised child barred from adding friends
    // gets a structured error the client turns into "ask your parent".
    const restr = await supervision.getEffectiveRestrictions(userId);
    if (restr && !restr.canAddFriends) {
      throw new AppError('FORBIDDEN', 'Adding friends is restricted by your parent', {
        supervisionRestricted: 'friend',
        targetUserId: String(targetId),
      });
    }
    const { sendFriendRequest } = await import('../services/relationships');
    const newType = await sendFriendRequest(userId, targetId);

    // Best-effort push notification to the target. Only fires for
    // fresh requests — when the call resulted in a direct friendship
    // (because the target had ALREADY sent us a request, and this
    // call auto-accepted it), no notification: both parties already
    // know each other intended this.
    if (newType === 'outgoing_request') {
      void (async () => {
        try {
          const sender = await db
            .select({ displayName: schema.users.displayName, username: schema.users.username })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);
          const senderName =
            sender[0]?.displayName ?? sender[0]?.username ?? 'Someone';
          const { sendToUser } = await import('../services/push');
          await sendToUser(targetId, {
            title: senderName,
            body: 'Sent you a friend request',
            url: '/friends',
            // Tag keyed by sender id so a re-request after a cancel
            // replaces the previous notification instead of stacking
            // two rings for the same person.
            tag: `friend-request-${userId.toString()}`,
            icon: '/icon-192.png',
          });
        } catch {
          // Push is non-critical — never block the REST response on
          // it.
        }
      })();
    }

    return c.json({ type: newType });
  },
);

/**
 * Accept an incoming friend request from `:targetId`. 404 if no such
 * incoming request exists.
 */
usersRouter.put(
  '/@me/relationships/friends/:targetId/accept',
  requireAuth,
  validate('param', targetSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { targetId } = c.req.valid('param');
    const { acceptFriendRequest } = await import('../services/relationships');
    await acceptFriendRequest(userId, BigInt(targetId));
    return c.json({ ok: true });
  },
);

/**
 * Remove a friend, decline an incoming request, or cancel an outgoing
 * one. Single DELETE because the action is "I don't want this
 * relationship" and the underlying row type doesn't change what we do.
 */
usersRouter.delete(
  '/@me/relationships/friends/:targetId',
  requireAuth,
  validate('param', targetSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { targetId } = c.req.valid('param');
    // Parental controls: removing friends can be restricted too. No
    // request flow here — removal isn't something a parent pre-approves;
    // the child just can't do it while restricted.
    const restr = await supervision.getEffectiveRestrictions(userId);
    if (restr && !restr.canRemoveFriends) {
      throw new AppError('FORBIDDEN', 'Removing friends is restricted by your parent', {
        supervisionRestricted: 'friend_remove',
      });
    }
    const { removeFriendOrRequest } = await import('../services/relationships');
    await removeFriendOrRequest(userId, BigInt(targetId));
    return c.json({ ok: true });
  },
);

/**
 * Block a user. Wipes any prior friendship/request state and inserts
 * a 'blocked' row.
 */
usersRouter.post(
  '/@me/relationships/blocks',
  requireAuth,
  validate('json', targetSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { targetId } = c.req.valid('json');
    const { blockUser } = await import('../services/relationships');
    await blockUser(userId, BigInt(targetId));
    return c.json({ ok: true });
  },
);

/**
 * Unblock a user. Removes the 'blocked' row only — if the parties
 * want to reconnect, the unblocker (or the unblocked) needs to send
 * a fresh friend request.
 */
usersRouter.delete(
  '/@me/relationships/blocks/:targetId',
  requireAuth,
  validate('param', targetSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { targetId } = c.req.valid('param');
    const { unblockUser } = await import('../services/relationships');
    await unblockUser(userId, BigInt(targetId));
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Notification overrides (mute / level per guild or channel)
// ═══════════════════════════════════════════════════════════════════════════

const notificationLevelSchema = z.enum(['all', 'mentions', 'nothing']);
const notificationTargetSchema = z.enum(['guild', 'channel']);

/**
 * GET — return every override the user has set. Client hydrates this
 * on connect so badge counts respect mutes from the first render.
 */
usersRouter.get('/@me/notification-settings', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const { listOverrides } = await import('../services/notifications');
  const overrides = await listOverrides(userId);
  return c.json({ overrides });
});

/**
 * PUT — upsert an override. Body level=null deletes (returns to default).
 */
const setOverrideSchema = z.object({
  targetType: notificationTargetSchema,
  targetId: snowflakeSchema,
  level: notificationLevelSchema.nullable(),
});

usersRouter.put(
  '/@me/notification-settings',
  requireAuth,
  validate('json', setOverrideSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { targetType, targetId, level } = c.req.valid('json');
    const { setOverride } = await import('../services/notifications');
    await setOverride(userId, targetType, BigInt(targetId), level);
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /@me/avatar  (multipart file upload → set user.avatarUrl)
// ═══════════════════════════════════════════════════════════════════════════
//
// Wraps the existing uploads service so the single multipart request
// both stores the file AND updates the user row in one round-trip.
// Validates the content type to images only — there's no use case for
// non-image avatars and accepting other types would let users abuse
// the avatar endpoint as a generic file host bypassing channel
// permissions.

const AVATAR_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

// Per-route caps for avatar/banner uploads, INDEPENDENT of the (much larger)
// generic MAX_UPLOAD_SIZE_MB. The clients already downscale + size-check before
// upload, but the server is the trust boundary — a direct API call bypasses the
// browser, so re-enforce here (also a decompression-bomb / storage-abuse guard).
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_MAX_DIM = 4096; // px per side; a raw phone photo fits, absurd/bomb images don't
const BANNER_MAX_BYTES = 8 * 1024 * 1024;
const BANNER_MAX_DIM = 8000; // banners can be wide

/**
 * Reject an avatar/banner upload that exceeds the byte cap, or — best-effort
 * via sharp — the pixel-dimension cap. sharp.metadata() parses only the header
 * (no full pixel decode) so a malformed/outsized image can't bomb us here; if
 * sharp isn't installed the byte cap still applies.
 */
async function assertImageUploadWithinLimits(
  file: File,
  opts: { maxBytes: number; maxDim: number; label: string },
): Promise<void> {
  if (file.size > opts.maxBytes) {
    throw errors.badRequest(
      `${opts.label} is too large (max ${Math.round(opts.maxBytes / (1024 * 1024))} MB)`,
    );
  }
  const { loadSharp } = await import('../services/imageCompression');
  const sharp = await loadSharp();
  if (!sharp) return;
  let dims: { w: number; h: number } | null = null;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(buf, { limitInputPixels: false }).metadata();
    dims = { w: meta.width ?? 0, h: meta.height ?? 0 };
  } catch {
    dims = null; // unreadable header — skip the dimension check
  }
  if (dims && (dims.w > opts.maxDim || dims.h > opts.maxDim)) {
    throw errors.badRequest(
      `${opts.label} dimensions are too large (max ${opts.maxDim}px per side; got ${dims.w}×${dims.h})`,
    );
  }
}

usersRouter.post('/@me/avatar', requireAuth, async (c) => {
  const userId = requireUserId(c);

  // Hono's req.parseBody handles multipart for us. We expect a single
  // 'file' part containing the image. Reject anything else.
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) {
    throw errors.badRequest('Missing file (expected multipart field "file")');
  }
  if (!AVATAR_CONTENT_TYPES.has(file.type)) {
    throw errors.badRequest('Avatar must be a PNG, JPEG, GIF, or WebP image');
  }
  await assertImageUploadWithinLimits(file, {
    maxBytes: AVATAR_MAX_BYTES,
    maxDim: AVATAR_MAX_DIM,
    label: 'Avatar',
  });

  const { saveUploadedFile, deleteAttachmentFile, parseCdnAttachmentId } =
    await import('../services/uploads');

  // Save the new file to disk BEFORE entering the transaction —
  // disk IO is slow and we don't want to hold the row lock for
  // the duration. The transaction below just swaps the URL.
  const saved = await saveUploadedFile(file, { uploaderId: userId });

  // Atomic swap. SELECT FOR UPDATE serializes concurrent uploads
  // on the same user row — without this, two parallel uploads
  // could both read the same priorAvatarUrl, both UPDATE
  // (last-write-wins), and the loser's file would orphan on disk
  // (DB row points at winner's file; no row references loser's
  // file; loser's file persists forever). With the lock, the
  // second transaction's "prior" reflects the FIRST transaction's
  // committed URL, so it correctly identifies and deletes that
  // file when its own UPDATE makes it stale.
  const { updated, priorAvatarId } = await db.transaction(async (tx) => {
    const [prior] = await tx
      .select({ avatarUrl: schema.users.avatarUrl })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
      .limit(1);
    if (!prior) throw errors.notFound('User');
    const [u] = await tx
      .update(schema.users)
      .set({ avatarUrl: saved.url, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .returning();
    if (!u) throw errors.notFound('User');
    return { updated: u, priorAvatarId: parseCdnAttachmentId(prior.avatarUrl) };
  });

  // Best-effort: delete the previous avatar's on-disk file now that
  // the row points at the new one. Skip if the previous URL was
  // null or didn't match the /cdn/<id>/... shape (e.g. an external
  // gravatar URL set via an admin SQL fix-up), and skip if
  // somehow the new save reused the same id (shouldn't happen —
  // snowflakes are monotonic — but be defensive).
  if (priorAvatarId !== null && priorAvatarId !== saved.attachmentId) {
    void deleteAttachmentFile(priorAvatarId);
  }

  // Broadcast USER_UPDATE so connected clients (other tabs, other
  // users in shared guilds, plus DM-only friends with no shared
  // guild) see the new avatar live, without waiting for the next
  // message this user sends to refresh their cached author payload.
  // Three concurrent reads: guild membership, DM peer set, neither
  // depending on the other.
  const { listDmPeers } = await import('../services/dms');
  const [memberRows, dmPeerIds] = await Promise.all([
    db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId)),
    listDmPeers(userId),
  ]);
  const { userUpdate } = await import('../gateway/dispatch');
  userUpdate({
    userId,
    user: {
      id: updated.id.toString(),
      username: updated.username,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      bio: updated.bio,
      customStatus: updated.customStatus,
      // Mask invisible→offline for the wire format. Same rule the
      // PATCH /@me path uses; consistent across both emission points.
      status:
        updated.status === 'invisible'
          ? 'offline'
          : (updated.status as 'online' | 'idle' | 'dnd' | 'offline'),
    },
    guildIds: memberRows.map((r) => r.guildId),
    userIds: dmPeerIds,
  });

  return c.json({ user: toSelfUser(updated) });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /@me/banner  (multipart file upload → set user.bannerUrl)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirror of the avatar path. Banners share the same content-type
// allow-list and the same uploads service, but write to a different
// column. We keep the broadcast on USER_UPDATE so clients pick up the
// new banner without an explicit refetch — same fan-out logic.

usersRouter.post('/@me/banner', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) {
    throw errors.badRequest('Missing file (expected multipart field "file")');
  }
  if (!AVATAR_CONTENT_TYPES.has(file.type)) {
    throw errors.badRequest('Banner must be a PNG, JPEG, GIF, or WebP image');
  }
  await assertImageUploadWithinLimits(file, {
    maxBytes: BANNER_MAX_BYTES,
    maxDim: BANNER_MAX_DIM,
    label: 'Banner',
  });

  const { saveUploadedFile, deleteAttachmentFile, parseCdnAttachmentId } =
    await import('../services/uploads');

  // Save outside the transaction (slow IO), then atomic swap with
  // SELECT FOR UPDATE — same pattern as the avatar path. Without
  // this, two concurrent banner uploads on the same user can both
  // capture the same priorBannerId, both UPDATE, and the loser's
  // file orphans on disk.
  const saved = await saveUploadedFile(file, { uploaderId: userId });

  const { updated, priorBannerId } = await db.transaction(async (tx) => {
    const [prior] = await tx
      .select({ bannerUrl: schema.users.bannerUrl })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
      .limit(1);
    if (!prior) throw errors.notFound('User');
    const [u] = await tx
      .update(schema.users)
      .set({ bannerUrl: saved.url, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .returning();
    if (!u) throw errors.notFound('User');
    return { updated: u, priorBannerId: parseCdnAttachmentId(prior.bannerUrl) };
  });

  if (priorBannerId !== null && priorBannerId !== saved.attachmentId) {
    void deleteAttachmentFile(priorBannerId);
  }

  const { listDmPeers } = await import('../services/dms');
  const [memberRows, dmPeerIds] = await Promise.all([
    db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId)),
    listDmPeers(userId),
  ]);
  const { userUpdate } = await import('../gateway/dispatch');
  userUpdate({
    userId,
    user: {
      id: updated.id.toString(),
      username: updated.username,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      bio: updated.bio,
      customStatus: updated.customStatus,
      status:
        updated.status === 'invisible'
          ? 'offline'
          : (updated.status as 'online' | 'idle' | 'dnd' | 'offline'),
    },
    guildIds: memberRows.map((r) => r.guildId),
    userIds: dmPeerIds,
  });

  return c.json({ user: toSelfUser(updated) });
});


// ── Saved-message bookmarks ─────────────────────────────────────────────
//
// Per-user message bookmarks. The save state is private — only the
// owner of the save sees it. Both write endpoints are idempotent
// (saving an already-saved message succeeds without error; unsaving
// an unsaved message succeeds without error) so the client can fire
// these freely from an optimistic toggle.

const savedParam = z.object({ messageId: z.string().regex(/^\d+$/) });

usersRouter.post(
  "/@me/saved/:messageId",
  requireAuth,
  validate("param", savedParam),
  async (c) => {
    const userId = requireUserId(c);
    const { messageId } = c.req.valid("param");
    const savedSvc = await import("../services/savedMessages");
    await savedSvc.saveMessage(userId, BigInt(messageId));
    return c.json({ ok: true });
  },
);

usersRouter.delete(
  "/@me/saved/:messageId",
  requireAuth,
  validate("param", savedParam),
  async (c) => {
    const userId = requireUserId(c);
    const { messageId } = c.req.valid("param");
    const savedSvc = await import("../services/savedMessages");
    await savedSvc.unsaveMessage(userId, BigInt(messageId));
    return c.json({ ok: true });
  },
);

// Cursor is `<iso-savedAt>_<messageId>` (composite keyset); a bare ISO
// datetime (older clients) is still accepted and parses as a
// timestamp-only boundary.
const savedListQuery = z.object({
  cursor: z
    .string()
    .max(80)
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined) return;
      const [iso, mid] = v.split("_");
      if (Number.isNaN(new Date(iso!).getTime()) || (mid !== undefined && !/^\d{1,20}$/.test(mid))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cursor" });
      }
    }),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

usersRouter.get(
  "/@me/saved",
  requireAuth,
  validate("query", savedListQuery),
  async (c) => {
    const userId = requireUserId(c);
    const { cursor, limit } = c.req.valid("query");
    const savedSvc = await import("../services/savedMessages");
    const messagesSvc = await import("../services/messages");
    let before: { savedAt: Date; messageId: bigint } | undefined;
    if (cursor) {
      const [iso, mid] = cursor.split("_");
      // Bare-ISO (legacy) cursors get messageId 0 — the composite
      // boundary then degenerates to the old strict savedAt < cursor.
      before = { savedAt: new Date(iso!), messageId: mid ? BigInt(mid) : 0n };
    }
    const { items, nextCursor } = await savedSvc.listSavedMessages(userId, {
      before,
      limit,
    });

    // Hydrate each message with author + attachments + reactions
    // so the SavedView can render full message cards without
    // refetching one-by-one.
    const messageRows = items.map((it) => it.message);
    const hydratedList = await messagesSvc.hydrateMessages(messageRows, userId);
    // Build an id→hydrated lookup so we can re-zip the saved entries
    // with their hydrated messages in original (saved-at desc) order.
    const hydratedById = new Map<string, unknown>();
    for (const m of hydratedList) {
      const idVal = (m as { id?: string })?.id;
      if (typeof idVal === "string") hydratedById.set(idVal, m);
    }

    return c.json({
      items: items
        .map((it) => ({
          savedAt: it.savedAt.toISOString(),
          message: hydratedById.get(it.message.id.toString()) ?? null,
          channel: it.channel
            ? {
                id: it.channel.id.toString(),
                type: it.channel.type,
                name: it.channel.name,
                guildId: it.channel.guildId
                  ? it.channel.guildId.toString()
                  : null,
              }
            : null,
        }))
        .filter((it) => it.message !== null),
      nextCursor,
    });
  },
);

// Lightweight membership-check endpoint. Returns the subset of the
// provided message ids that the caller has saved. Used to mark
// already-saved messages on initial channel load without firing
// one HEAD-style request per message.
const savedMembershipQuery = z.object({
  ids: z.string().min(1).max(2000), // comma-separated snowflakes
});

usersRouter.get(
  "/@me/saved/members",
  requireAuth,
  validate("query", savedMembershipQuery),
  async (c) => {
    const userId = requireUserId(c);
    const { ids } = c.req.valid("query");
    const messageIds = ids
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => BigInt(s));
    if (messageIds.length === 0) return c.json({ savedIds: [] });
    const savedSvc = await import("../services/savedMessages");
    const set = await savedSvc.listSavedAmong(userId, messageIds);
    return c.json({
      savedIds: Array.from(set).map((id) => id.toString()),
    });
  },
);


// ── Scheduled messages ──────────────────────────────────────────────────
//
// User-facing CRUD for the scheduled-send queue. Sending channel-side
// (POST a new scheduled row) goes through the channels router; this
// router handles "list mine" + "cancel one of mine" since they're
// user-scoped not channel-scoped.

usersRouter.get('/@me/scheduled-messages', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const scheduledSvc = await import('../services/scheduledMessages');
  const rows = await scheduledSvc.listForUser(userId);
  // Lightweight DTO — full message hydration would require resolving
  // channel + author on every row, which is overkill for the list
  // view. The client already has the channel cache; it can render
  // contextual labels from there.
  return c.json({
    items: rows.map((r) => ({
      id: r.id.toString(),
      channelId: r.channelId.toString(),
      content: r.content,
      attachments: r.attachmentsJson,
      replyToMessageId: r.replyToMessageId?.toString() ?? null,
      scheduledFor: r.scheduledFor.toISOString(),
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

usersRouter.delete(
  '/@me/scheduled-messages/:id',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  async (c) => {
    const userId = requireUserId(c);
    const { id } = c.req.valid('param');
    const scheduledSvc = await import('../services/scheduledMessages');
    await scheduledSvc.cancelScheduled(BigInt(id), userId);
    return c.json({ ok: true });
  },
);

// ── Username + email changes ────────────────────────────────────────────
//
// Both require the user's current password to re-confirm identity
// (re-prompts protect against chair-jacking — someone walking up to
// an unlocked laptop and changing the account away from the owner).
//
// Username change has a 90-day cooldown enforced by the service.
//
// Email change is a two-step flow: the request endpoint here mails a
// verification link to the NEW address; clicking that link hits the
// public confirm endpoint on the auth router (so it works without
// being logged in, in case the user is changing email on a device
// they aren't currently signed into).

const changeUsernameBody = z.object({
  username: usernameSchema,
  currentPassword: z.string().min(1).max(200),
});

usersRouter.patch(
  '/@me/username',
  requireAuth,
  validate('json', changeUsernameBody),
  async (c) => {
    const userId = requireUserId(c);
    const body = c.req.valid('json');
    await consumeStepUp(userId);
    const accountSvc = await import('../services/accountChanges');
    let result;
    try {
      result = await accountSvc.changeUsername({
        userId,
        currentPassword: body.currentPassword,
        newUsername: body.username,
      });
    } catch (e) {
      // Trap the unique-violation on users.username and surface
      // a friendly error. The 23505 SQLSTATE is "unique_violation".
      const pgErr = e as { code?: string };
      if (pgErr?.code === '23505') {
        throw errors.badRequest('That username is taken.');
      }
      throw e;
    }

    // Fan out USER_UPDATE so other clients (the user's other tabs,
    // members they share servers/DMs with) see the new username
    // without a refresh.
    const { userUpdate } = await import('../gateway/dispatch');
    const memberRows = await db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId));
    const dmPeerIds = await (async () => {
      const dms = await import('../services/dms');
      return dms.listDmPeers(userId);
    })();
    userUpdate({
      userId,
      user: {
        id: result.user.id.toString(),
        username: result.user.username,
        displayName: result.user.displayName,
        avatarUrl: result.user.avatarUrl,
        bio: result.user.bio,
        customStatus: result.user.customStatus,
        status:
          result.user.status === 'invisible'
            ? 'offline'
            : (result.user.status as 'online' | 'idle' | 'dnd' | 'offline'),
      },
      guildIds: memberRows.map((r) => r.guildId),
      userIds: dmPeerIds,
    });

    return c.json({ user: toSelfUser(result.user) });
  },
);

/**
 * GET /@me/username-change-eligibility — UI uses this to render
 * "you can change again in N days" without firing a PATCH.
 */
usersRouter.get('/@me/username-change-eligibility', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const [user] = await db
    .select({ usernameChangedAt: schema.users.usernameChangedAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw errors.notFound('User not found');
  const accountSvc = await import('../services/accountChanges');
  const remainingMs = accountSvc.usernameCooldownRemainingMs(
    user.usernameChangedAt,
  );
  return c.json({
    eligible: remainingMs === 0,
    remainingMs,
    nextEligibleAt:
      remainingMs > 0
        ? new Date(Date.now() + remainingMs).toISOString()
        : null,
  });
});

const requestEmailChangeBody = z.object({
  newEmail: emailSchema,
  currentPassword: z.string().min(1).max(200),
});

usersRouter.post(
  '/@me/email/change-request',
  requireAuth,
  validate('json', requestEmailChangeBody),
  async (c) => {
    const userId = requireUserId(c);
    const body = c.req.valid('json');
    await consumeStepUp(userId);

    const accountSvc = await import('../services/accountChanges');
    const emailSvc = await import('../services/email');

    if (!emailSvc.isEmailConfigured()) {
      throw errors.serviceUnavailable(
        'This server hasn\'t enabled email sending — email change is unavailable.',
      );
    }

    const { token, expiresInMinutes, newEmail } = await accountSvc.requestEmailChange({
      userId,
      currentPassword: body.currentPassword,
      newEmail: body.newEmail,
    });

    // token === null → the target email is already registered. Anti-enumeration:
    // respond identically to the success case and send nothing. Only send when
    // we actually have a token.
    if (token) {
      // Build the verification URL. PUBLIC_URL is the user-visible base for the
      // web app; appending /confirm-email?token=... is the convention the web
      // client handles on mount.
      const publicUrl = process.env.PUBLIC_URL ?? '';
      const confirmUrl = `${publicUrl.replace(/\/$/, '')}/confirm-email?token=${encodeURIComponent(token)}`;
      try {
        await emailSvc.sendEmailChangeVerification({
          to: newEmail,
          confirmUrl,
          expiresInMinutes,
        });
      } catch (err) {
        // Don't leak SMTP errors to the user — generic message keeps the
        // security posture clean (an attacker probing the endpoint for whether
        // an email exists shouldn't be able to detect SMTP failures either).
        throw errors.internal('Could not send verification email.');
      }
    }

    return c.json({ ok: true, expiresInMinutes });
  },
);

// ── Bots ────────────────────────────────────────────────────────────────
//
// Bot management for the authenticated human owner. Bots are real
// user rows (is_bot=true) that authenticate with a static token via
// `Authorization: Bot <token>`. The token is returned ONCE at create
// + regenerate; only its hash is stored.
//
//   POST   /@me/bots                  create a bot → { bot, token }
//   GET    /@me/bots                  list bots I own → { bots[] }
//   POST   /@me/bots/:id/token        regenerate token → { token }
//   PATCH  /@me/bots/:id              update bot profile → { bot }
//   DELETE /@me/bots/:id              delete bot

const createBotBody = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
});

// Bot DTO — like a public user, plus owner id. NEVER includes the
// token hash. The plaintext token is returned separately, only on
// create/regenerate.
function toBotDTO(bot: typeof schema.users.$inferSelect) {
  return {
    ...toPublicUser(bot),
    botOwnerId: bot.botOwnerId?.toString() ?? null,
    botEventUrl: bot.botEventUrl ?? null,
  };
}

usersRouter.post(
  '/@me/bots',
  requireAuth,
  validate('json', createBotBody),
  async (c) => {
    const ownerId = requireUserId(c);
    const body = c.req.valid('json');
    const bots = await import('../services/bots');
    const { bot, token } = await bots.createBot({
      ownerId,
      username: body.username,
      displayName: body.displayName,
    });
    return c.json({ bot: toBotDTO(bot), token });
  },
);

usersRouter.get('/@me/bots', requireAuth, async (c) => {
  const ownerId = requireUserId(c);
  const bots = await import('../services/bots');
  const rows = await bots.listBotsForOwner(ownerId);
  return c.json({ bots: rows.map(toBotDTO) });
});

usersRouter.post(
  '/@me/bots/:id/token',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const bots = await import('../services/bots');
    const { token } = await bots.regenerateBotToken(BigInt(id), ownerId);
    return c.json({ token });
  },
);

const updateBotBody = z.object({
  displayName: displayNameSchema.optional(),
  avatarUrl: cdnPathOrNullSchema.optional(),
  bio: bioSchema.optional(),
});

usersRouter.patch(
  '/@me/bots/:id',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  validate('json', updateBotBody),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const bots = await import('../services/bots');
    const updated = await bots.updateBotProfile(BigInt(id), ownerId, body);
    return c.json({ bot: toBotDTO(updated) });
  },
);

usersRouter.delete(
  '/@me/bots/:id',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const bots = await import('../services/bots');
    await bots.deleteBot(BigInt(id), ownerId);
    return c.json({ ok: true });
  },
);

// Set / clear a bot's event callback URL. Returns the signing secret
// ONCE (when a URL is set) so the owner can configure verification.
const botEventConfigBody = z.object({
  url: z.string().url().nullable(),
});

usersRouter.put(
  '/@me/bots/:id/event-config',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  validate('json', botEventConfigBody),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const { url } = c.req.valid('json');
    const bots = await import('../services/bots');
    const result = await bots.setBotEventConfig(BigInt(id), ownerId, url);
    return c.json(result);
  },
);

// ── Bot slash-commands ──────────────────────────────────────────────────────
//
//   POST   /@me/bots/:id/commands              register a command
//   GET    /@me/bots/:id/commands              list a bot's commands
//   DELETE /@me/bots/:id/commands/:commandId   delete a command
//
// Commands are owner-managed (loadOwnedBot gates them inside the service). A
// command is either global (guildId omitted) or scoped to one guild the bot is
// in; a guild-scoped command of the same name wins over a global one at invoke
// time. To actually receive invocations the bot must have an event callback
// configured (see /event-config) — without it, invoking returns a clear error.

function toBotCommandDTO(cmd: { id: bigint; botId: bigint; guildId: bigint | null; name: string; description: string; createdAt: Date }) {
  return {
    id: cmd.id.toString(),
    botId: cmd.botId.toString(),
    guildId: cmd.guildId?.toString() ?? null,
    name: cmd.name,
    description: cmd.description,
    createdAt: cmd.createdAt.toISOString(),
  };
}

const registerCommandBody = z.object({
  name: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(200),
  /** Omit for a global command; set to scope it to one guild. */
  guildId: z.string().regex(/^\d+$/).optional(),
});

usersRouter.post(
  '/@me/bots/:id/commands',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  validate('json', registerCommandBody),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const bots = await import('../services/bots');
    const cmd = await bots.registerBotCommand({
      botId: BigInt(id),
      ownerId,
      guildId: body.guildId ? BigInt(body.guildId) : null,
      name: body.name,
      description: body.description,
    });
    return c.json({ command: toBotCommandDTO(cmd) }, 201);
  },
);

usersRouter.get(
  '/@me/bots/:id/commands',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/) })),
  async (c) => {
    const ownerId = requireUserId(c);
    const { id } = c.req.valid('param');
    const bots = await import('../services/bots');
    const rows = await bots.listBotCommands(BigInt(id), ownerId);
    return c.json({ commands: rows.map(toBotCommandDTO) });
  },
);

usersRouter.delete(
  '/@me/bots/:id/commands/:commandId',
  requireAuth,
  validate('param', z.object({ id: z.string().regex(/^\d+$/), commandId: z.string().regex(/^\d+$/) })),
  async (c) => {
    const ownerId = requireUserId(c);
    const { commandId } = c.req.valid('param');
    const bots = await import('../services/bots');
    await bots.deleteBotCommand(BigInt(commandId), ownerId);
    return c.json({ ok: true });
  },
);


// ───────────────────────────────────────────────────────────────────────────
// DELETE /users/@me — self-serve account deletion
// ───────────────────────────────────────────────────────────────────────────
//
// The published Terms and Privacy Policy both state that a user can "delete
// your account at any time from Settings". Until this route existed that was
// simply untrue: the ONLY deletion path was DELETE /admin/users/:id, which
// explicitly refuses to act on the caller's own account ("You cannot delete
// your own account from here"). For a consumer service that stores minors'
// data, a policy promising a right the software does not implement is the
// kind of gap that matters, so this closes it.
//
// Deliberately mirrors the admin path's mechanics (owner check → orphan-guild
// purge → revoke + disconnect → hard delete) so there is exactly one deletion
// semantic, not two that drift.
//
// Gated by step-up re-auth: the current password, plus a TOTP code when 2FA is
// enabled. Account deletion is irreversible and destroys the user's messages'
// authorship, so a transient stolen access token must not be enough — the same
// reasoning that already guards passkey enrolment and 2FA changes.
const deleteAccountBody = z.object({
  password: z.string().min(1),
  // Required only when the account has TOTP armed.
  totpCode: z.string().trim().min(6).max(10).optional(),
});

usersRouter.delete(
  '/@me',
  requireAuth,
  // Bots authenticate with a static token and have no password to step up
  // with; account deletion is a human action on a human account.
  requireHumanSession,
  validate('json', deleteAccountBody),
  async (c) => {
    const userId = requireUserId(c);
    const { password, totpCode } = c.req.valid('json');

    // Step 1 — prove possession of the password. Consumes the shared per-user
    // step-up budget, so this can't be used to brute-force it.
    await assertStepUpPassword(userId, password);

    // Step 2 — and the second factor, when armed. Checked AFTER the password
    // so a wrong password never reveals whether 2FA is on.
    const [me] = await db
      .select({
        totpEnabled: schema.users.totpEnabled,
        username: schema.users.username,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1);
    if (!me) throw errors.notFound('User');
    if (me.totpEnabled) {
      if (!totpCode) throw errors.badRequest('A two-factor code is required');
      // verifyForLogin also accepts a RECOVERY code, which is what we want:
      // someone who has lost their authenticator must still be able to close
      // their account rather than being locked into it.
      const twoFactor = await import('../services/twoFactor');
      const ok = await twoFactor.verifyForLogin({ userId, code: totpCode });
      if (!ok) throw errors.invalidCredentials();
    }

    // Step 3 — owned servers block deletion, because guilds.owner_id is
    // ON DELETE RESTRICT. Surface it as a clear instruction rather than a raw
    // FK violation. Only ACTIVE guilds block: one the user already deleted is
    // gone from their perspective and shouldn't trap their account.
    const ownedActive = await db
      .select({ id: schema.guilds.id })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.ownerId, userId), isNull(schema.guilds.deletedAt)))
      .limit(1);
    if (ownedActive.length > 0) {
      throw errors.badRequest(
        'You own one or more servers. Transfer ownership or delete those servers first.',
      );
    }

    // Servers this user deleted back when deletion was only a flag: the rows
    // are still there, still holding an owner_id RESTRICT reference, and their
    // content was never removed. Purge them properly on the way past.
    const { purgeAccount, purgeGuild } = await import('../services/purge');
    const stale = await db
      .select({ id: schema.guilds.id })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.ownerId, userId), isNotNull(schema.guilds.deletedAt)));
    for (const g of stale) await purgeGuild(g.id);

    // Step 4 — boot every session and live socket before the row disappears.
    await revokeAllUserSessions(userId);
    for (const conn of registry.byUserId(userId)) {
      try {
        conn.close(4004, 'account deleted');
      } catch {
        // already closing
      }
    }

    // Purge rather than erase. Their server messages, files, reactions and
    // every piece of account data go; their DM conversations stay, still
    // showing the old username, because a one-to-one conversation is also the
    // other person's history. The row survives only as a tombstone — see
    // services/purge.ts.
    await purgeAccount(userId);

    // Audit trail. The user row is gone so user_id can't reference it — the
    // who lives in the detail text, matching the admin delete path.
    try {
      const { logEvent } = await import('../services/security');
      await logEvent({
        kind: 'user_self_delete',
        userId: null,
        actorId: null,
        guildId: null,
        channelId: null,
        detail: `Account @${me.username} (${userId}) deleted by its owner`,
      });
    } catch (err) {
      // Never fail the deletion because the audit write failed — it already
      // happened.
      log.error('self-delete audit log failed', { err });
    }

    // The refresh cookie now points at a revoked session on a deleted user;
    // clear it so the browser doesn't retry with a dead credential.
    clearRefreshCookie(c);
    return c.json({ deleted: true });
  },
);
