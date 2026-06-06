import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { healthRouter } from '../src/routes/health';
import { authRouter } from '../src/routes/auth';
import { errorHandler } from '../src/middleware';

describe('health route', () => {
  it('GET /health returns 200 with ok status (no DB)', async () => {
    const res = await healthRouter.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});

describe('auth /register validation (real handler + error handler, DB-free)', () => {
  // Mount the REAL auth router under the REAL error handler. The validate
  // middleware throws a ZodError that app.onError maps to VALIDATION_FAILED.
  // Invalid bodies fail validation BEFORE the handler body runs (rate-limit,
  // signup gate, DB insert), so nothing touches the database here.
  const app = new Hono();
  app.route('/auth', authRouter);
  app.onError(errorHandler);

  const register = (body: unknown) =>
    app.request('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects an empty body with 400 VALIDATION_FAILED and field issues', async () => {
    const res = await register({});
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    expect((body.error.details?.issues ?? []).length).toBeGreaterThan(0);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await register({
      email: 'not-an-email',
      username: 'validuser',
      displayName: 'Valid User',
      password: 'longenough8',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a too-short password with 400', async () => {
    const res = await register({
      email: 'a@b.com',
      username: 'validuser',
      displayName: 'Valid User',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });
});
