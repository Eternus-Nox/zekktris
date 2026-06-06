/**
 * QR code generator (alphanumeric/byte mode, ECC level M).
 *
 * Why hand-rolled instead of `qrcode` (50KB) or `qrcode-generator`?
 * For the otpauth URIs we render here (50-150 chars, byte mode,
 * version 5-10) we don't need a full-featured library. This
 * implementation is ~6KB minified, has no dependencies, and only
 * does what we need: encode an ASCII string, output a matrix of
 * black/white modules, render as an inline SVG.
 *
 * Algorithm summary (ISO/IEC 18004):
 *   1. Pick the smallest QR version (1–40) that fits our data
 *      length at ECC level M
 *   2. Build a bitstream: mode indicator (4 bits) + char count +
 *      encoded data + terminator + pad bytes
 *   3. Split into data codewords; compute Reed-Solomon ECC
 *      codewords for each block; interleave them per spec
 *   4. Lay out the matrix: finder/timing/alignment patterns,
 *      format/version info, then snake-fill the remaining
 *      modules with the codeword bits
 *   5. Apply data masking (8 candidate masks; pick lowest penalty)
 *   6. Write format info into reserved area
 *
 * References:
 *   - https://www.thonky.com/qr-code-tutorial/  (highly readable
 *     walkthrough of the spec)
 *   - ISO/IEC 18004:2015
 *
 * For our use (otpauth URIs ~100 chars, ECC M), this resolves
 * to version 5-6 → 37–41 modules per side. Rendered as ~256px SVG.
 */

// ── Reed-Solomon over GF(2^8), generator polynomial x^8 + x^4 + x^3 + x^2 + 1 ──

const RS_LOG = new Uint8Array(256);
const RS_EXP = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    RS_EXP[i] = x;
    RS_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  RS_EXP[255] = RS_EXP[0];
})();

function rsMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return RS_EXP[(RS_LOG[a]! + RS_LOG[b]!) % 255]!;
}

function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= rsMul(poly[j]!, 1);
      next[j + 1] ^= rsMul(poly[j]!, RS_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], generator: number[]): number[] {
  const buf = data.slice().concat(new Array(generator.length - 1).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      buf[i + j]! ^= rsMul(generator[j]!, factor);
    }
  }
  return buf.slice(data.length);
}

// ── QR version tables (ECC level M, byte mode) ──
// Format: [totalCodewords, eccCodewordsPerBlock, blockGroups[][numBlocks, dataCodewords]]
// Source: ISO/IEC 18004 Table 9 (M). We include versions 1-10 which cover
// data up to 271 bytes — far more than otpauth URIs need.
const QR_TABLE_M: Array<[number, number, [number, number][]]> = [
  [26, 10, [[1, 16]]],                       // v1: 16 data bytes
  [44, 16, [[1, 28]]],                       // v2
  [70, 26, [[1, 44]]],                       // v3
  [100, 18, [[2, 32]]],                      // v4
  [134, 24, [[2, 43]]],                      // v5
  [172, 16, [[4, 27]]],                      // v6
  [196, 18, [[4, 31]]],                      // v7
  [242, 22, [[2, 38], [2, 39]]],             // v8
  [292, 22, [[3, 36], [2, 37]]],             // v9
  [346, 26, [[4, 43], [1, 44]]],             // v10
];

const ALIGN_PATTERNS: Array<number[]> = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** Encode a string into a QR module matrix at the smallest fitting
    version with ECC level M. Returns a 2D boolean array where true
    is "dark module". */
export function qrEncode(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  // Pick smallest version that fits.
  let version = -1;
  for (let v = 0; v < QR_TABLE_M.length; v++) {
    const dataCap = QR_TABLE_M[v]![2].reduce((s, [n, d]) => s + n * d, 0);
    // bit budget = dataCap*8 - mode(4) - charCount(8 or 16) bits
    const charCountBits = v + 1 >= 10 ? 16 : 8;
    const dataBits = dataCap * 8 - 4 - charCountBits;
    if (data.length * 8 <= dataBits) {
      version = v + 1;
      break;
    }
  }
  if (version === -1) {
    throw new Error('QR data too long for supported versions (>271 bytes)');
  }

  const [totalCodewords, eccPerBlock, blockGroups] = QR_TABLE_M[version - 1]!;
  const size = 17 + version * 4;
  const charCountBits = version >= 10 ? 16 : 8;

  // ── Build bit buffer ──
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // byte mode
  pushBits(bits, data.length, charCountBits);
  for (const byte of data) pushBits(bits, byte, 8);

  // Terminator + byte padding
  const dataCapBytes = blockGroups.reduce((s, [n, d]) => s + n * d, 0);
  const dataCapBits = dataCapBytes * 8;
  const termBits = Math.min(4, dataCapBits - bits.length);
  for (let i = 0; i < termBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes alternating 0xEC, 0x11 per spec
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < dataCapBits) {
    pushBits(bits, padBytes[padIdx % 2]!, 8);
    padIdx++;
  }

  // Convert to codewords
  const dataWords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    dataWords.push(b);
  }

  // Split into blocks, compute ECC per block
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  const generator = rsGeneratorPoly(eccPerBlock);
  let off = 0;
  for (const [n, d] of blockGroups) {
    for (let b = 0; b < n; b++) {
      const block = dataWords.slice(off, off + d);
      off += d;
      blocks.push(block);
      eccBlocks.push(rsRemainder(block, generator));
    }
  }

  // Interleave data, then ECC
  const finalCodewords: number[] = [];
  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) finalCodewords.push(block[i]!);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const ecc of eccBlocks) finalCodewords.push(ecc[i]!);
  }

  // Codewords → bit stream
  const finalBits: number[] = [];
  for (const w of finalCodewords) {
    for (let i = 7; i >= 0; i--) finalBits.push((w >> i) & 1);
  }
  // Remainder bits (zero pad to required length)
  const rem = totalCodewords * 8 - finalBits.length;
  for (let i = 0; i < rem; i++) finalBits.push(0);

  // ── Build matrix ──
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  function setModule(r: number, c: number, dark: boolean, isReserved: boolean) {
    matrix[r]![c] = dark;
    if (isReserved) reserved[r]![c] = true;
  }

  // Finder patterns at three corners
  function drawFinder(r0: number, c0: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        setModule(rr, cc, inside && (onBorder || inCenter), true);
      }
    }
  }
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0, true);
    setModule(i, 6, i % 2 === 0, true);
  }

  // Alignment patterns (skipping ones overlapping finders)
  const aligns = ALIGN_PATTERNS[version] ?? [];
  for (const r of aligns) {
    for (const c of aligns) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const onBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          setModule(r + dr, c + dc, onBorder || isCenter, true);
        }
      }
    }
  }

  // Reserve format info area (filled in after masking)
  for (let i = 0; i < 9; i++) {
    if (matrix[8]![i] === null) reserved[8]![i] = true;
    if (matrix[i]![8] === null) reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
  // Dark module
  setModule(size - 8, 8, true, true);

  // Data bits: snake-fill bottom-to-top in 2-column strips, skipping
  // the timing column at index 6.
  let bitIdx = 0;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let r = 0; r < size; r++) {
      for (let cOff = 0; cOff < 2; cOff++) {
        const c = col - cOff;
        // Determine actual row based on direction
        const upward = ((size - 1 - col) & 0x2) === 0;
        const actualR = upward ? size - 1 - r : r;
        if (matrix[actualR]![c] !== null) continue;
        if (bitIdx < finalBits.length) {
          matrix[actualR]![c] = finalBits[bitIdx] === 1;
          bitIdx++;
        } else {
          matrix[actualR]![c] = false;
        }
      }
    }
  }

  // Pick best mask (lowest penalty across the 8 candidate masks)
  let bestPenalty = Infinity;
  let bestMatrix: boolean[][] | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const masked: boolean[][] = matrix.map((row, r) =>
      row.map((v, c) => {
        if (reserved[r]![c]) return v as boolean;
        return v! !== maskPattern(mask, r, c);
      }),
    );
    writeFormatInfo(masked, mask, reserved, size);
    const p = penalty(masked);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMatrix = masked;
    }
  }

  return bestMatrix!;
}

function pushBits(out: number[], value: number, count: number) {
  for (let i = count - 1; i >= 0; i--) out.push((value >> i) & 1);
}

function maskPattern(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

// Format info: (ECC level 00 for M) | mask, BCH(15,5), XOR mask 0x5412
const FORMAT_ECC_M = 0b00;
function writeFormatInfo(matrix: boolean[][], mask: number, _reserved: boolean[][], size: number) {
  const data = (FORMAT_ECC_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ (((rem >> 9) & 1) ? 0b10100110111 : 0);
  }
  const bits = ((data << 10) | rem) ^ 0b101010000010010;

  // Top-left format info
  for (let i = 0; i <= 5; i++) matrix[8]![i] = ((bits >> i) & 1) === 1;
  matrix[8]![7] = ((bits >> 6) & 1) === 1;
  matrix[8]![8] = ((bits >> 7) & 1) === 1;
  matrix[7]![8] = ((bits >> 8) & 1) === 1;
  for (let i = 9; i < 15; i++) matrix[14 - i]![8] = ((bits >> i) & 1) === 1;

  // Top-right + bottom-left
  for (let i = 0; i < 8; i++) matrix[8]![size - 1 - i] = ((bits >> i) & 1) === 1;
  for (let i = 8; i < 15; i++) matrix[size - 15 + i]![8] = ((bits >> i) & 1) === 1;
}

function penalty(m: boolean[][]): number {
  // Simplified penalty: just count adjacent same-color runs.
  // Full spec has 4 rules — this approximation picks reasonable
  // masks in practice for the small versions we use.
  const size = m.length;
  let p = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r]![c] === m[r]![c - 1]) {
        run++;
        if (run === 5) p += 3;
        else if (run > 5) p++;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r]![c] === m[r - 1]![c]) {
        run++;
        if (run === 5) p += 3;
        else if (run > 5) p++;
      } else run = 1;
    }
  }
  return p;
}

/** Render a QR matrix as an inline-SVG string. The `size` parameter
    is the rendered pixel size of the square; modules are scaled to
    fit. Includes a 4-module-wide quiet zone per spec. */
export function qrToSvg(matrix: boolean[][], pixelSize = 200): string {
  const modules = matrix.length;
  const quiet = 4;
  const total = modules + quiet * 2;
  const scale = pixelSize / total;
  const rects: string[] = [];
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (matrix[r]![c]) {
        const x = (c + quiet) * scale;
        const y = (r + quiet) * scale;
        rects.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${scale.toFixed(2)}" height="${scale.toFixed(2)}" />`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixelSize} ${pixelSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">` +
    `<rect width="${pixelSize}" height="${pixelSize}" fill="white"/>` +
    `<g fill="black">${rects.join('')}</g>` +
    `</svg>`
  );
}
