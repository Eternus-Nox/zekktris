/**
 * Markdown + mentions renderer
 * ----------------------------
 * Two-pass tokenizer.
 *
 * Pass 1 (block):  fenced code blocks (```optional-lang\n...\n```)
 *   Code blocks are taken verbatim — none of the inline rules below
 *   apply inside them. We split content into a sequence of {code|text}
 *   segments at ``` boundaries.
 *
 * Pass 2 (inline, applied to text segments only):
 *   **bold**            inline strong
 *   *italic* / _italic_ inline emphasis
 *   ~~strike~~          inline strikethrough
 *   `code`              inline monospace span
 *   <@id>  / <@!id>     user mention   → chip with display name
 *   <@&id>              role mention   → chip
 *   <#id>               channel mention → chip
 *   @everyone @here     mass mentions  → chip
 *   :emoji_name:        custom guild emoji → inline <img> if known
 *   https?://…          autolinked     → <a target="_blank">
 *
 * Nested inline formatting (e.g. `**bold _italic_**`) is intentionally not
 * recursive for v1 — the regex is greedy-first within a single segment but
 * doesn't recurse. The cost of full markdown nesting is a real parser
 * (~500 LOC) that we don't need yet.
 *
 * The function returns a `ReactNode` so callers can drop it inline.
 *
 * Resolving mentions: the renderer takes a `lookupUser` and `lookupChannel`
 * callback. When a mention can't be resolved, we render a faded "@unknown"
 * chip rather than the raw <@id> markup — it's still recognizable as a
 * mention, just less informative. Unresolved emoji — for example a
 * `:nonexistent:` token — fall back to literal text so users can still
 * see what they typed.
 */

import type { ReactNode } from 'react';
import type { Channel, GuildEmoji, PublicUser } from '@zekktris/client';

interface RenderContext {
  lookupUser(id: string): PublicUser | undefined;
  lookupChannel(id: string): Channel | undefined;
  /** Used to highlight mentions of the current user. */
  selfUserId: string | undefined;
  onChannelClick?: (channelId: string) => void;
  /** Resolve a `:name:` token to a guild emoji DTO. Called for every
      potential emoji match in the inline pass. Return undefined to
      leave the token as plain text (graceful degradation when the
      emoji was deleted or doesn't exist for this guild). */
  lookupEmoji?(name: string): GuildEmoji | undefined;
}

// Inline pattern. Order matters: longer/more-specific patterns first so
// they win the "earliest start position" tie. Each capture group
// corresponds to one token kind; we identify which one matched by the
// index of the first non-undefined group in the match.
const INLINE_PATTERN = new RegExp(
  [
    '(\\*\\*[^*]+?\\*\\*)',          // 1: **bold**
    '(\\*[^*\\s][^*]*?\\*)',         // 2: *italic*
    '(_[^_\\s][^_]*?_)',             // 3: _italic_
    '(~~[^~]+?~~)',                  // 4: ~~strikethrough~~
    '(`[^`]+?`)',                    // 5: `inline code`
    '(<@!?\\d+>)',                   // 6: user mention
    '(<@&\\d+>)',                    // 7: role mention
    '(<#\\d+>)',                     // 8: channel mention
    '(@everyone|@here)',             // 9: mass mention
    '(:[a-z0-9_]{2,32}:)',           // 10: :emoji:
    '(https?:\\/\\/[^\\s<>"]+)',     // 11: url
  ].join('|'),
  'g',
);

// Fenced code block — pass 1. The optional language hint after the opening
// fence is captured for future syntax-highlighter wiring; for v1 we just
// ignore it. The DOTALL via [\s\S] means the body can span lines.
const FENCED_PATTERN = /```([a-zA-Z0-9+\-_]*)\n?([\s\S]*?)```/g;

interface Segment {
  kind: 'text' | 'code';
  content: string;
  /** Language hint from the opening fence; only present when kind==='code'. */
  lang?: string;
}

function splitFencedBlocks(content: string): Segment[] {
  const out: Segment[] = [];
  FENCED_PATTERN.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_PATTERN.exec(content)) !== null) {
    if (m.index > cursor) out.push({ kind: 'text', content: content.slice(cursor, m.index) });
    out.push({ kind: 'code', content: m[2] ?? '', lang: m[1] || undefined });
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) out.push({ kind: 'text', content: content.slice(cursor) });
  return out;
}

/**
 * Detect whether a message is "emoji-only" — only emoji tokens and
 * whitespace, with at most JUMBO_MAX emoji. Such messages render the
 * emoji at a much larger size for visual punch (matching Discord and
 * iMessage).
 *
 * Token kinds we count as emoji:
 *   - `:name:` tokens that resolve via lookupEmoji
 *   - Single Unicode pictographic codepoints (\p{Extended_Pictographic})
 *     plus their variation selectors / skin-tone modifiers / ZWJ
 *     sequences
 *
 * Anything else (letters, digits, punctuation) disqualifies the message.
 */
const JUMBO_MAX = 3;
const EMOJI_TOKEN_RE = /:[a-z0-9_]{2,32}:/g;
// Matches a "compound emoji" — base pictographic plus optional variation
// selector, skin-tone modifier, and ZWJ-joined components. The `u` flag
// is required for \p{...} classes.
const PICTO_RE =
  /\p{Extended_Pictographic}(?:\u{FE0F}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?(?:\u200D\p{Extended_Pictographic}(?:\u{FE0F}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?)*/gu;

function isEmojiOnly(content: string, lookupEmoji?: (n: string) => unknown): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  let work = trimmed;
  let count = 0;

  // Replace `:name:` tokens with a sentinel character (only when they
  // actually resolve — unknown tokens stay literal text and disqualify).
  work = work.replace(EMOJI_TOKEN_RE, (m) => {
    const name = m.slice(1, -1);
    if (lookupEmoji && lookupEmoji(name)) {
      count++;
      return ' ';
    }
    return m; // unresolved — treat as text
  });

  // Replace pictographic emoji clusters with whitespace.
  work = work.replace(PICTO_RE, () => {
    count++;
    return ' ';
  });

  // If anything non-whitespace remains, the message has actual text
  // mixed in — not jumbo. Also bail if no emoji were found at all,
  // or more than the cap.
  if (count === 0 || count > JUMBO_MAX) return false;
  if (work.replace(/\s+/g, '').length > 0) return false;
  return true;
}

export function renderMessageContent(content: string, ctx: RenderContext): ReactNode {
  const segments = splitFencedBlocks(content);
  // Jumbo only applies when the entire message is one text segment
  // and it qualifies — code fences disqualify.
  const jumbo =
    segments.length === 1 &&
    segments[0]!.kind === 'text' &&
    isEmojiOnly(segments[0]!.content, ctx.lookupEmoji);
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const seg of segments) {
    if (seg.kind === 'code') {
      nodes.push(
        <pre
          key={key++}
          className="bg-bg-3 text-ink-1 rounded-md px-3 py-2 my-1 overflow-x-auto scrollbar-thin"
        >
          <code className="font-mono text-[0.9em] whitespace-pre">{seg.content}</code>
        </pre>,
      );
    } else {
      nodes.push(<RenderInline key={key++} content={seg.content} ctx={ctx} jumbo={jumbo} />);
    }
  }
  return <>{nodes}</>;
}

function RenderInline({
  content,
  ctx,
  jumbo,
}: {
  content: string;
  ctx: RenderContext;
  /** When true, custom-emoji `<img>` and unicode glyphs render at 2× size. */
  jumbo?: boolean;
}) {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  INLINE_PATTERN.lastIndex = 0; // global regex state hygiene
  for (const m of content.matchAll(INLINE_PATTERN)) {
    const start = m.index ?? 0;
    if (start > cursor) {
      out.push(content.slice(cursor, start));
    }
    cursor = start + m[0].length;

    if (m[1]) {
      out.push(<strong key={key++}>{m[1].slice(2, -2)}</strong>);
    } else if (m[2]) {
      out.push(<em key={key++}>{m[2].slice(1, -1)}</em>);
    } else if (m[3]) {
      out.push(<em key={key++}>{m[3].slice(1, -1)}</em>);
    } else if (m[4]) {
      out.push(<s key={key++}>{m[4].slice(2, -2)}</s>);
    } else if (m[5]) {
      out.push(
        <code key={key++} className="font-mono text-[0.9em] bg-bg-3 text-ink-1 px-1 py-px rounded">
          {m[5].slice(1, -1)}
        </code>,
      );
    } else if (m[6]) {
      const id = m[6].replace(/[<@!>]/g, '');
      const user = ctx.lookupUser(id);
      const isSelf = id === ctx.selfUserId;
      const label = user ? `@${user.displayName}` : '@unknown';
      out.push(
        <span
          key={key++}
          className={
            isSelf
              ? 'inline-block bg-amber-900/40 text-amber-200 px-1 rounded font-medium'
              : 'inline-block bg-accent/20 text-accent-soft hover:bg-accent/30 px-1 rounded font-medium'
          }
          title={user ? user.username : `user ${id}`}
        >
          {label}
        </span>,
      );
    } else if (m[7]) {
      const id = m[7].replace(/[<@&>]/g, '');
      out.push(
        <span
          key={key++}
          className="inline-block bg-accent/20 text-accent-soft px-1 rounded font-medium"
          title={`role ${id}`}
        >
          @role
        </span>,
      );
    } else if (m[8]) {
      const id = m[8].replace(/[<#>]/g, '');
      const channel = ctx.lookupChannel(id);
      const label = channel?.name ? `#${channel.name}` : '#unknown';
      out.push(
        <button
          key={key++}
          type="button"
          onClick={() => ctx.onChannelClick?.(id)}
          className="inline-block bg-accent/20 text-accent-soft hover:bg-accent/30 px-1 rounded font-medium"
        >
          {label}
        </button>,
      );
    } else if (m[9]) {
      out.push(
        <span
          key={key++}
          className="inline-block bg-amber-900/40 text-amber-200 px-1 rounded font-medium"
        >
          {m[9]}
        </span>,
      );
    } else if (m[10]) {
      // Custom emoji: `:name:`. Strip the colons, look it up against
      // the guild's emoji index. Hit → render as inline image with
      // the emoji name as alt + title (so screen readers announce
      // it and hover shows the source). Miss → fall through as plain
      // text. This protects us against (a) typos in `:name:` and
      // (b) deleted emoji rows that messages still reference.
      const name = m[10].slice(1, -1);
      const emoji = ctx.lookupEmoji?.(name);
      if (emoji) {
        out.push(
          <img
            key={key++}
            src={emoji.url}
            alt={`:${name}:`}
            title={`:${name}:`}
            // Jumbo (~44px) for emoji-only messages, otherwise 22px
            // inline. `align-text-bottom` keeps the bottom edge flush
            // with the surrounding text so two emoji on a line don't
            // bob relative to letters.
            className={
              jumbo
                ? 'inline-block w-[44px] h-[44px] align-text-bottom mx-0.5'
                : 'inline-block w-[22px] h-[22px] align-text-bottom mx-px'
            }
            loading="lazy"
            draggable={false}
          />,
        );
      } else {
        // Unknown emoji — render literally so the user sees their input.
        out.push(m[10]);
      }
    } else if (m[11]) {
      out.push(
        <a
          key={key++}
          href={m[11]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline break-all"
        >
          {m[11]}
        </a>,
      );
    }
  }
  if (cursor < content.length) {
    out.push(content.slice(cursor));
  }
  // For jumbo messages, wrap the whole inline run in a span that bumps
  // font-size — this scales unicode-emoji glyphs (which are rendered
  // as text) up to match the inline `<img>` jumbo size. Custom-emoji
  // images already use their own jumbo class above.
  if (jumbo) {
    return <span className="text-[2.6rem] leading-tight">{out}</span>;
  }
  return <>{out}</>;
}
