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
    that it's a Zekktris server. Resolves to the origin that answered, which
    differs from `origin` when the server redirects (apex → www, http →
    https): the app window may only stay on the origin it is told, so it must
    be told the one that serves the app. Else resolves to a message. */
export async function probeServer(
  origin: string,
): Promise<{ ok: true; origin: string } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/api/v1/instance/info`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { software?: string } | null;
    if (res.ok && body?.software === 'zekktris') return answeredFrom(res.url || origin);
    // A Zekktris server older than /instance/info (zekktris.com until it's
    // redeployed, or a self-hosted one not updated yet) still answers its
    // health check with this shape.
    const healthRes = await fetch(`${origin}/health`, { signal: ctrl.signal }).catch(() => null);
    const health = (healthRes?.ok ? await healthRes.json().catch(() => null) : null) as {
      status?: string;
      uptimeSeconds?: number;
    } | null;
    if (healthRes && health?.status === 'ok' && typeof health.uptimeSeconds === 'number') {
      return answeredFrom(healthRes.url || origin);
    }
    return { ok: false, error: "Something answered at that address, but it isn't a Zekktris server." };
  } catch (err) {
    const msg = String((err as { cause?: { code?: string } })?.cause?.code ?? err);
    if (/WRONG_VERSION_NUMBER|EPROTO/i.test(msg)) {
      return {
        ok: false,
        error:
          "That address doesn't use HTTPS. If the server is on your home network, type it with http:// in front.",
      };
    }
    if (/CERT|SSL|TLS/i.test(msg)) {
      return {
        ok: false,
        error: "That server's HTTPS certificate isn't valid. Its owner needs to finish setting up HTTPS.",
      };
    }
    return {
      ok: false,
      error: "Couldn't reach that server. Check the address, and that the server is running.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The origin a probe was answered from, held to the same rules as a typed
    address (a redirect to plain http on the public internet is refused). */
export function answeredFrom(
  url: string,
): { ok: true; origin: string } | { ok: false; error: string } {
  const n = normalizeServerUrl(url);
  return n.ok ? n : { ok: false, error: "That server redirects to an address the app can't use." };
}

/**
 * Someone typing "192.168.1.20" or "203.0.113.5" shouldn't need to know the
 * scheme or port. Without a typed scheme, try HTTPS first, then — for a
 * home-network address only — plain http (on the typed port, or on 80 and
 * 5550, the installer's --lan port). A typed scheme is used as is. Resolves to the
 * origin of the first candidate that answers as a Zekktris server (after its
 * redirects, see probeServer), or a message.
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
  // Only a typed scheme is final. A home-network address typed with a port
  // but no scheme ("192.168.1.20:5550") still falls back to http.
  const candidates = [n.origin];
  if (!input.includes('://') && isLocalHost(u.hostname)) {
    if (u.port) candidates.push(`http://${u.host}`);
    else candidates.push(`http://${u.host}`, `http://${u.host}:5550`);
  }
  let firstError: string | null = null;
  for (const origin of candidates) {
    const probed = await probeServer(origin);
    if (probed.ok) return probed;
    firstError ??= probed.error;
  }
  return { ok: false, error: firstError ?? "Couldn't reach that server." };
}

/**
 * Whether the saved server `from` redirecting the app to `to` is the same
 * server at a new address the app may follow by itself: the same host moved
 * to https (a LAN server that turned TLS on), or its www / apex twin. Anything
 * else — another host — is the user's call (main.ts asks in the server
 * picker). The caller still probes `to` before switching.
 */
export function isServerMove(from: string, to: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (a.origin === b.origin) return false;
  if (b.protocol !== 'https:' && b.protocol !== a.protocol) return false;
  if (!normalizeServerUrl(b.origin).ok) return false;
  const bare = (h: string) => h.replace(/^www\./, '');
  return bare(a.hostname) === bare(b.hostname);
}
