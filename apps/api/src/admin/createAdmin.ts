/**
 * Create (or promote) an instance admin from the server's own shell
 * ----------------------------------------------------------------
 * The installer's way to give a fresh server its first admin: it asks the
 * operator for an email + password and runs scripts/create-admin.ts inside
 * the api container, which calls this. Nothing on the network is involved,
 * so there is no window where a stranger can register the admin's address
 * first (the race BOOTSTRAP_ADMIN_EMAIL has on an open server without SMTP).
 *
 * The operator has shell access to the box, so this trusts them the same way
 * SQL access would: the address counts as verified, and the account is made
 * admin whether or not another admin already exists.
 *
 *   - No live account with the email → a new account, built like a signup
 *     (same email / username / display-name / password rules, scrypt hash,
 *     achievements ledger seeded) plus email_verified + is_admin. There's no
 *     date of birth to ask for here, so it's left unset and UNLOCKED: null
 *     reads as an adult everywhere, and the app's one-time "confirm your date
 *     of birth" banner lets the admin fill it in.
 *   - A live account already has the email → it is promoted (is_admin +
 *     email_verified). Its password is NOT touched; `password` is only used
 *     when an account is created.
 *
 * Pure of process I/O so it is integration-testable; the CLI is a thin
 * wrapper (scripts/create-admin.ts).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '@zekktris/shared/constants';
import { db, schema, isUniqueViolation } from '../db';
import { nextSnowflake } from '../snowflake';
import { hashPassword } from '../auth/passwords';
import {
  emailSchema,
  passwordSchema,
  usernameSchema,
  displayNameSchema,
} from '../lib/validation';

export interface CreateAdminInput {
  email: string;
  /** Required when the account doesn't exist yet; ignored when promoting. */
  password?: string;
  /** Defaults to one derived from the email's local part (made unique). */
  username?: string;
  /** Defaults to the username. */
  displayName?: string;
}

export type CreateAdminResult =
  | { outcome: 'created'; userId: bigint; email: string; username: string }
  | {
      outcome: 'promoted';
      userId: bigint;
      email: string;
      username: string;
      /** It was an admin already (nothing changed but email_verified). */
      wasAdmin: boolean;
      /** Promoted, but banned: it can't sign in until unbanned. */
      banned: boolean;
    };

/** A problem with the input the operator can fix (message is user-facing). */
export class CreateAdminError extends Error {}

/** First zod issue as a plain message, or the parsed value. */
function parseOrThrow<T>(s: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const r = s.safeParse(value);
  if (!r.success) throw new CreateAdminError(`${what}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  return r.data;
}

/**
 * A valid username from an email's local part: lowercased, anything outside
 * [a-z0-9_.] → '_', no '..', clipped to the max length, and 'admin' when
 * nothing usable is left. Exported for tests.
 */
export function usernameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const name = local
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, USERNAME_MAX_LENGTH);
  return name.length >= USERNAME_MIN_LENGTH ? name : 'admin';
}

/** `base`, then base2, base3, … each clipped so it stays within the max. */
function usernameCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix = String(attempt + 1);
  return `${base.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`.replace(/\.{2,}/g, '.');
}

const MAX_USERNAME_ATTEMPTS = 50;

export async function createAdmin(input: CreateAdminInput): Promise<CreateAdminResult> {
  const email = parseOrThrow(emailSchema, input.email, 'Email');

  const [existing] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      isAdmin: schema.users.isAdmin,
      isBot: schema.users.isBot,
      bannedAt: schema.users.bannedAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
    .limit(1);

  if (existing) {
    if (existing.isBot) throw new CreateAdminError('That email belongs to a bot account.');
    await db
      .update(schema.users)
      .set({ isAdmin: true, emailVerified: true, updatedAt: new Date() })
      .where(eq(schema.users.id, existing.id));
    return {
      outcome: 'promoted',
      userId: existing.id,
      email,
      username: existing.username,
      wasAdmin: existing.isAdmin,
      banned: existing.bannedAt !== null,
    };
  }

  if (input.password === undefined || input.password === '') {
    throw new CreateAdminError('A password is required to create the account.');
  }
  const password = parseOrThrow(passwordSchema, input.password, 'Password');
  const explicitUsername =
    input.username !== undefined ? parseOrThrow(usernameSchema, input.username, 'Username') : null;
  const base = explicitUsername ?? usernameFromEmail(email);
  const passwordHash = await hashPassword(password);

  for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
    const username = usernameCandidate(base, attempt);
    const displayName = parseOrThrow(
      displayNameSchema,
      input.displayName ?? username,
      'Display name',
    );
    const id = nextSnowflake();
    try {
      await db.insert(schema.users).values({
        id,
        email,
        emailVerified: true,
        username,
        displayName,
        passwordHash,
        isAdmin: true,
        // No DOB to collect here: leave it unset and unlocked so the admin
        // can enter it once from the app (see the header comment).
        dobLocked: false,
        // Same as a signup: a brand-new account has nothing earned yet.
        achievementsSeeded: true,
      });
      return { outcome: 'created', userId: id, email, username };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const detail = (err as { detail?: string }).detail ?? '';
      if (detail.includes('email')) {
        // Held by a deleted account (live ones were handled above).
        throw new CreateAdminError('That email belongs to a deleted account; use another one.');
      }
      if (detail.includes('username') && explicitUsername === null) continue;
      if (detail.includes('username')) throw new CreateAdminError('That username is already taken.');
      throw err;
    }
  }
  throw new CreateAdminError('Could not find a free username; pass one explicitly.');
}
