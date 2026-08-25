/**
 * VoiceMessagePlayer
 * ------------------
 * Custom playback control for voice-message attachments. Replaces the
 * generic file-attachment chip when `attachment.isVoiceMessage` is set.
 *
 * Visual:
 *   - Play/pause button (left)
 *   - Waveform bars (middle) — drawn from the base64-decoded sample
 *     array; bars before the playhead are accented, bars after are
 *     muted. Click anywhere on the waveform to seek.
 *   - Duration / position label (right)
 *
 * Audio source is the same CDN URL as any other attachment; the
 * <audio> element handles streaming + decoding. We don't pre-fetch
 * — the browser does it on play.
 *
 * If server-side media retention has aged out the original
 * (`blobExpiredAt`), the url no longer resolves and there is no thumbnail
 * to fall back to, so the chip renders a non-playable "no longer stored"
 * state instead of a play button that would 404.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment } from '@zekktris/client';
import { decryptedMediaURL } from '../lib/e2ee';
import { EXPIRED_TITLE, isBlobExpired } from '../lib/mediaRetention';
import { Play, Pause, Clock } from '../lib/icons';

interface Props {
  attachment: Attachment;
  /** Needed to decrypt a `.zke` (E2EE) voice note before playback. */
  channelId?: string;
}

/** Map a (decrypted) voice filename's extension to an audio MIME so the
    blob URL plays. The encrypted attachment's own contentType is
    octet-stream, so we recover the type from the inner filename. */
function voiceMimeFromName(name: string): string {
  const real = name.replace(/\.zke$/, '');
  const ext = real.split('.').pop()?.toLowerCase();
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'mp3') return 'audio/mpeg';
  return 'audio/mp4'; // m4a / default
}

// Render exactly this many bars regardless of how many samples the
// recording produced. Fixed bar count → fixed waveform width →
// chip is the same size for a 3-second clip and a 5-minute one.
// Bar-count ~32 fits a ~160px wide waveform at 5px-per-bar (3px
// bar + 2px gap), close to Discord's voice-message visual weight.
const BAR_COUNT = 32;

export function VoiceMessagePlayer({ attachment, channelId }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  // The URL the <audio> element plays. For a plaintext voice note this is
  // the CDN URL directly; for an encrypted (.zke) note we fetch + decrypt
  // the bytes and play a local blob URL instead (null until ready).
  const encrypted = attachment.filename.endsWith('.zke');
  // Voice notes have no thumbnail, so retention only reaches them when the
  // operator opted into reaping un-thumbnailed originals. When it has, the
  // audio is gone: keep `srcUrl` null so play stays disabled, and never
  // point <audio> at the dead url.
  const expired = isBlobExpired(attachment);
  const [srcUrl, setSrcUrl] = useState<string | null>(
    encrypted || expired ? null : attachment.url,
  );

  useEffect(() => {
    if (expired) {
      setSrcUrl(null);
      return;
    }
    if (!encrypted) {
      setSrcUrl(attachment.url);
      return;
    }
    if (!channelId) {
      setSrcUrl(null); // can't decrypt without the channel key
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Cached + owned by the shared decrypted-media cache — do not revoke.
        const url = await decryptedMediaURL(
          attachment.url,
          channelId,
          voiceMimeFromName(attachment.filename),
        );
        if (cancelled || !url) return;
        setSrcUrl(url);
      } catch {
        /* leave srcUrl null → play stays disabled */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.url, attachment.filename, channelId, encrypted, expired]);
  // Browsers can take a moment after play() before they report
  // currentTime > 0; we drive a stable progress fraction via an rAF
  // loop while playing rather than only on `timeupdate` events
  // (which fire ~4x/sec — visibly steppy).
  const rafRef = useRef<number | null>(null);

  const totalSec = attachment.durationSeconds ?? 0;
  const rawSamples = decodeWaveform(attachment.waveform);
  // Resample the raw waveform down to a fixed BAR_COUNT-length
  // array. Each output bar gets the MAX of the raw samples that
  // map to it — keeps the loud transients visible after
  // downsampling instead of averaging them into the noise floor.
  // When raw is shorter than BAR_COUNT we just stretch (each raw
  // sample maps to multiple output bars).
  const samples = useMemo(() => {
    if (!rawSamples || rawSamples.length === 0) return null;
    const out = new Uint8Array(BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) {
      const start = Math.floor((i * rawSamples.length) / BAR_COUNT);
      const end = Math.floor(((i + 1) * rawSamples.length) / BAR_COUNT);
      let max = 0;
      const lo = Math.max(0, start);
      const hi = Math.max(lo + 1, end);
      for (let j = lo; j < hi; j++) {
        const v = rawSamples[j] ?? 0;
        if (v > max) max = v;
      }
      out[i] = max;
    }
    return out;
  }, [rawSamples]);
  const playedFrac = totalSec > 0 ? Math.min(1, currentSec / totalSec) : 0;

  function ensureAudio(): HTMLAudioElement | null {
    if (audioRef.current) return audioRef.current;
    if (!srcUrl) return null; // still decrypting / locked
    const a = new Audio(srcUrl);
    a.preload = 'metadata';
    a.addEventListener('ended', () => {
      setPlaying(false);
      setCurrentSec(0);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    });
    a.addEventListener('pause', () => {
      setPlaying(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    });
    a.addEventListener('play', () => {
      setPlaying(true);
      const tick = () => {
        if (audioRef.current) setCurrentSec(audioRef.current.currentTime);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    });
    audioRef.current = a;
    return a;
  }

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const a = audioRef.current;
      if (a) {
        a.pause();
        // Detach so the GC can collect the buffered audio sooner.
        a.src = '';
      }
    };
  }, []);

  function toggle() {
    const a = ensureAudio();
    if (!a) return; // encrypted note still decrypting (or locked)
    if (a.paused) {
      void a.play().catch(() => {
        // Autoplay/permission errors — leave the UI in paused state.
        setPlaying(false);
      });
    } else {
      a.pause();
    }
  }

  function seekFromEvent(e: React.MouseEvent<HTMLDivElement>) {
    const a = ensureAudio();
    if (!a) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (totalSec > 0) {
      a.currentTime = frac * totalSec;
      setCurrentSec(a.currentTime);
    }
  }

  if (expired) {
    // Same chip shape as a playable note (so the message doesn't reflow),
    // with the transport swapped for a plain statement of what happened.
    return (
      <div
        className="mt-1 flex w-full max-w-md items-center gap-2.5 rounded-lg border border-line bg-bg-2 px-3 py-2"
        title={EXPIRED_TITLE}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-3 text-ink-3"
          aria-hidden
        >
          <Clock size={14} />
        </span>
        <span className="min-w-0 flex-1 text-sm text-ink-3">Voice message no longer stored</span>
        <span className="shrink-0 text-xs tabular-nums text-ink-3">
          {formatDuration(totalSec)}
        </span>
      </div>
    );
  }

  return (
    <div
      // Width matches the poll widget (max-w-md) so voice messages
      // and polls sit at the same visual scale within a message
      // column. `flex` (not inline-flex) lets the chip fill the
      // available width up to the cap; `w-full` makes that explicit.
      // Result: every voice message is the same width as a poll, and
      // the waveform spans all the way to the timestamp at the
      // right edge regardless of recording length.
      className="mt-1 flex w-full max-w-md items-center gap-2.5 px-3 py-2 rounded-lg bg-bg-2 border border-line"
    >
      <button
        type="button"
        onClick={toggle}
        disabled={!srcUrl}
        className="w-9 h-9 rounded-full flex items-center justify-center bg-accent text-white hover:bg-accent/90 disabled:opacity-50 shrink-0"
        aria-label={
          !srcUrl
            ? encrypted
              ? 'Decrypting voice message…'
              : 'Voice message unavailable'
            : playing
              ? 'Pause voice message'
              : 'Play voice message'
        }
        title={!srcUrl && encrypted ? 'Decrypting…' : undefined}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <div
        // Waveform stretches between play button and timestamp via
        // flex-1; bars are evenly spaced via justify-between so the
        // BAR_COUNT-many bars span the full available width without
        // gap-tuning.
        className="flex items-end justify-between flex-1 h-8 cursor-pointer"
        onClick={seekFromEvent}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={totalSec}
        aria-valuenow={currentSec}
        aria-label="Seek voice message"
        tabIndex={0}
      >
        {Array.from({ length: BAR_COUNT }).map((_, i) => {
          // Sample value 0-255 → bar height 4-32px. We add a small
          // floor (~3px) so quiet stretches still draw something.
          // For unknown waveforms, synthesize a deterministic
          // pseudo-pattern so the bars are still visually varied.
          const v = samples ? samples[i]! : 32 + ((i * 17) % 96);
          const height = 4 + Math.round((v / 255) * 28);
          // Bars before the playhead get the accent color; after, a
          // muted ink-3 tone. We compare bar-position fraction to
          // the played fraction.
          const barFrac = (i + 0.5) / BAR_COUNT;
          const past = barFrac <= playedFrac;
          return (
            <div
              key={i}
              className={`w-[3px] rounded-sm ${past ? 'bg-accent' : 'bg-ink-3/40'}`}
              style={{ height: `${height}px` }}
            />
          );
        })}
      </div>
      <span className="text-xs tabular-nums text-ink-3 shrink-0">
        {formatDuration(playing || currentSec > 0 ? currentSec : totalSec)}
      </span>
    </div>
  );
}

/** Decode a base64-encoded waveform back into an array of 0-255
    sample values. Returns null on any decode error so the caller can
    fall back to a default-shape preview. */
function decodeWaveform(b64: string | null): Uint8Array | null {
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
