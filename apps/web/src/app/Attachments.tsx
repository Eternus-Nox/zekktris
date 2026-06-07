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
import { decryptBytesForDm, getKeyVersion, subscribeToKeyChanges } from '../lib/e2ee';
import { ImageLightbox } from './ImageLightbox';
import { VoiceMessagePlayer } from './VoiceMessagePlayer';

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)$/i;

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

  // E2EE attachments (.zke suffix; iOS + web encrypt as iv||ct||tag with
  // the shared channel key) render through a decrypting card.
  const encrypted = attachments.filter((a) => a.filename.endsWith('.zke'));
  const plain = attachments.filter((a) => !a.filename.endsWith('.zke'));

  // Voice messages get their own custom player, separate from the
  // image grid + file-chip path. They're always at most one per
  // message (server enforces) but we filter generically in case that
  // ever loosens.
  const voices = plain.filter((a) => a.isVoiceMessage);
  const remaining = plain.filter((a) => !a.isVoiceMessage);
  const images = remaining.filter((a) => IMAGE_TYPES.test(a.contentType));
  const others = remaining.filter((a) => !IMAGE_TYPES.test(a.contentType));

  return (
    <div className="mt-1 space-y-1">
      {encrypted.length > 0 && (
        <div className="flex flex-col gap-1">
          {encrypted.map((a) => (
            <EncryptedAttachment key={a.id} attachment={a} channelId={channelId} />
          ))}
        </div>
      )}
      {voices.length > 0 && (
        <div className="flex flex-col gap-1">
          {voices.map((v) => (
            <VoiceMessagePlayer key={v.id} attachment={v} />
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
                className="rounded-md max-w-sm max-h-80 border border-line group-hover/img:border-accent/60 transition-colors object-cover cursor-zoom-in"
              />
            </button>
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

  useEffect(() => subscribeToKeyChanges(() => setKeyVersion(getKeyVersion())), []);

  const realName = attachment.filename.replace(/\.zke$/, '');
  const looksImage = /\.(png|jpe?g|gif|webp|avif)$/i.test(realName);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      if (!channelId) {
        setState('locked');
        return;
      }
      setState('loading');
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        const pt = await decryptBytesForDm(bytes, channelId);
        if (cancelled) return;
        if (!pt) {
          setState('locked');
          return;
        }
        url = URL.createObjectURL(new Blob([pt as BlobPart]));
        setObjectUrl(url);
        setState('ready');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.url, channelId, keyVersion]);

  if (state === 'ready' && objectUrl && looksImage) {
    return (
      <span className="relative inline-block">
        <img
          src={objectUrl}
          alt={realName}
          className="max-w-[320px] max-h-[280px] rounded-lg border border-line object-cover"
        />
        <span
          className="absolute top-1 right-1 rounded-full bg-bg-1/80 p-1"
          title="End-to-end encrypted"
        >
          <Lock size={11} className="text-accent" />
        </span>
      </span>
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