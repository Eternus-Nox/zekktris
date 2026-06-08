import { describe, it, expect } from 'vitest';
import { envSchema } from '../src/env';

// docker-compose passes unset optionals as `${VAR:-}` → the empty string ''
// (not undefined). These tests lock in that '' is normalized to undefined
// BEFORE any `.email()`/`.url()` validator runs, so the API boots on the
// default self-host path instead of crash-looping. Regression guard for the
// VAPID_CONTACT_EMAIL='' boot crash.

const base = {
  JWT_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};

describe('env: empty-string optionals are treated as undefined', () => {
  it("VAPID_CONTACT_EMAIL='' parses (no .email() failure) and becomes undefined", () => {
    const r = envSchema.safeParse({ ...base, VAPID_CONTACT_EMAIL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.VAPID_CONTACT_EMAIL).toBeUndefined();
  });

  it('a real VAPID_CONTACT_EMAIL is still validated + kept; a malformed one still fails', () => {
    const ok = envSchema.safeParse({ ...base, VAPID_CONTACT_EMAIL: 'ops@example.com' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.VAPID_CONTACT_EMAIL).toBe('ops@example.com');
    expect(envSchema.safeParse({ ...base, VAPID_CONTACT_EMAIL: 'not-an-email' }).success).toBe(false);
  });

  it("REDIS_URL='' parses (no .url() failure) and becomes undefined", () => {
    const r = envSchema.safeParse({ ...base, REDIS_URL: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.REDIS_URL).toBeUndefined();
  });

  it('a real REDIS_URL is kept; a malformed one still fails', () => {
    const ok = envSchema.safeParse({ ...base, REDIS_URL: 'redis://cache:6379' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.REDIS_URL).toBe('redis://cache:6379');
    expect(envSchema.safeParse({ ...base, REDIS_URL: 'not a url' }).success).toBe(false);
  });

  it('empty LiveKit / VAPID-key / cookie optionals all normalize to undefined', () => {
    const r = envSchema.safeParse({
      ...base,
      LIVEKIT_API_KEY: '',
      LIVEKIT_API_SECRET: '',
      LIVEKIT_WS_URL: '',
      LIVEKIT_HTTP_URL: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      COOKIE_DOMAIN: '',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.LIVEKIT_API_KEY).toBeUndefined();
      expect(r.data.LIVEKIT_API_SECRET).toBeUndefined();
      expect(r.data.LIVEKIT_WS_URL).toBeUndefined();
      expect(r.data.LIVEKIT_HTTP_URL).toBeUndefined();
      expect(r.data.VAPID_PUBLIC_KEY).toBeUndefined();
      expect(r.data.VAPID_PRIVATE_KEY).toBeUndefined();
      expect(r.data.COOKIE_DOMAIN).toBeUndefined();
    }
  });
});
