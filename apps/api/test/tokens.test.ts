import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../src/auth/tokens';

// Re-derive what tokens.ts derives internally so we can forge tokens that are
// correctly signed but otherwise wrong (expired, bad issuer) to exercise the
// verifier's guards.
const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const ISSUER = 'zekktris';
const AUDIENCE = 'zekktris-web';
const now = () => Math.floor(Date.now() / 1000);

function forge(opts: {
  secret?: Uint8Array;
  issuer?: string;
  audience?: string;
  iat?: number;
  exp?: number | string;
}) {
  return new SignJWT({ sid: '456' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('123')
    .setIssuedAt(opts.iat ?? now())
    .setExpirationTime(opts.exp ?? '15m')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .sign(opts.secret ?? secret);
}

describe('access tokens', () => {
  it('round-trips userId and sessionId through sign + verify', async () => {
    const token = await signAccessToken({ userId: 123n, sessionId: 456n });
    const claims = await verifyAccessToken(token);
    expect(claims.userId).toBe(123n);
    expect(claims.sessionId).toBe(456n);
  });

  it('rejects a structurally invalid token', async () => {
    await expect(verifyAccessToken('not.a.jwt')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await forge({ secret: new TextEncoder().encode('x'.repeat(40)) });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects a token with a stale issuer (legacy brand)', async () => {
    const token = await forge({ issuer: 'commune' });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects an expired token with TOKEN_EXPIRED, distinct from invalid', async () => {
    const token = await forge({ iat: now() - 3600, exp: now() - 1800 });
    await expect(verifyAccessToken(token)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });
});

describe('refresh tokens', () => {
  it('hashes deterministically and matches the issued hash', () => {
    const { token, hash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    // sha256 hex digest
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a fresh, high-entropy token each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});
