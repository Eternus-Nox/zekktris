/**
 * App-wide theme switching.
 *
 * Each theme is a [data-theme] block in index.css that swaps the themeable
 * channel variables (and OLED surface ladder). We persist the choice in
 * localStorage and apply it to <html> — early, before React renders, to avoid
 * a flash of the default theme. We also regenerate the browser tab favicon
 * from the theme's accent colors so the icon tracks the theme too.
 */
export type ThemeId =
  | 'default'
  | 'oled'
  | 'sunset'
  | 'sunset-oled'
  | 'forest'
  | 'forest-oled'
  | 'crimson'
  | 'crimson-oled'
  | 'blossom'
  | 'blossom-oled'
  | 'amethyst'
  | 'amethyst-oled';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  /** Palette family, for grouping in the picker. */
  group: string;
  oled: boolean;
  /** Two accent swatch colors for the preview. */
  swatch: [string, string];
  /** Full accent trio (accent, accent-2, accent-3) — drives the themed favicon. */
  accents: [string, string, string];
  /** Preview background. */
  bg: string;
}

// Ordered so each palette's normal + OLED entry are adjacent; the picker
// renders them as a vertical pair (OLED beneath its counterpart).
export const THEMES: ThemeOption[] = [
  { id: 'default', label: 'Abyssal Navy', group: 'Default', oled: false, swatch: ['#3dd7ec', '#9d7bff'], accents: ['#3dd7ec', '#9d7bff', '#ec5fb5'], bg: '#0a0f1c' },
  { id: 'oled', label: 'Abyssal OLED', group: 'Default', oled: true, swatch: ['#3dd7ec', '#9d7bff'], accents: ['#3dd7ec', '#9d7bff', '#ec5fb5'], bg: '#000000' },
  { id: 'sunset', label: 'Sunset', group: 'Orange & Yellow', oled: false, swatch: ['#ff8a3d', '#ffd13d'], accents: ['#ff8a3d', '#ffd13d', '#ff7a7a'], bg: '#0a0f1c' },
  { id: 'sunset-oled', label: 'Sunset OLED', group: 'Orange & Yellow', oled: true, swatch: ['#ff8a3d', '#ffd13d'], accents: ['#ff8a3d', '#ffd13d', '#ff7a7a'], bg: '#000000' },
  { id: 'forest', label: 'Forest', group: 'Green & Blue', oled: false, swatch: ['#3d9bff', '#4fdd8f'], accents: ['#3d9bff', '#4fdd8f', '#3dd8c0'], bg: '#0a0f1c' },
  { id: 'forest-oled', label: 'Forest OLED', group: 'Green & Blue', oled: true, swatch: ['#3d9bff', '#4fdd8f'], accents: ['#3d9bff', '#4fdd8f', '#3dd8c0'], bg: '#000000' },
  { id: 'crimson', label: 'Crimson', group: 'Red & Grey', oled: false, swatch: ['#ff4d4d', '#9aa3b8'], accents: ['#ff4d4d', '#9aa3b8', '#ff8080'], bg: '#0a0f1c' },
  { id: 'crimson-oled', label: 'Crimson OLED', group: 'Red & Grey', oled: true, swatch: ['#ff4d4d', '#9aa3b8'], accents: ['#ff4d4d', '#9aa3b8', '#ff8080'], bg: '#000000' },
  { id: 'blossom', label: 'Blossom', group: 'Pink & Peach', oled: false, swatch: ['#ff5fa2', '#ffb088'], accents: ['#ff5fa2', '#ffb088', '#ff9ecf'], bg: '#0a0f1c' },
  { id: 'blossom-oled', label: 'Blossom OLED', group: 'Pink & Peach', oled: true, swatch: ['#ff5fa2', '#ffb088'], accents: ['#ff5fa2', '#ffb088', '#ff9ecf'], bg: '#000000' },
  { id: 'amethyst', label: 'Amethyst', group: 'Purple & Gold', oled: false, swatch: ['#a855f7', '#f5b942'], accents: ['#a855f7', '#f5b942', '#d8a7ff'], bg: '#0a0f1c' },
  { id: 'amethyst-oled', label: 'Amethyst OLED', group: 'Purple & Gold', oled: true, swatch: ['#a855f7', '#f5b942'], accents: ['#a855f7', '#f5b942', '#d8a7ff'], bg: '#000000' },
];

const KEY = 'zk-theme';
const VALID = new Set<string>(THEMES.map((t) => t.id));

// native.ts applies iOS chrome (status bar + alternate icon). It only touches
// Capacitor inside functions, and imports back from here dynamically, so this
// static import creates no eval-time cycle.
import { applyNativeTheme } from './native';
// Holds the rasterised mark for OS notifications (no imports of its own).
import { setThemedIcon } from './themeIcon';

export function getStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (v && VALID.has(v)) return v as ThemeId;
  } catch {
    /* ignore */
  }
  return 'default';
}

/** Raw SVG markup for the angled Z sigil in the given theme's colors. */
function markSvg(t: ThemeOption): string {
  const [a1, a2, a3] = t.accents;
  const z =
    'M192 224 L832 224 L832 352 L416 704 L832 704 L832 832 L192 832 L192 704 L608 352 L192 352 Z';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${a1}"/><stop offset="0.5" stop-color="${a2}"/><stop offset="1" stop-color="${a3}"/>` +
    `</linearGradient></defs>` +
    `<rect width="1024" height="1024" rx="232" fill="${t.bg}"/>` +
    `<path d="${z}" fill="url(#g)"/>` +
    `</svg>`
  );
}

/** Build a tab favicon (the angled Z sigil) in the given theme's colors. */
function faviconDataUrl(t: ThemeOption): string {
  return `data:image/svg+xml,${encodeURIComponent(markSvg(t))}`;
}

function applyFavicon(t: ThemeOption): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconDataUrl(t);
}

interface DesktopIconPayload {
  window?: string;
  tray?: string;
}

interface DesktopIconBridge {
  // Accepts either a single PNG data URL (legacy) or an object with separate
  // window + tray PNGs. Older shell builds only know the string form, so we
  // keep both signatures here for backward compatibility.
  setAppIcon?: (payload: string | DesktopIconPayload) => void;
}

/** Update the PWA <meta name="theme-color"> so the Android PWA toolbar /
 *  splash / task-switcher chrome tints to the theme. Synchronous + cheap. */
function applyMetaThemeColor(t: ThemeOption): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = t.bg;
}

// Bumped per raster request, so a slow decode for an earlier theme can't land
// after (and overwrite) the icons of the theme the user switched to since.
let rasterSeq = 0;

/**
 * Rasterize the themed mark to PNGs and apply them where PNGs are needed:
 *   - the `apple-touch-icon` link (so a *fresh* add-to-home-screen on iOS/PWA
 *     captures the active theme — an already-installed icon is OS-cached and
 *     can't be changed at runtime);
 *   - the Electron shell's window/taskbar/dock + tray icons (if the desktop
 *     bridge is present);
 *   - OS notifications (lib/themeIcon): Electron's desktop notifications and,
 *     through the service worker, Web Push ones.
 * nativeImage / apple-touch-icon / notification icons can't read SVG, hence
 * the canvas raster here.
 */
function updateRasterIcons(t: ThemeOption): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const bridge = (window as unknown as { zekktris?: DesktopIconBridge }).zekktris;
  const seq = ++rasterSeq;
  const img = new Image();
  img.onload = () => {
    if (seq !== rasterSeq) return; // a newer theme's raster is on its way
    try {
      const rasterize = (size: number): string => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';
        ctx.drawImage(img, 0, 0, size, size);
        return canvas.toDataURL('image/png');
      };
      // 256 reads cleanly on the Windows taskbar, macOS dock, and as an
      // apple-touch-icon. 32 matches the OS tray on Windows/Linux.
      const windowPng = rasterize(256);

      // apple-touch-icon (PWA / iOS "Add to Home Screen").
      let touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
      if (!touch) {
        touch = document.createElement('link');
        touch.rel = 'apple-touch-icon';
        document.head.appendChild(touch);
      }
      if (windowPng) touch.href = windowPng;

      // OS notification icon (desktop notifications + Web Push via the SW).
      if (windowPng) setThemedIcon(windowPng);

      // Electron native icons.
      if (bridge?.setAppIcon) {
        bridge.setAppIcon({ window: windowPng, tray: rasterize(32) });
      }
    } catch {
      /* ignore — keep the build-time icons */
    }
  };
  img.src = faviconDataUrl(t);
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  // 'default' is the bare :root, so clear the attribute for it.
  if (id === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  const opt = THEMES.find((t) => t.id === id) ?? THEMES[0];
  applyFavicon(opt);
  applyMetaThemeColor(opt);
  updateRasterIcons(opt);
  applyNativeTheme(opt);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}

/** Apply the stored theme. Call once, as early as possible, on boot. */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}
