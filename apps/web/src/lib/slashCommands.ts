/**
 * Built-in slash commands
 * -----------------------
 * Client-side text transforms. The user types a command like `/me
 * waves` and `transformSlashCommand` returns the substituted text
 * (`*alice waves*`). The send pipeline calls this before encrypting
 * or sending so the server sees the transformed text — no special
 * server-side handling needed.
 *
 * Why client-side: these commands are presentation sugar, not
 * structured data the server needs to know about. Keeping them
 * client-side means the message in the DB is just plain text that
 * any future client can render without knowing about /me semantics.
 *
 * Commands:
 *   /me <action>         → *displayName action*    (italic action)
 *   /shrug [text]        → text ¯\_(ツ)_/¯
 *   /tableflip [text]    → text (╯°□°)╯︵ ┻━┻
 *   /unflip [text]       → text ┬─┬ ノ( ゜-゜ノ)
 *   /spoiler <text>      → ||text||                (rendered hidden)
 *
 * Unknown slashes (`/foo`, `/poll …` if no /poll handler) pass through
 * unchanged — the user sees their literal `/foo` in chat. Better than
 * silently dropping; signals to the user "this isn't a real command."
 */

const SHRUG = '¯\\_(ツ)_/¯';
const TABLEFLIP = '(╯°□°)╯︵ ┻━┻';
const UNFLIP = '┬─┬ ノ( ゜-゜ノ)';

export interface SlashContext {
  /** Display name used by /me to produce "*alice waves*". Falls back
      to username, then a generic placeholder. */
  displayName?: string | null;
  username?: string | null;
}

export interface SlashResult {
  /** The text to actually send. */
  content: string;
  /** Whether a slash command was recognized + applied. Lets the
      composer show a brief "Command executed" indicator if we
      ever want one; currently unused. */
  matched: boolean;
}

/**
 * Run any built-in slash command on `input` and return the
 * transformed text. If the input doesn't match a known command,
 * returns the input unchanged with matched=false.
 */
export function transformSlashCommand(
  input: string,
  ctx: SlashContext = {},
): SlashResult {
  // Slash commands must start at the beginning of the message.
  // Leading whitespace disqualifies; trailing is fine.
  if (!input.startsWith('/')) return { content: input, matched: false };

  // Parse the command name (up to first whitespace) and the rest.
  // Slice off the leading slash before splitting so we don't have
  // to special-case it in every branch.
  const body = input.slice(1);
  const match = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { content: input, matched: false };
  const name = match[1]!.toLowerCase();
  const arg = (match[2] ?? '').trim();

  // Pick a sensible "speaker" label for /me. We prefer displayName
  // (what users actually call themselves) over username (the @handle).
  const speaker = ctx.displayName || ctx.username || 'someone';

  switch (name) {
    case 'me':
      // /me with no argument is a no-op — sending "*alice*" alone
      // looks silly. Return original so the user can amend.
      if (arg.length === 0) return { content: input, matched: false };
      return { content: `*${speaker} ${arg}*`, matched: true };

    case 'shrug':
      return {
        content: arg.length > 0 ? `${arg} ${SHRUG}` : SHRUG,
        matched: true,
      };

    case 'tableflip':
      return {
        content: arg.length > 0 ? `${arg} ${TABLEFLIP}` : TABLEFLIP,
        matched: true,
      };

    case 'unflip':
      return {
        content: arg.length > 0 ? `${arg} ${UNFLIP}` : UNFLIP,
        matched: true,
      };

    case 'spoiler':
      // /spoiler wraps the argument in ||markdown||. With no argument
      // we leave it as-is — a bare /spoiler isn't useful.
      if (arg.length === 0) return { content: input, matched: false };
      return { content: `||${arg}||`, matched: true };

    default:
      // Unknown command — pass through. The literal `/foo` appears
      // in chat, which is the user's cue that nothing happened.
      return { content: input, matched: false };
  }
}
