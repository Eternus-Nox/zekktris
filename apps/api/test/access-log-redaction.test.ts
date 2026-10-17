import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { accessLog, errorHandler, redactPathForLog, requestId } from '../src/middleware';
import { webhooksExecuteRouter } from '../src/routes/webhooks';
import { log } from '../src/log';

describe('accessLog path redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts the webhook execute token, keeps the webhook id and other paths', () => {
    expect(redactPathForLog('/api/webhooks/123456789/s3cretTOKENvalue')).toBe(
      '/api/webhooks/123456789/[redacted]',
    );
    expect(redactPathForLog('/api/webhooks/1/tok/github')).toBe('/api/webhooks/1/[redacted]/github');
    expect(redactPathForLog('/API/Webhooks/1/tok')).toBe('/API/Webhooks/1/[redacted]');
    expect(redactPathForLog('/api/v1/webhooks/123')).toBe('/api/v1/webhooks/123');
    expect(redactPathForLog('/api/v1/channels/5/messages')).toBe('/api/v1/channels/5/messages');
  });

  it('never writes the token of a real webhook execute request to the log', async () => {
    // The real execute router: an invalid body fails validation before any
    // DB work, which still produces an access-log line (at warn, for a 4xx).
    const app = new Hono();
    app.use('*', requestId);
    app.use('*', accessLog);
    app.route('/api/webhooks', webhooksExecuteRouter);
    app.onError(errorHandler);

    const lines: unknown[] = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }

    const token = 'abcDEF0123456789secretTOKEN';
    const res = await app.request(`/api/webhooks/123456789012345678/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not_a_field: true }),
    });
    expect(res.status).toBe(400);

    const http = lines.filter((l) => (l as unknown[])[0] === 'http');
    expect(http).toHaveLength(1);
    expect((http[0] as [string, { path: string }])[1].path).toBe(
      '/api/webhooks/123456789012345678/[redacted]',
    );
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});
