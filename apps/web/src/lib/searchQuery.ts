/**
 * Search query parser
 * -------------------
 * Picks `from:`, `before:`, `after:` filter tokens out of a free-form
 * search string and returns the bare keywords plus structured filters.
 *
 *   "alice from:bob before:2024-06-15"
 *     → { keywords: 'alice', from: 'bob', before: '2024-06-15' }
 *
 *   "from:@alice"
 *     → { keywords: '', from: 'alice' }   (leading @ is stripped)
 *
 *   "deploy"
 *     → { keywords: 'deploy' }
 *
 * The parser is whitespace-tokenised but preserves "quoted phrases" so
 * the keyword string passed to Postgres' websearch_to_tsquery still
 * carries the user's exact-phrase intent.
 *
 * `from:` resolution (display-name → user id) is the caller's
 * responsibility — this module doesn't know about the user cache. It
 * just hands back the raw string the user typed; SearchPanel maps that
 * to a snowflake author_id by walking the cached members list.
 *
 * Date filters: `YYYY-MM-DD` only for v1. Anything else is silently
 * dropped and stays in the keyword stream — feels less hostile than
 * surfacing a "bad date" error mid-typing.
 */

// Snowflake encoding constants. Duplicated from @zekktris/shared rather
// than imported because the web app doesn't depend on the shared
// package directly. The values must stay in sync — they're stable
// (changing them would break every existing id) so the duplication is
// safe in practice.
const SNOWFLAKE_EPOCH_MS = 1704067200000; // Jan 1, 2024 UTC
const TIMESTAMP_SHIFT = 22n;

export interface ParsedSearchQuery {
  /** What goes into the keyword search. May be empty when the query
      is filter-only ("from:alice" with no other words). */
  keywords: string;
  /** Raw value of from:VALUE — display name or username, without the
      leading `@`. Caller resolves to a user id. */
  from?: string;
  /** YYYY-MM-DD as the user typed it. Caller converts to a snowflake. */
  before?: string;
  after?: string;
}

const FILTER_RE = /^(from|before|after):(.+)$/;

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const tokens = tokenize(input);
  const keywords: string[] = [];
  const out: ParsedSearchQuery = { keywords: '' };
  for (const t of tokens) {
    const m = FILTER_RE.exec(t);
    if (!m) {
      keywords.push(t);
      continue;
    }
    const key = m[1] as 'from' | 'before' | 'after';
    let value = m[2]!;
    // Strip a leading @ on `from:` for naturalness — users will type
    // "from:@alice" because that's how they reference users elsewhere.
    if (key === 'from' && value.startsWith('@')) value = value.slice(1);
    // For dates: validate YYYY-MM-DD; non-conforming values fall back
    // to the keyword stream so the search doesn't go silent on a typo.
    if ((key === 'before' || key === 'after') && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      keywords.push(t);
      continue;
    }
    out[key] = value;
  }
  out.keywords = keywords.join(' ');
  return out;
}

/**
 * Whitespace tokenizer that preserves "quoted phrases" as a single
 * token so a search for "deploy plan" stays atomic when the FTS layer
 * sees it. We DON'T strip the quotes — websearch_to_tsquery uses them
 * to require the phrase to appear contiguously.
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') {
      buf += ch;
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Convert a YYYY-MM-DD string + side ('before' | 'after') to a
 * snowflake bound. The server's snowflake schema is:
 *   (msSinceEpoch << 22) | worker | sequence
 * so the smallest snowflake at midnight of the given date is
 *   ((msAtMidnight - SNOWFLAKE_EPOCH_MS) << 22)
 * and we use that as the cutoff. The server applies `id < before`
 * (strict), so passing the start-of-day snowflake yields "messages
 * sent strictly before midnight of that day", matching how a user
 * would naturally interpret "before 2024-06-15".
 *
 * For `after`, we use the start of the FOLLOWING day so "after
 * 2024-06-15" includes all of June 15 itself, then everything later.
 *
 * Returns null for invalid dates.
 */
export function dateBoundToSnowflake(
  ymd: string,
  side: 'before' | 'after',
): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]),
    mo = Number(m[2]) - 1,
    d = Number(m[3]);
  // UTC: search filters anchor on the calendar day in UTC. Local-day
  // resolution would be more intuitive in a timezone-aware client but
  // also goes wrong across DST transitions and across users in
  // different zones searching the same channel; UTC is the boring
  // correct answer.
  const ms = Date.UTC(y, mo, d, side === 'before' ? 0 : 24, 0, 0, 0);
  if (Number.isNaN(ms)) return null;
  if (ms < SNOWFLAKE_EPOCH_MS) {
    // Date predates the snowflake epoch — every message id is larger
    // than this bound. For 'before' that means no results; for 'after'
    // that's a no-op (all messages match). Returning '0' makes the
    // server's `id < 0` always-false for before and `id > 0` always-true
    // for after, which is the right semantics either way.
    return '0';
  }
  const snowflake = (BigInt(ms - SNOWFLAKE_EPOCH_MS) << TIMESTAMP_SHIFT).toString();
  return snowflake;
}
