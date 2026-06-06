/**
 * Generate per-theme iOS alternate-icon PNG sets.
 *
 * iOS alternate icons must be PNGs baked into the app bundle (CFBundleAlternateIcons
 * in Info.plist) — the OS does NOT allow generating new icons at runtime. We can,
 * however, switch between a pre-declared set via UIApplication.setAlternateIconName.
 * This script renders one PNG per theme so they can be added to the Xcode project
 * and listed in Info.plist; the in-app theme picker then asks iOS to switch.
 *
 * Requires `sharp` to be installed (dev-dep):
 *   pnpm add -D sharp -w
 *
 * Run with:
 *   node scripts/generate-ios-icons.mjs
 *
 * Output: apps/web/ios-icons/<theme-id>/<name>.png — see the README there.
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dirname, '..', 'apps', 'web', 'ios-icons');

// Mirror of THEMES in apps/web/src/lib/theme.ts — keep in sync if you add
// or rename a theme.
const THEMES = [
  { id: 'default',       bg: '#0a0f1c', accents: ['#3dd7ec', '#9d7bff', '#ec5fb5'] },
  { id: 'oled',          bg: '#000000', accents: ['#3dd7ec', '#9d7bff', '#ec5fb5'] },
  { id: 'sunset',        bg: '#0a0f1c', accents: ['#ff8a3d', '#ffd13d', '#ff7a7a'] },
  { id: 'sunset-oled',   bg: '#000000', accents: ['#ff8a3d', '#ffd13d', '#ff7a7a'] },
  { id: 'forest',        bg: '#0a0f1c', accents: ['#3d9bff', '#4fdd8f', '#3dd8c0'] },
  { id: 'forest-oled',   bg: '#000000', accents: ['#3d9bff', '#4fdd8f', '#3dd8c0'] },
  { id: 'crimson',       bg: '#0a0f1c', accents: ['#ff4d4d', '#9aa3b8', '#ff8080'] },
  { id: 'crimson-oled',  bg: '#000000', accents: ['#ff4d4d', '#9aa3b8', '#ff8080'] },
  { id: 'blossom',       bg: '#0a0f1c', accents: ['#ff5fa2', '#ffb088', '#ff9ecf'] },
  { id: 'blossom-oled',  bg: '#000000', accents: ['#ff5fa2', '#ffb088', '#ff9ecf'] },
  { id: 'amethyst',      bg: '#0a0f1c', accents: ['#a855f7', '#f5b942', '#d8a7ff'] },
  { id: 'amethyst-oled', bg: '#000000', accents: ['#a855f7', '#f5b942', '#d8a7ff'] },
];

// iOS alternate-icon sizes. iPhone: 60pt @2x (120) + @3x (180). iPad: 76pt
// @1x (76) + @2x (152). iOS masks the corners itself, so we render flat tiles.
const SIZES = [
  { name: 'AppIcon-60@2x', px: 120 },
  { name: 'AppIcon-60@3x', px: 180 },
  { name: 'AppIcon-76',    px: 76 },
  { name: 'AppIcon-76@2x', px: 152 },
];

function svgFor(theme) {
  const [a1, a2, a3] = theme.accents;
  const z =
    'M192 224 L832 224 L832 352 L416 704 L832 704 L832 832 L192 832 L192 704 L608 352 L192 352 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
        <stop offset="0"   stop-color="${a1}"/>
        <stop offset="0.5" stop-color="${a2}"/>
        <stop offset="1"   stop-color="${a3}"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" fill="${theme.bg}"/>
    <path d="${z}" fill="url(#g)"/>
  </svg>`;
}

async function renderTheme(theme) {
  const svg = Buffer.from(svgFor(theme));
  const outDir = join(OUT_ROOT, theme.id);
  await mkdir(outDir, { recursive: true });
  for (const s of SIZES) {
    const buf = await sharp(svg).resize(s.px, s.px).png().toBuffer();
    await writeFile(join(outDir, `${s.name}.png`), buf);
  }
  console.log(`  ✓ ${theme.id}`);
}

async function main() {
  console.log(`Rendering iOS alternate-icon sets to ${OUT_ROOT}`);
  for (const t of THEMES) {
    await renderTheme(t);
  }
  console.log('Done. See apps/web/ios-icons/README.md for the Xcode wiring.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
