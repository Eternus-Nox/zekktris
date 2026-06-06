/**
 * Signup gate
 * -----------
 * Implements the registration policy controlled by env.ALLOW_REGISTRATION:
 *   open         anyone can sign up; ignores `code` from request body
 *   invite-only  requires a valid unused signup_code; if the code is bound
 *                to an email, the registering email must match
 *   closed       refuses registration entirely
 *
 * In invite-only mode this also atomically increments the code's `uses`
 * counter so it can't be redeemed past its limit by concurrent requests.
 */

import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { errors } from '../errors';

export interface SignupGateInput {
  email: string;
  /** Required when ALLOW_REGISTRATION === 'invite-only'. */
  code?: string;
}

/**
 * Decide whether this signup is allowed. For invite-only mode, atomically
 * consume the code's available uses; throws if the code is unknown,
 * exhausted, expired, or bound to a different email.
 */
export async function gateSignup(input: SignupGateInput): Promise<void> {
  switch (env.ALLOW_REGISTRATION) {
    case 'open':
      return;

    case 'closed':
      throw errors.forbidden('Registration is disabled on this server');

    case 'invite-only': {
      if (!input.code) {
        throw errors.badRequest('A signup code is required');
      }

      // Atomically increment `uses` only if the code is still redeemable.
      // The WHERE clause prevents race conditions: if two requests redeem
      // the same code at once, at most maxUses will succeed.
      const now = new Date();
      const updated = await db
        .update(schema.signupCodes)
        .set({ uses: sql`${schema.signupCodes.uses} + 1` })
        .where(
          and(
            eq(schema.signupCodes.code, input.code),
            sql`${schema.signupCodes.uses} < ${schema.signupCodes.maxUses}`,
            or(
              isNull(schema.signupCodes.expiresAt),
              gt(schema.signupCodes.expiresAt, now),
            ),
            or(
              isNull(schema.signupCodes.email),
              eq(schema.signupCodes.email, input.email),
            ),
          ),
        )
        .returning({ code: schema.signupCodes.code });

      if (updated.length === 0) {
        throw errors.forbidden('Signup code is invalid, expired, or already used');
      }
      return;
    }

    default: {
      // Exhaustiveness check.
      const _never: never = env.ALLOW_REGISTRATION;
      void _never;
      throw errors.internal('Unknown registration mode');
    }
  }
}
