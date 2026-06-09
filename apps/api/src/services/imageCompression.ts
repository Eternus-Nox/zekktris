/**
 * Attachment compression sweep
 * ----------------------------
 * Reduces on-disk footprint of older image uploads by re-encoding
 * them at lower quality (or with better compression for lossless
 * formats). Runs as a periodic background job from index.ts.
 *
 * Design constraints:
 *   - Idempotent: rows track compressed_at; the sweep skips processed
 *     rows. A row that's been compressed once is never re-compressed
 *     by the same sweep.
 *   - Honest about size: the post-compression size is written back to
 *     attachments.size so clients see the real number. If the re-encode
 *     somehow PRODUCED a larger file (rare but possible at extreme
 *     quality presets), we keep the original and just stamp
 *     compressed_at without changing size/content.
 *   - Atomic per file: we write to a sibling tmp file in the same
 *     directory and rename(2) over the original. On the same volume
 *     that's an atomic swap — a concurrent reader either sees the
 *     old file or the new one, never a half-written mess.
 *   - Sharp is optional: the only image library that handles all our
 *     formats well is sharp, which carries a sizable native binary.
 *     Dynamic import + try/catch means the API still runs (with
 *     compression disabled) on hosts that haven't installed it.
 *   - Bounded work per tick: process up to BATCH_LIMIT rows per call.
 *     A backlog of thousands of old files won't block the event loop
 *     for minutes — it'll just drain across many ticks.
 *
 * Trigger from index.ts on the operator's preferred cadence (daily
 * is fine — older files don't get older that fast).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lt, isNull, and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';

/**
 * Files younger than this are not compression candidates. Recent
 * attachments are still in the "active reference" window — they may
 * be linked from messages that are still in the user's scrollback,
 * which means the cost of any quality dip is more noticeable. Older
 * files are usually deep in scrollback or in archived DMs where the
 * tradeoff favors disk savings.
 */
const COMPRESS_AFTER_DAYS = 7;

/**
 * Decompression-bomb cap for the periodic sweep's decode. The upload
 * boundary rejects oversized images, but this sweep also decodes already-
 * stored files (including any that predate the boundary check), so it caps
 * sharp's input independently. 100 MP — see MAX_INPUT_PIXELS in
 * services/uploads.ts for the full rationale; kept in sync here rather than
 * cross-imported, mirroring this file's standalone loadSharp().
 */
const MAX_INPUT_PIXELS = 100_000_000;

/**
 * Files smaller than this aren't worth compressing — re-encoding
 * incurs a fixed CPU cost and the savings on a 30KB icon would be
 * single-digit kilobytes. Files this small also tend to be avatars
 * and emojis where any quality loss is more visible at small sizes.
 */
const COMPRESS_MIN_BYTES = 64 * 1024; // 64 KB

/**
 * How many rows the sweep evaluates per invocation. Caps the
 * worst-case event-loop occupancy when a backlog has accumulated
 * (e.g. operator turning compression on for the first time on an
 * existing instance with many old files). The sweep is idempotent,
 * so the next tick picks up where this one left off.
 */
const BATCH_LIMIT = 50;

/**
 * Quality target for lossy re-encodes (JPEG, WebP). The default for
 * most camera/phone exports is 90+; 75 saves ~30-50% without
 * perceptible loss for the 95th percentile viewer. The operator can
 * tune via env if their content skews differently (e.g. a community
 * focused on photography might prefer 85).
 */
const LOSSY_QUALITY = Number(env.IMAGE_COMPRESS_QUALITY ?? 75);

interface SharpModule {
  default: (
    input: string | Buffer,
    opts?: { limitInputPixels?: number },
  ) => SharpInstance;
}

interface SharpInstance {
  jpeg: (opts: { quality: number; mozjpeg?: boolean }) => SharpInstance;
  webp: (opts: { quality: number }) => SharpInstance;
  png: (opts: { compressionLevel: number; palette?: boolean }) => SharpInstance;
  toBuffer: () => Promise<Buffer>;
}

let sharpLoadAttempted = false;
let sharp: SharpModule['default'] | null = null;

/**
 * Dynamically load sharp on first use. The module is large (~30MB
 * with prebuilt binaries) and requires native libvips, so we don't
 * make it a hard dependency. Operators who want compression install
 * sharp manually; everyone else gets the sweep but it no-ops.
 *
 * Cached after first attempt: if sharp isn't installed we don't
 * keep paying the import-error cost on every sweep tick.
 */
async function loadSharp(): Promise<SharpModule['default'] | null> {
  if (sharpLoadAttempted) return sharp;
  sharpLoadAttempted = true;
  try {
    // String alias on the specifier prevents bundlers from trying to
    // resolve `sharp` at build time when it's not installed.
    const mod = (await import(/* @vite-ignore */ 'sharp' as string)) as
      | SharpModule
      | { default: SharpModule['default'] };
    sharp = ('default' in mod ? mod.default : (mod as SharpModule).default) ?? null;
  } catch {
    sharp = null;
  }
  return sharp;
}

/**
 * Run one batch of the compression sweep. Returns the number of rows
 * processed (whether or not they actually shrunk).
 *
 * Safe to call from any context — caught error paths catch all failure
 * modes (sharp missing, file missing, fs errors, db errors) so the
 * periodic timer in index.ts never sees an unhandled rejection.
 */
export async function runCompressionSweep(): Promise<{
  processed: number;
  compressed: number;
  bytesSaved: number;
  sharpAvailable: boolean;
}> {
  const sharpFn = await loadSharp();
  // When sharp isn't available we don't even fetch candidates — there's
  // nothing useful we'd do with them and we don't want to hammer the
  // db every sweep for no reason. The route still returns
  // sharpAvailable=false so the operator can see the state.
  if (!sharpFn) {
    return { processed: 0, compressed: 0, bytesSaved: 0, sharpAvailable: false };
  }

  const cutoff = new Date(Date.now() - COMPRESS_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Pull the candidate batch. The partial index on (created_at) WHERE
  // compressed_at IS NULL keeps this fast even when the compressed
  // pile is huge — we never scan rows we've already processed.
  const rows = await db
    .select({
      id: schema.attachments.id,
      filename: schema.attachments.filename,
      contentType: schema.attachments.contentType,
      size: schema.attachments.size,
    })
    .from(schema.attachments)
    .where(
      and(
        isNull(schema.attachments.compressedAt),
        lt(schema.attachments.createdAt, cutoff),
      ),
    )
    .limit(BATCH_LIMIT);

  let compressed = 0;
  let bytesSaved = 0;
  const now = new Date();

  for (const row of rows) {
    const result = await processOne(sharpFn, row);
    if (result.compressed) {
      compressed += 1;
      bytesSaved += result.bytesSaved;
    }
    // Mark the row processed regardless of outcome. A row we
    // intentionally skipped (non-image, too small, animated GIF)
    // doesn't need to be re-evaluated tomorrow — its size won't change
    // just because another day passed.
    try {
      await db
        .update(schema.attachments)
        .set({
          compressedAt: now,
          // Only update size when we actually wrote a smaller file.
          // Otherwise leave the row alone (the size column still
          // matches the on-disk file).
          ...(result.compressed ? { size: result.newSize } : {}),
        })
        .where(eq(schema.attachments.id, row.id));
    } catch {
      // DB hiccup — leave the row's compressed_at null; next tick
      // re-tries from the same place. The file is fine either way
      // (we wrote it atomically), so worst case we re-compress
      // tomorrow which is idempotent.
    }
  }

  return {
    processed: rows.length,
    compressed,
    bytesSaved,
    sharpAvailable: true,
  };
}

interface ProcessResult {
  compressed: boolean;
  newSize: number;
  bytesSaved: number;
}

async function processOne(
  sharpFn: SharpModule['default'],
  row: {
    id: bigint;
    filename: string;
    contentType: string;
    size: number;
  },
): Promise<ProcessResult> {
  const noop: ProcessResult = { compressed: false, newSize: row.size, bytesSaved: 0 };

  // Skip non-image types. We could in principle re-encode videos /
  // audio with ffmpeg too, but that's a separate tool and a separate
  // can of worms (audio quality target, video keyframe spacing).
  if (!row.contentType.startsWith('image/')) return noop;

  // GIF: might be animated, sharp's animated path doesn't reliably
  // produce smaller output. Skip.
  if (row.contentType === 'image/gif') return noop;

  // AVIF: already a state-of-the-art format. Re-encoding gains little
  // and risks color-space issues across viewer ecosystems. Skip.
  if (row.contentType === 'image/avif') return noop;

  // Too small to be worth touching.
  if (row.size < COMPRESS_MIN_BYTES) return noop;

  const dir = path.join(env.UPLOAD_DIR, row.id.toString());
  const diskPath = path.join(dir, row.filename);
  const tmpPath = path.join(dir, `.${row.filename}.compress.tmp`);

  try {
    // Verify file exists. If the row points at a missing file the
    // sweep shouldn't crash; just mark it processed (the file was
    // already gone, presumably from an earlier admin operation).
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) return noop;

    let pipeline: SharpInstance;
    try {
      const img = sharpFn(diskPath, { limitInputPixels: MAX_INPUT_PIXELS });
      if (row.contentType === 'image/jpeg') {
        // mozjpeg gives 5-10% better compression than libjpeg-turbo
        // at the same quality target. Enabled by default in modern
        // sharp builds.
        pipeline = img.jpeg({ quality: LOSSY_QUALITY, mozjpeg: true });
      } else if (row.contentType === 'image/webp') {
        pipeline = img.webp({ quality: LOSSY_QUALITY });
      } else if (row.contentType === 'image/png') {
        // PNG is lossless — we only get savings from better
        // compression settings and an indexed palette where possible.
        // compressionLevel: 9 = max zlib; palette: true converts to
        // indexed PNG for images with <=256 colors (screenshots,
        // diagrams, pixel art), often saving 50%+.
        pipeline = img.png({ compressionLevel: 9, palette: true });
      } else {
        // Unknown image subtype; don't touch.
        return noop;
      }
    } catch {
      // sharp failed to open — corrupted file, unsupported variant,
      // whatever. Don't recompress, but don't crash either.
      return noop;
    }

    let outBuf: Buffer;
    try {
      outBuf = await pipeline.toBuffer();
    } catch {
      return noop;
    }

    // Only swap if we actually saved bytes. A re-encode at our quality
    // target could legitimately produce a larger file (e.g. an already-
    // highly-compressed PNG re-encoded with a palette that doesn't
    // fit). Keep the original in that case.
    if (outBuf.length >= row.size) {
      return noop;
    }

    // Atomic swap: write the new bytes to a sibling tmp file, then
    // rename(2) over the original. Same-volume rename is atomic on
    // POSIX; readers either see the old file or the new one.
    await fs.writeFile(tmpPath, outBuf);
    await fs.rename(tmpPath, diskPath);

    return {
      compressed: true,
      newSize: outBuf.length,
      bytesSaved: row.size - outBuf.length,
    };
  } catch {
    // Last-line catch — file system errors, permission issues, etc.
    // Best-effort cleanup of any orphaned tmp file.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    return noop;
  }
}

