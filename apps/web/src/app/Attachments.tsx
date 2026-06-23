/**
 * Attachments
 * -----------
 * Renders the `attachments` array of a message. Images get displayed inline
 * with a max bound; clicking an image opens it in a full-screen lightbox
 * with a download link to the original. Non-image files become a small
 * card with name + size + a download link.
 *
 * For v1 we don't show video/audio inline — they'd require us to handle
 * playback controls correctly across formats, which is its own pass.
 * Other types just get the file-card treatment.
 */

import { useEffect, useState } from 'react';
import type { Attachment } from '@zekktris/client';
import { Lock, Paperclip } from '../lib/icons';
import { decryptedMediaURL, getKeyVersion, subscribeToKeyChanges } from '../lib/e2ee';
import { ImageLightbox } from './ImageLightbox';
import { VoiceMessagePlayer } from './VoiceMessagePlayer';

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)$/i;
const VIDEO_TYPES = /^video\//i;
/** Inner-filename (post-.zke-strip) extensions treated as images for the
    encrypted gallery. */
const ENC_IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|qt)$/i;

/** Recover a video MIME from a (decrypted) filename so a blob URL plays in
    a <video> element — the encrypted attachment's own type is octet-stream. */
function videoMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'webm') return 'video/webm';
  if (ext === 'ogv') return 'video/ogg';
  if (ext === 'mov' || ext === 'qt') return 'video/quicktime';
  if (ext === 'm4v') return 'video/x-m4v';
  return 'video/mp4';
}

export function Attachments({
  attachments,
  channelId,
}: {
  attachments: Attachment[];
  /** Needed to decrypt `.zke` E2EE attachments (channel-key lookup). */
  channelId?: string;
}) {
  // Track WHICH image opened the lightbox so prev/next can start from
  // there. null = closed.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  if (attachments.length === 0) return null;

  // Voice messages get their own custom player FIRST, regardless of
  // encryption: an encrypted voice note (.zke) must route to the player
  // (which decrypts) rather than the generic encrypted-file card.
  const voices = attachments.filter((a) => a.isVoiceMessage);
  const nonVoice = attachments.filter((a) => !a.isVoiceMessage);

  // E2EE attachments (.zke suffix; iOS + web encrypt as iv||ct||tag with
  // the shared channel key) render through a decrypting card. Encrypted
  // IMAGES are grouped into a decrypting gallery (grid + swipeable lightbox),
  // mirroring plain images; encrypted videos/files stay as individual cards.
  const encrypted = nonVoice.filter((a) => a.filename.endsWith('.zke'));
  const encImages = encrypted.filter((a) => ENC_IMAGE_EXT.test(a.filename.replace(/\.zke$/, '')));
  const encOther = encrypted.filter((a) => !ENC_IMAGE_EXT.test(a.filename.replace(/\.zke$/, '')));
  const plain = nonVoice.filter((a) => !a.filename.endsWith('.zke'));
  const images = plain.filter((a) => IMAGE_TYPES.test(a.contentType));
  const videos = plain.filter(
    (a) => !IMAGE_TYPES.test(a.contentType) && VIDEO_TYPES.test(a.contentType),
  );
  const others = plain.filter(
    (a) => !IMAGE_TYPES.test(a.contentType) && !VIDEO_TYPES.test(a.contentType),
  );

  return (
    <div className="mt-1 space-y-1">
      {encImages.length > 0 && (
        <EncryptedImageGallery attachments={encImages} channelId={channelId} />
      )}
      {encOther.length > 0 && (
        <div className="flex flex-col gap-1">
          {encOther.map((a) => (
            <EncryptedAttachment key={a.id} attachment={a} channelId={channelId} />
          ))}
        </div>
      )}
      {voices.length > 0 && (
        <div className="flex flex-col gap-1">
          {voices.map((v) => (
            <VoiceMessagePlayer key={v.id} attachment={v} channelId={channelId} />
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setLightboxIndex(i)}
              className="block group/img"
              title={img.filename}
              aria-label={`Open ${img.filename}`}
            >
              <img
                src={img.url}
                alt={img.filename}
                width={img.width ?? undefined}
                height={img.height ?? undefined}
                loading="lazy"
                decoding="async"
                className="rounded-md max-w-sm max-h-80 border border-line group-hover/img:border-accent/60 transition-colors object-contain cursor-zoom-in"
              />
            </button>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="flex flex-col gap-1">
          {videos.map((v) => (
            <video
              key={v.id}
              src={v.url}
              controls
              preload="metadata"
              className="rounded-md max-w-sm max-h-80 border border-line bg-black"
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1">
          {others.map((f) => (
            <FileCard key={f.id} attachment={f} />
          ))}
        </div>
      )}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={images.map((img) => ({ src: img.url, filename: img.filename }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/**
 * EncryptedImageGallery — decrypts a message's encrypted (.zke) images and
 * renders them grouped (same flex-wrap as plain images), opening the shared
 * ImageLightbox across the WHOLE decrypted set so you can page/swipe between
 * them. Mirrors the plain-image grouping; the decrypted bytes only ever live
 * in local blob URLs (revoked on unmount).
 */
function EncryptedImageGallery({
  attachments,
  channelId,
}: {
  attachments: Attachment[];
  channelId?: string;
}) {
  const [urls, setUrls] = useState<(string | null)[]>(() => attachments.map(() => null));
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [keyVersion, setKeyVersion] = useState(getKeyVersion());

  useEffect(() => subscribeToKeyChanges(() => setKeyVersion(getKeyVersion())), []);

  // Key the decrypt effect on the concrete attachment URLs (stable across
  // re-renders) + the channel key version, not the array identity.
  const urlKey = attachments.map((a) => a.url).join('|');
  useEffect(() => {
    if (!channelId) {
      setUrls(attachments.map(() => null));
      return;
    }
    let cancelled = false;
    void (async () => {
      // Object URLs are owned + cached by the shared decrypted-media cache
      // (keyed by channel+url, invalidated on key change) — do NOT revoke
      // them here, or a sibling/gallery view reusing the same cached URL
      // would break.
      const out = await Promise.all(
        attachments.map((a) => decryptedMediaURL(a.url, channelId)),
      );
      if (cancelled) return;
      setUrls(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, channelId, keyVersion]);

  // The lightbox set is the successfully-decrypted images (with real names).
  const ready = attachments
    .map((a, i) => ({ a, url: urls[i] }))
    .filter((x): x is { a: Attachment; url: string } => !!x.url);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((a, i) => {
          const url = urls[i];
          const realName = a.filename.replace(/\.zke$/, '');
          if (!url) {
            return (
              <span
                key={a.id}
                className="w-40 h-40 rounded-md border border-line bg-bg-2 flex items-center justify-center text-ink-3"
                title="Encrypted image"
              >
                <Lock size={16} />
              </span>
            );
          }
          const readyIdx = ready.findIndex((x) => x.a.id === a.id);
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setLightboxIndex(readyIdx)}
              className="block group/img"
              title={realName}
              aria-label={`Open ${realName}`}
            >
              <img
                src={url}
                alt={realName}
                loading="lazy"
                className="rounded-md max-w-sm max-h-80 border border-line group-hover/img:border-accent/60 transition-colors object-contain cursor-zoom-in"
              />
            </button>
          );
        })}
      </div>
      {lightboxIndex !== null && lightboxIndex >= 0 && (
        <ImageLightbox
          images={ready.map((x) => ({ src: x.url, filename: x.a.filename.replace(/\.zke$/, '') }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function FileCard({ attachment }: { attachment: Attachment }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      download
      className="inline-flex items-center gap-3 max-w-md bg-bg-2 border border-line hover:border-accent/60 rounded-md px-3 py-2 transition-colors"
    >
      <span className="w-8 h-8 flex items-center justify-center bg-bg-3 rounded text-ink-2 shrink-0" aria-hidden>
        <Paperclip size={16} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-ink-1">{attachment.filename}</span>
        <span className="block text-xs text-ink-3">{formatSize(attachment.size)}</span>
      </span>
      <span className="text-ink-2 text-sm shrink-0">↓</span>
    </a>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


/**
 * EncryptedAttachment — downloads the `.zke` payload, decrypts it with the
 * channel's shared key (same layout as iOS: iv(12) || ciphertext || tag),
 * and renders an inline image or a download card with the real filename.
 * Without the key it shows a locked placeholder; entering the key
 * elsewhere re-renders via the key-version subscription.
 */
function EncryptedAttachment({
  attachment,
  channelId,
}: {
  attachment: Attachment;
  channelId?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'locked' | 'failed' | 'ready'>('loading');
  const [keyVersion, setKeyVersion] = useState(getKeyVersion());
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => subscribeToKeyChanges(() => setKeyVersion(getKeyVersion())), []);

  const realName = attachment.filename.replace(/\.zke$/, '');
  const looksImage = /\.(png|jpe?g|gif|webp|avif)$/i.test(realName);
  const looksVideo = VIDEO_EXT.test(realName);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!channelId) {
        setState('locked');
        return;
      }
      setState('loading');
      try {
        // Cached + owned by the shared decrypted-media cache — do not revoke.
        const url = await decryptedMediaURL(
          attachment.url,
          channelId,
          looksVideo ? videoMimeFromName(realName) : undefined,
        );
        if (cancelled) return;
        if (!url) {
          setState('locked');
          return;
        }
        setObjectUrl(url);
        setState('ready');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.url, channelId, keyVersion]);

  if (state === 'ready' && objectUrl && looksImage) {
    // No per-image E2EE lock — like iOS, the decrypted image shows no badge;
    // the conversation-level lock by the DM (DMList) is the only E2EE signal.
    // Clicking opens the same full-screen lightbox as a normal image — it just
    // takes the decrypted object URL.
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="block group/img"
          title={realName}
          aria-label={`Open ${realName}`}
        >
          <img
            src={objectUrl}
            alt={realName}
            className="max-w-[320px] max-h-[280px] rounded-lg border border-line object-contain group-hover/img:border-accent/60 transition-colors cursor-zoom-in"
          />
        </button>
        {lightboxOpen && (
          <ImageLightbox src={objectUrl} filename={realName} onClose={() => setLightboxOpen(false)} />
        )}
      </>
    );
  }

  if (state === 'ready' && objectUrl && looksVideo) {
    // Decrypted video plays inline from the local object URL — the plaintext
    // bytes never round-trip through a server-hosted URL.
    return (
      <video
        src={objectUrl}
        controls
        preload="metadata"
        className="rounded-lg max-w-[320px] max-h-[280px] border border-line bg-black"
      />
    );
  }

  return (
    <span className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-2 border border-line text-sm max-w-[320px]">
      <Lock size={14} className="text-accent shrink-0" />
      {state === 'ready' && objectUrl ? (
        <a href={objectUrl} download={realName} className="text-ink-1 hover:underline truncate">
          {realName}
        </a>
      ) : (
        <span className="text-ink-3 truncate">
          {state === 'loading'
            ? 'Decrypting…'
            : state === 'locked'
              ? 'Encrypted attachment — unlock this conversation to view'
              : "Couldn't decrypt attachment"}
        </span>
      )}
    </span>
  );
}