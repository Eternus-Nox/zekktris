import { describe, it, expect } from 'vitest';
import { qrEncode, qrToSvg } from '../src/lib/qr';

// The invite QR (GuildSettingsModal) reuses the shared qr.ts that previously
// only served 2FA otpauth URIs. These tests confirm it encodes/renders a
// typical invite URL correctly.
const INVITE_URL = 'https://zekktris.com/invite/ABCDEFGH';

describe('qr for invite URLs', () => {
  it('encodes an invite URL into a square module matrix', () => {
    const m = qrEncode(INVITE_URL);
    expect(m.length).toBeGreaterThan(0);
    // Square.
    expect(m.every((row) => row.length === m.length)).toBe(true);
    // Finder pattern: the top-left module is dark.
    expect(m[0][0]).toBe(true);
    // Has both dark and light modules (not a degenerate all-one-color grid).
    const flat = m.flat();
    expect(flat.some((v) => v)).toBe(true);
    expect(flat.some((v) => !v)).toBe(true);
  });

  it('renders an SVG at the requested size with a white background', () => {
    const svg = qrToSvg(qrEncode(INVITE_URL), 180);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="180"');
    expect(svg).toContain('height="180"');
    expect(svg).toContain('fill="white"'); // quiet-zone background
    expect(svg).toContain('<rect'); // dark modules present
  });

  it('is deterministic for the same input', () => {
    expect(qrToSvg(qrEncode(INVITE_URL), 180)).toBe(qrToSvg(qrEncode(INVITE_URL), 180));
  });
});
