/**
 * Gateway client (browser)
 * ------------------------
 * Wraps a single WebSocket connection. Handles HELLO → IDENTIFY → READY,
 * sends HEARTBEAT at the interval the server tells us in HELLO, listens for
 * dispatch events, and reconnects with exponential backoff on disconnect.
 *
 * The class is small and stateful by design — one client per app session.
 * It emits high-level events via `on(name, handler)`; consumers don't need
 * to know about op codes or frame envelopes.
 *
 * Reconnect policy: on close, wait `backoff` ms then re-open. Backoff starts
 * at 1s and doubles up to 30s. Jitter is added so a server restart doesn't
 * thunder-herd. On a successful CONNECT the backoff resets to 1s.
 *
 * Token handling: token is read fresh on each (re)connect via `getToken()`,
 * not captured at construction. That way a refresh flow can rotate the
 * access token without restarting the client.
 */

import {
  GatewayOp,
  type GatewayEventName,
  type GatewayFrame,
} from './types';

type Handler = (data: unknown) => void;

export interface GatewayClientOptions {
  url: string;
  getToken(): string | null;
  /** Where we get our WebSocket constructor from. Browser uses globalThis.WebSocket. */
  WebSocket?: typeof WebSocket;
  /** Optional logger for debugging. Defaults to no-op. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export type ConnectionStatus =
  | 'idle'           // never connected
  | 'connecting'     // socket open in progress
  | 'identifying'    // HELLO received, IDENTIFY sent, waiting for READY
  | 'ready'          // READY received; live
  | 'reconnecting'   // closed; waiting before next attempt
  | 'closed';        // intentionally stopped (won't reconnect)

const MAX_BACKOFF_MS = 30_000;
/**
 * Heartbeat-ack watchdog. When we send a HEARTBEAT, we expect a
 * HEARTBEAT_ACK back within this window. If not, the WS is a zombie
 * (silent suspension on iOS, server unreachable, network blip with
 * no close event) and we tear down + reconnect. Tuned to be longer
 * than typical RTT but shorter than the heartbeat interval (30s) so
 * a zombie connection is caught well before the next heartbeat would
 * normally fire.
 */
const HEARTBEAT_ACK_TIMEOUT_MS = 10_000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Watchdog that fires if a HEARTBEAT we sent doesn't get acked
   * within HEARTBEAT_ACK_TIMEOUT_MS. Indicates the WS is a zombie
   * (server unreachable, or browser-level pause that didn't surface
   * as a close event). On fire, we tear down and reconnect.
   */
  private ackWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** ms to wait before next reconnect attempt. Reset to 1000 on success. */
  private backoff = 1000;
  /** Handlers per event name. */
  private handlers = new Map<string, Set<Handler>>();
  /** Status change subscribers. */
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private lastSeq: number | null = null;
  /**
   * Logical session id from the last READY/RESUMED. Persisted across socket
   * drops so a reconnect can attempt RESUME; cleared on intentional stop or
   * when the server rejects a resume. Null → we IDENTIFY fresh.
   */
  private sessionId: string | null = null;
  /** True between sending RESUME and getting RESUMED/INVALID_SESSION — lets us
   *  distinguish "resume rejected (fall back to IDENTIFY)" from "IDENTIFY
   *  failed (fatal)". */
  private resuming = false;
  private intentionallyClosed = false;

  constructor(private opts: GatewayClientOptions) {}

  // ── Public API ──────────────────────────────────────────────────────────

  start(): void {
    this.intentionallyClosed = false;
    this.connect();
  }

  /** Stop reconnecting and close the current socket if any. Idempotent. */
  stop(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'client stopping');
      } catch {
        // already closed; nothing to do
      }
      this.ws = null;
    }
    // Intentional stop ends the logical session — the next start() IDENTIFYs
    // fresh rather than trying to resume a session we deliberately left.
    this.sessionId = null;
    this.lastSeq = null;
    this.resuming = false;
    this.setStatus('closed');
  }

  /**
   * Force an immediate reconnect, bypassing the normal backoff. Used
   * when the host knows network or visibility just changed in our
   * favor (e.g. tab went from hidden to visible) and we want to
   * shortcut the exponential-backoff wait. ALWAYS reconnects — even
   * if `status` looks healthy. iOS Safari suspends WebSockets when a
   * tab is backgrounded WITHOUT firing a close event; the client
   * thinks it's still 'ready' but the underlying socket is dead.
   * Tearing down + reconnecting on visibility change is the only
   * reliable way to recover from those silent zombies.
   */
  forceReconnect(): void {
    if (this.intentionallyClosed) return;
    // Cancel any pending reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Clear any pending heartbeat-ack watchdog.
    if (this.ackWatchdogTimer) {
      clearTimeout(this.ackWatchdogTimer);
      this.ackWatchdogTimer = null;
    }
    // Reset backoff so the next attempt's outcome is fresh.
    this.backoff = 1000;
    // Tear down any existing socket. Even if it's "open" by readyState,
    // it might be a zombie — the new connect() replaces it cleanly.
    if (this.ws) {
      try {
        this.ws.close(4000, 'force reconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    // Stop the existing heartbeat timer; the new connection's HELLO
    // will start a fresh one.
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.connect();
  }

  /** Subscribe to a dispatch event. Returns an unsubscribe function. */
  on<T = unknown>(event: GatewayEventName | 'READY' | 'RESUMED', handler: (data: T) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatus(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status); // emit current status synchronously for late subscribers
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  private connect(): void {
    if (this.intentionallyClosed) return;
    const Ctor = this.opts.WebSocket ?? globalThis.WebSocket;
    if (!Ctor) {
      this.log('error', 'no WebSocket implementation');
      return;
    }

    this.setStatus('connecting');
    // A fresh socket; the resume decision is made when HELLO arrives.
    this.resuming = false;
    let ws: WebSocket;
    try {
      ws = new Ctor(this.opts.url);
    } catch (err) {
      this.log('warn', 'WebSocket constructor threw', { err: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.log('debug', 'gateway: socket open');
      // Wait for HELLO before doing anything else.
    });

    ws.addEventListener('message', (ev) => {
      this.handleFrame(ev.data);
    });

    ws.addEventListener('close', (ev) => {
      this.log('debug', 'gateway: socket closed', { code: ev.code, reason: ev.reason });
      this.cleanupSocket();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    ws.addEventListener('error', (ev) => {
      this.log('warn', 'gateway: socket error', { ev });
      // 'close' will follow; reconnect logic lives there.
    });
  }

  private cleanupSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    this.setStatus('reconnecting');
    const delay = Math.min(MAX_BACKOFF_MS, this.backoff) + Math.floor(Math.random() * 500);
    this.log('debug', `gateway: reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
      this.connect();
    }, delay);
  }

  // ── Frame handling ──────────────────────────────────────────────────────

  private handleFrame(raw: unknown): void {
    let frame: GatewayFrame;
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      this.log('warn', 'gateway: malformed frame');
      return;
    }
    if (typeof frame.s === 'number') this.lastSeq = frame.s;

    switch (frame.op) {
      case GatewayOp.HELLO: {
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30_000;
        this.startHeartbeat(interval);
        // If we have a prior session + seq, try to RESUME (replay the events
        // we missed) before falling back to a full IDENTIFY. Transparent: a
        // server that can't resume sends INVALID_SESSION and we IDENTIFY.
        if (this.canResume()) this.sendResume();
        else this.sendIdentify();
        return;
      }
      case GatewayOp.HEARTBEAT_ACK:
        // Ack received; clear the zombie-detection watchdog. Server
        // is alive and we can trust this socket until the next round.
        if (this.ackWatchdogTimer) {
          clearTimeout(this.ackWatchdogTimer);
          this.ackWatchdogTimer = null;
        }
        return;
      case GatewayOp.INVALID_SESSION:
        if (this.resuming) {
          // Our RESUME couldn't be satisfied (gap too large, unknown/expired
          // session, or a different node). Fall back to a fresh IDENTIFY on
          // this same open socket — fully transparent; the host's READY
          // handler does its usual reconnect resync.
          this.log('info', 'gateway: resume rejected, falling back to IDENTIFY');
          this.resuming = false;
          this.sessionId = null;
          this.lastSeq = null;
          this.sendIdentify();
          return;
        }
        // IDENTIFY itself was rejected — token bad or session revoked. Fatal:
        // don't auto-retry; tell the host.
        this.log('warn', 'gateway: INVALID_SESSION');
        this.intentionallyClosed = true;
        this.setStatus('closed');
        this.emit('INVALID_SESSION', frame.d);
        return;
      case GatewayOp.DISPATCH: {
        if (!frame.t) return;
        // READY (fresh identify) or RESUMED (replay caught us up) both mean
        // the connection is live; reset backoff and capture the session id so
        // the NEXT reconnect can attempt a resume.
        if (frame.t === 'READY' || frame.t === 'RESUMED') {
          this.backoff = 1000;
          this.resuming = false;
          const sid = (frame.d as { session_id?: string } | undefined)?.session_id;
          if (typeof sid === 'string') this.sessionId = sid;
          this.setStatus('ready');
        }
        this.emit(frame.t, frame.d);
        return;
      }
      default:
        this.log('debug', `gateway: ignoring op ${frame.op}`);
    }
  }

  /** Whether we hold enough state to attempt a RESUME on this connection. */
  private canResume(): boolean {
    return this.sessionId !== null && this.lastSeq !== null;
  }

  private sendResume(): void {
    const token = this.opts.getToken();
    if (!token || this.sessionId === null || this.lastSeq === null) {
      // No token or nothing to resume from — IDENTIFY instead.
      this.sendIdentify();
      return;
    }
    this.resuming = true;
    this.setStatus('identifying');
    this.send({
      op: GatewayOp.RESUME,
      d: { token, session_id: this.sessionId, seq: this.lastSeq },
    });
  }

  private sendIdentify(): void {
    const token = this.opts.getToken();
    if (!token) {
      this.log('warn', 'gateway: no token at IDENTIFY time');
      this.stop();
      return;
    }
    this.resuming = false;
    this.setStatus('identifying');
    this.send({
      op: GatewayOp.IDENTIFY,
      d: {
        token,
        properties: {
          os: detectOS(),
          browser: detectBrowser(),
          device: 'web',
        },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Send first heartbeat at a random offset 0..interval so multiple clients
    // don't synchronize on reconnect storms.
    const initialDelay = Math.floor(Math.random() * intervalMs);
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
        this.sendHeartbeat();
      }, intervalMs);
    }, initialDelay);
  }

  /**
   * Send a heartbeat and arm the ack watchdog. If the watchdog fires
   * before HEARTBEAT_ACK arrives, we treat the connection as a
   * zombie and force-reconnect. The previous watchdog (if any) is
   * cleared first — only one in flight at a time, so a quick
   * sequence of heartbeats doesn't accumulate timers.
   */
  private sendHeartbeat(): void {
    this.send({ op: GatewayOp.HEARTBEAT, d: { seq: this.lastSeq } });
    if (this.ackWatchdogTimer) clearTimeout(this.ackWatchdogTimer);
    this.ackWatchdogTimer = setTimeout(() => {
      this.ackWatchdogTimer = null;
      this.log('warn', 'gateway: heartbeat ack timeout, reconnecting');
      // Force-reconnect — old socket is dead even though we never got
      // a close event. Trying to send anything else on it would fail
      // silently.
      this.forceReconnect();
    }, HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private send(frame: GatewayFrame): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log('warn', 'gateway: send failed', { err: (err as Error).message });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of this.statusHandlers) {
      try {
        h(s);
      } catch {
        // status subscriber errors are not fatal
      }
    }
  }

  private emit(name: string, data: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        h(data);
      } catch (err) {
        this.log('error', `handler for ${name} threw`, { err: (err as Error).message });
      }
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
    if (this.opts.log) this.opts.log(level, msg, meta);
  }
}

// ── Browser fingerprint helpers (best-effort, never required) ──────────────

function detectOS(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os')) return 'mac';
  if (ua.includes('linux')) return 'linux';
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  return 'unknown';
}

function detectBrowser(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';
  return 'unknown';
}
