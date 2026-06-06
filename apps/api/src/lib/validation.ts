/**
 * Validation primitives
 * ---------------------
 * Reusable Zod schemas. Routes compose these for their request bodies. Each
 * field corresponds to a constant from @zekktris/shared so the limits stay in
 * lockstep between client and server.
 */

import { z } from 'zod';
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  BIO_MAX_LENGTH,
  CUSTOM_STATUS_MAX_LENGTH,
  UserStatus,
} from '@zekktris/shared/constants';
import { isSnowflake } from '@zekktris/shared/snowflake';

/** Decimal string of a 64-bit snowflake. Use for path/body params. */
export const snowflakeSchema = z
  .string()
  .refine(isSnowflake, { message: 'Invalid snowflake id' });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Must be a valid email address')
  .max(254, 'Email is too long');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
  .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters`)
  .regex(USERNAME_REGEX, 'Username may only contain a-z, 0-9, underscore, and period');

/**
 * Strip characters that look invisible or that visually corrupt
 * surrounding text. Applied to free-form text fields rendered into
 * the UI (display name, nickname, bio, custom status). React already
 * escapes HTML so we're not defending against XSS — these are
 * impersonation, list-break, and RTL-override vectors:
 *
 *   - C0/C1 control chars (NUL, ESC, etc.) — except plain newline +
 *     tab, which are useful in bios.
 *   - Zero-width chars (U+200B/C/D, U+FEFF, U+2060 word joiner) —
 *     "alice" and "alice\u200B" look identical but compare distinct.
 *   - Bidi formatting chars (U+202A–U+202E, U+2066–U+2069) — flip
 *     the display direction of trailing text. Classic file-rename
 *     attack vector ("evil\u202Egnp.exe" renders as "evilexe.png").
 *
 * Removal is silent: the field is normalized rather than rejected,
 * which avoids surfacing confusing error messages on paste of text
 * that happened to include a stray zero-width joiner.
 */
function stripUnsafeChars(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '') // C0/C1 minus \n (0x0A) and \t (0x09)
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // zero-width + word joiner + BOM
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, ''); // bidi overrides
}

export const displayNameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(
    z
      .string()
      .trim()
      .min(1, 'Display name cannot be empty')
      .max(DISPLAY_NAME_MAX_LENGTH, `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`),
  );

/**
 * Nickname schema — same hygiene as display name, applied per-guild.
 * Exported here rather than inlined in routes/guilds.ts so the
 * sanitization stays in one place.
 */
export const nicknameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().trim().max(32));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const bioSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().max(BIO_MAX_LENGTH))
  .nullable();
export const customStatusSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().max(CUSTOM_STATUS_MAX_LENGTH))
  .nullable();

/** User-settable status values. 'offline' is set automatically by presence; not a valid input. */
export const settableStatusSchema = z.enum([
  UserStatus.ONLINE,
  UserStatus.IDLE,
  UserStatus.DND,
  UserStatus.INVISIBLE,
]);

// ───────────────────────────────────────────────────────────────────────────
// Guild / role / channel / invite schemas
// ───────────────────────────────────────────────────────────────────────────

import {
  GUILD_NAME_MIN_LENGTH,
  GUILD_NAME_MAX_LENGTH,
  GUILD_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MIN_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  CHANNEL_NAME_MIN_LENGTH,
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_TOPIC_MAX_LENGTH,
  SLOWMODE_MAX_SECONDS,
  INVITE_DEFAULT_TTL_SECONDS,
  INVITE_MAX_TTL_SECONDS,
} from '@zekktris/shared/constants';

export const guildNameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(
    z
      .string()
      .trim()
      .min(GUILD_NAME_MIN_LENGTH)
      .max(GUILD_NAME_MAX_LENGTH),
  );

export const guildDescriptionSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().max(GUILD_DESCRIPTION_MAX_LENGTH))
  .nullable();

export const roleNameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(
    z
      .string()
      .trim()
      .min(ROLE_NAME_MIN_LENGTH)
      .max(ROLE_NAME_MAX_LENGTH),
  );

/** RGB packed as integer 0..0xFFFFFF. */
export const colorSchema = z.number().int().min(0).max(0xffffff);

/**
 * Webhook username override — the per-message persona name that
 * renders as the author label in chat. Same hygiene as user names:
 * stripping invisible/bidi chars prevents a webhook from impersonating
 * actual users via lookalike strings (e.g. "admin\u200B").
 */
export const webhookUsernameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().trim().min(1).max(80));

/**
 * Permission bitfields are bigint on the server but JSON-encoded as decimal
 * strings on the wire. Accept either a string of digits or a regular number.
 */
export const permissionsSchema = z
  .union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()])
  .transform((v): bigint => (typeof v === 'string' ? BigInt(v) : BigInt(v)));

export const channelNameSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(
    z
      .string()
      .trim()
      .min(CHANNEL_NAME_MIN_LENGTH)
      .max(CHANNEL_NAME_MAX_LENGTH),
  );

export const channelTopicSchema = z
  .string()
  .transform(stripUnsafeChars)
  .pipe(z.string().max(CHANNEL_TOPIC_MAX_LENGTH))
  .nullable();

export const slowmodeSchema = z.number().int().min(0).max(SLOWMODE_MAX_SECONDS);

export const inviteTtlSchema = z.number().int().min(60).max(INVITE_MAX_TTL_SECONDS);
/** Re-exported for convenience in route handlers. */
export const INVITE_DEFAULT_TTL = INVITE_DEFAULT_TTL_SECONDS;

// ───────────────────────────────────────────────────────────────────────────
// Message schemas
// ───────────────────────────────────────────────────────────────────────────

import {
  MESSAGE_CONTENT_MAX_LENGTH,
  MESSAGES_PAGE_DEFAULT,
  MESSAGES_PAGE_MAX,
} from '@zekktris/shared/constants';

/** Empty content is allowed (attachments-only messages). Whitespace-only is allowed too. */
export const messageContentSchema = z
  .string()
  .max(MESSAGE_CONTENT_MAX_LENGTH, `Message content must be at most ${MESSAGE_CONTENT_MAX_LENGTH} characters`);

export const messagePageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MESSAGES_PAGE_MAX)
  .default(MESSAGES_PAGE_DEFAULT);

/**
 * Emoji string — accepts unicode codepoints or shortcodes. We don't try to
 * validate that it's "really" an emoji (regex over unicode is brittle); the
 * service-layer validateEmoji enforces a byte-length cap.
 */
export const emojiSchema = z.string().min(1).max(64);

// ───────────────────────────────────────────────────────────────────────────
// CDN URL schemas
// ───────────────────────────────────────────────────────────────────────────

/**
 * URL field for avatar / banner / icon inputs on PATCH/POST routes.
 *
 * Restricted to either null (clearing the field) OR a path beginning with
 * `/cdn/` — a server-produced CDN reference. We deliberately reject
 * arbitrary http(s) URLs:
 *
 *   - External URLs turn every place the avatar/banner/icon renders into
 *     a tracking beacon. Each viewing client fetches the asset, leaking
 *     IP / User-Agent / Referer to whatever domain the URL points at.
 *   - External URLs also bypass content moderation — there's no upload
 *     scan or content-type check, and the resource at the URL can change
 *     after submission.
 *   - Pointing at heavy resources is an indirect DoS / bandwidth-abuse
 *     vector for the target.
 *
 * The avatar/banner/icon upload routes (POST /@me/avatar, etc.) produce
 * the canonical /cdn/<id>/<filename> values; clients should use those
 * routes to set the field, and PATCH only to clear it (null) or to
 * reference an already-uploaded /cdn/ path.
 *
 * The pattern is intentionally simple: just the prefix check. We don't
 * try to validate <id>/<filename> structurally because the CDN layer
 * owns that schema and may evolve it; rejecting at the prefix is enough
 * to block the external-URL attack surface.
 */
export const cdnPathOrNullSchema = z
  .string()
  .max(2048)
  .regex(/^\/cdn\//, 'Must be a /cdn/ path produced by the upload flow')
  .nullable();
