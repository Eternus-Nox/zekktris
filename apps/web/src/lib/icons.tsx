/**
 * Icons
 * -----
 * Small inline-SVG components. We use stroke-based icons (1.6px stroke at
 * the default 16-px size) so they read crisply on dark backgrounds and
 * scale without antialiasing artifacts. Geometry is cribbed from the
 * Feather/Lucide icon set (MIT) and lightly adjusted for visual balance.
 * Stroke weight chosen to match the Zekktris design system — slightly
 * lighter than Feather's default (which is 2px) for a more atmospheric
 * feel against the abyssal palette.
 *
 * Why inline SVG instead of `lucide-react`:
 *   - Bundle size: a single stroke icon is ~250 bytes, vs ~10 KB for the
 *     thinnest tree-shake of lucide. We use ~14 icons; total is ~3.5 KB.
 *   - No runtime dependency to maintain in the workspace.
 *   - Full control over stroke width, sizing, and accessible labels.
 *
 * Usage: `<Hash size={14} className="text-ink-3" />`. The `size` prop
 * controls width AND height; `className` propagates to the SVG element so
 * Tailwind colors via `text-*` work via `currentColor`.
 *
 * For accessibility, wrap inside a `<button aria-label="…">` for
 * interactive uses. Decorative icons (e.g. inside a button that has its
 * own visible text label) don't need extra ARIA — `aria-hidden` is set on
 * the SVG itself.
 */
import type { SVGProps } from 'react';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number;
}

function Svg({ size = 16, children, className = '', ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Channel-list & guild-rail icons ────────────────────────────────────────

export function Hash(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </Svg>
  );
}

export function Lock(props: IconProps) {
  // Closed-padlock glyph used as a "this channel has restricted
  // access" affordance next to a channel's hash. Matches the
  // outline weight of the other channel-row icons.
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

export function Archive(props: IconProps) {
  // Box-with-lid feather-style glyph. Used as the archive/unarchive
  // affordance on thread headers. The horizontal lid line sits above
  // the box body so it reads as "putting away into storage" rather
  // than just a generic container.
  return (
    <Svg {...props}>
      <path d="M21 8v13H3V8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <path d="M10 12h4" />
    </Svg>
  );
}

export function AtSign(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
    </Svg>
  );
}

// ── Action / button icons ──────────────────────────────────────────────────

export function Plus(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  );
}

export function X(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </Svg>
  );
}

export function Settings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function Trash(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Svg>
  );
}

export function Edit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z" />
    </Svg>
  );
}

export function FilePen(props: IconProps) {
  // Document page with a pen overlay — for things that are "written
  // rules" / "drafted text". Combines a feather-style file outline
  // with the Edit icon's pen stroke.
  return (
    <Svg {...props}>
      <path d="M12 22H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9l5 5v7" />
      <polyline points="14 2 14 8 19 8" />
      <path d="M16.5 17.5a2.121 2.121 0 0 1 3 3L15 25H12v-3z" transform="translate(-1 -7)" />
    </Svg>
  );
}

export function Copy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function QrCode(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="5" height="5" rx="1" />
      <rect x="16" y="3" width="5" height="5" rx="1" />
      <rect x="3" y="16" width="5" height="5" rx="1" />
      <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
      <path d="M21 21v.01" />
      <path d="M12 7v3a2 2 0 0 1-2 2H7" />
      <path d="M3 12h.01" />
      <path d="M12 3h.01" />
      <path d="M12 16v.01" />
      <path d="M16 12h1" />
      <path d="M21 12v.01" />
      <path d="M12 21v-1" />
    </Svg>
  );
}

// ── Sidebar / nav ──────────────────────────────────────────────────────────

export function ChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="9 6 15 12 9 18" />
    </Svg>
  );
}

export function ChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="15 18 9 12 15 6" />
    </Svg>
  );
}

export function CheckCircle(props: IconProps) {
  // Circle with a checkmark inside. Used for "resolved / complete"
  // affordances — forum threads, todo items, etc.
  return (
    <Svg {...props}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  // A bare checkmark. Used for selected/active affordances (status rows,
  // membership tier cards) where the iOS app shows an accent checkmark.
  return (
    <Svg {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function ChevronUp(props: IconProps) {
  // Vertical mirror of ChevronDown — used for reorder-up affordances.
  return (
    <Svg {...props}>
      <polyline points="6 15 12 9 18 15" />
    </Svg>
  );
}

// ── Modal / settings tabs ──────────────────────────────────────────────────

export function Users(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

export function UserPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </Svg>
  );
}

/**
 * Person silhouette with a minus glyph — the inverse of UserPlus,
 * used for "remove friend" actions in the profile card.
 */
export function UserMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </Svg>
  );
}

export function Info(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </Svg>
  );
}

export function AlertTriangle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}

// ── Other ──────────────────────────────────────────────────────────────────

export function LogOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Svg>
  );
}

// ── Voice channel & audio ──────────────────────────────────────────────────

/** Speaker glyph used to mark voice channels in the channel list. */
export function Volume2(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </Svg>
  );
}

// ── Roles & ordering ───────────────────────────────────────────────────────

/** Shield — used to mark the Roles tab in server settings. */
export function Shield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  );
}

/** Up-arrow for reorder buttons. */
export function ArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Svg>
  );
}

/** Down-arrow for reorder buttons. */
export function ArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </Svg>
  );
}

/** Search — magnifier glyph for the override target picker. */
export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}

/**
 * Six-dot grip handle — appears as the drag affordance on draggable
 * rows. The grip is purely visual: dragging actually starts on the
 * whole row, but the icon tells the user the row is moveable.
 */
export function GripVertical(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </Svg>
  );
}

/**
 * Pushpin / thumbtack — used to mark pinned messages and the "show
 * pinned messages" header button.
 */
export function Pin(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </Svg>
  );
}

/**
 * Plain speech-bubble — used to render a thread's icon in the channel
 * list.
 */
export function MessageSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

/**
 * XCircle — an X inside a circle. Destructive-action affordance used on
 * the DM settings panel's "Close DM" row (iOS parity: xmark.circle).
 */
export function XCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </Svg>
  );
}

/**
 * MessagesSquare — two overlapping speech bubbles. Used on the rail's
 * Home/DMs tile to match iOS's bubble.left.and.bubble.right.fill (and
 * Android's QuestionAnswer): "conversations", plural, as opposed to the
 * single-bubble MessageSquare used for threads.
 */
export function MessagesSquare(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Back bubble — up and to the left */}
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      {/* Front bubble — offset down-right, tail on the right side */}
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </Svg>
  );
}

/**
 * Forum — stacked-discussion glyph. Two overlapping rounded squares
 * signal "multiple posts/threads stacked together," distinct from the
 * single-bubble MessageSquare. Used on guild_forum channel rows and
 * as the icon in the ForumView header. The stagger between the two
 * squares is what makes it read as "stack of conversations" instead
 * of "a couple of speech bubbles".
 */
export function Forum(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Back square — lifted up and to the right */}
      <path d="M17 7v6a2 2 0 0 1-2 2H9l-2 2V9a2 2 0 0 1 2-2h6z" />
      {/* Front square — overlaps the back square's lower-left */}
      <path d="M21 11v6a2 2 0 0 1-2 2h-7l-3 3v-4" />
    </Svg>
  );
}

/**
 * ExternalLink — Feather-style square-with-out-arrow glyph. Used on
 * link-type channel rows in the sidebar to signal "this opens
 * externally" and on any inline link affordance that leaves the
 * app. Mirrors lucide-react / Feather's external-link icon.
 */
export function ExternalLink(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Box (lower-left of the glyph) */}
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      {/* Out-arrow head */}
      <polyline points="15 3 21 3 21 9" />
      {/* Out-arrow shaft */}
      <line x1="10" y1="14" x2="21" y2="3" />
    </Svg>
  );
}

/** Key — passkey / credential affordance (Feather key glyph). */
export function Key(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
    </Svg>
  );
}

/** Eye — "show password" toggle (revealed state). Feather's eye glyph. */
export function Eye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Eye with a slash — "hide password" toggle (concealed state). */
export function EyeOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  );
}

/**
 * Up-and-left elbow arrow — the reply indicator. Used both on the per-
 * message Reply hover button and on the "Replying to..." chip in the
 * composer. Same glyph Discord uses for the same purpose.
 */
export function CornerUpLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </Svg>
  );
}

/** Microphone-off — for self-mute indicator and mute toggle. */
export function MicOff(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </Svg>
  );
}

/** Microphone — paired with MicOff for the mute toggle's "on" state. */
export function Mic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </Svg>
  );
}

/** Calendar — month-page glyph for the scheduled-events surface. */
export function Calendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Svg>
  );
}

/** MapPin — location glyph for external events. */
export function MapPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  );
}

/** Phone — standard handset glyph used for "start a call" / "in
    a call" affordances. Paired with PhoneOff (same handset rotated
    135° to read as "hung up"). */
export function Phone(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </Svg>
  );
}

/** PhoneOff — used for the "leave voice channel" / hangup button.
    A standard phone-handset glyph rotated 135° so the receiver
    points down-and-away, the conventional "hung up" pose used by
    Discord and most call-software. The previous half-phone with a
    diagonal slash read as a fragment rather than an action. */
export function PhoneOff(props: IconProps) {
  return (
    <Svg {...props}>
      <g transform="rotate(135 12 12)">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </g>
    </Svg>
  );
}

/** Headphones — paired with HeadphonesOff for the deafen toggle. */
export function Headphones(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </Svg>
  );
}

/** Headphones with a slash through it — deafen "on" state. */
export function HeadphonesOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 18v-6a9 9 0 0 1 13.5-7.79" />
      <path d="M21 12v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  );
}

/** Paperclip — for file attachments. Replaces the 📎 emoji. */
export function Paperclip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Svg>
  );
}

/** Still camera — for capturing a photo in the composer. */
export function Camera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  );
}

/** Video camera — for the video toggle in voice view. */
export function Video(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </Svg>
  );
}

/** Video camera with slash — video "off" state. */
export function VideoOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  );
}

/** Monitor with arrow — used for screen-share button. */
export function ScreenShare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3" />
      <polyline points="8 21 16 21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <polyline points="17 8 22 3 17 -2" transform="translate(0 5)" />
      <line x1="22" y1="8" x2="11" y2="8" />
    </Svg>
  );
}

/** Monitor (desktop display on a stand) — the desktop/laptop device glyph in
 *  the Security → Active sessions list. Mirrors iOS's "laptopcomputer". */
export function Monitor(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </Svg>
  );
}

/** Smartphone (handset body + home indicator) — the mobile device glyph in
 *  the Security → Active sessions list. Mirrors iOS's "iphone". Distinct
 *  from `Phone`, which is a telephone handset used for calls. */
export function Smartphone(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </Svg>
  );
}

/** Globe (meridians) — fallback device glyph for an unrecognized or absent
 *  User-Agent in the Active sessions list. Mirrors iOS's "globe". */
export function Globe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Svg>
  );
}

/** Ban (universal "no" / prohibition glyph) — used for the Bans tab
 *  in guild settings and the Ban action in moderation menus. */
export function Ban(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </Svg>
  );
}

/** Smile (face) — used as the emoji glyph in pickers and the Emoji
 *  settings tab. Lucide-style proportions. */
export function Smile(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </Svg>
  );
}

/** Three vertical bars — used for the Poll button in the composer. */
export function BarChart(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="8" />
      <line x1="18" y1="20" x2="18" y2="16" />
    </Svg>
  );
}

/** Right-pointing arrow with a tail bend — used for the Forward
 *  button. Visually distinct from CornerUpLeft (reply): forward goes
 *  right, reply curves back left. */
export function Forward(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="15 17 20 12 15 7" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </Svg>
  );
}

/** Solid-leaning play triangle. */
export function Play(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Two parallel bars. */
export function Pause(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Microphone — composer voice-message button. (Existing Mic icon
 *  defined elsewhere in this file is reused.) */

/** Open hand — used for the stage "raise hand" affordance. */
export function Hand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v9" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </Svg>
  );
}

/** Pointing hand — index finger extended from a fist (a "poke / nudge"
 *  gesture). Used for the DM poke button (👉, but monochrome). */
export function HandPointing(props: IconProps) {
  return (
    <Svg {...props}>
      {/* Extended index finger pointing up */}
      <path d="M11 12V4a2 2 0 0 1 4 0v8" />
      {/* Curled fingers + thumb + wrist forming the fist below it */}
      <path d="M15 12a2 2 0 0 1 4 0v3a7 7 0 0 1-7 7 7 7 0 0 1-5-2l-3.3-3.4a2 2 0 0 1 2.9-2.8L9 13" />
    </Svg>
  );
}

/** Concentric arcs around a dot — broadcast / radio / stage marker.
 *  Visually distinct from Volume2 (voice) so users can tell stage
 *  channels apart from voice channels in the channel list at a glance. */
export function Radio(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
      <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
    </Svg>
  );
}

/** Compass — used for the server-discovery entry point. */
export function Compass(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" fill="currentColor" stroke="none" />
    </Svg>
  );
}


/** Square-with-folded-corner — used for the Sticker button.
 *  Distinct from BarChart and Smile so the composer's row of action
 *  glyphs reads at a glance. */
export function StickerSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z" />
      <polyline points="15 3 15 9 21 9" />
    </Svg>
  );
}

/** Upload (cloud-up) — used on file-picker drop zones, especially the
 *  emoji uploader where it sits inside a dashed outline. */
export function Upload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </Svg>
  );
}

/** Folder shape — used by the rail's folder tile. Square with a tab
 *  on top-left to distinguish from a plain rectangle. */
export function Folder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </Svg>
  );
}

/** Inbox tray — used by the mentions inbox trigger. Drawer-with-arrow
 *  glyph, evoking "things sent your way that you can pick up later". */
export function Inbox(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Svg>
  );
}

export function Activity(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </Svg>
  );
}

/** Clock face — used for timeout actions and indicators. Standard
 *  "this is about a duration" glyph: circle + two hands at 12 and 3. */
export function Clock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Svg>
  );
}

/** Stopwatch — disappearing messages (the DM settings row, the header
 *  indicator, the per-message marker and the timer-change notice). Distinct
 *  from Clock, which means "a point in time / timeout". */
export function Timer(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="10" y1="2" x2="14" y2="2" />
      <line x1="12" y1="14" x2="15" y2="11" />
      <circle cx="12" cy="14" r="8" />
    </Svg>
  );
}

/** Wi-Fi with a slash through it — used by the PWA offline banner.
 *  Three concentric arcs (signal cone) with a diagonal line cutting
 *  across. The dot at the tip of the cone is the device. */
export function WifiOff(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </Svg>
  );
}

/** Download glyph — arrow into a tray. Used by the PWA install
 *  affordance ("install this app"). Same outline weight as Upload. */
export function Download(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  );
}

/** Refresh/reload circular arrow. Used by the "update available"
 *  banner — clicking reloads to pick up the new build. */
export function RefreshCw(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Svg>
  );
}

/** Share/upload glyph in the iOS Safari style — square with an arrow
 *  emerging from the top. Used in the iOS Add-to-Home-Screen
 *  instructions modal because that's the actual button users tap. */
/** Bookmark glyph — outlined or filled depending on saved state.
 *  Used in message action bars: tapping saves; tapping again
 *  unsaves. Filled mode mirrors the visual language of saved /
 *  starred items everywhere else. */
export function Bookmark({
  size = 16,
  className,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ShareSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </Svg>
  );
}

/** Filled padlock for the E2EE indicator (matches the iOS DM lock badge,
 *  SF Symbol lock.fill). Tinted via `currentColor` so callers choose the
 *  color — the DM list renders it `text-accent` on a `bg-2` circle with a
 *  faint accent ring, exactly like iOS. Kept outside the shared Svg()
 *  wrapper because that wrapper is stroke-based; this glyph is filled. */
export function ShieldE2ee({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      className={className}
    >
      {/* Solid filled padlock (SF Symbol lock.fill look), tinted via
          currentColor. The DM badge renders it accent on a bg-2 circle so
          the web E2EE lock matches the iOS one exactly. */}
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  );
}
