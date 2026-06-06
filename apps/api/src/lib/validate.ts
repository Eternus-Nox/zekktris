/**
 * validate
 * --------
 * Thin wrapper around @hono/zod-validator. Without this, validation failures
 * bypass our app-wide error handler and ship the bare ZodError shape to
 * clients — `{ success: false, error: { issues, name } }` — which doesn't
 * match our error envelope. Throwing makes the error pass through
 * `app.onError`, which our middleware re-formats into the standard
 * `{ error: { code, message, details } }` shape.
 *
 * Usage:
 *   import { validate } from '../lib/validate';
 *   router.post('/x', validate('json', bodySchema), async (c) => {
 *     const body = c.req.valid('json');
 *     ...
 *   });
 */

import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';

type Target = 'json' | 'query' | 'param' | 'header' | 'form';

export function validate<S extends ZodSchema>(target: Target, schema: S) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      // ZodError; caught by errorHandler and turned into VALIDATION_FAILED.
      throw result.error;
    }
  });
}
