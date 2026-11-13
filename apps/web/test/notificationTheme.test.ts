import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PublicUser } from '@zekktris/client';
import { ToastCard, type ToastView } from '../src/state/Toasts';
import { renderMessageContent } from '../src/lib/markdown';
import { badgeIcon } from '../src/lib/achievementGlyphs';
import { badgeIcon as shelfBadgeIcon } from '../src/app/AchievementsShelf';
import { PawPrint } from '../src/lib/icons';
import {
  STATIC_NOTIFICATION_ICON,
  isThemeIconPng,
  setThemedIcon,
  themedNotificationIcon,
} from '../src/lib/themeIcon';
import { showDesktopNotification } from '../src/lib/desktopNotify';

// "The notifications should match the theme color too." Every themed
// notification surface reads the theme's CSS channels (--c-accent,
// --c-accent-2, --c-bg-0, --accent-glow), so it follows Settings → Appearance
// at once; the ones whose colour means something (errors, …) stay red. And the
// OS notification icon is the theme's own mark, not the default palette's PNG.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const card = (t: ToastView) => renderToStaticMarkup(createElement(ToastCard, { toast: t, onDismiss: () => {} }));

/** A real 1×1 PNG, as canvas.toDataURL('image/png') would hand it over. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('toasts', () => {
  it('gives an info toast the theme: an accent edge and an accent icon', () => {
    const html = card({ message: 'Call ended', kind: 'info' });
    expect(html).toContain('bg-bg-2/95 border-accent/30 text-ink-1');
    // The leading accent→accent-2 rail.
    expect(html).toContain('bg-gradient-to-b from-accent to-accent-2');
    expect(html).toMatch(/<svg [^>]*class="shrink-0 mt-px text-accent"/);
    expect(html).not.toMatch(/emerald/);
  });

  it('keeps a success toast green in every theme (under Crimson an accent card would read as an error)', () => {
    const html = card({ message: 'Saved', kind: 'success' });
    expect(html).toContain('bg-emerald-950/95 border-emerald-800/60 text-emerald-100');
    expect(html).toMatch(/<svg [^>]*class="shrink-0 mt-px text-emerald-300"/);
    expect(html).not.toMatch(/accent/);
  });

  it('keeps an error toast red in every theme', () => {
    const html = card({ message: 'Upload failed', kind: 'error' });
    expect(html).toContain('bg-red-950/95 border-red-800/60 text-red-100');
    expect(html).toMatch(/<svg [^>]*class="shrink-0 mt-px text-red-300"/);
    expect(html).not.toMatch(/accent/);
  });

  it('draws a poke as the themed banner: accent stroke and glow, accent-tinted poke-back chip', () => {
    const html = card({
      message: 'Sam',
      kind: 'poke',
      emoji: '👉',
      caption: 'Tap to open · tap the emoji to poke back',
      action: { label: '👉', ariaLabel: 'Poke back', onClick: () => {} },
    });
    expect(html).toContain('zk-accent-edge');
    expect(html).toContain('shadow-[0_4px_24px_var(--accent-glow)]');
    expect(html).toContain('bg-accent/[0.18] border border-accent/45');
    expect(html).toContain('aria-label="Poke back"');
    expect(html).toContain('Sam');
    expect(html).toContain('Tap to open · tap the emoji to poke back');
    // The emoji leads the banner and is the chip.
    expect(html.split('👉').length - 1).toBe(2);
  });

  it("draws an achievement with the badge's own shelf glyph in the themed circle, never gold or green", () => {
    // The toast and the shelf share one id → glyph map.
    expect(shelfBadgeIcon).toBe(badgeIcon);
    expect(badgeIcon('pet_keeper_1')).toBe(PawPrint);
    const html = card({
      message: 'Zekk Keeper',
      kind: 'achievement',
      caption: 'Achievement unlocked',
      icon: badgeIcon('pet_keeper_1'),
    });
    expect(html).toContain('bg-gradient-to-br from-accent/35 to-accent-2/25');
    expect(html).toContain(renderToStaticMarkup(createElement(PawPrint, { size: 16, className: 'text-accent' })));
    expect(html).toContain('zk-accent-edge');
    expect(html).toContain('shadow-[0_4px_24px_var(--accent-glow)]');
    expect(html).toContain('Achievement unlocked');
    expect(html).toContain('Zekk Keeper');
    expect(html).not.toMatch(/emerald|F4C95B|🏆/i);
  });

  it('is what the gateway handlers push for a poke and an unlock', () => {
    const src = read('../src/state/AppState.tsx');
    expect(src).toContain("toasts.push(d.initiator_name, 'poke', 15_000, {");
    expect(src).toContain("ariaLabel: 'Poke back',");
    expect(src).toMatch(/toasts\.push\(a\.name, 'achievement', 6000, \{\s*caption: 'Achievement unlocked',\s*icon: badgeIcon\(a\.id\),/);
    expect(src).not.toContain('Achievement unlocked —');
  });
});

describe('the themed CSS', () => {
  const css = read('../src/index.css');

  it('rings a call in the theme accents (iOS AlienPulse), not the default palette', () => {
    const pulse = css.slice(css.indexOf('@keyframes zk-alien-pulse'), css.indexOf('.zk-alien-pulse {'));
    expect(pulse).toContain('rgb(var(--c-accent) / .55)');
    expect(pulse).toContain('rgb(var(--c-accent-2) / .40)');
    expect(pulse).toContain('rgb(var(--c-accent-3) / .25)');
    expect(pulse).not.toMatch(/oklch|#[0-9a-f]{3,8}\b/i);
  });

  it('strokes the banners accent → accent-2', () => {
    const edge = css.slice(css.indexOf('.zk-accent-edge::after'));
    expect(edge.slice(0, edge.indexOf('}'))).toContain(
      'linear-gradient(90deg, rgb(var(--c-accent) / 0.6), rgb(var(--c-accent-2) / 0.6))',
    );
  });
});

describe('row badges and the unread divider', () => {
  const PILL = 'bg-gradient-to-br from-accent to-accent-2 text-bg-0';

  it('themes the mention pills and unread dots of channel and DM rows, and forum posts', () => {
    for (const file of ['ChannelList', 'DMList', 'ForumView']) {
      const src = read(`../src/app/${file}.tsx`);
      expect(src, file).toContain(PILL);
      expect(src, file).not.toMatch(/bg-red-500 text-white|rounded-full bg-red-500/);
    }
    for (const file of ['ChannelList', 'DMList']) {
      const src = read(`../src/app/${file}.tsx`);
      expect(src, file).toMatch(/aria-label="unread" className="w-1\.5 h-1\.5 rounded-full bg-accent shrink-0/);
    }
  });

  it('tints the poke a DM row keeps with the accent', () => {
    const src = read('../src/app/DMList.tsx');
    expect(src).toContain('rounded-full bg-accent/15 border border-accent/45');
  });

  it('draws "New messages" in the accent', () => {
    const src = read('../src/app/MessageView.tsx');
    const divider = src.slice(src.indexOf('function UnreadDivider()'), src.indexOf('function DateDivider('));
    expect(divider).toContain('<div className="flex-1 h-px bg-accent" />');
    expect(divider).toContain('text-[10px] font-bold text-accent shrink-0');
    expect(divider).not.toMatch(/red-/);
  });
});

describe('mention chips', () => {
  const user = (id: string, displayName: string) =>
    ({ id, username: displayName.toLowerCase(), displayName }) as unknown as PublicUser;
  const users: Record<string, PublicUser> = { '1': user('1', 'Me'), '2': user('2', 'Sam') };
  const html = renderToStaticMarkup(
    createElement(
      'p',
      null,
      renderMessageContent('<@1> <@2> @everyone @here', {
        lookupUser: (id) => users[id],
        lookupChannel: () => undefined,
        selfUserId: '1',
      }),
    ),
  );
  const chip = (text: string) => html.match(new RegExp(`<span class="([^"]*)"[^>]*>${text}</span>`))?.[1] ?? '';

  it('uses the accent for every mention, a step stronger when it pings you', () => {
    // Bright ink text: accent on accent/30 fails 4.5:1 in four of the six
    // families.
    const strong = 'bg-accent/30 text-ink-1 ring-1 ring-inset ring-accent/40';
    expect(chip('@Me')).toContain(strong);
    expect(chip('@everyone')).toContain(strong);
    expect(chip('@here')).toContain(strong);
    expect(chip('@Sam')).toContain('bg-accent/20 text-accent-soft');
    expect(html).not.toMatch(/amber/);
  });

  it('draws the composer\'s @everyone / @here suggestion in the accent too (iOS: accent on accent/15)', () => {
    const src = read('../src/lib/useMentionAutocomplete.tsx');
    expect(src).toContain('w-7 h-7 shrink-0 rounded-full bg-accent/15 text-accent');
    expect(src).not.toMatch(/(bg|text)-amber-/);
  });
});

describe('the OS notification icon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts only a base64 PNG data URL', () => {
    expect(isThemeIconPng(PNG)).toBe(true);
    for (const bad of [
      '/icon-192.png',
      'https://example.com/icon.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:image/png;base64,AAAA"><script>',
      `data:image/png;base64,${'A'.repeat(600 * 1024)}`,
      42,
      null,
      undefined,
    ]) {
      expect(isThemeIconPng(bad), String(bad).slice(0, 40)).toBe(false);
    }
  });

  it("is the static icon until theme.ts hands over the theme's mark, then that mark", () => {
    expect(themedNotificationIcon()).toBe(STATIC_NOTIFICATION_ICON);
    setThemedIcon('https://example.com/icon.png');
    expect(themedNotificationIcon()).toBe(STATIC_NOTIFICATION_ICON);
    setThemedIcon(PNG);
    expect(themedNotificationIcon()).toBe(PNG);
  });

  it('is the icon a desktop (Electron) notification shows', () => {
    setThemedIcon(PNG);
    let opts: NotificationOptions | undefined;
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(_title: string, o: NotificationOptions) {
        opts = o;
      }
    }
    vi.stubGlobal('window', { zekktris: { isDesktop: true } });
    vi.stubGlobal('Notification', FakeNotification);
    expect(showDesktopNotification({ title: 'Sam', body: 'hi' })).not.toBeNull();
    expect(opts?.icon).toBe(PNG);
  });

  it('is handed to the controlling service worker on every change', () => {
    const posted: unknown[] = [];
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage: (m: unknown) => posted.push(m) } } });
    setThemedIcon(PNG);
    setThemedIcon(PNG_2);
    expect(posted).toEqual([
      { type: 'SET_THEME_ICON', png: PNG },
      { type: 'SET_THEME_ICON', png: PNG_2 },
    ]);
  });

  it('waits once for a worker that does not control the page yet, then sends the latest', async () => {
    const posted: unknown[] = [];
    let activate!: (reg: unknown) => void;
    const ready = new Promise((r) => (activate = r));
    vi.stubGlobal('navigator', { serviceWorker: { controller: null, ready } });
    setThemedIcon(PNG);
    setThemedIcon(PNG_2);
    activate({ active: { postMessage: (m: unknown) => posted.push(m) } });
    await ready;
    await Promise.resolve();
    expect(posted).toEqual([{ type: 'SET_THEME_ICON', png: PNG_2 }]);
  });

  it('re-sends to a worker that takes control later (a deploy whose new worker claims the page)', () => {
    const posted: unknown[] = [];
    const listeners: Array<[type: string, fn: () => void]> = [];
    const container = {
      // The worker the page booted under (it may predate SET_THEME_ICON).
      controller: { postMessage: () => posted.push('old worker') } as { postMessage: (m: unknown) => void },
      ready: new Promise(() => {}),
      addEventListener: (type: string, fn: () => void) => {
        listeners.push([type, fn]);
      },
    };
    vi.stubGlobal('navigator', { serviceWorker: container });
    setThemedIcon(PNG);
    // A second theme switch adds no second listener.
    setThemedIcon(PNG_2);
    expect(listeners.map(([type]) => type)).toEqual(['controllerchange']);
    container.controller = { postMessage: (m: unknown) => posted.push(m) };
    listeners[0]![1]();
    expect(posted).toEqual(['old worker', 'old worker', { type: 'SET_THEME_ICON', png: PNG_2 }]);
  });
});

describe('the service worker', () => {
  // public/sw.js run against a fake worker scope: listeners, Cache Storage,
  // and showNotification.
  function worker() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const store = new Map<string, Map<string, Response>>();
    const caches = {
      async open(name: string) {
        const c = store.get(name) ?? new Map<string, Response>();
        store.set(name, c);
        return {
          async put(key: string, res: Response) {
            c.set(key, res);
          },
          async match(key: string) {
            return c.get(key)?.clone();
          },
          async addAll() {},
        };
      },
      async keys() {
        return [...store.keys()];
      },
      async delete(name: string) {
        return store.delete(name);
      },
    };
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    let focusedOn: string | null = null;
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
      registration: {
        showNotification: async (title: string, options: NotificationOptions) => {
          shown.push({ title, options });
        },
      },
      clients: {
        matchAll: async () =>
          focusedOn ? [{ visibilityState: 'visible', focused: true, url: `https://zk.test${focusedOn}` }] : [],
        claim: async () => {},
      },
      skipWaiting: async () => {},
      location: { origin: 'https://zk.test' },
    };
    new Function('self', 'caches', read('../public/sw.js'))(self, caches);
    const dispatch = async (type: string, init: object) => {
      const pending: Promise<unknown>[] = [];
      listeners[type]!({ ...init, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    };
    const push = async (payload: object) => {
      await dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
      return shown.at(-1)!.options;
    };
    const post = (png: unknown) => dispatch('message', { data: { type: 'SET_THEME_ICON', png } });
    return { dispatch, push, post, shown, store, focus: (path: string | null) => (focusedOn = path) };
  }

  it('shows the static icon until the page posts its themed one', async () => {
    const sw = worker();
    const o = await sw.push({ title: 'Sam', body: 'hi', url: '/channels/@me/1' });
    expect(o.icon).toBe('/icon-192.png');
    expect(o.badge).toBe('/icon-192.png');
  });

  it("then shows the theme's icon wherever the app icon was meant, keeping a sender's own image", async () => {
    const sw = worker();
    await sw.post(PNG);
    expect((await sw.push({ title: 'Sam', body: 'hi' })).icon).toBe(PNG);
    // Friend requests and calls name the static app icon explicitly.
    expect((await sw.push({ title: 'Sam', body: 'Incoming call', kind: 'call', icon: '/icon-192.png' })).icon).toBe(PNG);
    expect((await sw.push({ title: 'Sam', icon: 'https://cdn.example/avatar.png' })).icon).toBe(
      'https://cdn.example/avatar.png',
    );
    // The badge is an alpha mask the system tints: always the static icon.
    expect((await sw.push({ title: 'Sam' })).badge).toBe('/icon-192.png');
    // A later theme switch replaces it.
    await sw.post(PNG_2);
    expect((await sw.push({ title: 'Sam' })).icon).toBe(PNG_2);
  });

  it('ignores anything posted that is not a PNG data URL', async () => {
    const sw = worker();
    for (const bad of ['https://evil.example/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 42, { png: PNG }]) {
      await sw.post(bad);
    }
    expect((await sw.push({ title: 'Sam' })).icon).toBe('/icon-192.png');
    await sw.post(PNG);
    await sw.post('https://evil.example/x.png');
    expect((await sw.push({ title: 'Sam' })).icon).toBe(PNG);
  });

  it("keeps the icon through a new build's activate purge", async () => {
    const sw = worker();
    await sw.post(PNG);
    await sw.dispatch('activate', {});
    expect([...sw.store.keys()]).toContain('zekktris-theme');
    expect((await sw.push({ title: 'Sam' })).icon).toBe(PNG);
  });

  it('still shows nothing for the conversation already open in a focused tab', async () => {
    const sw = worker();
    await sw.post(PNG);
    sw.focus('/channels/@me/1');
    await sw.dispatch('push', {
      data: { json: () => ({ title: 'Sam', url: '/channels/@me/1' }), text: () => '' },
    });
    expect(sw.shown).toHaveLength(0);
  });
});
