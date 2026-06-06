/**
 * ImageLightbox
 * -------------
 * A lightweight full-screen image viewer. Renders into a fixed overlay
 * with a backdrop click-to-dismiss and Esc-to-close. We don't bundle
 * a full pan/zoom library — `object-contain` + `max-w/h-full` plus a
 * download link for the raw file is enough for chat attachments.
 *
 * Click-through behavior: clicking the backdrop closes; clicking the
 * image itself does NOT close (so users can drag-select or right-click
 * → save without dismissing). The X button and Esc both close.
 *
 * Multi-image navigation: when the caller passes a list with more than
 * one image, left/right arrows + on-screen prev/next buttons cycle
 * through the set. Useful for messages with multiple image attachments.
 *
 * Portal-rendered so the overlay escapes any ancestor transform (the
 * Shell uses `transition-transform` on the side drawers; without
 * Portal, `position: fixed` would clip to the drawer's containing
 * block).
 */

import { useEffect, useState } from 'react';
import { X } from '../lib/icons';
import { Portal } from '../lib/Portal';

interface LightboxImage {
  src: string;
  filename?: string;
}

export function ImageLightbox({
  src,
  filename,
  onClose,
  images,
  initialIndex,
}: {
  /** Backwards-compatible single-image entry point. */
  src?: string;
  filename?: string;
  onClose: () => void;
  /** Multi-image set. If present, takes precedence over src/filename;
      prev/next navigation appears when length > 1. */
  images?: LightboxImage[];
  initialIndex?: number;
}) {
  const list: LightboxImage[] =
    images && images.length > 0
      ? images
      : src
        ? [{ src, filename }]
        : [];
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex ?? 0, list.length - 1)),
  );
  const current = list[index];

  function next() {
    if (list.length <= 1) return;
    setIndex((i) => (i + 1) % list.length);
  }
  function prev() {
    if (list.length <= 1) return;
    setIndex((i) => (i - 1 + list.length) % list.length);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // next/prev are stable wrt setIndex; deliberately not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, list.length]);

  if (!current) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[80] bg-black/90 flex items-center justify-center"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={current.filename ?? 'Image preview'}
      >
        <div
          className="absolute top-0 inset-x-0 flex items-center gap-2 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-white/90 text-sm truncate flex-1">
            {current.filename ?? 'Image'}
            {list.length > 1 && (
              <span className="ml-2 text-white/60 text-xs">
                {index + 1} / {list.length}
              </span>
            )}
          </span>
          <a
            href={current.src}
            download={current.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/80 hover:text-white text-sm px-2 py-1 rounded hover:bg-white/10"
          >
            Open original
          </a>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded text-white/80 hover:text-white hover:bg-white/10"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {list.length > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                prev();
              }}
              aria-label="Previous image"
              className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-2xl backdrop-blur-sm z-10"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                next();
              }}
              aria-label="Next image"
              className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-2xl backdrop-blur-sm z-10"
            >
              ›
            </button>
          </>
        )}

        <img
          key={current.src}
          src={current.src}
          alt={current.filename ?? ''}
          className="max-w-full max-h-full object-contain p-4 sm:p-12 select-none"
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      </div>
    </Portal>
  );
}
