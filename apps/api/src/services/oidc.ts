/**
 * SSO / OIDC
 * ----------
 * Generic OpenID Connect login against ANY compliant provider (Google, Okta,
 * Keycloak, Authentik, Entra, …), configured per-instance via instance_settings
 * — no hardcoded provider. Flow: Authorization Code + PKCE + state + nonce, with
 * provider auto-discovery (.well-known/openid-configuration).
 *
 * Security model:
 *   - The ID token is verified with jose against the provider's JWKS, checking
 *     SIGNATURE, ISSUER, AUDIENCE (our client_id) and EXPIRY; we additionally
 *     check the NONCE binds the token to this login attempt (replay/injection).
 *   - STATE binds the callback to the browser that started the flow (CSRF). The
 *     state/nonce/PKCE-verifier live in a short-lived ENCRYPTED cookie (AES-GCM
 *     via FIELD_ENCRYPTION) — stateless + multi-node-safe, and the verifier
 *     stays secret from the user agent.
 *   - Identity is bound by `sub` (namespaced by issuer), not email — the stable
 *     link. Subsequent logins resolve by sub.
 *   - Account LINKING to an existing local account is gated on (a) a VERIFIED
 *     email claim AND (b) an explicit admin opt-in (`allowLinking`). Otherwise a
 *     matching email is REJECTED, never silently linked or duplicated — an
 *     unverified or attacker-controlled email must never take over an account.
 *   - SSO only establishes the app's NORMAL session (reuses createSession); it
 *     never weakens or replaces password auth. SSO accounts get a sentinel
 *     password hash that can't match any password.
 *
 * This module keeps the PURE bits (token validation, claim→user mapping)
 * separable from the network bits (discovery, token exchange) so they're
 * unit-testable with a locally-signed token + key.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema, isUniqueViolation } from '../db';
import { env } from '../env';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import {
  encryptField,
  decryptField,
  isFieldEncryptionEnabled,
} from '../lib/fieldCrypto';
import { USERNAME_MAX_LENGTH } from '@zekktris/shared/constants';
import * as settings from './instanceSettings';

// SSO accounts can't sign in with a password: this sentinel has no `$`, so
// verifyPassword (which splits on `$` and requires 3 parts) always returns
// false. They can set a password later via the normal change-password flow.
const SSO_PASSWORD_SENTINEL = 'sso-account-no-password-login';

const SETTING = {
  enabled: 'oidc.enabled',
  issuer: 'oidc.issuer',
  clientId: 'oidc.clientId',
  clientSecret: 'oidc.clientSecret', // stored encrypted
  scopes: 'oidc.scopes',
  buttonLabel: 'oidc.buttonLabel',
  allowLinking: 'oidc.allowLinking',
} as const;

const DEFAULT_SCOPES = 'openid email profile';
const DEFAULT_LABEL = 'Sign in with SSO';
const STATE_TTL_MS = 10 * 60_000;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  buttonLabel: string;
  allowLinking: boolean;
}

/** Full server-side config (secret decrypted). Null when SSO isn't fully
 *  configured/enabled — callers treat null as "SSO off". */
export async function getOidcConfig(): Promise<OidcConfig | null> {
  const s = await settings.getSettings(Object.values(SETTING));
  if (s[SETTING.enabled] !== 'true') return null;
  const issuer = s[SETTING.issuer];
  const clientId = s[SETTING.clientId];
  const enc = s[SETTING.clientSecret];
  if (!issuer || !clientId || !enc) return null;
  let clientSecret: string;
  try {
    clientSecret = decryptField(enc);
  } catch {
    return null; // can't decrypt → treat as misconfigured (off) rather than leak
  }
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    scopes: s[SETTING.scopes] || DEFAULT_SCOPES,
    buttonLabel: s[SETTING.buttonLabel] || DEFAULT_LABEL,
    allowLinking: s[SETTING.allowLinking] === 'true',
  };
}

/** What the public login page may know: whether SSO is on + the button label.
 *  NEVER exposes issuer/clientId/secret. */
export async function getPublicOidcConfig(): Promise<{ enabled: boolean; buttonLabel: string }> {
  const cfg = await getOidcConfig();
  return { enabled: cfg !== null, buttonLabel: cfg?.buttonLabel ?? DEFAULT_LABEL };
}

/** Admin view of the config — safe fields + whether a secret is set. Never
 *  returns the secret itself. */
export async function getAdminOidcConfig(): Promise<{
  enabled: boolean;
  issuer: string;
  clientId: string;
  scopes: string;
  buttonLabel: string;
  allowLinking: boolean;
  hasClientSecret: boolean;
}> {
  const s = await settings.getSettings(Object.values(SETTING));
  return {
    enabled: s[SETTING.enabled] === 'true',
    issuer: s[SETTING.issuer] ?? '',
    clientId: s[SETTING.clientId] ?? '',
    scopes: s[SETTING.scopes] || DEFAULT_SCOPES,
    buttonLabel: s[SETTING.buttonLabel] || DEFAULT_LABEL,
    allowLinking: s[SETTING.allowLinking] === 'true',
    hasClientSecret: !!s[SETTING.clientSecret],
  };
}

export interface SetOidcInput {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  /** Plaintext; stored encrypted. Omit to keep the existing secret. */
  clientSecret?: string | null;
  scopes?: string;
  buttonLabel?: string;
  allowLinking?: boolean;
}

export async function setOidcConfig(patch: SetOidcInput): Promise<void> {
  // The client secret is stored encrypted at rest — SSO requires
  // FIELD_ENCRYPTION configured so we never persist it in plaintext.
  if (!isFieldEncryptionEnabled()) {
    throw errors.badRequest(
      'SSO requires FIELD_ENCRYPTION_KEY to be configured (the OAuth client secret is stored encrypted).',
    );
  }
  if (patch.issuer !== undefined) {
    const v = patch.issuer.trim().replace(/\/+$/, '');
    if (v && !/^https:\/\//i.test(v)) throw errors.badRequest('OIDC issuer must be an https:// URL');
    await settings.setSetting(SETTING.issuer, v);
  }
  if (patch.clientId !== undefined) await settings.setSetting(SETTING.clientId, patch.clientId.trim());
  if (patch.clientSecret !== undefined && patch.clientSecret !== null && patch.clientSecret !== '') {
    await settings.setSetting(SETTING.clientSecret, encryptField(patch.clientSecret));
  }
  if (patch.scopes !== undefined) await settings.setSetting(SETTING.scopes, patch.scopes.trim() || DEFAULT_SCOPES);
  if (patch.buttonLabel !== undefined) await settings.setSetting(SETTING.buttonLabel, patch.buttonLabel.trim() || DEFAULT_LABEL);
  if (patch.allowLinking !== undefined) await settings.setSetting(SETTING.allowLinking, patch.allowLinking ? 'true' : 'false');

  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      // Don't let an admin "enable" a half-configured provider.
      const s = await settings.getSettings(Object.values(SETTING));
      if (!s[SETTING.issuer] || !s[SETTING.clientId] || !s[SETTING.clientSecret]) {
        throw errors.badRequest('Set issuer, client ID, and client secret before enabling SSO.');
      }
    }
    await settings.setSetting(SETTING.enabled, patch.enabled ? 'true' : 'false');
  }
}

// ── Provider discovery ───────────────────────────────────────────────────────

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { doc: Discovery; jwks: JWTVerifyGetKey; exp: number }>();

async function discover(issuer: string): Promise<{ doc: Discovery; jwks: JWTVerifyGetKey }> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.exp > Date.now()) return { doc: cached.doc, jwks: cached.jwks };

  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  if (!url.startsWith('https://')) throw errors.badRequest('OIDC issuer must be https');
  let doc: Discovery;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    doc = (await res.json()) as Discovery;
  } catch {
    throw errors.badRequest('Could not reach the SSO provider (discovery failed).');
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw errors.badRequest('SSO provider discovery document is incomplete.');
  }
  // OIDC Discovery requires the advertised issuer to be identical to the URL
  // the document was fetched from; a mismatch means a misconfigured (or
  // hostile) provider, and accepting it would validate ID tokens against an
  // issuer the admin never trusted.
  if (doc.issuer && doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw errors.badRequest('SSO provider discovery issuer does not match the configured issuer.');
  }
  // The token/JWKS endpoints come from the (remote) discovery JSON, and the
  // token POST carries the client secret — never follow them to plaintext.
  if (!doc.token_endpoint.startsWith('https://') || !doc.jwks_uri.startsWith('https://')) {
    throw errors.badRequest('SSO provider endpoints must be https.');
  }
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  discoveryCache.set(issuer, { doc, jwks, exp: Date.now() + 5 * 60_000 });
  return { doc, jwks };
}

// ── Authorization request (state / nonce / PKCE) ─────────────────────────────

const b64url = (buf: Buffer): string => buf.toString('base64url');

export interface AuthRequest {
  url: string;
  /** Encrypted cookie value to set; opaque to the client. */
  stateCookie: string;
}

interface StateBlob {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
}

/** Build the provider authorize URL + the encrypted state cookie to set. */
export async function buildAuthRequest(redirectUri: string): Promise<AuthRequest> {
  const cfg = await getOidcConfig();
  if (!cfg) throw errors.badRequest('SSO is not enabled.');
  const { doc } = await discover(cfg.issuer);

  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());

  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', cfg.scopes.includes('openid') ? cfg.scopes : `openid ${cfg.scopes}`);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');

  const blob: StateBlob = { state, nonce, codeVerifier, exp: Date.now() + STATE_TTL_MS };
  return { url: u.toString(), stateCookie: encryptField(JSON.stringify(blob)) };
}

/** Decrypt + validate the state cookie against the `state` query param (CSRF +
 *  expiry). Returns the trusted nonce + PKCE verifier. */
export function consumeStateCookie(cookieValue: string | undefined, stateParam: string): StateBlob {
  if (!cookieValue) throw errors.badRequest('Missing SSO state.');
  let blob: StateBlob;
  try {
    blob = JSON.parse(decryptField(cookieValue)) as StateBlob;
  } catch {
    throw errors.badRequest('Invalid SSO state.');
  }
  if (typeof blob.exp !== 'number' || blob.exp < Date.now()) throw errors.badRequest('SSO login expired; try again.');
  // Constant-ish comparison is unnecessary here (state is high-entropy and the
  // attacker can't observe timing across a redirect), but require an exact match.
  if (!blob.state || blob.state !== stateParam) throw errors.badRequest('SSO state mismatch (possible CSRF).');
  return blob;
}

// ── Token exchange + ID-token validation ─────────────────────────────────────

/** Exchange the authorization code for tokens; returns the raw ID token. */
async function exchangeCode(
  cfg: OidcConfig,
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: codeVerifier,
  });
  let json: { id_token?: string };
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`token ${res.status}`);
    json = (await res.json()) as { id_token?: string };
  } catch {
    throw errors.badRequest('SSO token exchange failed.');
  }
  if (!json.id_token) throw errors.badRequest('SSO provider returned no id_token.');
  return json.id_token;
}

/**
 * PURE ID-token validation — verifies signature/issuer/audience/expiry via jose
 * and the nonce binding. `keySource` is the JWKS (or a single key in tests).
 * Returns the validated claims. Exported for direct unit testing.
 */
export async function validateIdToken(
  idToken: string,
  opts: { issuer: string; audience: string; nonce: string; keySource: JWTVerifyGetKey | KeyLike | Uint8Array },
): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keySource as JWTVerifyGetKey, {
      issuer: opts.issuer,
      audience: opts.audience,
    }));
  } catch {
    throw errors.badRequest('SSO token is invalid or expired.');
  }
  if (!payload.sub) throw errors.badRequest('SSO token is missing a subject.');
  if (typeof payload.nonce !== 'string' || payload.nonce !== opts.nonce) {
    throw errors.badRequest('SSO nonce mismatch (possible replay).');
  }
  return payload;
}

// ── Claim → user mapping (JIT provision / opt-in link) ───────────────────────

function sanitizeUsername(raw: string): string {
  let u = raw.toLowerCase().replace(/[^a-z0-9_.]/g, '').replace(/\.\.+/g, '.').replace(/^[._]+|[._]+$/g, '');
  if (u.length < 2) u = `user${b64url(randomBytes(3)).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return u.slice(0, USERNAME_MAX_LENGTH);
}

async function generateUniqueUsername(payload: JWTPayload, email: string): Promise<string> {
  const pref =
    (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
    email.split('@')[0] ||
    'user';
  const base = sanitizeUsername(pref);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, USERNAME_MAX_LENGTH - 5)}_${b64url(randomBytes(2)).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const [taken] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  // Extremely unlikely fallback: fully random.
  return `user_${b64url(randomBytes(8)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
}

/**
 * Map validated ID-token claims to a user id, creating or linking as policy
 * allows. The security-critical decision tree:
 *   1. Existing binding by `sub` → that user (the stable link; trust it).
 *   2. No verified email → REJECT (can't safely create or link).
 *   3. Existing account with that email:
 *        - allowLinking → link (set oidc_sub) + log in.
 *        - else → REJECT (don't auto-link or duplicate).
 *   4. New email → JIT-provision a fresh account bound to this sub.
 */
export async function resolveUserFromClaims(payload: JWTPayload, cfg: OidcConfig): Promise<bigint> {
  const subKey = `${cfg.issuer}|${payload.sub}`;

  const [bySub] = await db.select().from(schema.users).where(eq(schema.users.oidcSub, subKey)).limit(1);
  if (bySub) {
    if (bySub.deletedAt || bySub.bannedAt) throw errors.forbidden('This account is unavailable.');
    return bySub.id;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  const emailVerified = payload.email_verified === true;
  if (!email || !emailVerified) {
    throw errors.badRequest(
      'Your SSO provider did not supply a verified email, so an account can’t be created or linked.',
    );
  }

  const [byEmail] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
    .limit(1);
  if (byEmail) {
    if (byEmail.isBot) throw errors.badRequest('That email belongs to a bot account.');
    if (!cfg.allowLinking) {
      throw errors.conflict(
        'An account with this email already exists. Sign in with your password, or ask an admin to enable SSO account linking.',
      );
    }
    if (byEmail.bannedAt) throw errors.forbidden('This account is unavailable.');
    await db
      .update(schema.users)
      .set({ oidcSub: subKey, emailVerified: true, updatedAt: new Date() })
      .where(eq(schema.users.id, byEmail.id));
    return byEmail.id;
  }

  // JIT provision — but only where the instance's registration policy allows
  // new accounts. Password signup enforces ALLOW_REGISTRATION via gateSignup;
  // without this gate, anyone who can authenticate at the IdP would get a
  // fully-provisioned account on a `closed` or `invite-only` instance. (We
  // don't call gateSignup directly: invite-only demands a signup code the SSO
  // flow has no way to supply, so the net effect is the same rejection with a
  // clearer message.)
  if (env.ALLOW_REGISTRATION !== 'open') {
    throw errors.forbidden(
      'Registration is closed on this server. Ask an admin to create or invite your account, then link it via SSO.',
    );
  }
  const username = await generateUniqueUsername(payload, email);
  const displayName =
    (typeof payload.name === 'string' && payload.name.trim()) ||
    (typeof payload.given_name === 'string' && payload.given_name.trim()) ||
    username;
  const id = nextSnowflake();
  try {
    await db.insert(schema.users).values({
      id,
      email,
      emailVerified: true, // verified by the IdP (we required email_verified)
      username,
      displayName: displayName.slice(0, 80),
      passwordHash: SSO_PASSWORD_SENTINEL,
      oidcSub: subKey,
      status: 'online',
    });
  } catch (err) {
    // The live-account lookup above filters soft-deleted rows, but the unique
    // indexes on email/username are NOT partial — a soft-deleted account can
    // still collide here. Surface something actionable instead of a generic
    // "SSO login failed".
    if (isUniqueViolation(err)) {
      throw errors.conflict(
        'An account with this email or username already existed on this server. Ask an admin to restore or remove it.',
      );
    }
    throw err;
  }
  return id;
}

/**
 * Full callback handler (network + pure). Exchanges the code, validates the ID
 * token against the live JWKS, and resolves the user. Returns the user id; the
 * route turns that into the app's normal session.
 */
export async function completeLogin(args: {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}): Promise<bigint> {
  const cfg = await getOidcConfig();
  if (!cfg) throw errors.badRequest('SSO is not enabled.');
  const { doc, jwks } = await discover(cfg.issuer);
  const idToken = await exchangeCode(cfg, doc.token_endpoint, args.code, args.codeVerifier, args.redirectUri);
  const payload = await validateIdToken(idToken, {
    // Always validate against the ADMIN-configured issuer (the trust anchor),
    // never the provider-supplied discovery value — discover() asserts they
    // match when the doc carries one.
    issuer: cfg.issuer,
    audience: cfg.clientId,
    nonce: args.nonce,
    keySource: jwks,
  });
  return resolveUserFromClaims(payload, cfg);
}

/** The redirect URI registered with the provider. Derived from PUBLIC_URL so
 *  it matches what the browser actually hits. */
export function redirectUri(): string {
  return `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/v1/auth/sso/callback`;
}
