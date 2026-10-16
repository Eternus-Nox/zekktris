import { describe, it, expect, afterEach, vi } from 'vitest';

// Link previews in E2EE chats send the decrypted link to the server, so the
// device-local toggle must default OFF and persist only an explicit opt-in.
describe('e2eeLinkPreviews pref', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function stubStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    return data;
  }

  it('defaults to off with empty storage', async () => {
    stubStorage();
    const m = await import('../src/lib/e2eeLinkPreviews');
    expect(m.getE2eeLinkPreviews()).toBe(false);
  });

  it('defaults to off when storage is unavailable', async () => {
    const m = await import('../src/lib/e2eeLinkPreviews');
    expect(m.getE2eeLinkPreviews()).toBe(false);
  });

  it('persists an opt-in and clears it on opt-out', async () => {
    const data = stubStorage();
    const m = await import('../src/lib/e2eeLinkPreviews');
    m.setE2eeLinkPreviews(true);
    expect(m.getE2eeLinkPreviews()).toBe(true);
    expect(data.get('zk:e2ee-link-previews')).toBe('1');
    m.setE2eeLinkPreviews(false);
    expect(m.getE2eeLinkPreviews()).toBe(false);
    expect(data.has('zk:e2ee-link-previews')).toBe(false);
  });

  it('reads a stored opt-in on load', async () => {
    stubStorage({ 'zk:e2ee-link-previews': '1' });
    const m = await import('../src/lib/e2eeLinkPreviews');
    expect(m.getE2eeLinkPreviews()).toBe(true);
  });
});
