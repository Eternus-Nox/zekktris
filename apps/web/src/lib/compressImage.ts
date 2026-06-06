/**
 * compressImage — client-side image downscale + re-encode.
 * --------------------------------------------------------
 * Runs in the browser BEFORE upload so the server never has to decode
 * or re-encode anything: it just stores the bytes it receives. This
 * cuts upload bandwidth/time, server CPU, and on-disk storage at the
 * source.
 *
 * Behavior:
 *   - Only touches still raster images (jpeg / png / webp). Animated
 *     GIFs and non-images pass through untouched (re-encoding a GIF on
 *     a canvas would flatten it to a single frame).
 *   - Skips files already under `minBytes` — not worth the work.
 *   - Downscales so the longest side is at most `maxDimension`, then
 *     re-encodes to WebP (which keeps PNG transparency, unlike JPEG)
 *     at `quality`.
 *   - If the result isn't actually smaller (already-optimized image),
 *     returns the ORIGINAL so we never make a file bigger.
 *   - Any failure (decode error, no canvas, etc.) returns the original
 *     so uploads never break because of compression.
 */

export interface CompressOptions {
  /** Max length of the longest side, in px. */
  maxDimension?: number;
  /** WebP quality, 0..1. */
  quality?: number;
  /** Don't bother compressing files smaller than this (bytes). */
  minBytes?: number;
}

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function compressImage(
  file: File,
  opts: CompressOptions = {},
): Promise<File> {
  const maxDimension = opts.maxDimension ?? 1920;
  const quality = opts.quality ?? 0.82;
  const minBytes = opts.minBytes ?? 256 * 1024;

  if (!COMPRESSIBLE.has(file.type)) return file;
  if (file.size < minBytes) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    if (!width || !height) {
      bitmap.close?.();
      return file;
    }
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', quality),
    );
    // No blob, or no size win → keep the original untouched.
    if (!blob || blob.size >= file.size) return file;

    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.webp`, {
      type: 'image/webp',
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

/** Compress a batch, preserving order. Failures fall back per-file. */
export async function compressImages(files: File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressImage(f)));
}
