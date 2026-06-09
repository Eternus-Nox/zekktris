import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, type KeyLike } from 'jose';
import { and, eq, isNull, like } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { __setKeysForTests, __resetKeysForTests } from '../src/lib/fieldCrypto';
import {
  validateIdToken,
  resolveUserFromClaims,
  consumeStateCookie,
  buildAuthRequest,
  getOidcConfig,
  getPublicOidcConfig,
  getAdminOidcConfig,
  setOidcConfig,
  type OidcConfig,
} from '../src/services/oidc';
import * as settings from '../src/services/instanceSettings';
import { createUser, cleanupAll } from './seed';
import { nextSnowflake } from '../src/snowflake';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping OIDC tests — no database reachable');
}

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'zekktris-client';
let priv: KeyLike;
let pub: KeyLike;
let priv2: KeyLike; // a different key, for signature-tampering

const cfg: OidcConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  scopes: 'openid email profile',
  buttonLabel: 'SSO',
  allowLinking: false,
};

async function mintIdToken(
  key: KeyLike,
  claims: {
    iss?: string;
    aud?: string;
    sub?: string;
    nonce?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    expDeltaSec?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (claims.nonce !== undefined) payload.nonce = claims.nonce;
  if (claims.email !== undefined) payload.email = claims.email;
  if (claims.email_verified !== undefined) payload.email_verified = claims.email_verified;
  if (claims.name !== undefined) payload.name = claims.name;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? CLIENT_ID)
    .setSubject(claims.sub ?? 'sub-123')
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expDeltaSec ?? 300))
    .sign(key);
}

beforeAll(async () => {
  ({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'));
  ({ privateKey: priv2 } = await generateKeyPair('RS256'));
  __setKeysForTests(Buffer.alloc(32, 7)); // enable field encryption for config + state cookie
});
afterAll(async () => {
  __resetKeysForTests();
  if (dbReady) {
    // Clean JIT-provisioned users + reset oidc settings.
    await db.delete(schema.users).where(like(schema.users.email, 'oidc-%@test.local'));
    await cleanupAll();
    await closeDb();
  }
});

describe('OIDC ID-token validation (pure, jose)', () => {
  it('accepts a correctly-signed token with matching issuer/audience/nonce', async () => {
    const tok = await mintIdToken(priv, { nonce: 'N1', email: 'a@x.test', email_verified: true });
    const payload = await validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub });
    expect(payload.sub).toBe('sub-123');
    expect(payload.email).toBe('a@x.test');
  });

  it('rejects a bad signature (signed by a different key)', async () => {
    const tok = await mintIdToken(priv2, { nonce: 'N1' });
    await expect(validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub })).rejects.toThrow();
  });

  it('rejects a wrong issuer', async () => {
    const tok = await mintIdToken(priv, { iss: 'https://evil.test', nonce: 'N1' });
    await expect(validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub })).rejects.toThrow();
  });

  it('rejects a wrong audience', async () => {
    const tok = await mintIdToken(priv, { aud: 'someone-else', nonce: 'N1' });
    await expect(validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const tok = await mintIdToken(priv, { nonce: 'N1', expDeltaSec: -60 });
    await expect(validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub })).rejects.toThrow();
  });

  it('rejects a nonce mismatch (replay protection)', async () => {
    const tok = await mintIdToken(priv, { nonce: 'OTHER' });
    await expect(validateIdToken(tok, { issuer: ISSUER, audience: CLIENT_ID, nonce: 'N1', keySource: pub })).rejects.toThrow();
  });
});

describe('OIDC state cookie (CSRF / PKCE)', () => {
  it('round-trips and enforces the state match + expiry', async () => {
    // buildAuthRequest needs discovery (network) — instead, construct a blob
    // the same way and confirm consumeStateCookie validates it. We exercise
    // the encrypt/decrypt + state-compare path that guards CSRF.
    const { encryptField } = await import('../src/lib/fieldCrypto');
    const blob = { state: 'S1', nonce: 'N1', codeVerifier: 'V1', exp: Date.now() + 60_000 };
    const cookie = encryptField(JSON.stringify(blob));
    expect(consumeStateCookie(cookie, 'S1')).toMatchObject({ nonce: 'N1', codeVerifier: 'V1' });
    expect(() => consumeStateCookie(cookie, 'WRONG')).toThrow(); // CSRF: state mismatch
    expect(() => consumeStateCookie(undefined, 'S1')).toThrow(); // missing
    const expired = encryptField(JSON.stringify({ ...blob, exp: Date.now() - 1 }));
    expect(() => consumeStateCookie(expired, 'S1')).toThrow(); // expired
    expect(() => consumeStateCookie('not-a-valid-cookie', 'S1')).toThrow(); // garbage
    void buildAuthRequest; // referenced
  });
});

describe.runIf(dbReady)('OIDC claim → user mapping', () => {
  afterEach(async () => {
    await db.delete(schema.users).where(like(schema.users.email, 'oidc-%@test.local'));
  });

  it('JIT-provisions a new user for a new verified email and binds the sub', async () => {
    const email = `oidc-jit-${Date.now()}@test.local`;
    const id = await resolveUserFromClaims(
      { sub: 'new-sub-1', email, email_verified: true, name: 'New Person' } as never,
      cfg,
    );
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    expect(u?.email).toBe(email);
    expect(u?.oidcSub).toBe(`${ISSUER}|new-sub-1`);
    expect(u?.emailVerified).toBe(true);
    expect(u?.passwordHash).not.toMatch(/\$/); // sentinel → can't password-login
  });

  it('resolves an existing binding by sub (not email)', async () => {
    const uid = await createUser();
    const sub = `bound-${uid}`;
    await db.update(schema.users).set({ oidcSub: `${ISSUER}|${sub}` }).where(eq(schema.users.id, uid));
    const got = await resolveUserFromClaims({ sub, email: 'whatever@x.test', email_verified: true } as never, cfg);
    expect(got).toBe(uid);
  });

  it('REJECTS an unverified email (no provision, no link)', async () => {
    await expect(
      resolveUserFromClaims({ sub: 'unv-1', email: `oidc-unv@test.local`, email_verified: false } as never, cfg),
    ).rejects.toThrow();
  });

  it('REJECTS a matching existing email when linking is OFF', async () => {
    const uid = await createUser();
    const email = `oidc-existing@test.local`;
    await db.update(schema.users).set({ email }).where(eq(schema.users.id, uid));
    await expect(
      resolveUserFromClaims({ sub: 'link-attempt', email, email_verified: true } as never, { ...cfg, allowLinking: false }),
    ).rejects.toThrow();
    // No binding was created.
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid)).limit(1);
    expect(u?.oidcSub ?? null).toBeNull();
  });

  it('LINKS to an existing account when linking is ON + email verified', async () => {
    const uid = await createUser();
    const email = `oidc-link-${uid}@test.local`;
    await db.update(schema.users).set({ email }).where(eq(schema.users.id, uid));
    const got = await resolveUserFromClaims(
      { sub: 'link-yes', email, email_verified: true } as never,
      { ...cfg, allowLinking: true },
    );
    expect(got).toBe(uid);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid)).limit(1);
    expect(u?.oidcSub).toBe(`${ISSUER}|link-yes`);
  });
});

describe.runIf(dbReady)('OIDC config (instance settings)', () => {
  afterEach(async () => {
    for (const k of ['oidc.enabled', 'oidc.issuer', 'oidc.clientId', 'oidc.clientSecret', 'oidc.scopes', 'oidc.buttonLabel', 'oidc.allowLinking']) {
      await settings.setSetting(k, null);
    }
  });

  it('is off until fully configured; public config never leaks secrets', async () => {
    expect(await getOidcConfig()).toBeNull();
    const pubc = await getPublicOidcConfig();
    expect(pubc.enabled).toBe(false);
    expect(JSON.stringify(pubc)).not.toContain('clientSecret');
  });

  it('enabling requires issuer + clientId + secret; secret stored encrypted, never returned', async () => {
    // Can't enable with nothing configured.
    await expect(setOidcConfig({ enabled: true })).rejects.toThrow();

    await setOidcConfig({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'topsecret', scopes: 'openid email', buttonLabel: 'Login' });
    await setOidcConfig({ enabled: true });

    const full = await getOidcConfig();
    expect(full?.clientSecret).toBe('topsecret'); // decrypted server-side
    // Stored value is NOT the plaintext.
    const stored = await settings.getSetting('oidc.clientSecret');
    expect(stored).not.toBe('topsecret');

    // Admin view exposes hasClientSecret but not the secret.
    const adminView = await getAdminOidcConfig();
    expect(adminView.hasClientSecret).toBe(true);
    expect(JSON.stringify(adminView)).not.toContain('topsecret');
    expect(adminView).not.toHaveProperty('clientSecret');

    // Disable → getOidcConfig null again.
    await setOidcConfig({ enabled: false });
    expect(await getOidcConfig()).toBeNull();
  });
});
