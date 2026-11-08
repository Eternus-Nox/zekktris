/**
 * Disappearing messages — limits and the timer's readable form
 * ------------------------------------------------------------
 * A DM's timer (dm_settings.ttl_seconds_after_read) is 1..2419200 seconds
 * (1 second to 4 weeks) or null for off. Each message snapshots it at send
 * time (messages.expire_after_seconds); its clock starts when a recipient
 * reads it (messages.expires_at).
 *
 * The duration wording is shared with every client ("1 day", "1 minute 30
 * seconds"): the server only needs the long form, for the readable fallback
 * `content` of the 'system_disappearing' notice that installed apps which
 * don't know the type show as-is.
 */

/** Shortest timer accepted. */
export const DISAPPEARING_MIN_SECONDS = 1;
/** Longest timer accepted: 4 weeks. Advertised to clients as
 *  `maxTtlSeconds` on GET /users/@me/channels/:id/settings. */
export const DISAPPEARING_MAX_SECONDS = 2_419_200;

const UNITS: ReadonlyArray<readonly [seconds: number, singular: string, plural: string]> = [
  [604_800, 'week', 'weeks'],
  [86_400, 'day', 'days'],
  [3_600, 'hour', 'hours'],
  [60, 'minute', 'minutes'],
  [1, 'second', 'seconds'],
];

/** Long form: every non-zero part, largest first — 604800 → "1 week",
 *  259200 → "3 days", 90 → "1 minute 30 seconds". */
export function formatDisappearingDuration(totalSeconds: number): string {
  let rest = Math.max(0, Math.floor(totalSeconds));
  const parts: string[] = [];
  for (const [size, singular, plural] of UNITS) {
    const n = Math.floor(rest / size);
    if (n === 0) continue;
    rest -= n * size;
    parts.push(`${n} ${n === 1 ? singular : plural}`);
  }
  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}

/** The notice's fallback content, third person: "Alex set disappearing
 *  messages to 1 day." / "Alex turned off disappearing messages." */
export function disappearingNoticeText(actorName: string, timerSeconds: number | null): string {
  return timerSeconds === null
    ? `${actorName} turned off disappearing messages.`
    : `${actorName} set disappearing messages to ${formatDisappearingDuration(timerSeconds)}.`;
}
