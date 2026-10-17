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

  it('follows a change made in another tab (storage event)', async () => {
    const data = stubStorage({ 'zk:e2ee-link-previews': '1' });
    let onStorage: ((e: { key: string | null }) => void) | undefined;
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: (e: { key: string | null }) => void) => {
        if (type === 'storage') onStorage = cb;
      },
    });
    const m = await import('../src/lib/e2eeLinkPreviews');
    expect(m.getE2eeLinkPreviews()).toBe(true);
    expect(onStorage).toBeTypeOf('function');
    // Another tab switches previews off.
    data.delete('zk:e2ee-link-previews');
    onStorage!({ key: 'zk:e2ee-link-previews' });
    expect(m.getE2eeLinkPreviews()).toBe(false);
    // Unrelated keys are ignored; storage.clear() (key null) is re-read.
    data.set('zk:e2ee-link-previews', '1');
    onStorage!({ key: 'zk:something-else' });
    expect(m.getE2eeLinkPreviews()).toBe(false);
    onStorage!({ key: null });
    expect(m.getE2eeLinkPreviews()).toBe(true);
  });
});

// The gate MessageItem runs before sending a decrypted link to /unfurl.
describe('resolveE2eeLinkPreviews', () => {
  const embed = { url: 'https://example.com/a', kind: 'link' } as never;
  const encrypted = {
    previewsEnabled: true,
    isEncrypted: true,
    noKey: false,
    plaintext: 'look https://example.com/a, and https://example.org/b.',
    hasServerEmbeds: false,
  };

  it('never calls unfurl while previews are off', async () => {
    const { resolveE2eeLinkPreviews } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi.fn(async () => ({ embed }));
    expect(resolveE2eeLinkPreviews({ ...encrypted, previewsEnabled: false }, unfurl)).toBeNull();
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('unfurls each decrypted link once previews are on', async () => {
    const { resolveE2eeLinkPreviews } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi.fn(async (u: string) => ({ embed: u.includes('example.com') ? embed : null }));
    const found = await resolveE2eeLinkPreviews(encrypted, unfurl);
    expect(unfurl.mock.calls.map((c) => c[0])).toEqual(['https://example.com/a', 'https://example.org/b']);
    expect(found).toEqual([embed]);
  });

  it('does nothing for plaintext, undecryptable or already-embedded messages', async () => {
    const { resolveE2eeLinkPreviews } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi.fn(async () => ({ embed }));
    expect(resolveE2eeLinkPreviews({ ...encrypted, isEncrypted: false }, unfurl)).toBeNull();
    expect(resolveE2eeLinkPreviews({ ...encrypted, noKey: true }, unfurl)).toBeNull();
    expect(resolveE2eeLinkPreviews({ ...encrypted, plaintext: null }, unfurl)).toBeNull();
    expect(resolveE2eeLinkPreviews({ ...encrypted, hasServerEmbeds: true }, unfurl)).toBeNull();
    expect(resolveE2eeLinkPreviews({ ...encrypted, plaintext: 'no links here' }, unfurl)).toBeNull();
    expect(unfurl).not.toHaveBeenCalled();
  });

  it('keeps going when one link fails to unfurl', async () => {
    const { resolveE2eeLinkPreviews } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi.fn(async (u: string) => {
      if (u.includes('example.com')) throw new Error('boom');
      return { embed };
    });
    expect(await resolveE2eeLinkPreviews(encrypted, unfurl)).toEqual([embed]);
    expect(unfurl).toHaveBeenCalledTimes(2);
  });
});

describe('cachedUnfurl', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('sends each link to the server once', async () => {
    const { cachedUnfurl } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi.fn(async () => ({ embed: null }));
    await Promise.all([cachedUnfurl('https://a.example/', unfurl), cachedUnfurl('https://a.example/', unfurl)]);
    await cachedUnfurl('https://a.example/', unfurl);
    await cachedUnfurl('https://b.example/', unfurl);
    expect(unfurl.mock.calls.map((c) => c[0])).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('retries a link whose unfurl failed', async () => {
    const { cachedUnfurl } = await import('../src/lib/e2eeLinkPreviews');
    const unfurl = vi
      .fn<(u: string) => Promise<{ embed: null }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ embed: null });
    await expect(cachedUnfurl('https://a.example/', unfurl)).rejects.toThrow('boom');
    await expect(cachedUnfurl('https://a.example/', unfurl)).resolves.toEqual({ embed: null });
    expect(unfurl).toHaveBeenCalledTimes(2);
  });
});
