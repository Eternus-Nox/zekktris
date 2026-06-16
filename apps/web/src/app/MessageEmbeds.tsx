/**
 * MessageEmbeds
 * -------------
 * Renders link-preview cards for a message's `embeds` array. Each card
 * shows the source's site name + favicon, title (linked to the URL),
 * description, and an optional image. Layout adapts to whether an
 * image is present:
 *   - With image: side-by-side on desktop, stacked on mobile
 *   - Without image: a tighter single-column card
 *
 * Cards open the URL in a new tab; we don't render any iframe or
 * embedded content — the card is purely a preview.
 *
 * The component is a thin layout — all content comes from the server-
 * resolved embed (Open Graph / Twitter / fallback). When the message's
 * embed list is null (still resolving), we render nothing rather than
 * a "loading" indicator: the wait is short and a flash of "loading"
 * is more distracting than an empty slot that fills in.
 */

import { useState, type SyntheticEvent } from 'react';
import type { MessageEmbed } from '@zekktris/client';

interface Props {
  embeds: MessageEmbed[] | null;
}

export function MessageEmbeds({ embeds }: Props) {
  if (!embeds || embeds.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 max-w-2xl">
      {embeds.map((e, i) => (
        <EmbedCard key={i} embed={e} />
      ))}
    </div>
  );
}

function EmbedCard({ embed }: { embed: MessageEmbed }) {
  // Rich webhook embeds (Discord-style) render the full card; auto-resolved
  // link/image previews keep the existing tuned layout below.
  if (embed.kind === 'rich') return <RichEmbedCard embed={embed} />;
  // Track image-load failure so we can drop back to the no-image
  // layout when the og:image URL 404s. Some sites publish broken
  // og:image values and we don't want to render a broken-image icon
  // in the user's chat history.
  const [imgError, setImgError] = useState(false);
  const showImage = embed.imageUrl && !imgError;

  // Truncate the description for the card. The DTO already trims to
  // ~400 chars; we further clamp at the CSS level via line-clamp so
  // the card height stays predictable.
  const hasContent = !!(embed.title || embed.description);
  if (!hasContent && !showImage) return null;

  return (
    <div className="flex border-l-2 border-accent/60 bg-bg-2 rounded-r-md overflow-hidden">
      {/* Text column. flex-1 so it grows to fill the card; min-w-0
          prevents long unbreakable strings (URLs, hashes) from
          pushing the layout out. */}
      <div className="flex-1 min-w-0 p-3 space-y-1">
        {/* Site attribution row — favicon + site name, small and
            unobtrusive. We render this only when site name is
            present; favicon-only feels half-baked. */}
        {embed.siteName && (
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            {embed.faviconUrl && (
              // Same image-error handling as the main image. We use a
              // separate state-less img for the favicon — favicons are
              // usually small and rarely break, so we accept the
              // occasional broken-favicon as a non-issue.
              <img
                src={embed.faviconUrl}
                alt=""
                width={14}
                height={14}
                className="w-3.5 h-3.5 shrink-0"
                onError={(e) => {
                  // Hide the broken favicon by collapsing it. Keep the
                  // alt text empty so screen readers ignore it.
                  e.currentTarget.style.display = 'none';
                }}
              />
            )}
            <span className="truncate">{embed.siteName}</span>
          </div>
        )}
        {embed.title && (
          <a
            href={embed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-medium text-accent hover:underline line-clamp-2 break-words"
          >
            {embed.title}
          </a>
        )}
        {embed.description && (
          <p className="text-sm text-ink-2 line-clamp-3 break-words">{embed.description}</p>
        )}
        {/* Bare URL fallback — when neither title nor description was
            extractable, show the URL itself as a clickable anchor.
            (showImage path can still apply.) */}
        {!embed.title && !embed.description && (
          <a
            href={embed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline break-all"
          >
            {embed.url}
          </a>
        )}
      </div>

      {/* Image column. Hidden on small screens via responsive
          breakpoints — a stacked image-on-top layout works better on
          mobile, but to keep the markup simple we just hide the image
          column under sm: and let the text column take the full width.
          A future polish pass could render a stacked card on mobile
          with the image above the text. */}
      {showImage && embed.imageUrl && (
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:block shrink-0 w-32 bg-bg-3"
          aria-label={embed.title ?? 'Open link'}
        >
          <img
            src={embed.imageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
            decoding="async"
          />
        </a>
      )}
    </div>
  );
}

/** Hide a broken icon image without leaving a placeholder. */
function hideOnError(e: SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.display = 'none';
}

/** Only allow http(s) hrefs. The server already scheme-validates webhook embed
 *  urls, but React doesn't sanitize hrefs — guard here too so no untrusted
 *  `javascript:`/`data:` url can ever become a clickable link. */
function safeHref(url: string | null): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * Rich (Discord-style) webhook embed: accent bar, author, title/description,
 * name/value fields (inline = two columns), large image, small thumbnail, and
 * a footer with optional timestamp. Mirrors the iOS embedCard rich branch.
 */
function RichEmbedCard({ embed }: { embed: MessageEmbed }) {
  const [imgError, setImgError] = useState(false);
  // Discord sends the accent as an sRGB int; fall back to the theme accent.
  const accent =
    embed.color != null ? `#${(embed.color & 0xffffff).toString(16).padStart(6, '0')}` : undefined;
  const showImage = !!embed.imageUrl && !imgError;
  const ts = embed.timestamp ? formatEmbedTimestamp(embed.timestamp) : null;
  const footer = [embed.footerText, ts].filter(Boolean).join(' • ');

  return (
    <div
      className="flex border-l-[3px] border-accent/60 bg-bg-2 rounded-r-md overflow-hidden"
      style={accent ? { borderColor: accent } : undefined}
    >
      <div className="flex-1 min-w-0 p-3 space-y-1.5">
        {embed.authorName && (
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
            {embed.authorIconUrl && (
              <img
                src={embed.authorIconUrl}
                alt=""
                className="w-5 h-5 rounded-full shrink-0 object-cover"
                onError={hideOnError}
              />
            )}
            <span className="truncate">{embed.authorName}</span>
          </div>
        )}
        {embed.title &&
          (safeHref(embed.url) ? (
            <a
              href={safeHref(embed.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="block font-semibold text-accent hover:underline break-words"
            >
              {embed.title}
            </a>
          ) : (
            <div className="font-semibold text-ink-1 break-words">{embed.title}</div>
          ))}
        {embed.description && (
          <p className="text-sm text-ink-2 whitespace-pre-wrap break-words">{embed.description}</p>
        )}
        {embed.fields && embed.fields.length > 0 && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 pt-0.5">
            {embed.fields.map((f, i) => (
              <div key={i} className={f.inline ? '' : 'col-span-2'}>
                <div className="text-xs font-semibold text-ink-1 break-words">{f.name}</div>
                <div className="text-sm text-ink-2 whitespace-pre-wrap break-words">{f.value}</div>
              </div>
            ))}
          </div>
        )}
        {showImage && embed.imageUrl && (
          <img
            src={embed.imageUrl}
            alt=""
            className="mt-1 rounded max-h-80 max-w-full w-auto object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
            decoding="async"
          />
        )}
        {footer && (
          <div className="flex items-center gap-1.5 text-xs text-ink-3 pt-0.5">
            {embed.footerIconUrl && (
              <img
                src={embed.footerIconUrl}
                alt=""
                className="w-4 h-4 rounded-full shrink-0 object-cover"
                onError={hideOnError}
              />
            )}
            <span className="truncate">{footer}</span>
          </div>
        )}
      </div>
      {embed.thumbnailUrl && (
        <div className="shrink-0 w-16 sm:w-20 p-3 pl-0">
          <img
            src={embed.thumbnailUrl}
            alt=""
            className="w-full rounded object-cover"
            onError={hideOnError}
          />
        </div>
      )}
    </div>
  );
}

/** Render an embed's ISO timestamp as a short local date-time; passthrough if
 *  it isn't parseable. */
function formatEmbedTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
