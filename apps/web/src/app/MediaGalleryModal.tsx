/**
 * MediaGalleryModal — the "all shared media & documents" view for a DM /
 * channel, mirroring the iOS MediaGalleryView. Photos and Files tabs over
 * GET /channels/:id/attachments (newest-first, paginated by attachment id).
 * Buckets client-side so encrypted (.zke) attachments classify by their inner
 * filename; encrypted photos decrypt in-browser (same path as Attachments.tsx)
 * and open in the shared ImageLightbox. Plain files download via the CDN URL.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Attachment, Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { decryptedMediaURL, getKeyVersion, subscribeToKeyChanges } from '../lib/e2ee';
import { ImageLightbox } from './ImageLightbox';
import { Portal } from '../lib/Portal';
import { Lock, Paperclip, X } from '../lib/icons';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff'];

function realName(a: Attachment): string {
  return a.filename.endsWith('.zke') ? a.filename.slice(0, -4) : a.filename;
}
function isImageAttachment(a: Attachment): boolean {
  if (a.contentType.startsWith('image/')) return true;
  const ext = realName(a).split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.includes(ext);
}

export function MediaGalleryModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { rest } = useAuth();
  const [items, setItems] = useState<Attachment[]>([]);
  const [tab, setTab] = useState<'media' | 'files'>('media');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [lightbox, setLightbox] = useState<{ src: string; filename?: string } | null>(null);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const last = items.length ? items[items.length - 1].id : undefined;
      const r = await rest.channelAttachments(channel.id, last);
      const seen = new Set(items.map((i) => i.id));
      setItems((prev) => [...prev, ...r.attachments.filter((a) => !seen.has(a.id))]);
      setHasMore(r.attachments.length >= 60);
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [rest, channel.id, items]);

  // Initial page.
  useEffect(() => {
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const media = items.filter((a) => isImageAttachment(a) && !a.isVoiceMessage);
  const files = items.filter((a) => !isImageAttachment(a) && !a.isVoiceMessage);
  const shown = tab === 'media' ? media : files;

  return (
    <Portal>
    <div className="fixed inset-0 z-[110] flex flex-col bg-bg-1/95 backdrop-blur-sm" role="dialog" aria-modal="true">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-base font-semibold text-ink-1">Shared media</h2>
        <div className="ml-2 flex gap-1">
          {(['media', 'files'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-sm font-medium ${
                tab === t ? 'bg-accent/20 text-accent' : 'text-ink-3 hover:text-ink-1'
              }`}
            >
              {t === 'media' ? 'Photos' : 'Files'}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="ml-auto rounded p-1 text-ink-3 hover:text-ink-1" aria-label="Close">
          <X size={20} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'media' ? (
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
            {media.map((a) => (
              <GalleryPhoto key={a.id} a={a} channelId={channel.id} onOpen={setLightbox} />
            ))}
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-1">
            {files.map((a) => (
              <GalleryFile key={a.id} a={a} />
            ))}
          </div>
        )}

        {shown.length === 0 && !loading && (
          <div className="py-16 text-center text-sm text-ink-3">
            {tab === 'media' ? 'No photos shared yet.' : 'No files shared yet.'}
          </div>
        )}
        {loading && <div className="py-6 text-center text-sm text-ink-3">Loading…</div>}
        {hasMore && !loading && items.length > 0 && (
          <button
            type="button"
            onClick={() => void loadMore()}
            className="mx-auto mt-4 block rounded-md bg-bg-3 px-4 py-2 text-sm text-ink-2 hover:text-ink-1"
          >
            Load more
          </button>
        )}
      </div>

      {lightbox && (
        // Above the gallery's own z-[110] — the lightbox portals to <body>,
        // so without a higher z it would open *behind* this modal.
        <ImageLightbox
          src={lightbox.src}
          filename={lightbox.filename}
          onClose={() => setLightbox(null)}
          overlayZClassName="z-[120]"
        />
      )}
    </div>
    </Portal>
  );
}

function GalleryPhoto({
  a,
  channelId,
  onOpen,
}: {
  a: Attachment;
  channelId: string;
  onOpen: (x: { src: string; filename?: string }) => void;
}) {
  const encrypted = a.filename.endsWith('.zke');
  // Grid cell uses the small thumbnail when present; the lightbox opens full.
  const inlineSrc = a.thumbnailUrl ?? a.url;
  const [src, setSrc] = useState<string | null>(encrypted ? null : inlineSrc);
  const [keyVersion, setKeyVersion] = useState(getKeyVersion());

  useEffect(() => subscribeToKeyChanges(() => setKeyVersion(getKeyVersion())), []);

  useEffect(() => {
    if (!encrypted) return;
    let cancelled = false;
    (async () => {
      try {
        // Cached + owned by the shared decrypted-media cache — do not revoke.
        const url = await decryptedMediaURL(inlineSrc, channelId);
        if (cancelled || !url) return;
        setSrc(url);
      } catch {
        /* leave locked */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inlineSrc, channelId, encrypted, keyVersion]);

  // Open the FULL image in the lightbox (the grid shows only the thumbnail).
  const openFull = async () => {
    if (!encrypted) {
      onOpen({ src: a.url, filename: realName(a) });
      return;
    }
    const full = await decryptedMediaURL(a.url, channelId);
    if (full ?? src) onOpen({ src: (full ?? src)!, filename: realName(a) });
  };

  return (
    <button
      type="button"
      onClick={() => void openFull()}
      className="aspect-square overflow-hidden rounded bg-bg-3"
      title={realName(a)}
    >
      {src ? (
        <img src={src} alt={realName(a)} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-ink-4">
          <Lock size={16} />
        </span>
      )}
    </button>
  );
}

function GalleryFile({ a }: { a: Attachment }) {
  const encrypted = a.filename.endsWith('.zke');
  const name = realName(a);
  if (encrypted) {
    return (
      <div className="flex items-center gap-3 rounded-md bg-bg-2 px-3 py-2 text-sm">
        <Lock size={16} className="text-accent" />
        <span className="flex-1 truncate text-ink-1">{name}</span>
      </div>
    );
  }
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      download
      className="flex items-center gap-3 rounded-md border border-line bg-bg-2 px-3 py-2 text-sm hover:border-accent/60"
    >
      <Paperclip size={16} className="text-ink-2" />
      <span className="flex-1 truncate text-ink-1">{name}</span>
      <span className="text-ink-3">↓</span>
    </a>
  );
}
