import { describe, it, expect, afterEach, vi } from 'vitest';
import { e2eeSupported } from '../src/lib/e2eeSupport';

// A --lan install serves http://<lan-ip>, a non-secure context where the
// browser hides crypto.subtle. E2EE UI must detect that up front.
describe('e2eeSupported', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is false on a plain-http (non-secure) origin', () => {
    vi.stubGlobal('window', { isSecureContext: false });
    expect(e2eeSupported()).toBe(false);
  });

  it('is false when WebCrypto is missing even if the context claims secure', () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('crypto', {});
    expect(e2eeSupported()).toBe(false);
  });

  it('is true on a secure origin with WebCrypto', () => {
    vi.stubGlobal('window', { isSecureContext: true });
    expect(typeof crypto.subtle).toBe('object');
    expect(e2eeSupported()).toBe(true);
  });

  it('is false outside a browser', () => {
    expect(e2eeSupported()).toBe(false);
  });
});
