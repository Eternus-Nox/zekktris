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
