/**
 * Instance routes (non-admin)
 * ---------------------------
 * Instance-wide, read-only config any signed-in user may see. Distinct from
 * /admin (staff-gated mutations) — clients need these values to render the
 * right paywalls without staff credentials.
 *
 * Endpoints:
 *   GET /api/v1/instance/monetization  which tier unlocks each paid surface
 */

import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { getConfig } from '../services/monetization';

export const instanceRouter = new Hono();

// The full monetization config, defaults filled in. uploadCapsMb values are
// number|null — null means "no override configured; the env cap applies"
// (clients treat it as "no special limit to display").
instanceRouter.get('/monetization', requireAuth, async (c) => {
  const config = await getConfig();
  return c.json({ config });
});
