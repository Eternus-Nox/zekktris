/**
 * Media retention — the "full-size original is no longer stored" state.
 * ---------------------------------------------------------------------
 * Server-side media retention ages out the FULL-SIZE bytes of an
 * attachment while keeping everything else: the message, its text, the
 * attachment row (filename / size / dimensions) and the small preview
 * thumbnail. See `ATTACHMENT_RETENTION_DAYS` on the API.
 *
 * The signal is `attachment.blobExpiredAt` (ISO string, or null/undefined
 * while the original is still stored — which is the normal case, and what
 * locally-synthesized optimistic attachments carry).
 *
 * The contract that matters at every call site:
 *
 *   - `attachment.url` is STILL POPULATED and still points at the old
 *     path. It just doesn't resolve any more. So gate on `blobExpiredAt`,
 *     never on a missing/empty url, and never fetch `url` for an expired
 *     attachment — no inline <img>/<video> src, no lightbox, no download
 *     or "open original" link. Doing so lands the user on a broken image
 *     or a 404.
 *   - `thumbnailUrl` is kept forever and is what we render instead. For
 *     E2EE it is its own channel-key-encrypted object with its own IV, so
 *     it keeps decrypting fine once the original is gone.
 *   - Nothing was deleted from anyone's DEVICE. This is server-side only,
 *     which is why the copy below says "no longer stored on our servers"
 *     and not "deleted".
 */

import type { CSSProperties } from 'react';
import type { Attachment } from '@zekktris/client';
import { Clock } from './icons';

/** True when media retention has removed this attachment's full-size
 *  original from the server. `blobExpiredAt` is optional on the client type
 *  (optimistic attachments omit it) — absent means "still stored". */
export function isBlobExpired(a: Attachment): boolean {
  return !!a.blobExpiredAt;
}

/** Short label for the badge that sits on a surviving thumbnail. */
export const EXPIRED_LABEL = 'Original expired';

/** Tooltip / long-form explanation. Deliberately says "our servers": the
 *  sweep never touches anyone's device, and claiming otherwise would be a
 *  false data-retention promise. */
export const EXPIRED_TITLE =
  'The full-size original is no longer stored on our servers. This preview is kept. Copies already saved on a device are unaffected.';

/**
 * The pill that sits on top of a surviving thumbnail. Absolutely
 * positioned — the caller supplies a `relative` frame. Translucent dark
 * rather than the usual `bg-bg-2` surface because it has to stay readable
 * over arbitrary image content (same reasoning as the lightbox chrome).
 */
export function ExpiredBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] leading-none text-white/90 backdrop-blur-sm ${className}`}
    >
      <Clock size={11} />
      {EXPIRED_LABEL}
    </span>
  );
}

/**
 * Fallback for an expired attachment with NO surviving preview — a file, a
 * video, a voice note, or an old image that predates thumbnails. Styled as
 * the same chip as the plain file card so it reads as "an attachment that
 * is here but can't be opened", not as an error.
 */
export function ExpiredMediaCard({
  filename,
  subtitle,
  style,
  className = '',
}: {
  filename: string;
  /** e.g. a formatted file size — prefixed onto the second line. */
  subtitle?: string;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      title={EXPIRED_TITLE}
      style={style}
      className={`inline-flex max-w-[320px] items-center gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2 text-sm ${className}`}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg-3 text-ink-3"
        aria-hidden
      >
        <Clock size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink-2">{filename}</span>
        <span className="block text-xs text-ink-3">
          {subtitle ? `${subtitle} · ` : ''}Original no longer stored
        </span>
      </span>
    </span>
  );
}
