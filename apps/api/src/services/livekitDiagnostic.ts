/**
 * LiveKit / voice diagnostic
 * --------------------------
 * Self-host's #1 gotcha is a misconfigured LiveKit SFU — wrong host/port,
 * unreachable signaling, or mismatched keys — and the symptom (calls that
 * never connect) is opaque. This runs an end-to-end check of the instance's
 * LiveKit config and reports a clear pass/fail per step with the specific
 * problem, so an operator can fix "voice doesn't work" without reading logs.
 *
 * Steps:
 *   1. credentials present (else: presence-only voice, which is a valid mode)
 *   2. browser signaling URL resolvable (what clients connect to)
 *   3. server can mint a join token (verifies the secret is usable)
 *   4. server can REACH LiveKit signaling + auth (RoomServiceClient.listRooms)
 *
 * NOTE on scope: step 4 proves the api→SFU control-plane path. It does NOT
 * prove that browser↔SFU **media** (UDP 7882) works — that depends on the
 * client's network and can't be tested server-side. The result says so.
 *
 * Never returns secrets — only config URLs (host:port, not credentials) and
 * high-level, classified error messages.
 */

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { env } from '../env';
import { browserLivekitWsUrl } from './voice';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface LivekitCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface LivekitDiagnostic {
  /** Whether LiveKit credentials are configured at all. */
  configured: boolean;
  /**
   * True iff every check that CAN run server-side passed (config, token
   * minting, api→SFU control plane). Deliberately NOT "voice works
   * end-to-end": browser↔SFU media (UDP 7882 / TCP 7881 + a routable
   * advertised IP) is untestable from the server and is the most common
   * real-world failure — the always-present `media_path` warn step keeps
   * that visible so a green control plane can't masquerade as working
   * audio.
   */
  ok: boolean;
  /** Browser-facing signaling URL (clients connect here). Config, not secret. */
  wsUrl: string | null;
  /** Server-facing admin/signaling URL the API uses. Config, not secret. */
  httpUrl: string | null;
  checks: LivekitCheck[];
  generatedAt: string;
}

/** Server-side admin/signaling URL. Mirrors the resolution voice.ts uses for
 *  RoomServiceClient: explicit LIVEKIT_HTTP_URL, else derive from the ws URL. */
function resolveHttpUrl(): string | null {
  if (env.LIVEKIT_HTTP_URL) return env.LIVEKIT_HTTP_URL;
  if (env.LIVEKIT_WS_URL) {
    return env.LIVEKIT_WS_URL.replace(/^wss?:/i, (m) =>
      m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
    );
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Map a raw RoomServiceClient error into clear operator guidance — without
 *  leaking secrets (the URL is config, the message is classified, not raw). */
function classifyError(err: unknown, httpUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';
  const lower = `${code} ${msg}`.toLowerCase();
  if (lower.includes('econnrefused')) {
    return `Connection refused at ${httpUrl} — the SFU isn't listening there. Check it's running and that LIVEKIT_HTTP_URL host/port are correct.`;
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return `Hostname in ${httpUrl} does not resolve. Fix LIVEKIT_HTTP_URL (in Docker the api reaches the bundled SFU at host.docker.internal:7880).`;
  }
  if (lower.includes('timed out') || lower.includes('etimedout')) {
    return `Timed out reaching ${httpUrl}. The host/port may be wrong or a firewall is blocking the control connection.`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid') || lower.includes('permission')) {
    return `LiveKit rejected the credentials — LIVEKIT_API_KEY / LIVEKIT_API_SECRET don't match the SFU's keys.`;
  }
  if (lower.includes('certificate') || lower.includes('self-signed') || lower.includes('ssl')) {
    return `TLS error reaching ${httpUrl}. Use a valid cert, or point LIVEKIT_HTTP_URL at the plain-HTTP control port.`;
  }
  // Generic fallback: include a trimmed message (no secrets in listRooms errors).
  return `Could not reach LiveKit at ${httpUrl}: ${msg.slice(0, 200)}`;
}

export async function diagnoseLivekit(): Promise<LivekitDiagnostic> {
  const checks: LivekitCheck[] = [];
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const wsUrl = browserLivekitWsUrl();
  const httpUrl = resolveHttpUrl();
  const now = () => new Date().toISOString();

  // 1. Credentials present.
  const haveKeys = !!apiKey && !!apiSecret;
  checks.push({
    id: 'credentials',
    label: 'API key & secret configured',
    status: haveKeys ? 'pass' : 'warn',
    detail: haveKeys
      ? 'LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set.'
      : 'Not set — voice runs in presence-only mode (you can see who is in a channel, but there is no audio/video). Set LIVEKIT_API_KEY / LIVEKIT_API_SECRET to enable calls.',
  });
  if (!haveKeys) {
    return { configured: false, ok: false, wsUrl, httpUrl, checks, generatedAt: now() };
  }

  // 2. Browser signaling URL resolvable.
  checks.push({
    id: 'ws_url',
    label: 'Browser signaling URL',
    status: wsUrl ? 'pass' : 'fail',
    detail: wsUrl
      ? `Clients connect to ${wsUrl}.`
      : 'Could not derive a client WebSocket URL — set LIVEKIT_WS_URL, or PUBLIC_URL (so the bundled SFU is reached at /livekit).',
  });

  // 3. Token minting (verifies the secret can sign join grants).
  let tokenOk = false;
  let tokenDetail = '';
  try {
    const at = new AccessToken(apiKey!, apiSecret!, { identity: 'zk-diagnostic', ttl: '1m' });
    at.addGrant({ roomJoin: true, room: 'zk-diagnostic' });
    const jwt = await at.toJwt();
    tokenOk = typeof jwt === 'string' && jwt.length > 0;
    tokenDetail = tokenOk ? 'Signed a join token successfully.' : 'Token minting returned an empty token.';
  } catch (e) {
    tokenDetail = `Failed to sign a token: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
  }
  checks.push({ id: 'token', label: 'Mint join token', status: tokenOk ? 'pass' : 'fail', detail: tokenDetail });

  // 4. Reach LiveKit signaling + auth (control-plane). This is the check that
  //    catches the #1 gotcha: api can't reach the SFU, or keys are wrong.
  let serverStatus: CheckStatus = 'fail';
  let serverDetail = '';
  if (!httpUrl) {
    serverDetail = 'No server URL — set LIVEKIT_HTTP_URL (or LIVEKIT_WS_URL) so the API can reach the SFU control API.';
  } else {
    try {
      const svc = new RoomServiceClient(httpUrl, apiKey!, apiSecret!);
      const rooms = await withTimeout(svc.listRooms(), 5000, 'LiveKit listRooms');
      serverStatus = 'pass';
      serverDetail = `Reached LiveKit at ${httpUrl}; credentials accepted (${rooms.length} active room${rooms.length === 1 ? '' : 's'}). Note: this verifies api→SFU signaling; browser↔SFU media still needs UDP 7882 reachable from clients.`;
    } catch (e) {
      serverDetail = classifyError(e, httpUrl);
    }
  }
  checks.push({ id: 'server', label: 'Reach LiveKit signaling + auth', status: serverStatus, detail: serverDetail });

  // 5. Media reachability — always-present and always 'warn', because the
  //    server CANNOT test it: WebRTC media flows browser↔SFU directly and
  //    its reachability depends on each client's network. This is the #1
  //    real-world voice failure ("connects but no audio" / endless
  //    reconnect), so the diagnostic must surface it explicitly instead of
  //    letting four green control-plane checks imply calls will work.
  checks.push({
    id: 'media_path',
    label: 'Media ports (cannot be tested server-side)',
    status: 'warn',
    detail:
      'Verify manually: UDP 7882 (media) and TCP 7881 (fallback) must be reachable from clients — open them in the host firewall and, behind NAT, forward both on the router. If remote users see "negotiation timed out" or connect with no audio, the SFU is likely advertising an unroutable/private IP: either let it STUN-discover the public IP (LIVEKIT_USE_EXTERNAL_IP=true, the default) or pin one via LIVEKIT_HOST with LIVEKIT_USE_EXTERNAL_IP=false. A quick end-to-end test is joining a voice channel from a phone on cellular (off the LAN).',
  });

  // 'warn' steps don't fail the diagnostic — they flag what couldn't be
  // verified. Only a hard 'fail' (bad config/creds/unreachable SFU) does.
  const ok = checks.every((c) => c.status !== 'fail');
  return { configured: true, ok, wsUrl, httpUrl, checks, generatedAt: now() };
}
