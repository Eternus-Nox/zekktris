/**
 * Server address handling for the desktop shell — mirrors the iOS and Android
 * pickers. Anyone can run their own Zekktris server; the shell loads
 * whichever one the user picked (zekktris.com by default).
 */

import { isIP } from 'node:net';

/** True for hosts only reachable on the local network. Never resolves DNS —
    names other than localhost / *.local count as public. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (v === 6) {
    return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}

/**
 * Turn what someone typed ("chat.example.com", "203.0.113.5",
 * "https://chat.example.com:8443/", "http://192.168.1.20:5550") into an
 * origin. No scheme → https. Plain http only for a local-network server.
 */
export function normalizeServerUrl(
  input: string,
): { ok: true; origin: string } | { ok: false; error: string } {
  let text = input.trim();
  if (!text) return { ok: false, error: 'Enter a server address.' };
  if (!text.includes('://')) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That doesn't look like a server address." };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: "That doesn't look like a server address." };
  }
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
    return {
      ok: false,
      error: 'Plain http:// only works for a server on your home network. Use https://.',
    };
  }
  return { ok: true, origin: u.origin };
}

/** One GET to {origin}/api/v1/instance/info: proves the address answers and
    that it's a Zekktris server. Resolves to null on success, else a message. */
export async function probeServer(origin: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/api/v1/instance/info`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { software?: string } | null;
    if (res.ok && body?.software === 'zekktris') return null;
    // A Zekktris server older than /instance/info (zekktris.com until it's
    // redeployed, or a self-hosted one not updated yet) still answers its
    // health check with this shape.
    const health = await fetch(`${origin}/health`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as { status?: string; uptimeSeconds?: number } | null;
    if (health?.status === 'ok' && typeof health.uptimeSeconds === 'number') return null;
    return "Something answered at that address, but it isn't a Zekktris server.";
  } catch (err) {
    const msg = String((err as { cause?: { code?: string } })?.cause?.code ?? err);
    if (/WRONG_VERSION_NUMBER|EPROTO/i.test(msg)) {
      return "That address doesn't use HTTPS. If the server is on your home network, type it with http:// in front.";
    }
    if (/CERT|SSL|TLS/i.test(msg)) {
      return "That server's HTTPS certificate isn't valid. Its owner needs to finish setting up HTTPS.";
    }
    return "Couldn't reach that server. Check the address, and that the server is running.";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Someone typing "192.168.1.20" or "203.0.113.5" shouldn't need to know the
 * scheme or port. When they typed neither, try HTTPS first, then — for a
 * home-network address only — plain http on 80 and on 5550 (the installer's
 * --lan port). An explicit scheme or port is used as typed. Resolves to the
 * first origin that answers as a Zekktris server, or a message.
 */
export async function findServer(
  input: string,
): Promise<{ ok: true; origin: string } | { ok: false; error: string }> {
  const n = normalizeServerUrl(input);
  if (!n.ok) return n;
  // The built-in server is always fine — no need to probe it.
  if (n.origin === 'https://zekktris.com' || n.origin === 'https://www.zekktris.com') {
    return { ok: true, origin: 'https://zekktris.com' };
  }
  const u = new URL(n.origin);
  const explicit = input.includes('://') || u.port !== '';
  const candidates = [n.origin];
  if (!explicit && isLocalHost(u.hostname)) {
    candidates.push(`http://${u.host}`, `http://${u.host}:5550`);
  }
  let firstError: string | null = null;
  for (const origin of candidates) {
    const failure = await probeServer(origin);
    if (!failure) return { ok: true, origin };
    firstError ??= failure;
  }
  return { ok: false, error: firstError ?? "Couldn't reach that server." };
}
