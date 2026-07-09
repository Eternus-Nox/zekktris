/**
 * Profanity mask for the parental "blur swear words" filter. When a supervised
 * child's effective restrictions have `filterProfanity` on, every message body
 * they see is run through {@link maskProfanity}, which masks each whole-word
 * profanity match to its first letter + bullets (e.g. `fucking` → `f••••••`).
 *
 * The word set is ported from the server's WATCH + BLOCKED presets
 * (apps/api/src/data/bannedWordsPreset.ts). Whole-word, case-insensitive —
 * matches the server's automod matching semantics (`\b…\b`, `i`). This is a
 * client-side render control only; nothing is sent or stored masked.
 */

// General profanity + sexual/explicit (server WATCH_WORDS_PRESET).
const WATCH = [
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'motherfucker',
  'motherfuckers', 'motherfucking', 'shit', 'shits', 'shitty', 'bullshit',
  'shithead', 'dumbass', 'jackass', 'asshole', 'assholes', 'arsehole',
  'bastard', 'bastards', 'bitch', 'bitches', 'bitchy', 'son of a bitch',
  'goddamn', 'goddammit', 'piss off', 'pissed off',
  'cock', 'cocks', 'cocksucker', 'dick', 'dicks', 'dickhead', 'pussy',
  'pussies', 'cunt', 'cunts', 'twat', 'wank', 'wanker', 'jerkoff',
  'jerk off', 'blowjob', 'blow job', 'handjob', 'hand job', 'cum',
  'jizz', 'tits', 'titties', 'boobs', 'dildo', 'porn', 'porno',
  'pornography', 'slut', 'sluts', 'slutty', 'whore', 'whores', 'hoe',
  'hoes', 'skank',
];

// Slurs (server BLOCKED_WORDS_PRESET) — always masked for a child.
const BLOCKED = [
  'nigger', 'niggers', 'nigga', 'niggas', 'chink', 'chinks', 'gook',
  'spic', 'spics', 'wetback', 'wetbacks', 'kike', 'kikes', 'beaner',
  'beaners', 'raghead', 'towelhead', 'faggot', 'faggots', 'fag', 'fags',
  'dyke', 'dykes', 'tranny', 'trannies', 'retard', 'retards', 'retarded',
];

const WORDS = [...BLOCKED, ...WATCH];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longer phrases first so they win over any substring (e.g. "son of a bitch"
// before "bitch"). `\b` boundaries keep "class" from matching "ass", etc.
const PATTERN = new RegExp(
  '\\b(' +
    [...WORDS].sort((a, b) => b.length - a.length).map(escapeRegex).join('|') +
    ')\\b',
  'gi',
);

// Keep the first letter/digit; replace subsequent letters/digits with •,
// leaving spaces/punctuation so multi-word phrases keep their shape.
function maskMatch(word: string): string {
  let seenFirst = false;
  let out = '';
  for (const ch of word) {
    if (!/[a-z0-9]/i.test(ch)) {
      out += ch;
    } else if (!seenFirst) {
      seenFirst = true;
      out += ch;
    } else {
      out += '•';
    }
  }
  return out;
}

// Custom-emoji shortcodes (:name:) and mention/channel tokens (<…>) must NOT be
// masked — rewriting their inner text (e.g. :cum: → :c••:) corrupts the token so
// it no longer resolves. Mask only the text OUTSIDE these spans.
const PROTECTED = /:[A-Za-z0-9_]+:|<[^>]+>/g;

export function maskProfanity(text: string): string {
  if (!text) return text;
  let out = '';
  let last = 0;
  PROTECTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED.exec(text)) !== null) {
    out += text.slice(last, m.index).replace(PATTERN, (w) => maskMatch(w));
    out += m[0]; // leave the token untouched
    last = m.index + m[0].length;
  }
  out += text.slice(last).replace(PATTERN, (w) => maskMatch(w));
  return out;
}
