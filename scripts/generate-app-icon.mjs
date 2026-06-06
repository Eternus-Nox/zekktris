/**
 * Generate the PRIMARY iOS app icon (home-screen icon) from the brand SVG.
 *
 * This is the single 1024×1024 marketing icon that Xcode's asset catalog
 * wants for AppIcon (Xcode 14+ downsizes it to every needed size). It is
 * SEPARATE from the per-theme *alternate* icons in apps/web/ios-icons/<theme>/
 * (those are produced by generate-ios-icons.mjs).
 *
 * iOS requirements this script enforces:
 *   - exactly 1024×1024
 *   - fully OPAQUE (no alpha) — the App Store rejects icons with transparency
 *   - square with NO rounded corners — iOS applies its own corner mask, so we
 *     drop the brand SVG's rounded corners and let the gradient fill the canvas
 *
 * Requires `sharp` (dev-dep):  pnpm add -D sharp -w
 * Run:                         node scripts/generate-app-icon.mjs
 * Output:                      apps/web/ios-icons/AppIcon-1024.png
 *
 * Then drag the PNG into Xcode → App target → Assets.xcassets → AppIcon
 * (the single 1024 "App Store" slot). See IOS_BUILD.md → "App icon".
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'apps', 'web', 'public', 'icon.svg');
const OUT = join(__dirname, '..', 'apps', 'web', 'ios-icons', 'AppIcon-1024.png');
const BG = '#0a0f1c'; // brand abyss navy — fills the corners we un-round

const svg = await readFile(SRC, 'utf8');
// Remove the brand mark's rounded corners so the icon is a full opaque
// square (iOS masks its own corners; a pre-rounded icon shows gaps).
const squared = svg.replace(/rx="232" ry="232"/g, 'rx="0" ry="0"');

await sharp(Buffer.from(squared))
  .resize(1024, 1024)
  .flatten({ background: BG }) // drop alpha → opaque, as the App Store requires
  .png()
  .toFile(OUT);

const meta = await sharp(OUT).metadata();
console.log(
  `Wrote ${OUT} (${meta.width}x${meta.height}, channels=${meta.channels}, hasAlpha=${meta.hasAlpha})`,
);
