/**
 * Environment configuration
 * -------------------------
 * All process.env reads MUST go through this module. Anything else is a bug.
 *
 * On import, this validates the environment with Zod and throws synchronously
 * if anything required is missing or malformed. That means a misconfigured
 * deployment fails fast at startup instead of mysteriously breaking later.
 *
 * Defaults are sized for self-host on a small box; tighten in production via
 * env overrides.
 */

import { z } from 'zod';

const RegistrationMode = z.enum(['open', 'invite-only', 'closed']);
export type RegistrationMode = z.infer<typeof RegistrationMode>;

const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

const NodeEnv = z.enum(['development', 'test', 'production']);

/**
 * Treat an empty-string env var as absent.
 *
 * docker-compose passes unset optionals as `${VAR:-}`, which reaches the
 * process as `''` — NOT undefined. A bare `z.string().email().optional()`
 * (or `.url()`, etc.) then runs its validator on `''` and fails, crash-looping
 * the API on the default self-host path. Wrapping the field so `'' → undefined`
 * lets `.optional()` and the validators behave as intended. This mirrors the
 * inline `z.preprocess((v) => (v === '' ? undefined : v), …)` already used for
 * the APNS, SMTP, FIELD_ENCRYPTION_KEY, and BOOTSTRAP_ADMIN_EMAIL fields.
 */
const emptyAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const envSchema = z.object({
  // ── Runtime ────────────────────────────────────────────────────────────
  NODE_ENV: NodeEnv.default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // The app's public-facing absolute URL. Used to build outgoing links
  // (CDN, invites, email) and the same-origin LiveKit signaling URL.
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** Trust X-Forwarded-* headers when running behind a reverse proxy. */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // ── Logging ────────────────────────────────────────────────────────────
  LOG_LEVEL: LogLevel.default('info'),

  // ── Snowflake ──────────────────────────────────────────────────────────
  /** Per-process worker id (0..1023). Each running api replica MUST set a unique value. */
  WORKER_ID: z.coerce.number().int().min(0).max(1023).default(0),

  // ── Database ───────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),

  // ── Cache / pubsub ─────────────────────────────────────────────────────
  REDIS_URL: emptyAsUndefined(z.string().url().optional()),

  // ── Observability ──────────────────────────────────────────────────────
  /**
   * Opt-in bearer token for the Prometheus scrape endpoint GET /metrics.
   * When UNSET the endpoint is disabled entirely (responds 404) so operational
   * data is never exposed by accident. When set, scrapers must send
   * `Authorization: Bearer <token>`. The admin JSON metrics (/api/v1/admin/metrics)
   * are always available to instance admins regardless of this. Note: the
   * bundled Caddy does not proxy /metrics, so it's reachable only on the
   * internal network unless an operator adds a route.
   */
  METRICS_TOKEN: emptyAsUndefined(z.string().min(16).optional()),

  // ── Auth ───────────────────────────────────────────────────────────────
  /** HS256 signing key for short-lived access tokens. Min 32 bytes. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /**
   * HS256 signing key for refresh-token derivation. MUST differ from JWT_SECRET
   * so a compromise of one doesn't compromise the other.
   */
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  /** Lifetime of access tokens, in seconds. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900), // 15 min
  /** Lifetime of refresh tokens, in seconds. */
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 30), // 30 days

  // ── Field encryption at rest ───────────────────────────────────────────
  /**
   * Optional 32-byte key (hex = 64 chars, or base64 = 44 chars) used to
   * encrypt sensitive columns at rest — currently the TOTP 2FA secret and
   * the bot event-signing secret — with AES-256-GCM. Generate with
   * `openssl rand -hex 32`.
   *
   * When UNSET, those fields are stored in plaintext (the pre-feature
   * behavior), so existing deployments keep working on upgrade; setting
   * the key turns encryption on. Keep the key STABLE and backed up — if
   * it's lost, already-encrypted secrets can't be decrypted (users would
   * have to re-enroll 2FA / regenerate bot secrets). It MUST differ from
   * the JWT secrets.
   */
  FIELD_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .refine(
        (s) => /^[0-9a-fA-F]{64}$/.test(s) || Buffer.from(s, 'base64').length === 32,
        'FIELD_ENCRYPTION_KEY must be 32 bytes: 64 hex chars or base64 of 32 bytes',
      )
      .optional(),
  ),

  /**
   * Optional comma-separated list of PREVIOUS field-encryption keys (each the
   * same 32-byte hex/base64 format as FIELD_ENCRYPTION_KEY). Used for safe key
   * rotation: writes use the primary key above, but decryption falls back to
   * these so already-stored 2FA/bot secrets keep working after the primary is
   * rotated. After running the re-encrypt script (everything is now under the
   * new primary) you can drop the old key from this list.
   */
  FIELD_ENCRYPTION_KEYS_OLD: z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== ''
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
    z
      .array(
        z
          .string()
          .refine(
            (s) => /^[0-9a-fA-F]{64}$/.test(s) || Buffer.from(s, 'base64').length === 32,
            'each FIELD_ENCRYPTION_KEYS_OLD entry must be 32 bytes: 64 hex chars or base64 of 32 bytes',
          ),
      )
      .optional(),
  ),

  // ── Registration ───────────────────────────────────────────────────────
  ALLOW_REGISTRATION: RegistrationMode.default('open'),

  // ── Account inactivity sweep ───────────────────────────────────────────
  // Hard-delete user accounts that haven't refreshed an access token
  // (i.e. opened the app) in this many days. Set to 0 to disable. The
  // 365-day default mirrors common platform retention policies and
  // gives long-absent users a generous window to come back before
  // their data is removed. Cascade rules in the schema preserve
  // message history (authorId set null) but drop everything tied
  // to the user's identity (sessions, memberships, DMs, etc).
  INACTIVITY_TTL_DAYS: z.coerce.number().int().min(0).default(365),
  /** How often the sweep runs, in hours. Default: once per day. */
  INACTIVITY_SWEEP_INTERVAL_HOURS: z.coerce.number().min(0.25).default(24),

  // ── DM streak-expiry warning ───────────────────────────────────────────
  /** Post a "your DM streak ends soon" notice this many hours before a streak
   *  resets (streaks reset at UTC midnight). Default 6 → warns at/after
   *  18:00 UTC. Set STREAK_WARN_ENABLED=false to disable the sweep entirely. */
  STREAK_WARN_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  STREAK_WARN_HOURS_BEFORE: z.coerce.number().int().min(1).max(23).default(6),

  // ── Invite cleanup ─────────────────────────────────────────────────────
  /** Periodically hard-delete invites that are permanently dead (expired, or
   *  spent their max uses) and have been dead longer than the grace window.
   *  Recently-dead invites stay visible in the invite manager; this just keeps
   *  the table from growing without bound (most invites carry a 24h TTL). Set
   *  INVITE_PRUNE_ENABLED=false to disable the sweep. */
  INVITE_PRUNE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** Days a dead invite is retained (still listed in the manager) before it's
   *  swept. 0 = delete on the next sweep with no retention. */
  INVITE_PRUNE_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(7),

  // ── Uploads ────────────────────────────────────────────────────────────
  UPLOAD_DIR: z.string().default('/data/uploads'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().min(1).max(10_000).default(100),
  MAX_FILES_PER_MESSAGE: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Periodic image-compression sweep: re-encodes attachments older
   * than 7 days at lower quality to reduce disk footprint. Requires
   * the `sharp` npm package to be installed (intentionally NOT a
   * hard dependency — operators who don't want native image deps can
   * skip it and the sweep no-ops gracefully).
   *
   * IMAGE_COMPRESS_QUALITY: JPEG/WebP quality target (1-100). Default
   *   75 saves ~30-50% on typical phone-camera output without visible
   *   loss; photography-focused communities may prefer 85.
   * IMAGE_COMPRESS_SWEEP_INTERVAL_HOURS: how often to run.
   * IMAGE_COMPRESS_ENABLED: master off-switch; '0' or 'false' disables
   *   the sweep even when sharp is available.
   */
  IMAGE_COMPRESS_QUALITY: z.coerce.number().int().min(1).max(100).default(75),
  IMAGE_COMPRESS_SWEEP_INTERVAL_HOURS: z.coerce.number().min(0.25).default(24),
  IMAGE_COMPRESS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  // ── Cookies ────────────────────────────────────────────────────────────
  /** Domain set on the refresh-token cookie. Leave empty to default to the request host. */
  COOKIE_DOMAIN: emptyAsUndefined(z.string().optional()),
  /**
   * Whether to send `Secure` on cookies. Should be 'true' in production with TLS;
   * 'false' on plain-HTTP local dev so cookies aren't dropped by the browser.
   */
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // ── Voice / video (LiveKit) ────────────────────────────────────────────
  // All three are independently optional; voice token minting requires
  // ALL of them to be set. Missing any one causes joinVoice to return
  // a null token and the client falls back to presence-only mode. The
  // api still boots in either configuration — no startup-check failure.
  LIVEKIT_API_KEY: emptyAsUndefined(z.string().optional()),
  LIVEKIT_API_SECRET: emptyAsUndefined(z.string().optional()),
  LIVEKIT_WS_URL: emptyAsUndefined(z.string().optional()),
  // LiveKit's server-side admin APIs (RoomServiceClient — used to
  // forcibly evict banned/kicked users from voice rooms) speak HTTPS,
  // not WSS. Most LiveKit deployments serve both on the same host —
  // when this env var is unset, the eviction helper derives an
  // http(s) URL from LIVEKIT_WS_URL automatically. Override here only
  // if your deployment runs the admin API on a separate hostname.
  LIVEKIT_HTTP_URL: emptyAsUndefined(z.string().optional()),

  // ── Web Push (notifications) ───────────────────────────────────────────
  // VAPID keys identify the application server to push gateways. Both
  // public and private must be set together; missing either disables
  // push at runtime (subscribe endpoint returns 503, send is a no-op).
  // The contact email is included in the JWT VAPID claim — gateways
  // use it to reach the operator if their service abuses push.
  // Generate keys with: `npx web-push generate-vapid-keys`
  VAPID_PUBLIC_KEY: emptyAsUndefined(z.string().optional()),
  VAPID_PRIVATE_KEY: emptyAsUndefined(z.string().optional()),
  // `''` (docker-compose's `${VAPID_CONTACT_EMAIL:-}` default) must become
  // undefined BEFORE `.email()` runs, or the API crash-loops on boot for every
  // self-host that hasn't configured Web Push.
  VAPID_CONTACT_EMAIL: emptyAsUndefined(z.string().email().optional()),

  // ── APNs (native iOS push) ──────────────────────────────────────────────
  // Token-based Apple Push Notification service for the native iOS app
  // (Web Push doesn't work inside the Capacitor WKWebView). All four key
  // fields must be set to enable APNs; missing any disables it (send is a
  // no-op, the device-token endpoint 503s). Create the .p8 + Key ID at
  // developer.apple.com → Keys → enable "Apple Push Notifications service".
  //   APNS_KEY_P8     — the .p8 contents: PEM text, or base64 of the file
  //                     (base64 avoids newline headaches in env files).
  //   APNS_KEY_ID     — 10-char Key ID shown when you create the key.
  //   APNS_TEAM_ID    — your 10-char Apple Team ID.
  //   APNS_BUNDLE_ID  — the app bundle id, e.g. com.zekktris.app.
  //   APNS_PRODUCTION — "true" for TestFlight/App Store (default), "false"
  //                     only for Xcode debug "Run" builds (sandbox host).
  APNS_KEY_P8: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Alternative to APNS_KEY_P8: absolute path to the .p8 file (bind-mount
  // it into the container). Sidesteps every multiline/quoting pitfall of
  // stuffing PEM or base64 into env files. If both are set, APNS_KEY_P8
  // wins.
  APNS_KEY_P8_FILE: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  APNS_KEY_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  APNS_TEAM_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  APNS_BUNDLE_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  APNS_PRODUCTION: z.preprocess((v) => {
    if (v === undefined || v === '') return true; // TestFlight/App Store default
    if (typeof v === 'string') return !/^(false|0|no|off)$/i.test(v.trim());
    return Boolean(v);
  }, z.boolean()),

  // Firebase Cloud Messaging (FCM HTTP v1) for the native Android app — the
  // Android Capacitor shell registers an FCM token (Web Push can't run in the
  // Android System WebView). Supply a Firebase service account so the server
  // can mint OAuth tokens and send. All three fields required to enable FCM;
  // missing any disables it (send is a no-op, 'android' device-token register
  // still succeeds so the column is filled, just never delivered).
  // Get them from the Firebase console → Project settings → Service accounts →
  // "Generate new private key" (a JSON file with these three fields):
  //   FCM_PROJECT_ID    — the Firebase project id (== google-services project).
  //   FCM_CLIENT_EMAIL  — service-account email (…@<project>.iam.gserviceaccount.com).
  //   FCM_PRIVATE_KEY   — the service account's PEM private key. Use base64 of
  //                       the PEM to avoid newline headaches in env files (the
  //                       sender accepts raw PEM or base64).
  FCM_PROJECT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  FCM_CLIENT_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  FCM_PRIVATE_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  // ── First-install bootstrap ────────────────────────────────────────────
  // Optional email address. On startup, if no user has is_admin=true yet
  // AND a user exists with this email, that user is promoted to admin.
  // Idempotent: once any admin exists, this env var has no effect, so
  // it's safe to leave set across restarts (e.g. in docker-compose.yml).
  // Empty/unset → no bootstrap attempt at all. Solves the chicken-and-
  // egg problem on fresh installs: without this, the operator would
  // need direct SQL access to make their first admin.
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().email().optional(),
  ),

  // ── Email (SMTP) ───────────────────────────────────────────────────────
  // Outbound email config. Used currently by password-reset; future
  // notifications (email digests, account-activity alerts) will use
  // the same channel. All keys are optional — missing SMTP_HOST
  // disables email-dependent features (forgot-password returns 503).
  //
  // For self-host operators, point these at any SMTP relay: Mailgun,
  // SendGrid, AWS SES, Postmark, or a local Postfix instance. The
  // server doesn't care which.
  //
  // SMTP_SECURE controls TLS:
  //   - true:  implicit TLS (typically port 465)
  //   - false: STARTTLS upgrade if available (typically port 587)
  //
  // SMTP_FROM is the From: header on outbound mail. Must be an
  // address the relay is willing to send for — typically a verified
  // sender or your domain's postmaster address.
  SMTP_HOST: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
  SMTP_PASS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().optional(),
  ),
  SMTP_FROM: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().email().optional(),
  ),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Database pool size.
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Prepared statements. OFF by default for pgBouncer transaction-pooling
  // safety; set true when connecting directly to Postgres for a query
  // plan-caching speedup.
  DB_PREPARED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail loudly. Do not start the server with a bad config.
    console.error('✗ Invalid environment configuration:\n' + issues);
    process.exit(1);
  }
  if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    console.error('✗ JWT_SECRET and JWT_REFRESH_SECRET must differ.');
    process.exit(1);
  }
  if (
    parsed.data.FIELD_ENCRYPTION_KEY &&
    (parsed.data.FIELD_ENCRYPTION_KEY === parsed.data.JWT_SECRET ||
      parsed.data.FIELD_ENCRYPTION_KEY === parsed.data.JWT_REFRESH_SECRET)
  ) {
    console.error('✗ FIELD_ENCRYPTION_KEY must differ from the JWT secrets.');
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
