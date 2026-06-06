import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, verifyAgainstDummy } from '../src/auth/passwords';

describe('password hashing (scrypt)', () => {
  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('s3cret-pw');
    expect(await verifyPassword('not-the-pw', hash)).toBe(false);
  });

  it('produces the documented scrypt-v1$salt$key format (16-byte salt, 64-byte key)', async () => {
    const hash = await hashPassword('whatever');
    expect(hash).toMatch(/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('uses a random salt — same password hashes differently, both verify', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('throws on an empty password and never verifies one', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    expect(await verifyPassword('', 'scrypt-v1$00$00')).toBe(false);
  });

  it('returns false (never throws) for malformed stored hashes', async () => {
    const real = await hashPassword('pw');
    expect(await verifyPassword('pw', 'garbage')).toBe(false); // no $-parts
    expect(await verifyPassword('pw', 'a$b$c')).toBe(false); // wrong version label
    expect(await verifyPassword('pw', real.replace('scrypt-v1', 'scrypt-v2'))).toBe(false); // unknown version
    expect(await verifyPassword('pw', 'scrypt-v1$zz$zz')).toBe(false); // non-hex / wrong length
  });

  it('verifyAgainstDummy always returns false (timing equalizer)', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false);
    expect(await verifyAgainstDummy('')).toBe(false);
  });
});
