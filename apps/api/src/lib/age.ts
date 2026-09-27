import { z } from 'zod';
/**
 * Age helpers — shared by the signup age-gate (auth) and the minor-supervision
 * lifecycle (supervision). Age is always derived from the stored
 * `users.date_of_birth` on the fly; we never persist a separate age/flag.
 */

/** Minimum signup age. Under-13 is rejected outright at registration. */
export const MIN_SIGNUP_AGE = 13;

/** Age at which a supervised minor is auto-released (link revoked, fully
    unrestricted). 13–17 = minor/supervised; 18+ = adult. */
export const ADULT_AGE = 18;

/** Days a 13–17 account has, from creation, to connect a parent before the
    strict unlinked-minor restrictions kick in. */
export const MINOR_GRACE_DAYS = 30;

/**
 * Whole years old on `on`, computed in UTC from a YYYY-MM-DD birth date.
 * Slice-based parse (vs split/destructure) so each part is a definite number
 * under strict index checks; callers pass regex-validated / DB `date` strings.
 */
export function ageOnDate(dob: string, on: Date): number {
  const y = Number(dob.slice(0, 4));
  const m = Number(dob.slice(5, 7));
  const d = Number(dob.slice(8, 10));
  let age = on.getUTCFullYear() - y;
  const month = on.getUTCMonth() + 1;
  const day = on.getUTCDate();
  if (month < m || (month === m && day < d)) age -= 1;
  return age;
}

/** True when a YYYY-MM-DD birth date makes the person a supervised minor
    (13–17) as of now. Null/empty DOB (legacy accounts) → false. */
export function isMinorDob(dob: string | null | undefined, on: Date = new Date()): boolean {
  if (!dob) return false;
  const age = ageOnDate(dob, on);
  return age >= MIN_SIGNUP_AGE && age < ADULT_AGE;
}

/**
 * The latest YYYY-MM-DD birth date that still counts as ADULT (18+) as of
 * `on` — i.e. `on` minus 18 years. A DOB `<=` this is an adult (auto-released
 * from supervision); a DOB `>` this is a supervised minor. Used in SQL to do
 * the 18+ release on the fly wherever "active parents" are read, so release
 * never depends on the periodic sweep having run.
 */
export function adultCutoffDob(on: Date = new Date()): string {
  const y = on.getUTCFullYear() - ADULT_AGE;
  const m = String(on.getUTCMonth() + 1).padStart(2, '0');
  const d = String(on.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * A date of birth as an account may hold it: a real YYYY-MM-DD calendar date,
 * 1900 or later, and at least MIN_SIGNUP_AGE today. Shared by the self-service
 * change (PATCH /users/@me/date-of-birth) and the staff edit (Admin → Account
 * Info) so a staff member can't set an age the signup gate would refuse — an
 * under-13 account is a ban/delete decision, not a DOB edit.
 */
export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Enter a valid date of birth.')
  .refine((s) => Number(s.slice(0, 4)) >= 1900, 'Enter a valid date of birth.')
  .refine((s) => ageOnDate(s, new Date()) >= MIN_SIGNUP_AGE, {
    message: `You must be at least ${MIN_SIGNUP_AGE} years old to use Zekktris.`,
  });
