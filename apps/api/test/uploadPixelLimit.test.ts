import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_INPUT_PIXELS,
  imageTotalPixels,
  exceedsPixelLimit,
  saveUploadedFile,
} from '../src/services/uploads';

// ── Pure decision logic (no sharp / no disk) ──────────────────────────────

describe('image pixel-limit decision', () => {
  it('MAX_INPUT_PIXELS is 100 megapixels', () => {
    expect(MAX_INPUT_PIXELS).toBe(100_000_000);
  });

  it('counts total pixels including animation frames', () => {
    expect(imageTotalPixels(4000, 3000)).toBe(12_000_000); // 12 MP still
    expect(imageTotalPixels(1000, 1000, 50)).toBe(50_000_000); // 50 frames
    expect(imageTotalPixels(0, 0)).toBe(0);
    expect(imageTotalPixels(-5, 10)).toBe(0); // garbage dims clamp to 0
  });

  it('passes realistic photos', () => {
    expect(exceedsPixelLimit(4000, 3000)).toBe(false); // 12 MP
    expect(exceedsPixelLimit(8000, 6000)).toBe(false); // 48 MP flagship phone
    expect(exceedsPixelLimit(12000, 8000)).toBe(false); // 96 MP, under cap
  });

  it('rejects gigapixel still bombs', () => {
    expect(exceedsPixelLimit(20000, 20000)).toBe(true); // 400 MP
    expect(exceedsPixelLimit(50000, 50000)).toBe(true); // 2.5 GP
  });

  it('rejects many-frame animated bombs (small frame, huge count)', () => {
    expect(exceedsPixelLimit(1000, 1000, 200)).toBe(true); // 200 MP across frames
    expect(exceedsPixelLimit(500, 500, 500)).toBe(true); // 125 MP across frames
  });

  it('is exact at the boundary', () => {
    expect(exceedsPixelLimit(10000, 10000)).toBe(false); // exactly 100 MP — allowed
    expect(exceedsPixelLimit(10001, 10000)).toBe(true); // one row over — rejected
  });
});

// ── End-to-end through saveUploadedFile (real sharp + real disk) ───────────

const sharpAvailable = await (async () => {
  try {
    await import(/* @vite-ignore */ ('sharp' as string));
    return true;
  } catch {
    return false;
  }
})();

if (!sharpAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[uploadPixelLimit] skipping disk/sharp e2e — sharp not installed');
}

/** A 66-byte PNG whose IHDR declares 20000×20000 (400 MP) but carries a
 *  trivial IDAT — a textbook decompression bomb (tiny file, huge dims). */
function craftPngBomb(width: number, height: number): Buffer {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fileFrom(buf: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(buf)], name, { type });
}

describe.runIf(sharpAvailable)('saveUploadedFile decompression-bomb guard', () => {
  it('rejects a tiny PNG that declares a gigapixel size, with a clear error', async () => {
    const bomb = craftPngBomb(20000, 20000); // ~66 bytes, 400 MP declared
    await expect(
      saveUploadedFile(fileFrom(bomb, 'bomb.png', 'image/png')),
    ).rejects.toThrow(/megapixel limit/i);
  });

  it('accepts a normal small image and stores it', async () => {
    const sharp = (await import(/* @vite-ignore */ ('sharp' as string))).default;
    const normal: Buffer = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const saved = await saveUploadedFile(fileFrom(normal, 'ok.png', 'image/png'));
    try {
      expect(saved.contentType).toMatch(/^image\//);
      const onDisk = await fs.stat(saved.diskPath);
      expect(onDisk.isFile()).toBe(true);
    } finally {
      // Clean up the per-attachment dir this test wrote.
      await fs.rm(path.dirname(saved.diskPath), { recursive: true, force: true });
    }
  });
});
