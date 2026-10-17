/**
 * Link previews in end-to-end encrypted chats (per device, default OFF).
 *
 * The server can't unfurl ciphertext, so a preview for a link inside an
 * encrypted message has to be requested by the client after decryption —
 * which hands that link (not the message) to the server. That leaks which
 * links are shared in an "end-to-end encrypted" chat, so it's opt-in, per
 * device, and stored in localStorage like the other display preferences.
 * Wording mirrors the iOS toggle.
 */
import { useSyncExternalStore } from 'react';
import type { MessageEmbed } from '@zekktris/client';

const KEY = 'zk:e2ee-link-previews';

let enabled = load();
const listeners = new Set<() => void>();

// A change made in another tab arrives as a 'storage' event; without this,
// switching previews OFF there would leave this tab still sending links.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return; // null: storage.clear()
    const next = load();
    if (next === enabled) return;
    enabled = next;
    for (const l of listeners) l();
  });
}

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function getE2eeLinkPreviews(): boolean {
  return enabled;
}

export function setE2eeLinkPreviews(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — keep in-memory value */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive hook: re-renders subscribers when the toggle changes. */
export function useE2eeLinkPreviews(): boolean {
  return useSyncExternalStore(subscribe, getE2eeLinkPreviews, () => false);
}

// Extract http(s) URLs from text for client-side link-preview resolution on
// E2EE messages. Mirrors the server's message extractor (services/embeds.ts):
// same conservative regex + trailing-punctuation trim, deduped, capped.
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let m of matches) {
    while (m.length > 0 && /[.,;!?)]$/.test(m)) m = m.slice(0, -1);
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Client-side link previews for one E2EE message. Returns null when there is
 * nothing to resolve — previews are off on this device, the message isn't
 * encrypted or couldn't be decrypted, the server already attached embeds, or
 * the text has no links — and `unfurl` is then never called. Otherwise it
 * unfurls each link (best-effort per URL) and resolves to the embeds found.
 */
export function resolveE2eeLinkPreviews(
  msg: {
    previewsEnabled: boolean;
    isEncrypted: boolean;
    noKey: boolean;
    plaintext: string | null | undefined;
    hasServerEmbeds: boolean;
  },
  unfurl: (url: string) => Promise<{ embed: MessageEmbed | null }>,
): Promise<MessageEmbed[]> | null {
  if (!msg.previewsEnabled || !msg.isEncrypted || msg.noKey || !msg.plaintext) return null;
  if (msg.hasServerEmbeds) return null;
  const urls = extractUrls(msg.plaintext);
  if (urls.length === 0) return null;
  return (async () => {
    const found: MessageEmbed[] = [];
    for (const u of urls) {
      try {
        const { embed } = await unfurl(u);
        if (embed) found.push(embed);
      } catch {
        // best-effort per URL
      }
    }
    return found;
  })();
}
