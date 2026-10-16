/**
 * REST client
 * -----------
 * Thin wrapper around fetch. The signature pattern is: every method returns
 * the unwrapped data on the happy path, and throws an ApiError on non-2xx.
 * Consumers can `try/catch` instead of checking statuses everywhere.
 *
 * Token is read from a mutable holder so the user can swap it on
 * login/refresh without re-creating the client. If `null`, no Authorization
 * header is sent — appropriate for register/login/preview-invite endpoints.
 */

import type {
  AchievementsResponse,
  Attachment,
  AuthSession,
  QuickLoginCode,
  DeviceLoginStart,
  DeviceLoginPollResult,
  DeviceLoginRequestInfo,
  AuditLogEntry,
  AutomodRule,
  Channel,
  Guild,
  GuildMember,
  GuildBan,
  GuildEmoji,
  GuildFolder,
  Invite,
  InvitePreview,
  Message,
  MessageEmbed,
  MonetizationConfig,
  MonetizationConfigPatch,
  PermissionOverride,
  PokeHistoryEntry,
  PublicUser,
  Bot,
  BotCommand,
  GuildCommand,
  ReactionRoleMapping,
  ReadState,
  Role,
  ScheduledEvent,
  EventRsvp,
  Sticker,
  StageParticipant,
  DiscoverableGuild,
  SecurityConfig,
  SecurityEvent,
  SecurityWord,
  SelfUser,
  SessionInfo,
  VoiceState,
  Webhook,
} from './types';

export interface RestClientOptions {
  /** Base URL of the API including /api/v1 (no trailing slash). */
  baseUrl: string;
  /** Token getter — called on each request. Returns null when unauthenticated. */
  getToken(): string | null;
  /** Optional fetch override — used in tests / Node environments. */
  fetch?: typeof fetch;
  /**
   * Called when the client successfully refreshes the access token
   * via /auth/refresh. The host (AuthContext) should persist the new
   * token to localStorage and update its in-memory copy. If absent,
   * the client still uses the new token for the retried request but
   * the host won't know about it — so we recommend always wiring
   * this in production.
   */
  onTokenRefreshed?(accessToken: string): void;
  /**
   * Called when /auth/refresh answers 401 or 403 — i.e. the refresh
   * token itself is dead and no amount of retrying will bring the
   * session back. The host should treat this as a hard logout: clear
   * stored tokens, navigate to login.
   *
   * Deliberately NOT called for network errors, timeouts, 5xx, or the
   * 409 the api returns when another tab won the rotation race. Those
   * are transient, the credential is still good, and wiping it for
   * them is what turned every offline moment and every api restart
   * into "it logged me out again".
   */
  onRefreshFailed?(): void;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Human-readable fallback for an HTTP status when the server didn't supply a
 * message (gateway/proxy errors, unexpected bodies). Keeps raw codes like
 * "Non-JSON response (502)" / "HTTP 500" off user-facing screens.
 */
function friendlyHttpMessage(status: number): string {
  if (status === 429) return "You're doing that a bit too fast — wait a moment and try again.";
  if (status === 502 || status === 503 || status === 504) {
    return 'The server is unavailable right now. Please try again in a moment.';
  }
  if (status >= 500) return 'Something went wrong on the server. Please try again.';
  if (status === 413) return 'That was too large to upload.';
  if (status === 408) return 'The request timed out. Please try again.';
  return `Request failed (${status}).`;
}

/**
 * The outcome of a /auth/refresh attempt. The distinction that matters is
 * `fatal`: only that means "the session is over, clear the credentials".
 * Collapsing every failure into one null — which is what this used to be —
 * is why an offline moment, a 502 during a deploy, or a lost rotation race
 * signed the user out.
 */
interface RefreshOutcome {
  /** The rotated access token, or null if this attempt didn't get one. */
  accessToken: string | null;
  /** True only for 401/403 from /auth/refresh: the refresh token is dead. */
  fatal: boolean;
}

/**
 * Backoff ladder for a TRANSIENT refresh failure, in ms between attempts (so
 * four attempts, ~6 s of waiting in the worst case).
 *
 * Kept deliberately short. When the api answers 409 the token we're presenting
 * has been superseded, and the server only treats that as benign concurrency
 * for a couple of minutes before it starts calling it token theft — so a client
 * that kept retrying for minutes would talk itself into a revoked session. Six
 * seconds sits comfortably inside that window while still riding out an api
 * restart or a momentary drop.
 */
const REFRESH_RETRY_DELAYS_MS = [400, 1_200, 4_000];

/**
 * Spread a ladder rung over ±50% at random.
 *
 * Without this, N tabs whose access tokens were minted together expire together
 * and retry in lockstep at exactly 400 / 1600 / 5600 ms — every rung is the
 * same thundering herd against an endpoint that is doing real work per attempt,
 * and the tabs that lost the first race are disproportionately likely to lose
 * every subsequent one and exhaust the ladder. Jitter decorrelates them, which
 * matters most during exactly the outage the retries exist to survive.
 */
function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.5 + Math.random()));
}

export class RestClient {
  constructor(private opts: RestClientOptions) {}

  /**
   * Single in-flight refresh promise — coalesces concurrent 401s into
   * one /auth/refresh call. Without this, ten parallel API calls all
   * 401ing simultaneously would each fire their own refresh, causing
   * a refresh-token rotation race that invalidates the others.
   */
  private refreshInFlight: Promise<RefreshOutcome> | null = null;

  private async tryRefresh(): Promise<RefreshOutcome> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        return await this.refreshWithBackoff();
      } finally {
        // Clear the lock so subsequent token expiries can refresh
        // again. We do this in `finally` so even thrown errors don't
        // leave a stale promise that blocks future refreshes.
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  /**
   * Refresh, retrying only the failures that are worth retrying. Stops the
   * moment we have a token or a fatal answer; otherwise walks the backoff
   * ladder and gives up transiently — the caller keeps its credentials and the
   * next request will try again.
   */
  private async refreshWithBackoff(): Promise<RefreshOutcome> {
    let outcome = await this.refreshOnce();
    for (const delay of REFRESH_RETRY_DELAYS_MS) {
      if (outcome.accessToken !== null || outcome.fatal) return outcome;
      await new Promise((resolve) => setTimeout(resolve, jittered(delay)));
      outcome = await this.refreshOnce();
    }
    return outcome;
  }

  /** One /auth/refresh round trip. Never throws — every failure mode is
      classified into the RefreshOutcome tri-state instead. */
  private async refreshOnce(): Promise<RefreshOutcome> {
    const fetchImpl = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.opts.baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // Network-level failure: offline, DNS, connection reset, the app opened
      // before wi-fi came up. The refresh cookie is almost certainly still
      // good — we simply couldn't ask.
      return { accessToken: null, fatal: false };
    }
    // The only two answers that actually mean "this session is over".
    if (res.status === 401 || res.status === 403) return { accessToken: null, fatal: true };
    if (!res.ok) {
      // 409 = another tab won the rotation race, or we're retrying a refresh
      // whose response was lost; 5xx = the api is restarting or a proxy
      // answered for it. Both are worth retrying; neither is a logout.
      //
      // Note the server now answers most lost-response replays with a 200
      // carrying the token the lost response was meant to deliver, so that case
      // usually resolves on the first rung rather than walking the ladder. A
      // 409 here means the replay was outside the server's grace window, came
      // from a different client, or its recovery store was unavailable — all
      // still worth one more try with whatever token we end up holding.
      return { accessToken: null, fatal: false };
    }
    let accessToken: string | undefined;
    try {
      accessToken = ((await res.json()) as { accessToken?: string }).accessToken;
    } catch {
      // A 200 with an unparseable body means something interposed (proxy,
      // captive portal), not that the session died.
      return { accessToken: null, fatal: false };
    }
    if (!accessToken) return { accessToken: null, fatal: false };
    this.opts.onTokenRefreshed?.(accessToken);
    return { accessToken, fatal: false };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: HeadersInit,
    /** Internal — blocks the refresh-then-retry recursion at depth 1. */
    isRetry = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((extraHeaders as Record<string, string>) ?? {}),
    };
    const token = this.opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchImpl = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        // Cookies are needed for the refresh endpoint; harmless elsewhere.
        credentials: 'include',
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
      });
    } catch {
      // fetch() rejects on network-level failure (server unreachable, DNS,
      // offline, CORS). The raw "Failed to fetch" / "Load failed" is opaque —
      // surface a plain, actionable message instead (status 0 = no response).
      throw new ApiError(0, 'NETWORK', "Can't reach the server. Check your connection and try again.");
    }

    // 204 No Content / empty body — return undefined as T.
    if (res.status === 204) return undefined as unknown as T;

    const text = await res.text();
    let parsed: unknown;
    // Non-JSON body almost always means a gateway/proxy error page (502/503/
    // 504) or the API being down — we surface a human message rather than
    // "Non-JSON response (502)". But note we do NOT throw here: this used to
    // return before the `!res.ok` block below, which meant a 401 delivered as
    // an HTML page (a WAF, a captive portal, or a proxy answering for the api)
    // never reached the refresh path at all. onRefreshFailed could then never
    // fire, so a genuinely dead session was retried forever instead of logging
    // out. The status is what decides the auth handling; the body shape only
    // decides the error we end up throwing.
    let unparseable = false;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      unparseable = true;
    }
    if (unparseable && res.ok) {
      throw new ApiError(res.status, 'BAD_RESPONSE', friendlyHttpMessage(res.status));
    }

    if (!res.ok) {
      // Auto-refresh path: if we got a 401 on a request that wasn't
      // already a retry, AND we sent a token (refresh only helps for
      // expired-token cases — not for endpoints that simply require
      // auth and we never had one), try to refresh and replay the
      // request with the new token. /auth/refresh itself is exempt
      // — refreshing a refresh would be silly and would loop.
      if (
        res.status === 401 &&
        !isRetry &&
        token !== null &&
        !path.startsWith('/auth/refresh') &&
        !path.startsWith('/auth/login') &&
        !path.startsWith('/auth/logout') &&
        !path.startsWith('/auth/register') &&
        !path.startsWith('/auth/quick-login/redeem')
      ) {
        const refresh = await this.tryRefresh();
        if (refresh.accessToken !== null) {
          return this.request<T>(method, path, body, extraHeaders, true);
        }
        // Only a 401/403 from /auth/refresh proves the session is gone. A
        // network blip, a 5xx mid-deploy, or a lost rotation race must NOT wipe
        // the user's credentials — we let this one request fail and keep the
        // tokens, so the next call (or the next retry) can recover.
        if (refresh.fatal) this.opts.onRefreshFailed?.();
      }
      // Body wasn't JSON: the auth handling above has run on the status, which
      // is all it needs; there is no error envelope to read, so fall back to
      // the friendly message for this status.
      if (unparseable) {
        throw new ApiError(res.status, 'BAD_RESPONSE', friendlyHttpMessage(res.status));
      }
      const err = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
      // When the body has no standard { error } envelope (e.g. login's
      // top-level { requires2FA: true } 401), surface the whole parsed object
      // as `details` so callers can read those flags, and fall back to a
      // human message instead of a bare "HTTP 401".
      const topLevelDetails =
        !err && parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : undefined;
      throw new ApiError(
        res.status,
        err?.code ?? 'UNKNOWN',
        err?.message ?? friendlyHttpMessage(res.status),
        err?.details ?? topLevelDetails,
      );
    }
    return parsed as T;
  }

  // ── Auth ────────────────────────────────────────────────────────────────

  register(input: {
    email: string;
    username: string;
    displayName: string;
    password: string;
    /** Date of birth, YYYY-MM-DD. Required: the server age-gates under-13. */
    dateOfBirth: string;
    /** Signup code. Required when the instance is invite-only; ignored
        otherwise. */
    code?: string;
  }): Promise<AuthSession> {
    return this.request('POST', '/auth/register', input);
  }

  login(input: { email: string; password: string; code?: string }): Promise<AuthSession> {
    return this.request('POST', '/auth/login', input);
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/logout');
  }

  // ── Quick login (log in on another device) ──────────────────────────────
  // DEPRECATED — the logged-in device mints a code that a logged-out device
  // redeems, so the displayed code IS the credential and anyone who reads it
  // off the screen takes the account. Superseded by the device-login methods
  // below. Kept only because shipped iOS/Android builds still call these; see
  // the delete checklist in apps/api/src/routes/auth.ts.

  /** [authed] Mint (or re-randomize) a short-lived, single-use quick-login
      code for the current user. Does NOT change this device's session.
      @deprecated use the device-login flow. */
  generateQuickLoginCode(): Promise<QuickLoginCode> {
    return this.request('POST', '/auth/quick-login/create');
  }
  /** [authed] Invalidate the current user's active quick-login code — call on
      leaving the quick-login section.
      @deprecated use denyDeviceLogin. */
  cancelQuickLoginCode(): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/quick-login/cancel');
  }
  /** [public] Redeem a quick-login code on a logged-out device → a new session
      (same envelope as login; the server also sets the refresh cookie).
      @deprecated use pollDeviceLogin. */
  redeemQuickLoginCode(code: string): Promise<AuthSession> {
    return this.request('POST', '/auth/quick-login/redeem', { code });
  }

  // ── Device-approval login ("approve this login on your phone") ──────────
  // The inverse, and the flow to build against. The LOGGED-OUT device calls
  // startDeviceLogin + pollDeviceLogin; the logged-in phone calls
  // lookupDeviceLogin then approveDeviceLogin / denyDeviceLogin.
  //
  // HANDLING RULES FOR THE NEW DEVICE — these are not optional:
  //   * Display `userCode` (and QR it). NEVER display, QR, log or persist
  //     `deviceCode`; keep it in memory for the life of the attempt only.
  //   * Poll no faster than the CURRENT `interval`, and adopt the new interval
  //     whenever a response carries one (`slow_down` raises it).
  //   * `approved` is delivered exactly once — persist the session on receipt
  //     or it is gone.

  /** [public] Open a device-login request from a logged-out device. Send the
      body even when you have no label (`{}` is fine). */
  startDeviceLogin(input: { deviceName?: string } = {}): Promise<DeviceLoginStart> {
    return this.request('POST', '/auth/device-login/start', input);
  }
  /** [public] Ask for the outcome, presenting the SECRET deviceCode. Never
      throws for pending/denied/expired — check `status`. */
  pollDeviceLogin(deviceCode: string): Promise<DeviceLoginPollResult> {
    return this.request('POST', '/auth/device-login/poll', { deviceCode });
  }
  /** [authed] On the logged-in phone: what is this code asking for? Feed the
      returned metadata to the approval screen — it is the only defence against
      an attacker phishing an approval out of the user. 404 when unknown or
      expired. */
  lookupDeviceLogin(userCode: string): Promise<DeviceLoginRequestInfo> {
    return this.request('POST', '/auth/device-login/lookup', { userCode });
  }
  /** [authed] Approve: bind the request to the current user and log that
      device in. Terminal. 409 if it was already answered. */
  approveDeviceLogin(userCode: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/device-login/approve', { userCode });
  }
  /** [authed] Deny. Terminal. */
  denyDeviceLogin(userCode: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/device-login/deny', { userCode });
  }

  // ── WebAuthn passkeys ───────────────────────────────────────────────────
  // `options` is the @simplewebauthn options JSON; the web app feeds it to
  // startRegistration/startAuthentication and posts the result back. Typed
  // unknown here so the shared client carries no WebAuthn dependency.
  passkeyRegisterOptions(): Promise<{ challengeId: string; options: unknown }> {
    return this.request('POST', '/auth/passkey/register/options');
  }
  passkeyRegisterVerify(input: {
    challengeId: string;
    response: unknown;
    deviceName?: string;
    /** Step-up: the account password, re-verified server-side before the
        new credential is stored (adding a login factor is sensitive). */
    currentPassword: string;
  }): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/passkey/register/verify', input);
  }
  passkeyLoginOptions(): Promise<{ challengeId: string; options: unknown }> {
    return this.request('POST', '/auth/passkey/login/options');
  }
  passkeyLoginVerify(input: { challengeId: string; response: unknown }): Promise<AuthSession> {
    return this.request('POST', '/auth/passkey/login/verify', input);
  }
  listPasskeys(): Promise<{ passkeys: PasskeyInfo[] }> {
    return this.request('GET', '/auth/passkey');
  }
  /** Step-up: removing a login factor requires the account password. */
  deletePasskey(id: string, currentPassword: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/auth/passkey/${id}`, { currentPassword });
  }

  /**
   * Initiate a password reset for the given email. The server
   * always returns ok regardless of whether the email exists —
   * the UI should show a generic "if an account exists with this
   * email you'll get a link" message rather than revealing the
   * answer. Rate-limited server-side (3/hour per IP and per
   * email); subsequent calls within the window also return ok.
   */
  forgotPassword(input: { email: string }): Promise<{ ok: boolean; message: string }> {
    return this.request('POST', '/auth/forgot-password', input);
  }

  /**
   * Complete a password reset using a token from the email. On
   * success the server has rotated the password AND revoked all
   * existing sessions — the user must log in again with the new
   * password.
   */
  resetPassword(input: { token: string; newPassword: string }): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/reset-password', input);
  }

  /** Whether this deployment enforces email verification (SMTP set up). */
  emailVerificationRequired(): Promise<{ required: boolean }> {
    return this.request('GET', '/auth/email-verification-required');
  }

  /** Consume a signup verification token (from the emailed link). */
  verifyEmail(token: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/verify-email', { token });
  }

  /** Resend the verification email to the logged-in user. */
  resendVerification(): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/resend-verification');
  }

  /** Correct the email on a NOT-YET-VERIFIED account (escape hatch for a
      typo at signup) and re-send the verification link. Verified accounts
      must use the password-gated change-email flow instead. */
  changeUnverifiedEmail(email: string): Promise<{ ok: boolean; email: string }> {
    return this.request('POST', '/auth/change-unverified-email', { email });
  }

  // ── Users ───────────────────────────────────────────────────────────────

  getMe(): Promise<{ user: SelfUser }> {
    return this.request('GET', '/users/@me');
  }

  patchMe(
    patch: Partial<
      Pick<
        SelfUser,
        | 'displayName'
        | 'bio'
        | 'status'
        | 'customStatus'
        | 'locale'
        | 'avatarUrl'
        | 'bannerUrl'
        | 'avatarDecoration'
        | 'dmReadReceiptsEnabled'
        | 'allowDmsFromServerMembers'
        | 'publicKey'
        | 'achievementsPublic'
        | 'notifyAchievements'
        | 'notifyReactions'
        | 'showSubscriptionTier'
        | 'tagLabel'
        | 'tagColor'
        | 'staffColor'
        | 'staffGlow'
      >
    >,
  ): Promise<{ user: SelfUser }> {
    return this.request('PATCH', '/users/@me', patch);
  }

  /**
   * One-time self-service date-of-birth set / correction. Allowed only while
   * `canChangeDob` is true; it re-locks after a successful change. Dedicated
   * endpoint (not patchMe) because it's gated + single-use.
   */
  updateDateOfBirth(dateOfBirth: string): Promise<{ user: SelfUser }> {
    return this.request('PATCH', '/users/@me/date-of-birth', { dateOfBirth });
  }

  /**
   * Persist the user's preferred guild rail ordering. Accepts the
   * FULL ordered list — not deltas — because the list is small and
   * the client always knows the canonical order it wants.
   *
   * The server filters out ids that aren't current memberships and
   * de-dupes, then returns the sanitized array. The client should
   * use the returned `guildOrder` to update its local state so any
   * filter-outs (e.g. a guild the user just left in another tab)
   * are reflected. Fire-and-forget callers can ignore the return.
   */
  setGuildOrder(guildIds: string[]): Promise<{ guildOrder: string[] }> {
    return this.request('PATCH', '/users/@me/guild-order', { guildIds });
  }

  /** Replace the user's full set of rail folders. Pass the entire
      desired folder list — partial updates aren't supported because
      folder ids and contents can shift in interrelated ways (moving
      a guild between folders, deleting a folder, etc.) and a single
      atomic write is simpler to reason about. Returns the server-
      sanitized list (folders with no valid members are dropped, see
      the route comment). */
  updateGuildFolders(folders: GuildFolder[]): Promise<{ folders: GuildFolder[] }> {
    return this.request('PATCH', '/users/@me/guild-folders', { folders });
  }

  /** Recent @-mentions of the authenticated user, newest first.
      Returns full Message DTOs augmented with guildId + channelName
      so the client can build navigation links without resolving the
      channel separately. `before` paginates older. */
  listMentions(opts: { before?: string; limit?: number } = {}): Promise<{
    mentions: Array<Message & { guildId: string | null; channelName: string | null }>;
  }> {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/users/@me/mentions${qs ? `?${qs}` : ''}`);
  }

  /** Zero out every channel's mention_count for the current user.
      Server dispatches CHANNEL_ACK per affected channel so other
      tabs / devices drop the badges in real time. Returns the count
      of channels that had pending mentions. */
  clearMentions(): Promise<{ cleared: number }> {
    return this.request('POST', '/users/@me/mentions/clear');
  }

  /** Dismiss a single mention from the inbox (the one-row counterpart to
      clearMentions). Removes the (message, user) row; idempotent. */
  deleteMention(messageId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/mentions/${messageId}`);
  }

  /**
   * Upload an image to use as the current user's avatar. The server
   * stores the file via the same uploads pipeline used for chat
   * attachments and patches user.avatarUrl in one call. Accepted
   * types: PNG, JPEG, GIF, WebP. Use `patchMe({ avatarUrl: null })`
   * to clear an existing avatar without uploading anything.
   */
  uploadAvatar(file: File): Promise<{ user: SelfUser }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', '/users/@me/avatar', fd);
  }

  /**
   * Upload + set the current user's profile banner. Same pattern as
   * uploadAvatar — single multipart request stores the file and
   * patches user.bannerUrl. Accepted types: PNG, JPEG, GIF, WebP.
   * Use `patchMe({ bannerUrl: null })` to clear without uploading.
   */
  uploadBanner(file: File): Promise<{ user: SelfUser }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', '/users/@me/banner', fd);
  }

  /**
   * Change the current user's password. Server requires the current
   * password (rotation guard) and the new password (subject to the
   * same complexity rules as signup). `revokeOtherSessions` defaults
   * true server-side — strongly recommended after a password change
   * since old sessions might be on devices the user no longer
   * controls.
   */
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions?: boolean;
  }): Promise<{ ok: boolean; revokedSessions?: number }> {
    return this.request('POST', '/users/@me/password', input);
  }

  /**
   * Permanently close the signed-in account. Irreversible: the user row is
   * deleted, every session is revoked, and authored messages are de-identified.
   * Step-up gated — the current password is required, plus a TOTP or recovery
   * code when 2FA is armed.
   *
   * Rejects with a 400 if the user still owns an active server; they must
   * transfer or delete it first.
   */
  deleteAccount(input: {
    password: string;
    totpCode?: string;
  }): Promise<{ deleted: boolean }> {
    return this.request('DELETE', '/users/@me', input);
  }

  // ── Active sessions ────────────────────────────────────────────────────
  // Every device currently logged in as the current user. The server stamps
  // exactly one entry with `current: true` — trust that flag rather than
  // trying to match the local token against the list.

  /** List the current user's logged-in sessions. */
  listSessions(): Promise<{ sessions: SessionInfo[] }> {
    return this.request('GET', '/users/@me/sessions');
  }

  /**
   * Revoke a single session, signing that device out. Passing the current
   * session's id would sign the caller out of this device — UIs shouldn't
   * offer that; use `logout()` instead.
   */
  revokeSession(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/sessions/${id}`);
  }

  /** Revoke every session except the current one. */
  revokeOtherSessions(): Promise<{ ok: boolean }> {
    return this.request('DELETE', '/users/@me/sessions');
  }

  // ── Bots ──────────────────────────────────────────────────────────────
  // Bot accounts owned by the current user. The plaintext token is
  // returned ONLY by createBot + regenerateBotToken — store it
  // immediately, it can't be retrieved again.

  /** Create a bot. Returns the bot DTO + its plaintext token (shown once). */
  createBot(input: {
    username: string;
    displayName: string;
  }): Promise<{ bot: Bot; token: string }> {
    return this.request('POST', '/users/@me/bots', input);
  }

  /** List the bots the current user owns. */
  listBots(): Promise<{ bots: Bot[] }> {
    return this.request('GET', '/users/@me/bots');
  }

  /** Regenerate a bot's token. Invalidates the previous token. */
  regenerateBotToken(botId: string): Promise<{ token: string }> {
    return this.request('POST', `/users/@me/bots/${botId}/token`);
  }

  /** Update a bot's profile (display name, avatar path, bio). */
  updateBot(
    botId: string,
    patch: { displayName?: string; avatarUrl?: string | null; bio?: string | null },
  ): Promise<{ bot: Bot }> {
    return this.request('PATCH', `/users/@me/bots/${botId}`, patch);
  }

  /** Delete a bot permanently. */
  deleteBot(botId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/bots/${botId}`);
  }

  /** Add one of your bots (or any bot by id) to a guild. Requires
      MANAGE_GUILD on the target guild. */
  addBotToGuild(guildId: string, botId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/guilds/${guildId}/bots`, { botId });
  }

  /** Set or clear (url=null) a bot's event callback URL. Returns the
      signing secret once when a URL is set. */
  setBotEventConfig(
    botId: string,
    url: string | null,
  ): Promise<{ eventUrl: string | null; secret: string | null }> {
    return this.request('PUT', `/users/@me/bots/${botId}/event-config`, { url });
  }

  // ── Bot slash-commands ────────────────────────────────────────────────────

  /** Register a slash-command for a bot you own. Omit `guildId` for a global
   *  command, or scope it to one guild the bot is in. */
  registerBotCommand(
    botId: string,
    input: { name: string; description: string; guildId?: string },
  ): Promise<{ command: BotCommand }> {
    return this.request('POST', `/users/@me/bots/${botId}/commands`, input);
  }

  /** List the commands registered on a bot you own. */
  listBotCommands(botId: string): Promise<{ commands: BotCommand[] }> {
    return this.request('GET', `/users/@me/bots/${botId}/commands`);
  }

  /** Delete one of a bot's commands. */
  deleteBotCommand(botId: string, commandId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/bots/${botId}/commands/${commandId}`);
  }

  /** Commands available in a guild (every command whose bot is a member,
   *  guild-scoped or global) — for the composer's slash picker. */
  listGuildCommands(guildId: string): Promise<{ commands: GuildCommand[] }> {
    return this.request('GET', `/guilds/${guildId}/commands`);
  }

  /** Invoke `/<name> <args>` in a channel — delivers an interaction to the
   *  bot's callback. Returns the resolved bot + command name. */
  invokeCommand(
    guildId: string,
    input: { channelId: string; name: string; argText?: string },
  ): Promise<{ botName: string; commandName: string }> {
    return this.request('POST', `/guilds/${guildId}/commands/invoke`, input);
  }


  getUser(userId: string): Promise<{ user: PublicUser }> {
    return this.request('GET', `/users/${userId}`);
  }

  // ── Guilds ──────────────────────────────────────────────────────────────

  listGuilds(): Promise<{ guilds: Guild[] }> {
    return this.request('GET', '/guilds');
  }

  getGuild(guildId: string): Promise<{ guild: Guild }> {
    return this.request('GET', `/guilds/${guildId}`);
  }

  createGuild(input: { name: string; description?: string }): Promise<{ guild: Guild; defaultChannelId: string }> {
    return this.request('POST', '/guilds', input);
  }

  /** Download a full configuration backup (settings, roles, channel tree,
   *  role overrides, icon + banner) as an opaque JSON document. The caller
   *  treats the result as a blob to save to disk; the shape is owned by the
   *  server's guildBackup service. Requires MANAGE_GUILD. */
  exportGuild(guildId: string): Promise<unknown> {
    return this.request('GET', `/guilds/${guildId}/export`);
  }

  /** Restore a previously-exported backup as a BRAND-NEW guild owned by the
   *  caller (clone — never mutates an existing server). `backup` is the
   *  parsed JSON document produced by exportGuild. When `nameOverride` is
   *  given, the new server uses that name instead of the file's stored one. */
  importGuild(
    backup: unknown,
    nameOverride?: string,
  ): Promise<{ guild: Guild; defaultChannelId: string | null }> {
    const q = nameOverride && nameOverride.trim()
      ? `?name=${encodeURIComponent(nameOverride.trim())}`
      : '';
    return this.request('POST', `/guilds/import${q}`, backup);
  }

  patchGuild(
    guildId: string,
    input: Partial<
      Pick<
        Guild,
        | 'name'
        | 'description'
        | 'iconUrl'
        | 'bannerUrl'
        | 'systemChannelId'
        | 'afkChannelId'
        | 'afkTimeoutSeconds'
        | 'welcomeChannelId'
        | 'welcomeMessageEnabled'
        | 'welcomeMessageTemplate'
        | 'rulesContent'
      >
    >,
  ): Promise<{ guild: Guild }> {
    return this.request('PATCH', `/guilds/${guildId}`, input);
  }

  /**
   * Upload + set a guild's icon. Multipart upload, MANAGE_GUILD required
   * server-side. Accepted types: PNG, JPEG, GIF, WebP. Use
   * `patchGuild(id, { iconUrl: null })` to clear the icon.
   */
  uploadGuildIcon(guildId: string, file: File): Promise<{ guild: Guild }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', `/guilds/${guildId}/icon`, fd);
  }

  /**
   * Upload + set a guild's banner. Same shape as uploadGuildIcon,
   * different column. Banners appear at the top of the channel list
   * and on the discovery card.
   */
  uploadGuildBanner(guildId: string, file: File): Promise<{ guild: Guild }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', `/guilds/${guildId}/banner`, fd);
  }

  deleteGuild(guildId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}`);
  }

  leaveGuild(guildId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/guilds/${guildId}/leave`);
  }

  // ── Members ─────────────────────────────────────────────────────────────

  listMembers(guildId: string, opts: { limit?: number; after?: string } = {}): Promise<{ members: GuildMember[] }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.after) q.set('after', opts.after);
    const qs = q.toString();
    return this.request('GET', `/guilds/${guildId}/members${qs ? `?${qs}` : ''}`);
  }

  // ── Channels ────────────────────────────────────────────────────────────

  listGuildChannels(guildId: string): Promise<{ channels: Channel[] }> {
    return this.request('GET', `/guilds/${guildId}/channels`);
  }

  createGuildChannel(
    guildId: string,
    input: {
      type: 'guild_text' | 'guild_category' | 'guild_voice' | 'guild_stage' | 'guild_forum' | 'guild_link';
      name: string;
      parentId?: string | null;
      topic?: string | null;
      /** Required when type='guild_link'. Server validates http(s)
          scheme + ≤2048 chars + parseable. Ignored on other types. */
      linkUrl?: string;
    },
  ): Promise<{ channel: Channel }> {
    return this.request('POST', `/guilds/${guildId}/channels`, input);
  }

  /**
   * Edit a guild channel's name, topic, slowmode, parent (category), or
   * position. Only the fields you pass are updated; null on `topic` or
   * `parentId` clears them, undefined leaves them alone.
   */
  patchChannel(
    channelId: string,
    input: Partial<{
      name: string;
      topic: string | null;
      parentId: string | null;
      rateLimitPerUser: number;
      position: number;
      nsfw: boolean;
      /** Voice-channel only: disable voice (participants join muted). */
      voiceDisabled: boolean;
      /** Link-channel URL — only valid for guild_link rows. Same
          validation as create: http(s) + ≤2048 chars. */
      linkUrl: string;
    }>,
  ): Promise<{ channel: Channel }> {
    return this.request('PATCH', `/channels/${channelId}`, input);
  }

  /**
   * Bulk-reorder channels in a guild. Send the desired final state for
   * each channel that needs to move; the server applies all updates
   * atomically and dispatches CHANNEL_UPDATE events for the deltas.
   * Caller should send only the channels that actually changed —
   * unchanged channels can be omitted to reduce payload.
   */
  reorderChannels(
    guildId: string,
    channels: Array<{ id: string; position: number; parentId?: string | null }>,
  ): Promise<{ channels: Channel[] }> {
    return this.request('PATCH', `/guilds/${guildId}/channels/positions`, { channels });
  }

  deleteChannel(channelId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}`);
  }

  // ── Invites ─────────────────────────────────────────────────────────────

  createInvite(channelId: string, input: { maxUses?: number | null; ttlSeconds?: number | null } = {}): Promise<{ invite: Invite }> {
    return this.request('POST', `/channels/${channelId}/invites`, input);
  }

  /** Public preview of an invite — no auth required. The /invite/:code
      landing page calls this to render server name/icon/banner/member
      count before asking the visitor to sign in or sign up. */
  previewInvite(code: string): Promise<{ invite: InvitePreview }> {
    return this.request('GET', `/invites/${code}`);
  }

  acceptInvite(code: string): Promise<{ guildId: string; channelId: string }> {
    return this.request('POST', `/invites/${code}`);
  }

  /** List all active invites for a guild. Requires MANAGE_INVITES. */
  listGuildInvites(guildId: string): Promise<{ invites: Invite[] }> {
    return this.request('GET', `/guilds/${guildId}/invites`);
  }

  // ── Pinned messages ─────────────────────────────────────────────────────

  /**
   * List all pinned messages in a channel. Newest first; capped at 50
   * server-side. Returns the same Message DTO shape as listMessages.
   */
  listPinnedMessages(channelId: string): Promise<{ messages: Message[] }> {
    return this.request('GET', `/channels/${channelId}/pins`);
  }

  /**
   * Full-text search across a guild's messages, scoped server-side to the
   * channels the caller can view. `q` accepts natural search syntax (quoted
   * phrases, OR, -exclusion). Optional channel/author filters; keyset
   * pagination via `before`.
   */
  searchGuildMessages(
    guildId: string,
    opts: {
      q: string;
      channelId?: string;
      authorId?: string;
      before?: string;
      after?: string;
      limit?: number;
    },
  ): Promise<{ messages: Message[] }> {
    const qs = new URLSearchParams({ q: opts.q });
    if (opts.channelId) qs.set('channelId', opts.channelId);
    if (opts.authorId) qs.set('authorId', opts.authorId);
    if (opts.before) qs.set('before', opts.before);
    if (opts.after) qs.set('after', opts.after);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    return this.request('GET', `/guilds/${guildId}/messages/search?${qs.toString()}`);
  }

  /**
   * Pin a message. Requires MANAGE_MESSAGES on the channel. Idempotent
   * — pinning an already-pinned message is a no-op (returns the row).
   */
  pinMessage(channelId: string, messageId: string): Promise<{ message: Message }> {
    return this.request('PUT', `/channels/${channelId}/pins/${messageId}`);
  }

  /** Unpin a message. Same permission gate as pin. */
  unpinMessage(channelId: string, messageId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}/pins/${messageId}`);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Search messages in a channel by full-text content. Postgres FTS uses
   * `websearch_to_tsquery` so the query syntax is user-friendly: bare
   * keywords AND together, "quoted phrases" match exactly, OR / -word
   * are also accepted. Results capped at `limit` (default 50, max 100).
   */
  searchMessages(
    channelId: string,
    q: string,
    opts: {
      limit?: number;
      /** Filter to messages from a specific user. */
      authorId?: string;
      /** Snowflake — return only messages with id < this. */
      before?: string;
      /** Snowflake — return only messages with id > this. */
      after?: string;
    } = {},
  ): Promise<{ messages: Message[] }> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.authorId) params.set('author_id', opts.authorId);
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    return this.request('GET', `/channels/${channelId}/messages/search?${params}`);
  }

  /**
   * Cross-DM message search. Searches across every direct-message
   * conversation the caller is a recipient in — used by the DM-list
   * view's search affordance to find "that thing in some DM" without
   * having to remember which one.
   *
   * Same filters as searchMessages (q, limit, authorId, before,
   * after). Guild messages are NOT included — that surface stays
   * per-channel because guild visibility is permission-gated.
   */
  searchDirectMessages(
    q: string,
    opts: {
      limit?: number;
      authorId?: string;
      before?: string;
      after?: string;
    } = {},
  ): Promise<{ messages: Message[] }> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.authorId) params.set('author_id', opts.authorId);
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    return this.request('GET', `/users/@me/dms/search?${params}`);
  }

  // ── Voice preferences sync ──────────────────────────────────────────────

  /**
   * Fetch the saved voice-prefs blob for the current user. Shape is
   * opaque to the client lib — the web app owns the VoicePrefsState
   * type and casts on read. Empty object on first call (no prefs
   * ever saved).
   */
  getVoicePrefs(): Promise<{ voicePrefs: Record<string, unknown> }> {
    return this.request('GET', '/users/@me/voice-prefs');
  }

  /**
   * Write the voice-prefs blob. Full replacement, not patch — the
   * web client always sends the entire current state. Body size is
   * capped server-side at 32 KB.
   */
  updateVoicePrefs(voicePrefs: Record<string, unknown>): Promise<{
    voicePrefs: Record<string, unknown>;
  }> {
    return this.request('PATCH', '/users/@me/voice-prefs', { voicePrefs });
  }

  // ── Push notifications ──────────────────────────────────────────────────

  /**
   * Fetch the server's VAPID public key. Browsers need it to call
   * `pushManager.subscribe()`. `enabled: false` means the server admin
   * hasn't configured push — the UI should hide the subscribe button
   * with a "your admin hasn't enabled push notifications" hint.
   */
  getPushPublicKey(): Promise<{ key: string | null; enabled: boolean }> {
    return this.request('GET', '/users/push/public-key');
  }

  /**
   * Register a browser-issued push subscription. Idempotent on endpoint
   * — re-subscribing from the same browser overwrites the existing row.
   */
  subscribePush(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    label?: string;
  }): Promise<{ subscription: { id: string; label: string | null; createdAt: string } }> {
    return this.request('POST', '/users/@me/push-subscriptions', input);
  }

  /**
   * List the current user's push subscriptions for the "your devices"
   * settings section. Auth secret + p256dh aren't returned — the
   * server keeps those out of the payload.
   */
  listPushSubscriptions(): Promise<{
    subscriptions: Array<{
      id: string;
      label: string | null;
      createdAt: string;
      lastUsedAt: string;
      /** Hex SHA-256 of the push endpoint URL — match against this
          browser's own PushSubscription.endpoint to find its row. */
      endpointHash: string;
    }>;
  }> {
    return this.request('GET', '/users/@me/push-subscriptions');
  }

  /** Revoke a subscription by its row id. */
  deletePushSubscription(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/push-subscriptions/${id}`);
  }

  // ── Native push (APNs on iOS, FCM on Android) ───────────────────────────
  /**
   * Register this device's native push token — an APNs token (platform 'ios')
   * or an FCM registration token (platform 'android'). Idempotent on the token
   * server-side. Rejects with 503 if the server has no matching push config —
   * callers should swallow that (push just won't be available).
   */
  registerDeviceToken(input: {
    token: string;
    platform?: 'ios' | 'ios_voip' | 'android';
    label?: string;
  }): Promise<{
    deviceToken: { id: string; platform: string; label: string | null; createdAt: string };
  }> {
    return this.request('POST', '/users/@me/device-tokens', input);
  }

  /** Unregister an APNs device token (e.g. on logout). */
  unregisterDeviceToken(token: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/device-tokens/${encodeURIComponent(token)}`);
  }

  // ── Threads ─────────────────────────────────────────────────────────────

  /**
   * Start a thread anchored to a specific message in a guild text channel.
   * Idempotent on the anchor: a second call with the same channelId/
   * messageId returns the existing thread instead of creating a duplicate.
   * Permission: requires SEND_MESSAGES on the parent channel.
   */
  createThread(
    channelId: string,
    messageId: string,
    input?: { name?: string },
  ): Promise<{ channel: Channel }> {
    return this.request(
      'POST',
      `/channels/${channelId}/messages/${messageId}/threads`,
      input ?? {},
    );
  }

  /**
   * List active + archived threads under a parent channel. Active first,
   * then archived; capped at 50 server-side. Anyone with VIEW_CHANNEL on
   * the parent can list its threads.
   */
  listThreadsForChannel(channelId: string): Promise<{ threads: Channel[] }> {
    return this.request('GET', `/channels/${channelId}/threads`);
  }

  /**
   * Create a new post inside a forum channel. A post is a thread under
   * the forum (anchor-less; the first message inside the resulting
   * thread is the post body). Returns both the new post (channel) and
   * the initial message so the client can navigate into the post with
   * its content already known.
   *
   * Permissions: VIEW_CHANNEL + SEND_MESSAGES on the forum channel.
   */
  createForumPost(
    forumChannelId: string,
    input: {
      title: string;
      content: string;
      /** Optional auto-archive duration in minutes. Server accepts only
       *  the canonical preset values: 60, 1440, 4320, 10080. When
       *  omitted, defaults to 4320 (3 days) server-side. */
      autoArchiveMinutes?: 60 | 1440 | 4320 | 10080;
    },
  ): Promise<{ post: Channel; message: Message }> {
    return this.request('POST', `/channels/${forumChannelId}/posts`, input);
  }

  /**
   * List posts in a forum channel. Posts are returned in the same
   * order as listThreadsForChannel — active first, then archived,
   * newest first within each group. Capped at 50 server-side.
   *
   * Alias of listThreadsForChannel — kept as a separate method so the
   * call sites read naturally ("list posts in this forum") rather than
   * leaking the underlying thread-channel implementation detail.
   */
  listForumPosts(forumChannelId: string): Promise<{ threads: Channel[] }> {
    return this.request('GET', `/channels/${forumChannelId}/threads`);
  }

  /**
   * Archive a thread (or forum post — they're the same underlying
   * channel type). Archived threads become read-only: the message
   * stream switches to a banner-only view; new messages get rejected
   * server-side.
   *
   * Authorization: MANAGE_THREADS on the guild, OR being the post
   * creator (creator-self-cleanup affordance). Server enforces; the
   * client doesn't pre-check.
   *
   * Idempotent: archiving an already-archived thread is a no-op
   * server-side and returns the current channel state.
   */
  archiveThread(threadId: string): Promise<{ channel: Channel }> {
    return this.request('POST', `/channels/${threadId}/archive`, {});
  }

  /**
   * Unarchive a thread. Clears archived_at and refreshes the
   * last-activity timestamp so the freshly-revived thread doesn't
   * immediately re-archive on the next sweep tick.
   *
   * Same authorization as archiveThread. Idempotent.
   *
   * Note: posting a message to an archived thread also auto-
   * unarchives it (server-side bumpThreadActivity behavior). This
   * endpoint exists for the explicit "unarchive without posting"
   * case.
   */
  unarchiveThread(threadId: string): Promise<{ channel: Channel }> {
    return this.request('POST', `/channels/${threadId}/unarchive`, {});
  }

  /**
   * Mark a thread as resolved (complete / answered). Soft signal —
   * the thread stays open and accepting replies, just renders with
   * a checkmark. Authorization: thread creator OR MANAGE_THREADS.
   */
  resolveThread(threadId: string): Promise<{ channel: Channel }> {
    return this.request('POST', `/channels/${threadId}/resolve`, {});
  }

  unresolveThread(threadId: string): Promise<{ channel: Channel }> {
    return this.request('POST', `/channels/${threadId}/unresolve`, {});
  }

  // ── Relationships (friends, requests, blocks) ──────────────────────────

  /**
   * List every relationship the current user has — friends, pending
   * requests (incoming and outgoing), blocked users. Server returns
   * one flat list with a `type` discriminator so the client can group.
   *
   * `user.lastSeenAt` ("last online", ISO 8601) is present ONLY on
   * `type: 'friend'` rows — non-friends get null. It is the only endpoint
   * that serves it. Statuses here are already masked ('invisible' arrives
   * as 'offline'), and lastSeenAt stops advancing while its owner is
   * invisible, so neither field can unmask them.
   */
  listRelationships(): Promise<{
    relationships: Array<{
      type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked';
      createdAt: string;
      user: PublicUser;
    }>;
  }> {
    return this.request('GET', '/users/@me/relationships');
  }

  /**
   * Personal DM nicknames — the current user's private map of
   * { targetUserId: nickname }, shown in place of a user's name in direct
   * messages only. Fetch once at login and apply client-side.
   */
  getDmNicknames(): Promise<{ nicknames: Record<string, string> }> {
    return this.request('GET', '/users/@me/dm-nicknames');
  }

  /** Set (or replace) this user's personal DM nickname for `targetId`. */
  setDmNickname(targetId: string, nickname: string): Promise<{ nickname: string }> {
    return this.request('PUT', `/users/@me/dm-nicknames/${targetId}`, { nickname });
  }

  /** Clear this user's personal DM nickname for `targetId` (idempotent). */
  clearDmNickname(targetId: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/users/@me/dm-nicknames/${targetId}`);
  }

  /**
   * Send (or auto-accept reciprocal of) a friend request.
   * Returns the new relationship type — 'outgoing_request' for a fresh
   * request, 'friend' if there was already an incoming one to accept.
   */
  sendFriendRequest(targetId: string): Promise<{ type: 'outgoing_request' | 'friend' }> {
    return this.request('POST', '/users/@me/relationships/friends', { targetId });
  }

  /** Send a friend request by typed username (Friends view "Add friend"). */
  sendFriendRequestByUsername(
    username: string,
  ): Promise<{ type: 'outgoing_request' | 'friend' }> {
    return this.request('POST', '/users/@me/relationships/friends', { username });
  }

  /** Accept an incoming friend request. */
  acceptFriendRequest(targetId: string): Promise<{ ok: boolean }> {
    return this.request('PUT', `/users/@me/relationships/friends/${targetId}/accept`);
  }

  /**
   * Remove a friend, decline an incoming request, or cancel an outgoing
   * one. Server picks the right action based on the existing row type.
   */
  removeFriend(targetId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/relationships/friends/${targetId}`);
  }

  /** Block a user. Wipes any prior friendship/request state. */
  blockUser(targetId: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/users/@me/relationships/blocks', { targetId });
  }

  /** Unblock a user. Doesn't auto-friend. */
  unblockUser(targetId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/relationships/blocks/${targetId}`);
  }

  // ── Notification overrides (mute / level per guild or channel) ────────

  /**
   * List every notification override the current user has set. Used
   * to hydrate AppState on connect so badge counts respect mutes from
   * the first paint.
   */
  listNotificationOverrides(): Promise<{
    overrides: Array<{
      targetType: 'guild' | 'channel';
      targetId: string;
      level: 'all' | 'mentions' | 'nothing';
    }>;
  }> {
    return this.request('GET', '/users/@me/notification-settings');
  }

  /**
   * Upsert a notification override. Pass `level: null` to clear (back
   * to default 'all'). Pass `'nothing'` to mute. Server tracks per-guild
   * AND per-channel — channel overrides win when both exist.
   */
  setNotificationOverride(
    targetType: 'guild' | 'channel',
    targetId: string,
    level: 'all' | 'mentions' | 'nothing' | null,
  ): Promise<{ ok: boolean }> {
    return this.request('PUT', '/users/@me/notification-settings', {
      targetType,
      targetId,
      level,
    });
  }

  /** Revoke an invite. The code stops working immediately. */
  deleteInvite(code: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/invites/${code}`);
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /** List all roles in a guild. Sorted server-side by position desc. */
  listRoles(guildId: string): Promise<{ roles: Role[] }> {
    return this.request('GET', `/guilds/${guildId}/roles`);
  }

  /** Create a new role. Returns the full role row. */
  createRole(
    guildId: string,
    input: {
      name: string;
      color?: number;
      /** Decimal-string bitfield. Caller can't grant perms they lack. */
      permissions?: string;
      hoist?: boolean;
      mentionable?: boolean;
    },
  ): Promise<{ role: Role }> {
    return this.request('POST', `/guilds/${guildId}/roles`, input);
  }

  /**
   * Edit a role. All fields optional; only provided fields are changed.
   * Position can be edited here for single-role moves; for atomic
   * multi-role reorders use `reorderRoles`.
   */
  patchRole(
    guildId: string,
    roleId: string,
    input: Partial<{
      name: string;
      color: number;
      permissions: string;
      hoist: boolean;
      mentionable: boolean;
      position: number;
      selfAssignable: boolean;
      description: string | null;
    }>,
  ): Promise<{ role: Role }> {
    return this.request('PATCH', `/guilds/${guildId}/roles/${roleId}`, input);
  }

  /** Delete a role. Cannot be used on @everyone (id === guildId). */
  deleteRole(guildId: string, roleId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/roles/${roleId}`);
  }

  /**
   * Atomically reorder multiple roles in one request. `positions` is
   * the list of {id, position} pairs to update; roles not in the list
   * keep their current position. Caller must outrank every role moved.
   */
  reorderRoles(
    guildId: string,
    positions: Array<{ id: string; position: number }>,
  ): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/guilds/${guildId}/roles`, { positions });
  }

  // ── Members ─────────────────────────────────────────────────────────────

  /**
   * Edit a guild member's role set and/or timeout. Pass `roleIds` to
   * replace the entire role membership for that user (server diffs against
   * current state and applies add/remove). (Server nicknames were removed —
   * only the private DM nickname system remains.)
   */
  patchMember(
    guildId: string,
    userId: string,
    input: Partial<{
      roleIds: string[];
      /**
       * Timeout end-timestamp as ISO-8601, or null to clear. Server
       * caps at 28 days in the future and requires MODERATE_MEMBERS.
       * Past timestamps coerce to null (clear). Self-timeouts are
       * rejected — you can't lock yourself out of your own server.
       */
      communicationDisabledUntil: string | null;
    }>,
  ): Promise<{ member: GuildMember }> {
    return this.request('PATCH', `/guilds/${guildId}/members/${userId}`, input);
  }

  /**
   * Remove a member from a guild. Requires KICK_MEMBERS plus the
   * standard role-hierarchy guard (you must outrank the target).
   * Doesn't ban — the user can be re-invited.
   */
  kickMember(guildId: string, userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/members/${userId}`);
  }

  // ── Bans ────────────────────────────────────────────────────────────────
  //
  // Bans are stricter than kicks: the user is removed AND blocked from
  // re-joining via invite until unbanned. The list endpoint requires
  // BAN_MEMBERS on the target guild; create/delete additionally apply
  // the role-hierarchy guard (you can't ban someone with a higher
  // top-role than you, except as the guild owner).

  /** List all current bans for a guild. Requires BAN_MEMBERS. */
  listBans(guildId: string): Promise<{ bans: GuildBan[] }> {
    return this.request('GET', `/guilds/${guildId}/bans`);
  }

  /**
   * Ban a user. Idempotent — re-banning an already-banned user
   * refreshes the moderator + reason rather than failing. Reason is
   * optional; null/empty means "no recorded reason".
   */
  banMember(
    guildId: string,
    userId: string,
    input: { reason?: string | null } = {},
  ): Promise<{ ok: boolean }> {
    return this.request('PUT', `/guilds/${guildId}/bans/${userId}`, input);
  }

  /** Lift a ban. 404s if no ban exists for that user. */
  unbanMember(guildId: string, userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/bans/${userId}`);
  }

  // ── Reports / moderation triage ───────────────────────────────────────────

  /** File a report against a message or user. Open to any member. The
   *  reporter only gets an acknowledgment ({ ok, reportId }). */
  createReport(
    guildId: string,
    input: {
      targetType: 'message' | 'user';
      targetUserId?: string;
      messageId?: string;
      reason: 'spam' | 'harassment' | 'nsfw' | 'violence' | 'other';
      details?: string;
    },
  ): Promise<{ ok: boolean; reportId: string }> {
    return this.request('POST', `/guilds/${guildId}/reports`, input);
  }

  /** Moderation queue for a guild. Gated to moderators. Returns the
   *  reports plus the current open count (for a badge). Filter by status
   *  (default 'open') and/or report type; keyset-paginate with `before`. */
  listReports(
    guildId: string,
    opts: {
      status?: 'open' | 'resolved' | 'dismissed' | 'all';
      targetType?: 'message' | 'user';
      before?: string;
      limit?: number;
    } = {},
  ): Promise<{ reports: Report[]; openCount: number }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.targetType) qs.set('targetType', opts.targetType);
    if (opts.before) qs.set('before', opts.before);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.request('GET', `/guilds/${guildId}/reports${q ? `?${q}` : ''}`);
  }

  /**
   * Resolve or dismiss a report. Optionally take a moderation action against
   * the reported entity in the same step: `moderation: 'ban'` (needs
   * BAN_MEMBERS) bans the reported user, `'delete_message'` (needs
   * MANAGE_MESSAGES) deletes the reported message. Both also write their own
   * audit entries; a report.<action> audit entry records the decision.
   */
  handleReport(
    guildId: string,
    reportId: string,
    input: {
      action: 'resolve' | 'dismiss';
      note?: string;
      moderation?: 'none' | 'ban' | 'delete_message';
    },
  ): Promise<{ report: Report }> {
    return this.request('PATCH', `/guilds/${guildId}/reports/${reportId}`, input);
  }

  // ── Automod rules ───────────────────────────────────────────────────────
  //
  // Per-guild moderation rules that fire on message send. All four
  // endpoints require MANAGE_GUILD — automod configuration is a
  // server-admin concern, not a per-channel moderation concern.
  //
  // Rule type matrix (server-enforced limits in parentheses):
  //   word_blocklist  — patterns up to 100 entries, 200 chars each
  //   repeat_message  — schema reserved, not enforced in v1
  //   mention_spam    — schema reserved, not enforced in v1
  //
  // Actions:
  //   block               — reject message with AUTOMOD_BLOCKED
  //   block_and_timeout   — also apply timeoutSeconds (≤ 28 days)
  //                         to the sender via the existing timeout
  //                         mechanism; broadcasts a guildMemberUpdate

  /** List all automod rules for a guild. Requires MANAGE_GUILD. */
  listAutomodRules(guildId: string): Promise<{ rules: AutomodRule[] }> {
    return this.request('GET', `/guilds/${guildId}/automod-rules`);
  }

  /**
   * Create a new automod rule. `ruleType` is required; the other
   * fields default server-side (patterns: [], action: 'block',
   * enabled: true). When action is 'block_and_timeout',
   * timeoutSeconds is required.
   */
  createAutomodRule(
    guildId: string,
    input: {
      name: string;
      ruleType:
        | 'word_blocklist'
        | 'regex_pattern'
        | 'link_filter'
        | 'repeat_message'
        | 'mention_spam';
      patterns?: string[];
      threshold?: number;
      windowSeconds?: number;
      action?: 'block' | 'block_and_timeout' | 'log_only';
      timeoutSeconds?: number;
      exemptRoleIds?: string[];
      exemptChannelIds?: string[];
    },
  ): Promise<{ rule: AutomodRule }> {
    return this.request('POST', `/guilds/${guildId}/automod-rules`, input);
  }

  /**
   * Update an existing automod rule. All fields optional; only the
   * fields you pass get changed. Pass `null` to nullable fields
   * (threshold, windowSeconds, timeoutSeconds) to clear them.
   */
  updateAutomodRule(
    guildId: string,
    ruleId: string,
    input: Partial<{
      name: string;
      enabled: boolean;
      patterns: string[];
      threshold: number | null;
      windowSeconds: number | null;
      action: 'block' | 'block_and_timeout' | 'log_only';
      timeoutSeconds: number | null;
      exemptRoleIds: string[];
      exemptChannelIds: string[];
    }>,
  ): Promise<{ rule: AutomodRule }> {
    return this.request('PATCH', `/guilds/${guildId}/automod-rules/${ruleId}`, input);
  }

  /** Delete an automod rule. Hard delete; the rule is gone. */
  deleteAutomodRule(guildId: string, ruleId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/automod-rules/${ruleId}`);
  }

  // ── Audit log ───────────────────────────────────────────────────────────
  //
  // Read-only paginated view of audit_log_entries. Requires
  // VIEW_AUDIT_LOG. Pagination uses the entry id as a cursor — pass
  // the smallest id from the current page as `before` to fetch the
  // next page (entries are sorted DESC by id, which is monotonic
  // with time).

  /**
   * List audit-log entries for a guild. Returns up to `limit`
   * entries (default 50, max 100) older than the `before` cursor.
   * Optionally filter by action prefix (e.g. "member.", "automod.").
   */
  listAuditLog(
    guildId: string,
    opts: { before?: string; limit?: number; actionPrefix?: string; actorId?: string } = {},
  ): Promise<{ entries: AuditLogEntry[] }> {
    const qs = new URLSearchParams();
    if (opts.before !== undefined) qs.set('before', opts.before);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.actionPrefix !== undefined) qs.set('actionPrefix', opts.actionPrefix);
    if (opts.actorId !== undefined) qs.set('actorId', opts.actorId);
    const q = qs.toString();
    return this.request(
      'GET',
      `/guilds/${guildId}/audit-log${q ? `?${q}` : ''}`,
    );
  }

  /** Fetch the full audit log (chronological, up to a server cap) for
   *  download. `truncated` is true when the cap was hit. */
  exportAuditLog(
    guildId: string,
  ): Promise<{ exportedAt: string; guildId: string; truncated: boolean; entries: AuditLogEntry[] }> {
    return this.request('GET', `/guilds/${guildId}/audit-log/export`);
  }

  // ── Onboarding ──────────────────────────────────────────────────────────
  //
  // Members of guilds with rules_content configured start in
  // 'pending' state and must acknowledge before they can participate.
  // Acknowledgment is idempotent: re-POSTing for an already-active
  // member returns success with alreadyActive=true.

  /**
   * Acknowledge the guild's rules, flipping the member from
   * 'pending' to 'active'. Idempotent — `alreadyActive: true` in
   * the response means the user was already active (no state
   * change). The server also broadcasts a guildMemberUpdate which
   * updates the local member state via the existing reducer path.
   */
  acknowledgeOnboarding(guildId: string): Promise<{ ok: boolean; alreadyActive: boolean }> {
    return this.request('POST', `/guilds/${guildId}/onboarding/acknowledge`, {});
  }

  /**
   * Server-side onboarding member-state stats. Returns the count
   * of members currently in each state. Used by the Rules tab in
   * guild settings to show "N members are waiting to acknowledge"
   * accurately even when the local membersByGuild cache hasn't
   * loaded the full list yet. Requires MANAGE_GUILD.
   */
  getOnboardingStats(guildId: string): Promise<{ pending: number; active: number }> {
    return this.request('GET', `/guilds/${guildId}/onboarding/stats`);
  }

  // ── Self-assignable roles ───────────────────────────────────────────────
  //
  // Members can grant/revoke roles for themselves when an admin has
  // flagged the role `selfAssignable`. The `@me` literal in the path
  // means no possibility of cross-user grants — the server scopes
  // these endpoints to the authenticated caller only.

  /**
   * List the self-assignable roles in a guild. Returns roles in
   * position-DESC order (same as the regular role list). Any guild
   * member can call. Members with no roles to choose from will get
   * back an empty array — the Browse Roles UI shows a "no roles
   * available" empty state in that case.
   */
  listSelfAssignableRoles(guildId: string): Promise<{ roles: Role[] }> {
    return this.request('GET', `/guilds/${guildId}/self-assignable-roles`);
  }

  /**
   * Grant self the role. Idempotent — granting a role you already
   * have is a no-op success. Pending-onboarding members are blocked
   * with PENDING_ACKNOWLEDGMENT.
   */
  assignSelfRole(guildId: string, roleId: string): Promise<{ ok: boolean }> {
    return this.request('PUT', `/guilds/${guildId}/members/@me/roles/${roleId}`);
  }

  /** Revoke self the role. Symmetric to assignSelfRole. */
  revokeSelfRole(guildId: string, roleId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/members/@me/roles/${roleId}`);
  }

  // ── Scheduled events ────────────────────────────────────────────────────
  //
  // Read endpoints are open to any guild member. Write endpoints
  // require MANAGE_EVENTS. RSVP endpoints (PUT/DELETE rsvp) are
  // open to any active (non-pending-onboarding) member.

  /**
   * List events in a guild. Default returns scheduled + active
   * events ordered by start time ascending. Pass `includeArchived=true`
   * to include completed events; pass a specific `status` to narrow.
   *
   * Each event in the response includes `rsvpCounts` (going/maybe/declined
   * aggregate) and `myRsvp` (the caller's current RSVP, or null).
   */
  listGuildEvents(
    guildId: string,
    opts: {
      status?: 'scheduled' | 'active' | 'completed' | 'canceled';
      includeArchived?: boolean;
      limit?: number;
    } = {},
  ): Promise<{ events: ScheduledEvent[] }> {
    const qs = new URLSearchParams();
    if (opts.status !== undefined) qs.set('status', opts.status);
    if (opts.includeArchived !== undefined) qs.set('includeArchived', String(opts.includeArchived));
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.request('GET', `/guilds/${guildId}/events${q ? `?${q}` : ''}`);
  }

  /** Fetch one event by id, with creator + rsvpCounts + myRsvp. */
  getEvent(guildId: string, eventId: string): Promise<{ event: ScheduledEvent }> {
    return this.request('GET', `/guilds/${guildId}/events/${eventId}`);
  }

  /**
   * Create a new event. Requires MANAGE_EVENTS. `startAt` (ISO
   * string) must not be in the past; `endAt` (when provided) must
   * be after `startAt`. The `locationKind` + corresponding data
   * pair is validated server-side.
   */
  createEvent(
    guildId: string,
    input: {
      name: string;
      description?: string | null;
      startAt: string;
      endAt?: string | null;
      locationKind: 'voice_channel' | 'external';
      locationChannelId?: string | null;
      locationText?: string | null;
      imageUrl?: string | null;
    },
  ): Promise<{ event: ScheduledEvent }> {
    return this.request('POST', `/guilds/${guildId}/events`, input);
  }

  /**
   * Update an existing event. Requires MANAGE_EVENTS. All fields
   * optional; status transitions are validated server-side
   * (canceled and completed are terminal). Pass `status: 'canceled'`
   * to cancel.
   */
  updateEvent(
    guildId: string,
    eventId: string,
    input: Partial<{
      name: string;
      description: string | null;
      startAt: string;
      endAt: string | null;
      locationKind: 'voice_channel' | 'external';
      locationChannelId: string | null;
      locationText: string | null;
      status: 'scheduled' | 'active' | 'completed' | 'canceled';
      imageUrl: string | null;
    }>,
  ): Promise<{ event: ScheduledEvent }> {
    return this.request('PATCH', `/guilds/${guildId}/events/${eventId}`, input);
  }

  /** Hard-delete an event. Prefer status='canceled' for soft removal. */
  deleteEvent(guildId: string, eventId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/events/${eventId}`);
  }

  /**
   * RSVP to an event (UPSERT — sets or updates the caller's
   * status). Status one of 'going' | 'maybe' | 'declined'. Pending-
   * onboarding members get PENDING_ACKNOWLEDGMENT.
   */
  rsvpEvent(
    guildId: string,
    eventId: string,
    status: 'going' | 'maybe' | 'declined',
  ): Promise<{ ok: boolean }> {
    return this.request('PUT', `/guilds/${guildId}/events/${eventId}/rsvp`, { status });
  }

  /** Clear the caller's RSVP entirely (full un-RSVP). */
  clearEventRsvp(guildId: string, eventId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/events/${eventId}/rsvp`);
  }

  /**
   * Personal-dashboard list of upcoming events. Every event in every
   * guild the caller is currently a member of where the caller has
   * RSVP'd going-or-maybe and the event hasn't ended yet.
   *
   * Each item carries the event DTO plus minimal guild context
   * (name + iconUrl) so the cross-guild list can render guild
   * affiliation without forcing the caller to resolve the guild
   * from local state. Useful when state.guilds hasn't loaded yet
   * (e.g. on a deep-link entry) or when filtering by guildId at
   * render time would mis-order the list.
   *
   * Sorted by start_at ascending. Capped at 50 server-side.
   */
  listMyUpcomingEvents(): Promise<{
    events: Array<{
      event: ScheduledEvent;
      guildName: string;
      guildIconUrl: string | null;
    }>;
  }> {
    return this.request('GET', `/users/@me/events`);
  }

  /**
   * Upload a banner image for an event. Multipart file upload that
   * sets the event's imageUrl atomically + cleans up the prior file.
   * Requires MANAGE_EVENTS. Server broadcasts scheduledEventUpdate
   * so connected clients see the new banner live.
   *
   * Accepts: PNG / JPEG / GIF / WebP. Same content-type set as
   * guild icon upload.
   *
   * Hand-built fetch rather than the JSON `request` helper — that
   * one JSON.stringify's the body, which mangles FormData. Headers
   * are left bare so the browser sets the multipart boundary
   * automatically.
   */
  async uploadEventImage(
    guildId: string,
    eventId: string,
    file: File,
  ): Promise<{ event: ScheduledEvent }> {
    const form = new FormData();
    form.append('file', file);
    const fetchImpl = this.opts.fetch ?? fetch;
    const res = await fetchImpl(
      `${this.opts.baseUrl}/guilds/${guildId}/events/${eventId}/image`,
      {
        method: 'POST',
        credentials: 'include',
        body: form,
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new ApiError(
        res.status,
        (body.code as string) ?? 'UPLOAD_FAILED',
        (body.message as string) ?? 'Upload failed',
        body.detail as Record<string, unknown> | undefined,
      );
    }
    return res.json() as Promise<{ event: ScheduledEvent }>;
  }

  /**
   * Pre-create image upload — for the create-event flow where
   * there's no eventId to attach to yet. Saves the file to CDN
   * and returns just the URL; caller embeds the URL in the
   * subsequent createEvent body's imageUrl field.
   *
   * Same content-type whitelist as the per-event endpoint.
   * Requires MANAGE_EVENTS in the target guild.
   */
  async uploadEventImagePrecreate(
    guildId: string,
    file: File,
  ): Promise<{ url: string }> {
    const form = new FormData();
    form.append('file', file);
    const fetchImpl = this.opts.fetch ?? fetch;
    const res = await fetchImpl(
      `${this.opts.baseUrl}/guilds/${guildId}/event-image-uploads`,
      {
        method: 'POST',
        credentials: 'include',
        body: form,
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new ApiError(
        res.status,
        (body.code as string) ?? 'UPLOAD_FAILED',
        (body.message as string) ?? 'Upload failed',
        body.detail as Record<string, unknown> | undefined,
      );
    }
    return res.json() as Promise<{ url: string }>;
  }

  /**
   * List attendees (RSVPs joined with users) for an event. Open to
   * any guild member. Optional status filter narrows to e.g.
   * just-going for the "who's coming" tab. Defaults to all RSVPs
   * ordered by createdAt ascending (earliest-signups first).
   */
  listEventAttendees(
    guildId: string,
    eventId: string,
    opts: { status?: 'going' | 'maybe' | 'declined'; limit?: number } = {},
  ): Promise<{ attendees: EventRsvp[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.request(
      'GET',
      `/guilds/${guildId}/events/${eventId}/attendees${q ? `?${q}` : ''}`,
    );
  }

  // ── Custom emoji ────────────────────────────────────────────────────────
  //
  // Emoji are guild-scoped. Members can list (to render :name: in
  // messages), MANAGE_EMOJIS holders can upload/rename/delete. The
  // upload endpoint takes multipart form-data (file + name); rename
  // and delete are JSON.

  /** List all custom emoji for a guild. Any member may call. */
  listGuildEmojis(guildId: string): Promise<{ emojis: GuildEmoji[] }> {
    return this.request('GET', `/guilds/${guildId}/emojis`);
  }

  /**
   * Upload a new emoji. `name` must be 2–32 chars: lowercase letters,
   * digits, and underscores. `file` must be PNG/GIF/WebP and under
   * 512 KB. Server enforces a per-guild slot cap (50 by default).
   */
  uploadGuildEmoji(
    guildId: string,
    input: { name: string; file: File },
  ): Promise<{ emoji: GuildEmoji }> {
    const fd = new FormData();
    fd.append('name', input.name);
    fd.append('file', input.file, input.file.name);
    return this.request('POST', `/guilds/${guildId}/emojis`, fd);
  }

  /** Rename an existing emoji. 409 if the new name is taken. */
  renameGuildEmoji(
    guildId: string,
    emojiId: string,
    name: string,
  ): Promise<{ emoji: GuildEmoji }> {
    return this.request('PATCH', `/guilds/${guildId}/emojis/${emojiId}`, { name });
  }

  /** Delete an emoji. The on-disk file is left in place so existing
      reactions can still tombstone it; the row goes away. */
  deleteGuildEmoji(guildId: string, emojiId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/emojis/${emojiId}`);
  }

  // ── Stickers ────────────────────────────────────────────────────────────

  listGuildStickers(guildId: string): Promise<{ stickers: Sticker[] }> {
    return this.request('GET', `/guilds/${guildId}/stickers`);
  }

  /**
   * Upload a new sticker. `name` is 2-30 chars (free-form), `description`
   * optional ≤100 chars, `file` PNG/APNG/GIF/WebP under 512 KB. Per-guild
   * cap is 50 by default.
   */
  uploadGuildSticker(
    guildId: string,
    input: { name: string; description?: string | null; file: File },
  ): Promise<{ sticker: Sticker }> {
    const fd = new FormData();
    fd.append('name', input.name);
    if (input.description) fd.append('description', input.description);
    fd.append('file', input.file, input.file.name);
    return this.request('POST', `/guilds/${guildId}/stickers`, fd);
  }

  /** Rename and/or re-describe an existing sticker. 409 if the new name
      is taken. Pass `description: null` to clear the description. */
  patchGuildSticker(
    guildId: string,
    stickerId: string,
    patch: { name?: string; description?: string | null },
  ): Promise<{ sticker: Sticker }> {
    return this.request('PATCH', `/guilds/${guildId}/stickers/${stickerId}`, patch);
  }

  /** Delete a sticker. The on-disk file is also removed. */
  deleteGuildSticker(guildId: string, stickerId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/guilds/${guildId}/stickers/${stickerId}`);
  }

  // ── Stage channels ──────────────────────────────────────────────────────

  /** List participants currently in a stage channel. Visible to any
      member who can VIEW_CHANNEL. */
  listStageParticipants(
    channelId: string,
  ): Promise<{ channel: Channel; participants: StageParticipant[] }> {
    return this.request('GET', `/channels/${channelId}/stage`);
  }

  /** Join a stage channel. Returns a LiveKit token gated by the
      caller's speaker status — speakers get publish=true, audience
      get publish=false. Idempotent. */
  joinStage(
    channelId: string,
  ): Promise<{
    participant: StageParticipant;
    token: string | null;
    wsUrl: string | null;
  }> {
    return this.request('POST', `/channels/${channelId}/stage/join`);
  }

  /** Leave a stage channel. Idempotent. */
  leaveStage(channelId: string): Promise<void> {
    return this.request('POST', `/channels/${channelId}/stage/leave`);
  }

  /** Raise hand to request promotion to speaker. Audience only. */
  raiseHand(channelId: string): Promise<void> {
    return this.request('POST', `/channels/${channelId}/stage/hand`);
  }

  /** Lower a previously-raised hand. Idempotent. */
  lowerHand(channelId: string): Promise<void> {
    return this.request('DELETE', `/channels/${channelId}/stage/hand`);
  }

  /** Promote (true) or demote (false) a participant. Moderator-only. */
  setStageSpeaker(
    channelId: string,
    userId: string,
    isSpeaker: boolean,
  ): Promise<{ participant: StageParticipant }> {
    return this.request('POST', `/channels/${channelId}/stage/speakers`, {
      userId,
      isSpeaker,
    });
  }

  /** Update the stage's topic banner. Moderator-only. Pass null to clear. */
  setStageTopic(channelId: string, topic: string | null): Promise<{ channel: Channel }> {
    return this.request('PATCH', `/channels/${channelId}/stage/topic`, { topic });
  }

  // ── Server discovery ────────────────────────────────────────────────────

  /** Browse / search the public guild directory. Empty `q` returns the
      full list, sorted by member count desc. */
  listDiscoverable(input: {
    q?: string;
    category?: string;
    offset?: number;
  }): Promise<{ guilds: DiscoverableGuild[]; total: number }> {
    const params = new URLSearchParams();
    if (input.q) params.set('q', input.q);
    if (input.category) params.set('category', input.category);
    if (input.offset !== undefined) params.set('offset', input.offset.toString());
    const query = params.toString();
    return this.request('GET', `/discovery${query ? `?${query}` : ''}`);
  }

  /** Public-join a discoverable guild — no invite code required. */
  joinDiscoverable(guildId: string): Promise<{
    guildId: string;
    channelId: string | null;
    alreadyMember: boolean;
  }> {
    return this.request('POST', `/guilds/${guildId}/discovery/join`);
  }

  /** Toggle a guild's discoverable flag (owner / MANAGE_GUILD). Pass
      `discoveryDescription: null` to clear an existing description; omit
      to leave unchanged. Same convention applies to `discoveryCategory`. */
  setGuildDiscovery(
    guildId: string,
    input: {
      discoverable: boolean;
      discoveryDescription?: string | null;
      discoveryCategory?: string | null;
    },
  ): Promise<{ guild: Guild }> {
    return this.request('PATCH', `/guilds/${guildId}/discovery`, input);
  }

  // ── Channel permission overrides ────────────────────────────────────────

  /**
   * List per-channel overrides. Requires MANAGE_ROLES on the guild.
   * Returned overrides are NOT sorted — the resolver applies them in
   * a specific order (everyone → roles by ascending position → member),
   * but for editing purposes we display them grouped by target type.
   */
  listChannelOverrides(channelId: string): Promise<{ overrides: PermissionOverride[] }> {
    return this.request('GET', `/channels/${channelId}/permissions`);
  }

  /**
   * Set or update a per-channel override. `allow`/`deny` are decimal-
   * string bitfields; if both are 0n the override is deleted server-
   * side and the response carries `{ ok: true, deleted: true }`.
   */
  putChannelOverride(
    channelId: string,
    targetId: string,
    input: { type: 'role' | 'member'; allow?: string; deny?: string },
  ): Promise<{ override?: PermissionOverride; ok?: boolean; deleted?: boolean }> {
    return this.request('PUT', `/channels/${channelId}/permissions/${targetId}`, input);
  }

  /** Delete a per-channel override. */
  deleteChannelOverride(
    channelId: string,
    targetId: string,
    type: 'role' | 'member',
  ): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}/permissions/${targetId}?type=${type}`);
  }

  // ── Voice ───────────────────────────────────────────────────────────────

  /**
   * Join a voice channel. Server upserts the voice_state row, dispatches
   * VOICE_STATE_UPDATE to the guild, and returns the new state plus an
   * SFU connection token. Token is null until the LiveKit integration
   * round lands — the client should treat null as "presence only, no
   * audio yet" and surface a hint to the user.
   */
  joinVoice(channelId: string): Promise<{
    voiceState: VoiceState;
    channelVoiceStates: VoiceState[];
    token: string | null;
    wsUrl: string | null;
  }> {
    return this.request('POST', `/channels/${channelId}/voice/join`);
  }

  /**
   * Current occupants of a voice channel. Read-only and side-effect free, so
   * it is safe to poll while in a call.
   *
   * Exists because the roster is otherwise event-only: one missed
   * VOICE_STATE_UPDATE leaves someone audible but invisible with nothing to
   * heal it. Gated on VIEW_CHANNEL (not CONNECT) — seeing who is in a channel
   * is what the channel list already shows.
   */
  listVoiceStates(channelId: string): Promise<{ voiceStates: VoiceState[] }> {
    return this.request('GET', `/channels/${channelId}/voice/states`);
  }

  /** Everyone in voice across a whole server — the sidebar's heal, so a missed
   *  VOICE_STATE_UPDATE can't leave people invisible until someone joins. */
  listGuildVoiceStates(guildId: string): Promise<{ voiceStates: VoiceState[] }> {
    return this.request('GET', `/guilds/${guildId}/voice/states`);
  }

  /** Update self-mute / self-deaf flags on the user's current voice state. */
  updateVoiceState(
    channelId: string,
    patch: { selfMute?: boolean; selfDeaf?: boolean },
  ): Promise<{ voiceState: VoiceState }> {
    return this.request('POST', `/channels/${channelId}/voice/state`, patch);
  }

  /** Leave the given voice channel. Idempotent. */
  leaveVoice(channelId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}/voice`);
  }

  /**
   * Move a user from their current voice channel to another voice channel
   * in the same guild. Requires MOVE_MEMBERS on the source channel.
   * Used by the drag-and-drop affordance on voice participants.
   */
  moveVoiceMember(input: {
    userId: string;
    channelId: string;
  }): Promise<{ voiceState: VoiceState }> {
    return this.request('POST', '/channels/move', input);
  }

  /**
   * Decline an incoming 1:1 DM call. Server-side this finds the
   * caller (the other recipient currently in voice in this channel)
   * and ends their voice session, which propagates a voice-state
   * update to both sides — the caller's client tears down, the
   * recipient's incoming-call surface disappears. Returns 200 even
   * when there's no call to decline (idempotent).
   */
  declineCall(channelId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/channels/${channelId}/voice/decline`);
  }

  // ── Messages ────────────────────────────────────────────────────────────

  listMessages(
    channelId: string,
    opts: { before?: string; after?: string; around?: string; limit?: number } = {},
  ): Promise<{ messages: Message[] }> {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.after) q.set('after', opts.after);
    if (opts.around) q.set('around', opts.around);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
  }

  /**
   * Poke/nudge the other party in a 1:1 DM. Creates no message and doesn't
   * clutter the DM; it arrives back as a live POKE gateway event (+ a big-emoji
   * push for a closed app) and is recorded in a small bounded history (see
   * listPokes). Server throttles to one poke per target per 10s. `pokeType` is
   * one of poke | heart | wave | like | fire.
   */
  poke(channelId: string, pokeType: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/channels/${channelId}/poke`, { pokeType });
  }

  /**
   * Recent pokes RECEIVED by the current user on a 1:1 DM, newest first, capped
   * at 6. Feeds the poke button's history popover.
   */
  listPokes(channelId: string): Promise<{ pokes: PokeHistoryEntry[] }> {
    return this.request('GET', `/channels/${channelId}/pokes`);
  }

  /**
   * Send a message. With `files` present, switches to multipart/form-data
   * with a `payload_json` field plus `files[N]` parts — the same shape the
   * Discord protocol uses, and what the API expects in `routes/messages.ts`
   * for single-step uploads.
   */
  sendMessage(
    channelId: string,
    input: {
      content: string;
      replyToId?: string | null;
      files?: File[];
      /** Optional poll attachment. The message can have empty content
          when a poll is present — the poll IS the message. */
      poll?: {
        question: string;
        options: string[];
        multipleChoice?: boolean;
        durationHours: number;
      };
      /** When set, the message is a forward of the referenced source.
          The server validates the caller can read the source channel
          before letting the forward through. The caller can supply
          their own `content` alongside (a comment on the forward). */
      forwardFromMessageId?: string;
      /** When set, this message attaches the referenced sticker. The
          sticker must belong to the destination channel's guild;
          server returns 400 otherwise. Sticker is mutually exclusive
          with attachments / polls / forwards. */
      stickerId?: string;
      /** When set, the FIRST file in `files` is treated as a voice
          message. Server requires exactly one audio file in files,
          no text content, and no other body shape (poll/sticker/
          forward) when this is provided. */
      voiceMessage?: { durationSeconds: number; waveform: string };
      /** Client echo token — returned in the MESSAGE_CREATE gateway
          event so the sender can reconcile its optimistic placeholder
          without a duplicate flash. */
      nonce?: string;
      /** Per-file client metadata, POSITIONAL to `files` (entry k describes
          files[k], may be null). Carries plaintext image dims so E2EE (.zke)
          images — which the server can't measure — reserve the slot on the
          recipient before decrypt, and `hasThumbnail` when a `thumbs[k]` part
          is present. */
      attachmentsMeta?: ({ width?: number; height?: number; hasThumbnail?: boolean } | null)[];
      /** Per-file ENCRYPTED thumbnail, POSITIONAL to `files` (null when none).
          Uploaded as a sparse `thumbs[k]` part for E2EE images. */
      thumbs?: (File | null)[];
    },
  ): Promise<{ message: Message }> {
    const files = input.files ?? [];
    if (files.length === 0) {
      return this.request('POST', `/channels/${channelId}/messages`, {
        content: input.content,
        replyToId: input.replyToId,
        ...(input.poll ? { poll: input.poll } : {}),
        ...(input.forwardFromMessageId ? { forwardFromMessageId: input.forwardFromMessageId } : {}),
        ...(input.stickerId ? { stickerId: input.stickerId } : {}),
        ...(input.nonce ? { nonce: input.nonce } : {}),
      });
    }
    const fd = new FormData();
    fd.append(
      'payload_json',
      JSON.stringify({
        content: input.content,
        replyToId: input.replyToId ?? null,
        ...(input.poll ? { poll: input.poll } : {}),
        ...(input.forwardFromMessageId ? { forwardFromMessageId: input.forwardFromMessageId } : {}),
        ...(input.stickerId ? { stickerId: input.stickerId } : {}),
        ...(input.voiceMessage ? { voiceMessage: input.voiceMessage } : {}),
        ...(input.nonce ? { nonce: input.nonce } : {}),
        ...(input.attachmentsMeta ? { attachments: input.attachmentsMeta } : {}),
      }),
    );
    for (let i = 0; i < files.length; i++) {
      // Server reads `files[N]` so this naming is part of the contract.
      fd.append(`files[${i}]`, files[i]!, files[i]!.name);
    }
    // Sparse encrypted thumbnails, positional to files[i] (E2EE images only).
    if (input.thumbs) {
      for (let i = 0; i < input.thumbs.length; i++) {
        const t = input.thumbs[i];
        if (t) fd.append(`thumbs[${i}]`, t, t.name);
      }
    }
    return this.request('POST', `/channels/${channelId}/messages`, fd);
  }

  // ── Polls ──────────────────────────────────────────────────────────────

  /** Cast a vote on a poll option. For single-choice polls, this
      retracts any prior vote on the same poll. For multi-choice, it's
      idempotent. The server broadcasts a MESSAGE_UPDATE on success. */
  voteOnPoll(channelId: string, pollId: string, optionId: string): Promise<void> {
    return this.request('POST', `/channels/${channelId}/polls/${pollId}/options/${optionId}/vote`);
  }

  /** Retract a single vote. No-op if the vote doesn't exist. */
  removePollVote(channelId: string, pollId: string, optionId: string): Promise<void> {
    return this.request('DELETE', `/channels/${channelId}/polls/${pollId}/options/${optionId}/vote`);
  }

  /** End a poll early. Caller must be the message author OR have
      MANAGE_MESSAGES on the channel. */
  endPoll(channelId: string, pollId: string): Promise<void> {
    return this.request('POST', `/channels/${channelId}/polls/${pollId}/end`);
  }

  editMessage(channelId: string, messageId: string, content: string): Promise<{ message: Message }> {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
  }

  deleteMessage(channelId: string, messageId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * Resolve a single link preview for a URL found in a DECRYPTED E2EE message.
   * The server can't unfurl ciphertext, so the client decrypts, extracts URLs,
   * and asks the server to resolve each one (the server reuses the same
   * SSRF-protected fetcher as the normal embed pipeline). Returns
   * `{ embed: null }` when no preview could be built.
   */
  unfurl(url: string): Promise<{ embed: MessageEmbed | null }> {
    return this.request('GET', `/unfurl?url=${encodeURIComponent(url)}`);
  }

  /**
   * Soft-delete every message in a channel. Restricted server-side to
   * MANAGE_MESSAGES holders. Returns `{ deleted, done }` — `done`
   * goes false if the server hit its per-call cap (1000 rows) and
   * the caller should re-invoke until `done === true`. Channels with
   * no messages return `{ deleted: 0, done: true }` immediately.
   */
  purgeChannel(channelId: string): Promise<{ deleted: number; done: boolean }> {
    return this.request('POST', `/channels/${channelId}/messages/purge`);
  }

  // ── Two-factor authentication ─────────────────────────────────────────────

  /** Read 2FA status for the current user. */
  getTwoFactorStatus(): Promise<{ enabled: boolean; verifiedAt: string | null; recoveryRemaining: number }> {
    return this.request('GET', '/users/@me/totp');
  }

  /** Begin enrollment. Returns the secret + an otpauth:// URI for QR
      rendering. The user MUST call confirmTwoFactor with a valid
      code from their authenticator app to complete enrollment. */
  beginTwoFactor(): Promise<{ secret: string; otpauthUri: string }> {
    return this.request('POST', '/users/@me/totp/begin');
  }

  /** Confirm enrollment with a TOTP code. On success, 2FA is enabled
      and recovery codes are returned. Show the codes to the user
      ONCE; the server only stores their hashes. */
  confirmTwoFactor(code: string, currentPassword: string): Promise<{ recoveryCodes: string[] }> {
    return this.request('POST', '/users/@me/totp/confirm', { code, currentPassword });
  }

  /** Disable 2FA. Requires a current TOTP code OR a recovery code. */
  disableTwoFactor(code: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/users/@me/totp/disable', { code });
  }

  // ── Reaction roles ──────────────────────────────────────────────────────

  listReactionRoles(guildId: string): Promise<{ items: ReactionRoleMapping[] }> {
    return this.request('GET', `/guilds/${guildId}/reaction-roles`);
  }

  /**
   * Create or replace a reaction-role mapping. The (messageId, emoji)
   * tuple is the natural key; passing the same tuple with a new
   * roleId redirects the mapping rather than erroring.
   */
  upsertReactionRole(
    guildId: string,
    input: { messageId: string; channelId: string; emoji: string; roleId: string },
  ): Promise<{ ok: boolean }> {
    return this.request('PUT', `/guilds/${guildId}/reaction-roles`, input);
  }

  deleteReactionRole(
    guildId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ ok: boolean }> {
    const params = new URLSearchParams({ messageId, emoji });
    return this.request('DELETE', `/guilds/${guildId}/reaction-roles?${params.toString()}`);
  }

  startTyping(channelId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/channels/${channelId}/typing`);
  }

  // ── Reactions ───────────────────────────────────────────────────────────

  addReaction(channelId: string, messageId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  removeReaction(channelId: string, messageId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  // ── DMs ─────────────────────────────────────────────────────────────────

  openDM(recipientId: string): Promise<{ channel: Channel }> {
    return this.request('POST', '/users/@me/channels', { recipientId });
  }

  /**
   * Close (delete) a DM from the caller's side. The other recipient
   * isn't affected — their channel and history persist. If the caller
   * later opens a DM with the same person, a new channel is created.
   */
  closeDM(channelId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/@me/channels/${channelId}`);
  }

  listDMs(): Promise<{ channels: Channel[] }> {
    return this.request('GET', '/users/@me/channels');
  }

  // ── DM auto-delete settings ────────────────────────────────────────────
  //
  // Per-DM TTL. Read with getDmSettings; set/clear with updateDmSettings.
  // The TTL applies to BOTH recipients of the DM — it's a property of
  // the conversation, not a per-user preference. Either party can
  // change it; the change shows up live on the other side via the
  // DM_SETTINGS_UPDATE gateway event.

  /**
   * Read the auto-delete TTL for a DM channel. Returns
   * `{ ttlSecondsAfterRead: null }` when auto-delete is off (the
   * default for any DM that has never been configured).
   */
  getDmSettings(
    channelId: string,
  ): Promise<{ ttlSecondsAfterRead: number | null; notificationShowContent: boolean | null }> {
    return this.request('GET', `/users/@me/channels/${channelId}/settings`);
  }

  /**
   * Set THIS user's notification-preview preference for a DM (private; not
   * shared with the other recipient). `showContent`: true = show sender +
   * content in pushes, false = generic "New message", null = revert to the
   * default (E2EE generic, plaintext shows content).
   */
  setDmNotificationPreview(
    channelId: string,
    showContent: boolean | null,
  ): Promise<{ notificationShowContent: boolean | null }> {
    return this.request(
      'PATCH',
      `/users/@me/channels/${channelId}/notification-preview`,
      { showContent },
    );
  }

  /**
   * Update the auto-delete TTL for a DM channel. Pass null to turn
   * auto-delete off; otherwise a positive integer in [10, 86400]
   * seconds. Returns the new value as confirmed by the server.
   *
   * Disabling does NOT undelete already-deleted messages or clear
   * viewed_at timestamps — it just stops the sweep from acting on
   * future expirations.
   */
  updateDmSettings(
    channelId: string,
    ttlSecondsAfterRead: number | null,
  ): Promise<{ ttlSecondsAfterRead: number | null }> {
    return this.request(
      'PATCH',
      `/users/@me/channels/${channelId}/settings`,
      { ttlSecondsAfterRead },
    );
  }

  /**
   * Enable shared-key E2EE on this DM. The caller has derived the
   * key locally from a passphrase; we send the PBKDF2 salt and the
   * SHA-256 verifier of the derived key. Server stores them so the
   * other participant can rederive the same key from the same
   * passphrase and verify they typed it correctly.
   *
   * Calling on an already-enabled DM rotates the password — the
   * previous verifier is overwritten and the previous password
   * becomes uncheckable (so anyone with only the OLD password is
   * locked out).
   */
  enableDmE2ee(
    channelId: string,
    salt: string,
    verifier: string,
  ): Promise<{ ok: true }> {
    return this.request(
      'PUT',
      `/users/@me/channels/${channelId}/e2ee-enable`,
      { salt, verifier },
    );
  }

  /**
   * Disable E2EE on this DM AND PURGE all encrypted messages in the
   * conversation. Both participants see the disable and lose access
   * to historic encrypted messages — they're hard-deleted server-
   * side. Re-enabling later generates a fresh salt; the old
   * password is permanently dead.
   *
   * Requires `verifier` — the SHA-256 verifier derived from the
   * caller's LOCAL key (proof they know the passphrase). The server
   * rejects a missing/wrong verifier, so the conversation must be
   * unlocked on this device before it can be turned off.
   */
  disableDmE2ee(
    channelId: string,
    verifier: string,
  ): Promise<{ ok: true; purgedCount: number }> {
    return this.request(
      'DELETE',
      `/users/@me/channels/${channelId}/e2ee-disable`,
      { verifier },
    );
  }

  // ── Saved messages (bookmarks) ──────────────────────────────────────────

  /**
   * Save a message to the caller's bookmarks. Idempotent — re-saving
   * an already-saved message succeeds with no error.
   */
  saveMessage(messageId: string): Promise<{ ok: true }> {
    return this.request('POST', `/users/@me/saved/${messageId}`);
  }

  /**
   * Unsave a message. Idempotent — unsaving an unsaved message
   * succeeds with no error.
   */
  unsaveMessage(messageId: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/users/@me/saved/${messageId}`);
  }

  /**
   * Paginated list of saved messages, newest save first. Each item
   * is a hydrated Message DTO plus the channel summary needed to
   * render context ("Saved from #general · Today at 3:14 PM").
   *
   * `cursor` is the savedAt ISO of the last item from the previous
   * page; pass it back to get the next page. Initial call omits.
   */
  listSavedMessages(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: Array<{
      savedAt: string;
      message: Message;
      channel: {
        id: string;
        type: string;
        name: string | null;
        guildId: string | null;
      } | null;
    }>;
    nextCursor: string | null;
  }> {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set('cursor', opts.cursor);
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.request('GET', `/users/@me/saved${q ? '?' + q : ''}`);
  }

  /**
   * Bulk membership check. Returns which of the given message ids
   * the caller has saved. Used on initial channel load to render
   * the bookmark icon as filled for already-saved messages.
   */
  savedMembership(messageIds: string[]): Promise<{ savedIds: string[] }> {
    if (messageIds.length === 0) return Promise.resolve({ savedIds: [] });
    const ids = messageIds.join(',');
    return this.request(
      'GET',
      `/users/@me/saved/members?ids=${encodeURIComponent(ids)}`,
    );
  }

  // ── Scheduled messages ──────────────────────────────────────────────────

  /**
   * Schedule a message for future delivery. Returns the scheduled-row
   * id (NOT the eventual message id — the real message snowflake is
   * minted at send time by the worker). On the user's "scheduled
   * messages" list, this id is the cancel-by handle.
   */
  scheduleMessage(
    channelId: string,
    input: {
      content: string;
      scheduledFor: string;
      replyToMessageId?: string | null;
    },
  ): Promise<{
    scheduled: {
      id: string;
      channelId: string;
      content: string;
      scheduledFor: string;
      replyToMessageId: string | null;
      attempts: number;
      lastError: string | null;
      createdAt: string;
    };
  }> {
    return this.request(
      'POST',
      `/channels/${channelId}/scheduled-messages`,
      input,
    );
  }

  /** List the caller's pending scheduled messages, soonest-first. */
  listScheduledMessages(): Promise<{
    items: Array<{
      id: string;
      channelId: string;
      content: string;
      attachments: unknown[];
      replyToMessageId: string | null;
      scheduledFor: string;
      attempts: number;
      lastError: string | null;
      createdAt: string;
    }>;
  }> {
    return this.request('GET', '/users/@me/scheduled-messages');
  }

  /** Cancel a scheduled message. Idempotent. */
  cancelScheduledMessage(id: string): Promise<{ ok: true }> {
    return this.request('DELETE', `/users/@me/scheduled-messages/${id}`);
  }

  // ── Account changes (username + email) ──────────────────────────────────

  /**
   * Change the user's username. 90-day cooldown enforced server-side.
   * Requires the current password as re-confirmation.
   */
  changeUsername(input: {
    username: string;
    currentPassword: string;
  }): Promise<{ user: SelfUser }> {
    return this.request('PATCH', '/users/@me/username', input);
  }

  /**
   * Read the user's username-change eligibility. Used by the UI to
   * render "you can change again in N days" without firing a write.
   */
  getUsernameChangeEligibility(): Promise<{
    eligible: boolean;
    remainingMs: number;
    nextEligibleAt: string | null;
  }> {
    return this.request('GET', '/users/@me/username-change-eligibility');
  }

  /**
   * Request a change to the user's email. Server validates the
   * password + new email, sends a verification link to the NEW
   * address. Returns the link's expiry in minutes so the UI can
   * inform the user.
   */
  requestEmailChange(input: {
    newEmail: string;
    currentPassword: string;
  }): Promise<{ ok: true; expiresInMinutes: number }> {
    return this.request('POST', '/users/@me/email/change-request', input);
  }

  /**
   * Confirm an email change via the token from the verification
   * email. Public endpoint — doesn't require an auth header (the
   * token itself is the credential).
   */
  confirmEmailChange(token: string): Promise<{ ok: true; newEmail: string }> {
    return this.request('POST', '/auth/confirm-email-change', { token });
  }

  // ── Custom status ───────────────────────────────────────────────────────

  /**
   * Set or clear the custom status. Any combination of text/emoji
   * may be supplied; pass null to clear that field. To clear the
   * whole status, pass all three as null. Reuses the broader
   * PATCH /@me endpoint, just narrowed to the status-shaped fields.
   */
  setCustomStatus(opts: {
    text?: string | null;
    emoji?: string | null;
    expiresAt?: string | null;
  }): Promise<{ user: SelfUser }> {
    const body: Record<string, unknown> = {};
    if ('text' in opts) body.customStatus = opts.text;
    if ('emoji' in opts) body.customStatusEmoji = opts.emoji;
    if ('expiresAt' in opts) body.customStatusExpiresAt = opts.expiresAt;
    return this.request('PATCH', '/users/@me', body);
  }

  /**
   * Acknowledge a message in a channel — moves the user's read marker
   * forward (the server refuses backwards moves so an older messageId is
   * a no-op for the marker but always resets mentionCount to 0).
   */
  ack(channelId: string, messageId: string): Promise<{ readState: ReadState }> {
    return this.request('POST', `/channels/${channelId}/messages/${messageId}/ack`);
  }

  listReadStates(): Promise<{ readStates: ReadState[] }> {
    return this.request('GET', '/users/@me/read-states');
  }

  // ── Webhooks ────────────────────────────────────────────────────────────
  //
  // Channel-scoped incoming webhooks. All admin endpoints require
  // MANAGE_WEBHOOKS on the channel; the public execute endpoint at
  // /api/webhooks/:id/:token (NOT under /api/v1) is token-gated and
  // unauthed — anyone with the URL can post.

  /** List all webhooks for a channel. Caller needs MANAGE_WEBHOOKS. */
  listChannelWebhooks(channelId: string): Promise<{ webhooks: Webhook[] }> {
    return this.request('GET', `/channels/${channelId}/webhooks`);
  }

  /** Create a webhook. Returns the row including the secret token —
      treat as a secret. The server-side service generates the token. */
  createWebhook(
    channelId: string,
    input: { name: string; avatarUrl?: string | null },
  ): Promise<{ webhook: Webhook }> {
    return this.request('POST', `/channels/${channelId}/webhooks`, input);
  }

  /** Update a webhook's display name and/or avatar URL. Pass `null`
      to clear the avatar. Pass undefined to leave a field unchanged. */
  patchWebhook(
    webhookId: string,
    input: { name?: string; avatarUrl?: string | null },
  ): Promise<{ webhook: Webhook }> {
    return this.request('PATCH', `/webhooks/${webhookId}`, input);
  }

  /** Upload an image as the webhook's avatar (multipart). Stores the file
   *  and sets the webhook's avatar to its /cdn/ path in one request. */
  uploadWebhookAvatar(webhookId: string, file: File): Promise<{ webhook: Webhook }> {
    const fd = new FormData();
    fd.append('file', file);
    return this.request('POST', `/webhooks/${webhookId}/avatar`, fd);
  }

  /** Delete a webhook. Token instantly stops working. No undo. */
  deleteWebhook(webhookId: string): Promise<void> {
    return this.request('DELETE', `/webhooks/${webhookId}`);
  }

  // ── Instance admin ──────────────────────────────────────────────────────
  //
  // All admin endpoints reject non-admin callers with 403. The client
  // hides the admin route unless `selfUser.isAdmin` is true, but the
  // server is the source of truth — these methods will throw with a
  // FORBIDDEN ApiError if the gate fails.

  adminStats(): Promise<{ stats: AdminStats }> {
    return this.request('GET', '/admin/stats');
  }

  /** Operational/runtime metrics (gateway connections, uptime, voice,
   *  scheduled backlog, DB/Redis health). Instance-admin gated. */
  adminMetrics(): Promise<{ metrics: InstanceMetrics }> {
    return this.request('GET', '/admin/metrics');
  }

  /** Download an instance-wide configuration backup — every guild's config
   *  backup bundled into one document. Instance-admin gated. `includeImages`
   *  defaults to true; pass false for a smaller config-only bundle. */
  adminExportBackup(includeImages = true): Promise<{ backup: InstanceBackup }> {
    return this.request('GET', `/admin/backup?includeImages=${includeImages ? 'true' : 'false'}`);
  }

  /** Restore an instance backup — rebuilds each guild as a NEW guild owned by
   *  the restoring admin (never mutates existing guilds). Per-guild
   *  best-effort; the result lists each guild's outcome. Instance-admin gated. */
  adminRestoreBackup(backup: unknown): Promise<{ created: InstanceRestoreResult[] }> {
    return this.request('POST', '/admin/backup/restore', backup);
  }

  /** On-disk backup bundles written by scripts/backup.sh on the host, plus the
   *  last maintenance job the host agent ran. Reporting only — the API never
   *  takes or deletes a backup (that needs the host). Instance-admin gated. */
  adminBackupStatus(): Promise<HostBackupStatus> {
    return this.request('GET', '/admin/backups');
  }

  /** Ask the HOST to run one maintenance action. Queued, not immediate: the
   *  agent polls once a minute. Instance-admin gated. */
  adminRunMaintenance(
    action:
      | 'backup'
      | 'backup-full'
      | 'verify'
      | 'restore'
      | 'update'
      | 'restart'
      | 'schedule-on'
      | 'schedule-off'
      | 'doctor',
    /** Restore only, and required for it: the exact bundle filename. A restore
     *  replaces the whole database, so naming the bundle IS the confirmation —
     *  there is deliberately no "restore the latest one" shortcut. */
    file?: string,
  ): Promise<{ queued: boolean; action: string }> {
    return this.request('POST', '/admin/maintenance', file ? { action, file } : { action });
  }

  // ── Admin: instance security ──────────────────────────────────────────────

  adminSecurityConfig(): Promise<{ config: SecurityConfig }> {
    return this.request('GET', '/admin/security/config');
  }

  adminPatchSecurityConfig(patch: Partial<SecurityConfig>): Promise<{ config: SecurityConfig }> {
    return this.request('PATCH', '/admin/security/config', patch);
  }

  /** `kind: 'staff'` is a meta-filter matching every staff_* audit kind. */
  adminSecurityEvents(opts: { kind?: 'spam_limited' | 'banned_word' | 'watch_word' | 'staff'; before?: string; limit?: number } = {}): Promise<{ events: SecurityEvent[] }> {
    const q = new URLSearchParams();
    if (opts.kind) q.set('kind', opts.kind);
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/admin/security/events${qs ? `?${qs}` : ''}`);
  }

  adminSecurityWords(): Promise<{ words: SecurityWord[] }> {
    return this.request('GET', '/admin/security/words');
  }

  /** Add (or move) a word. severity 'blocked' = hard block; 'watch' = alert
      only. Omitting severity defaults to 'blocked' (back-compat). */
  adminAddSecurityWord(
    word: string,
    severity: SecurityWord['severity'] = 'blocked',
  ): Promise<{ words: SecurityWord[] }> {
    return this.request('POST', '/admin/security/words', { word, severity });
  }

  adminRemoveSecurityWord(word: string): Promise<{ words: SecurityWord[] }> {
    return this.request('DELETE', `/admin/security/words/${encodeURIComponent(word)}`);
  }

  /** The common moderation wordlist (read-only; nothing added). */
  adminSecurityWordPreset(): Promise<{ words: string[] }> {
    return this.request('GET', '/admin/security/words/preset');
  }

  /** Bulk-load the common wordlist (insert-only, duplicates skipped). Slurs
      file as 'blocked', general profanity as 'watch'. */
  adminLoadSecurityWordPreset(): Promise<{ added: number; words: SecurityWord[] }> {
    return this.request('POST', '/admin/security/words/preset');
  }

  // ── Achievements ──────────────────────────────────────────────────────────

  myAchievements(): Promise<AchievementsResponse> {
    return this.request('GET', '/users/@me/achievements');
  }

  userAchievements(userId: string): Promise<AchievementsResponse> {
    return this.request('GET', `/users/${userId}/achievements`);
  }

  /** A channel's attachments newest-first for the shared-media gallery,
      paginated by attachment id (`before` cursor). Fetched unfiltered; the
      caller buckets Media vs Files (so E2EE `.zke` items classify by their
      inner filename). */
  channelAttachments(
    channelId: string,
    before?: string,
  ): Promise<{ attachments: Attachment[] }> {
    const q = new URLSearchParams({ limit: '60' });
    if (before) q.set('before', before);
    return this.request('GET', `/channels/${channelId}/attachments?${q.toString()}`);
  }

  adminListUsers(opts: {
    q?: string;
    before?: string;
    limit?: number;
    bannedOnly?: boolean;
  } = {}): Promise<{ users: AdminUser[] }> {
    const q = new URLSearchParams();
    if (opts.q) q.set('q', opts.q);
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.bannedOnly) q.set('bannedOnly', 'true');
    const qs = q.toString();
    return this.request('GET', `/admin/users${qs ? `?${qs}` : ''}`);
  }

  /** Ban an account for a duration (default permanent). Covers text + voice. */
  adminBanUser(
    userId: string,
    duration: '1m' | '3m' | '6m' | 'perm' = 'perm',
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/ban`, { duration });
  }

  adminUnbanUser(userId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/unban`);
  }

  /** Reopen a user's one-time date-of-birth change (e.g. wrong age at signup). */
  adminResetDobLock(userId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/reset-dob-lock`);
  }

  // Account Info (Admin → Users → an account) ------------------------------
  // Admin-only unless noted. Moderators get mute/unmute and notes (the server
  // enforces this; the UI just doesn't offer the rest).

  /** [ADMIN] The full account record: email, DOB, sessions, counts, state. */
  adminGetAccount(userId: string): Promise<{ account: AdminAccount }> {
    return this.request('GET', `/admin/users/${userId}`);
  }

  /** [ADMIN] Friends, requests, blocks and 1:1 DM partners. Audited. */
  adminGetAccountContacts(userId: string): Promise<AdminAccountContacts> {
    return this.request('GET', `/admin/users/${userId}/contacts`);
  }

  /** [ADMIN] Rename. Doesn't use up the owner's own 90-day allowance. */
  adminSetUsername(userId: string, username: string): Promise<{ ok: boolean; username: string }> {
    return this.request('PATCH', `/admin/users/${userId}/username`, { username });
  }

  /** [ADMIN] Change email (marked verified; the old address is notified). */
  adminSetEmail(userId: string, email: string): Promise<{ ok: boolean; oldAddressNotified: boolean }> {
    return this.request('PATCH', `/admin/users/${userId}/email`, { email });
  }

  /** [ADMIN] Set date of birth (YYYY-MM-DD, 13+). Re-locks it. */
  adminSetDateOfBirth(userId: string, dateOfBirth: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/admin/users/${userId}/date-of-birth`, { dateOfBirth });
  }

  /** [ADMIN] Email the owner a reset link and sign them out everywhere. */
  adminSendPasswordReset(userId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/password-reset`);
  }

  /** [ADMIN + MOD] Mute: can read, can't post, react or talk. */
  adminMuteUser(
    userId: string,
    duration: AdminMuteDuration,
  ): Promise<{ ok: boolean; mutedUntil: string | null }> {
    return this.request('POST', `/admin/users/${userId}/mute`, { duration });
  }

  /** [ADMIN + MOD] Lift a mute. */
  adminUnmuteUser(userId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/unmute`);
  }

  /** [ADMIN + MOD] Staff notes on an account, newest first. */
  adminListNotes(userId: string): Promise<{ notes: StaffNote[] }> {
    return this.request('GET', `/admin/users/${userId}/notes`);
  }

  /** [ADMIN + MOD] Add a staff note (1–2000 chars). */
  adminAddNote(
    userId: string,
    body: string,
  ): Promise<{ ok: boolean; note: { id: string; body: string; createdAt: string } }> {
    return this.request('POST', `/admin/users/${userId}/notes`, { body });
  }

  /** [ADMIN + MOD] Delete a note — moderators only their own. */
  adminDeleteNote(userId: string, noteId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/admin/users/${userId}/notes/${noteId}`);
  }

  /**
   * [ADMIN ONLY] Who this user exchanges 1:1 DMs with, whether they are friends,
   * and how many messages each conversation holds.
   *
   * Never includes message content — counts and identity only. Moderators cannot
   * reach this: the admin router's moderator allowlist is fail-safe and this
   * route is deliberately absent from it.
   */
  async adminUserDmPeers(userId: string): Promise<AdminDmPeersResponse> {
    return this.request('GET', `/admin/users/${userId}/dm-peers`);
  }

  // Legacy paid subscriptions (payments were removed 2026-10-02) -----------

  /** Stripe Billing Portal for a subscription bought before payments were
      removed (cancel / card details); redirect the browser to `url`. */
  createBillingPortal(): Promise<{ url: string }> {
    return this.request('POST', '/billing/portal');
  }

  /** Cancel own leftover paid subscription at period end. */
  cancelSubscription(): Promise<{ ok: boolean; endsAt: string | null }> {
    return this.request('POST', '/billing/cancel');
  }

  /** ADMIN: how many leftover paid subscriptions are still billing. */
  adminPaidSubscriptions(): Promise<{ active: number }> {
    return this.request('GET', '/admin/paid-subscriptions');
  }

  /** ADMIN: turn every leftover paid subscription into a forever tier and
      cancel its Stripe billing. */
  adminRetirePaidSubscriptions(): Promise<{ converted: number; cancelFailures: number }> {
    return this.request('POST', '/admin/paid-subscriptions/retire');
  }

  /** Give (or re-give — overwrites) a perk tier. */
  adminGiftSubscription(
    userId: string,
    tier: 'scout' | 'guardian' | 'legend',
    duration: '1m' | '3m' | '6m' | 'forever',
  ): Promise<{ ok: boolean; subscription: { tier: string; expiresAt: string | null } }> {
    return this.request('POST', `/admin/users/${userId}/subscription`, { tier, duration });
  }

  /** Remove a user's perk tier. Cosmetics are free, so nothing else changes. */
  adminRemoveSubscription(userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/admin/users/${userId}/subscription`);
  }

  // Perks (admin-configurable; the route keeps its old "monetization" name) -

  /** What each perk tier unlocks on this instance. Any signed-in user may
      read it; clients fetch it at login and gate locally. */
  getMonetization(): Promise<{ config: MonetizationConfig }> {
    return this.request('GET', '/instance/monetization');
  }

  /** ADMIN: update perk settings (full config or any subset).
      Responds with the post-update effective config. */
  adminUpdateMonetization(
    config: MonetizationConfigPatch,
  ): Promise<{ config: MonetizationConfig }> {
    return this.request('PUT', '/admin/monetization', { config });
  }

  /** Set a user's instance role. The two flags are mutually exclusive
   *  server-side; 'none' clears both. Admin-only. */
  adminSetUserRole(
    userId: string,
    role: 'administrator' | 'moderator' | 'none',
  ): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/role`, { role });
  }

  /** Force-logout: revoke all sessions for a user without banning them. */
  adminLogoutUser(userId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/admin/users/${userId}/logout`);
  }

  /** Permanently delete a user account (hard delete). */
  adminDeleteUser(userId: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/admin/users/${userId}`);
  }

  adminListGuilds(opts: { q?: string; limit?: number } = {}): Promise<{ guilds: AdminGuild[] }> {
    const q = new URLSearchParams();
    if (opts.q) q.set('q', opts.q);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/admin/guilds${qs ? `?${qs}` : ''}`);
  }

  /** Instance-level force-delete of a guild. Bypasses the owner check. */
  adminDeleteGuild(guildId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/admin/guilds/${guildId}`);
  }

  adminStorage(): Promise<{ storage: AdminStorage }> {
    return this.request('GET', '/admin/storage');
  }

  /** Per-file storage listing (paginated, 50/page) with sizes,
   *  categories, compression state, and used/unused flags. */
  adminStorageItems(opts?: {
    page?: number;
    category?: StorageCategory | 'all';
    sort?: 'size' | 'recent';
    q?: string;
    guildId?: string;
  }): Promise<StorageListing> {
    const qs = new URLSearchParams();
    if (opts?.page) qs.set('page', String(opts.page));
    if (opts?.category) qs.set('category', opts.category);
    if (opts?.sort) qs.set('sort', opts.sort);
    if (opts?.q) qs.set('q', opts.q);
    if (opts?.guildId) qs.set('guildId', opts.guildId);
    const q = qs.toString();
    return this.request('GET', `/admin/storage/items${q ? `?${q}` : ''}`);
  }

  /** Delete one stored file (by attachment id) from disk. */
  adminDeleteStorageItem(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/admin/storage/items/${id}`);
  }

  /** Re-compress one stored image on the server to reclaim space. */
  adminCompressStorageItem(
    id: string,
  ): Promise<{ changed: boolean; beforeBytes: number; afterBytes: number }> {
    return this.request('POST', `/admin/storage/items/${id}/compress`);
  }

  /** Run the unused-file GC sweep on demand. */
  adminStorageGc(): Promise<{ scanned: number; deleted: number }> {
    return this.request('POST', '/admin/storage/gc');
  }

  /** Recent registrations + guild creations for the overview feed. */
  adminActivity(): Promise<{ activity: AdminActivity }> {
    return this.request('GET', '/admin/activity');
  }

  /**
   * Ghost-mode: peek at a guild's metadata + channel list without
   * joining as a member. The admin remains undetectable — no
   * membership row is created, no presence broadcast happens.
   */
  adminPeekGuild(guildId: string): Promise<{
    guild: AdminPeekGuild;
    channels: AdminPeekChannel[];
  }> {
    return this.request('GET', `/admin/guilds/${guildId}/peek`);
  }

  /**
   * Ghost-mode: read a channel's recent messages with a simplified
   * DTO (no mentions, polls, forwards, or sticker bodies — just
   * content + author + attachments + reaction tallies). Returns
   * voiceChannel:true and an empty messages array for voice/stage
   * channels (no backlog to observe).
   */
  adminPeekChannelMessages(
    channelId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<{ messages: AdminPeekMessage[]; voiceChannel: boolean }> {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request(
      'GET',
      `/admin/channels/${channelId}/peek/messages${qs ? `?${qs}` : ''}`,
    );
  }

  // ── Family / parental controls ──────────────────────────────────────────

  /** Current user's supervision summary (who they supervise / who
      supervises them, plus pending requests in each direction). */
  familyMe(): Promise<FamilySummary> {
    return this.request('GET', '/family/me');
  }

  /** Parent: request to supervise a child account by username. */
  familyRequestLink(username: string): Promise<{ child: FamilyUser }> {
    return this.request('POST', '/family/links', { username });
  }

  /** Child: accept a pending supervision request from a parent. */
  familyAcceptLink(parentId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/links/${parentId}/accept`);
  }

  /** Either party: end a supervision link (or cancel/decline a request). */
  familyRemoveLink(otherId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/family/links/${otherId}`);
  }

  /** Child invites a guardian by email. `pending` = the email has an account
      (awaiting their accept); `awaiting_signup` = we emailed an invite. */
  familyRequestParent(email: string): Promise<{ status: 'pending' | 'awaiting_signup' }> {
    return this.request('POST', '/family/request-parent', { email });
  }

  /** Parent accepts a child-initiated supervision request. */
  familyAcceptChildRequest(childId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/child-requests/${childId}/accept`);
  }

  // Parent read view ---------------------------------------------------------

  familyChildFriends(childId: string): Promise<{
    relationships: Array<{ type: string; createdAt: string; user: FamilyUser }>;
  }> {
    return this.request('GET', `/family/children/${childId}/friends`);
  }

  familyChildChannels(childId: string): Promise<{ channels: FamilyChildChannel[] }> {
    return this.request('GET', `/family/children/${childId}/channels`);
  }

  familyChildMessages(
    childId: string,
    channelId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<{ messages: FamilyChildMessage[] }> {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', opts.before);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request(
      'GET',
      `/family/children/${childId}/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
    );
  }

  // Restrictions + blocked guilds (parent) ----------------------------------

  familyChildRestrictions(
    childId: string,
  ): Promise<{ restrictions: ChildRestrictions; blockedGuildIds: string[] }> {
    return this.request('GET', `/family/children/${childId}/restrictions`);
  }

  familySetRestrictions(
    childId: string,
    patch: Partial<ChildRestrictions>,
  ): Promise<{ restrictions: ChildRestrictions }> {
    return this.request('PATCH', `/family/children/${childId}/restrictions`, patch);
  }

  familyBlockGuild(childId: string, guildId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/children/${childId}/blocked-guilds`, { guildId });
  }

  familyUnblockGuild(childId: string, guildId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/family/children/${childId}/blocked-guilds/${guildId}`);
  }

  /** The child's servers, each flagged with whether it's currently blocked. */
  familyChildGuilds(childId: string): Promise<{ guilds: FamilyChildGuild[] }> {
    return this.request('GET', `/family/children/${childId}/guilds`);
  }

  // Approval requests --------------------------------------------------------

  /** Parent: pending approval requests across supervised children. */
  familyRequests(): Promise<{ requests: FamilyRequest[] }> {
    return this.request('GET', '/family/requests');
  }

  familyApproveRequest(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/requests/${id}/approve`);
  }

  familyDenyRequest(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/requests/${id}/deny`);
  }

  /** Child: ask a parent to approve adding a friend. */
  familyRequestFriend(targetId: string, note?: string): Promise<{ id: string }> {
    return this.request('POST', '/family/requests/friend', { targetId, ...(note ? { note } : {}) });
  }

  /** Child: ask a parent to approve joining a server (by invite code). */
  familyRequestGuild(inviteCode: string, note?: string): Promise<{ id: string }> {
    return this.request('POST', '/family/requests/guild', {
      inviteCode,
      ...(note ? { note } : {}),
    });
  }

  // Watch words + flags (parent) ---------------------------------------------

  familyChildWatchWords(childId: string): Promise<{ words: string[] }> {
    return this.request('GET', `/family/children/${childId}/watch-words`);
  }

  familyAddWatchWord(childId: string, word: string): Promise<{ words: string[] }> {
    return this.request('POST', `/family/children/${childId}/watch-words`, { word });
  }

  familyRemoveWatchWord(childId: string, word: string): Promise<{ words: string[] }> {
    return this.request(
      'DELETE',
      `/family/children/${childId}/watch-words?word=${encodeURIComponent(word)}`,
    );
  }

  familyChildFlags(childId: string): Promise<{ flags: FamilyFlag[] }> {
    return this.request('GET', `/family/children/${childId}/flags`);
  }

  familyMarkFlagReviewed(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/family/flags/${id}/reviewed`);
  }
}

export interface FamilyUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  status?: string;
  customStatus?: string | null;
  since?: string;
}

export interface FamilySummary {
  /** The current user's own restrictions if they're a supervised child;
      null otherwise. */
  restrictions: ChildRestrictions | null;
  /** Age-driven minor state (server-computed; optional for forward-compat
      with older servers). isMinor = 13–17. graceActive = minor, unlinked,
      within the 30-day window to connect a parent. restrictedHeavily = minor,
      unlinked, past the window (strict restrictions in effect). */
  isMinor?: boolean;
  graceActive?: boolean;
  graceDaysRemaining?: number | null;
  restrictedHeavily?: boolean;
  /** Children I actively supervise. */
  children: FamilyUser[];
  /** Supervision requests I've sent that are awaiting acceptance. */
  outgoingRequests: FamilyUser[];
  /** Child-initiated requests awaiting MY (the parent's) acceptance. */
  incomingChildRequests?: FamilyUser[];
  /** Parents actively supervising me. */
  supervisedBy: FamilyUser[];
  /** Parent-initiated requests awaiting MY acceptance. */
  incomingRequests: FamilyUser[];
  /** Parent invites I (the child) sent, awaiting the parent's acceptance. */
  outgoingParentRequests?: FamilyUser[];
}

export interface PasskeyInfo {
  id: string;
  deviceName: string | null;
  /** True for a synced/multi-device passkey (UX hint only). */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ChildRestrictions {
  canAddFriends: boolean;
  canRemoveFriends: boolean;
  allowVoice: boolean;
  allowVideo: boolean;
  allowStream: boolean;
  allowCreateGuild: boolean;
  /** Accept invites / join discoverable servers. */
  allowJoinGuilds: boolean;
  /** Post in server channels. */
  allowMessaging: boolean;
  /** Who the child may direct-message. */
  dmPolicy: 'none' | 'friends' | 'all';
  /** Mask swear/vulgar words (f•••) in the child's message views. */
  filterProfanity: boolean;
}

/**
 * Payload of the FAMILY_SUPERVISION_UPDATE gateway event — the recipient's
 * OWN supervision state after a guardian changed it (restrictions edited, a
 * link accepted or ended, a server blocked/unblocked, the 18+ auto-release).
 *
 * Apply it directly to whatever local state gates supervised actions —
 * `restrictions` is the same object GET /family/me returns (null = no
 * restrictions), so a client never has to round-trip to re-gate itself.
 *
 * Guardians are deliberately NOT in this payload: it is delivered to the
 * supervised account only. A UI that lists guardians should refetch
 * /family/me when this arrives.
 */
export interface FamilySupervisionUpdate {
  restrictions: ChildRestrictions | null;
  /** True when at least one guardian actively supervises this account. */
  supervised: boolean;
  /** 13–17. */
  isMinor: boolean;
  /** Minor with no guardian → strict lockdown. */
  restrictedHeavily: boolean;
  /** Servers a guardian has put off-limits for this account. */
  blockedGuildIds: string[];
}

export interface FamilyRequest {
  id: string;
  type: 'friend' | 'guild';
  note: string | null;
  createdAt: string;
  child: { id: string; username: string; displayName: string | null };
  target: { id: string; username: string; displayName: string | null } | null;
  guild: { id: string; name: string | null } | null;
  inviteCode: string | null;
}

export interface FamilyFlag {
  id: string;
  messageId: string;
  channelId: string;
  /** Comma-joined matched watch words. */
  matchedWord: string;
  direction: 'sent' | 'received';
  createdAt: string;
  reviewed: boolean;
  /** True when the flagged message was written by the child. */
  byChild: boolean;
  /** Up to ~280 chars of the message content (supervised DMs are plaintext). */
  snippet: string | null;
}

export interface FamilyChildGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  blocked: boolean;
}

export interface FamilyChildChannel {
  id: string;
  lastMessageId: string | null;
  recipient: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface FamilyChildMessage {
  id: string;
  channelId: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  /** True when the child deleted this message — supervision retains and shows it. */
  deleted?: boolean;
  /** Full attachment shape, identical to a normal message's. In
      particular it carries `thumbnailUrl` (render this, not the
      full-size `url`, in the review list) and `blobExpiredAt` (non-null
      = media retention removed the original, so `url` no longer
      resolves — see `isBlobExpired`). */
  attachments: Attachment[];
}

// ── Admin DTO shapes ──────────────────────────────────────────────────────

/** A moderation report (queue item). Mirrors the server ReportDTO. */
export interface Report {
  id: string;
  guildId: string;
  reporter: PublicUser | null;
  targetType: 'message' | 'user';
  targetUser: PublicUser | null;
  messageId: string | null;
  channelId: string | null;
  /** Snapshot of the reported message content at file time (survives delete). */
  messageContent: string | null;
  reason: 'spam' | 'harassment' | 'nsfw' | 'violence' | 'other' | string;
  details: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  handledById: string | null;
  handledAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export interface AdminStats {
  users: { total: number; banned: number };
  guilds: number;
  channels: number;
  messages: { total: number; last24h: number };
  activeSessions: number;
  generatedAt: string;
}

/** Instance-wide configuration backup (GET /admin/backup). Bundles each
 *  guild's config backup; `guilds` entries are opaque per-guild backup docs. */
export interface InstanceBackup {
  format: 'zekktris.instance-backup';
  version: number;
  exportedAt: string;
  guildCount: number;
  truncated: boolean;
  includeImages: boolean;
  guilds: unknown[];
}

/** Per-guild outcome from POST /admin/backup/restore. */
/** One backup bundle on the host's disk. */
export interface HostBackupSnapshot {
  filename: string;
  bytes: number;
  takenAt: string;
  ageHours: number;
}

/** What the host's backup cron has actually produced, plus the last job the
 *  maintenance agent ran. `stale` is the one an admin should react to: it means
 *  the newest bundle is over 36 hours old, or there is no bundle at all. */
export interface HostBackupStatus {
  configured: boolean;
  directory: string;
  count: number;
  totalBytes: number;
  newest: HostBackupSnapshot | null;
  stale: boolean;
  snapshots: HostBackupSnapshot[];
  pending: boolean;
  /** Null when the host agent has never run — which means the buttons here
   *  would queue work nothing picks up. */
  schedule: { enabled: boolean; nightly: string; weekly: string } | null;
  agentRunning: boolean;
  lastJob: {
    action: string;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    ok: boolean;
    output: string;
  } | null;
}

export interface InstanceRestoreResult {
  sourceGuildId: string;
  name: string;
  ok: boolean;
  guildId?: string;
  error?: string;
}

/** Operational/runtime metrics from GET /admin/metrics. Mirrors the
 *  server's InstanceMetrics shape. */
export interface InstanceMetrics {
  process: { uptimeSeconds: number; workerId: number; nodeEnv: string };
  gateway: { connections: number; onlineUsers: number };
  counts: {
    users: number;
    bannedUsers: number;
    guilds: number;
    channels: number;
    messages: number;
    messagesLast24h: number;
    activeSessions: number;
  };
  voice: { rooms: number; participants: number };
  scheduledMessages: { pending: number; due: number };
  db: { ok: boolean; latencyMs: number };
  redis: { configured: boolean; healthy: boolean | null };
  generatedAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string | null;
  /** Null for moderators — they don't get account info. */
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Instance moderator (restricted staff role). */
  isModerator: boolean;
  /** Date of birth (YYYY-MM-DD); null for legacy accounts that never set one. */
  dateOfBirth: string | null;
  bannedAt: string | null;
  /** For a TIMED ban: when it auto-lifts (ISO). Null = permanent (when
      bannedAt is set) or not banned. */
  bannedUntil: string | null;
  /** Instance mute (staff action). Set = muted; mutedUntil null = permanent. */
  mutedAt?: string | null;
  mutedUntil?: string | null;
  createdAt: string;
  /** Approx last-active time (max session activity); null if never. */
  lastSeenAt: string | null;
  /** Active supporter membership (own row; inherited family pass-down is not
      an admin-managed row and doesn't show here). */
  subscriptionTier?: 'scout' | 'guardian' | 'legend' | null;
  /** Membership expiry (ISO); null = unlimited/forever. */
  subscriptionExpiresAt?: string | null;
}

export type AdminMuteDuration = '1h' | '1d' | '1w' | 'perm';

/** GET /admin/users/:id — the admin-only account record. */
export interface AdminAccount {
  id: string;
  username: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  dateOfBirth: string | null;
  dobLocked: boolean;
  isMinor: boolean;
  isAdmin: boolean;
  isModerator: boolean;
  isBot: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  usernameChangedAt: string | null;
  lastSeenAt: string | null;
  banned: boolean;
  bannedAt: string | null;
  bannedUntil: string | null;
  muted: boolean;
  mutedAt: string | null;
  mutedUntil: string | null;
  subscriptionTier: 'scout' | 'guardian' | 'legend' | null;
  subscriptionExpiresAt: string | null;
  activeSessions: number;
  guildCount: number;
  friendCount: number;
}

export interface AdminContactPerson {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** When the relationship / conversation began. */
  since: string;
}

export interface AdminAccountContacts {
  friends: AdminContactPerson[];
  incomingRequests: AdminContactPerson[];
  outgoingRequests: AdminContactPerson[];
  blocked: AdminContactPerson[];
  dmPartners: AdminContactPerson[];
}

export interface StaffNote {
  id: string;
  body: string;
  createdAt: string;
  /** Null when the author's account is gone. */
  author: { id: string; username: string; displayName: string } | null;
}

export interface AdminGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  memberCount: number;
  createdAt: string;
  discoverable: boolean;
}

export interface AdminStorage {
  attachments: { count: number; totalBytes: number };
  avatars: { count: number };
  banners: { count: number };
  emojis: { count: number };
  stickers: { count: number };
  /** Live on-disk totals from the file scan (updates after deletions). */
  onDisk: {
    totalBytes: number;
    totalCount: number;
    unusedBytes: number;
    unusedCount: number;
  };
}

export type StorageCategory =
  | 'attachment'
  | 'avatar'
  | 'banner'
  | 'emoji'
  | 'sticker'
  | 'other'
  | 'unused';

export interface StorageItem {
  id: string;
  filename: string | null;
  format: string | null;
  compressed: boolean | null;
  category: StorageCategory;
  sizeBytes: number;
  mtimeMs: number;
  referenced: boolean;
  /** Owning guild id, or null for global files (user assets, DM files). */
  guildId: string | null;
}

export interface StorageListing {
  items: StorageItem[];
  page: number;
  pageSize: number;
  total: number;
  /** On-disk bytes of items matching the current filters (incl. guild). */
  filteredBytes: number;
  totalBytes: number;
  totalCount: number;
  unusedBytes: number;
  unusedCount: number;
  categoryCounts: Record<StorageCategory, number>;
}

export interface AdminActivity {
  recentUsers: Array<{
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: string;
  }>;
  recentGuilds: Array<{
    id: string;
    name: string;
    iconUrl: string | null;
    ownerId: string;
    createdAt: string;
  }>;
}

export interface AdminPeekGuild {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  createdAt: string;
  memberCount: number;
}

export interface AdminPeekChannel {
  id: string;
  guildId: string | null;
  parentId: string | null;
  type: string;
  name: string;
  topic: string | null;
  position: number;
  nsfw: boolean;
}

export interface AdminDmPeer {
  /** The shared DM channel. */
  channelId: string;
  user: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
  /** True when the subject has this person as a friend. */
  isFriend: boolean;
  /** Messages in that conversation (deleted excluded). Content is never sent. */
  messageCount: number;
}

export interface AdminDmPeersResponse {
  /** Sorted by messageCount, busiest first. */
  peers: AdminDmPeer[];
  /** True when the subject has more DM channels than the server will enumerate. */
  capped: boolean;
}

export interface AdminPeekMessage {
  id: string;
  channelId: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  /** Full attachment shape, identical to a normal message's — including
      `thumbnailUrl` and `blobExpiredAt`. Gate every full-size fetch on
      `blobExpiredAt`, never on a missing `url` (which stays populated). */
  attachments: Attachment[];
  reactions: Array<{ emoji: string; count: number }>;
  hasReply: boolean;
  hasForward: boolean;
  hasSticker: boolean;
}
