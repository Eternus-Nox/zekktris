import { describe, it, expect } from 'vitest';
import { envSchema } from '../src/env';

const base = {
  JWT_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};

describe('env: gateway abuse limits', () => {
  it('default to generous limits when unset', () => {
    const r = envSchema.parse(base);
    expect(r.GATEWAY_CONNECTS_PER_MINUTE_PER_IP).toBe(120);
    expect(r.GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER).toBe(60);
  });

  it("'' (compose ${VAR:-}) keeps the default instead of coercing to 0 = disabled", () => {
    const r = envSchema.parse({
      ...base,
      GATEWAY_CONNECTS_PER_MINUTE_PER_IP: '',
      GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER: '',
    });
    expect(r.GATEWAY_CONNECTS_PER_MINUTE_PER_IP).toBe(120);
    expect(r.GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER).toBe(60);
  });

  it('accept an explicit value, 0 (disabled), and reject negatives', () => {
    const r = envSchema.parse({
      ...base,
      GATEWAY_CONNECTS_PER_MINUTE_PER_IP: '0',
      GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER: '15',
    });
    expect(r.GATEWAY_CONNECTS_PER_MINUTE_PER_IP).toBe(0);
    expect(r.GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER).toBe(15);
    expect(
      envSchema.safeParse({ ...base, GATEWAY_CONNECTS_PER_MINUTE_PER_IP: '-1' }).success,
    ).toBe(false);
  });
});
