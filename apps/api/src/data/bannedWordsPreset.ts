/**
 * Common banned-words preset (Admin → Security → "Load common wordlist").
 *
 * A starter moderation list in the spirit of the widely used open-source
 * blocklists (Shutterstock LDNOOBW and similar): strong profanity, sexual
 * terms, and slurs. The filter matches whole words case-insensitively, so
 * common variants/plurals are listed explicitly.
 *
 * This is a STARTING POINT — admins can remove anything too strict for
 * their community and add anything missing. Loading the preset never
 * removes existing entries (insert-only, duplicates skipped).
 */

export const BANNED_WORDS_PRESET: string[] = [
  // Strong profanity + variants
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'motherfucker',
  'motherfuckers', 'motherfucking', 'shit', 'shits', 'shitty', 'bullshit',
  'shithead', 'dumbass', 'jackass', 'asshole', 'assholes', 'arsehole',
  'bastard', 'bastards', 'bitch', 'bitches', 'bitchy', 'son of a bitch',
  'goddamn', 'goddammit', 'piss off', 'pissed off',

  // Sexual / explicit
  'cock', 'cocks', 'cocksucker', 'dick', 'dicks', 'dickhead', 'pussy',
  'pussies', 'cunt', 'cunts', 'twat', 'wank', 'wanker', 'jerkoff',
  'jerk off', 'blowjob', 'blow job', 'handjob', 'hand job', 'cum',
  'jizz', 'tits', 'titties', 'boobs', 'dildo', 'porn', 'porno',
  'pornography', 'slut', 'sluts', 'slutty', 'whore', 'whores', 'hoe',
  'hoes', 'skank',

  // Slurs (racial, ethnic, homophobic, transphobic, ableist)
  'nigger', 'niggers', 'nigga', 'niggas', 'chink', 'chinks', 'gook',
  'spic', 'spics', 'wetback', 'wetbacks', 'kike', 'kikes', 'beaner',
  'beaners', 'raghead', 'towelhead', 'faggot', 'faggots', 'fag', 'fags',
  'dyke', 'dykes', 'tranny', 'trannies', 'retard', 'retards', 'retarded',
];
