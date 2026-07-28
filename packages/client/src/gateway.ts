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
  /**
   * The pending random initial-delay timeout that startHeartbeat schedules
   * before the first heartbeat. Tracked so reconnects can cancel it: an
   * untracked one that outlived its socket would start a SECOND interval
   * alongside the new connection's — whichever assignment lost the
   * heartbeatTimer slot became an orphan that heartbeated forever and
   * could never be cleared (one leaked interval per fast reconnect).
   */
  private heartbeatStartTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Reused for binary frames — TextDecoder is stateless, so one instance
      avoids allocating a fresh decoder per ArrayBuffer message. */
  private readonly decoder = new TextDecoder();
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
    if (this.heartbeatStartTimer) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
    }
    if (this.ackWatchdogTimer) {
      clearTimeout(this.ackWatchdogTimer);
      this.ackWatchdogTimer = null;
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
  /**
   * Wake-from-idle check: verify the socket is actually alive, and only
   * reconnect if it isn't.
   *
   * Prefer this over [forceReconnect] for signals that fire on ordinary user
   * activity — window focus, network 'online' — because forceReconnect ALWAYS
   * tears the socket down. Wiring it to 'focus' meant every alt-tab back to
   * the app destroyed a healthy connection and paid a full HELLO/RESUME
   * handshake; production Caddy logs showed /gateway sockets living ~25 s.
   *
   * A zombie socket (iOS Safari suspending a backgrounded tab, a half-open TCP
   * after sleep) still looks OPEN by readyState, which is why the old code
   * reconnected unconditionally. But we already have a precise detector for
   * that: send a HEARTBEAT and let the existing ack watchdog force-reconnect
   * if no HEARTBEAT_ACK comes back. A live socket answers in a round trip and
   * is left alone; a dead one is torn down a few seconds later, which is far
   * sooner than the 30 s heartbeat interval would have noticed on its own.
   *
   * Use [forceReconnect] directly when you KNOW the connection is gone.
   */
  ensureAlive(): void {
    if (this.intentionallyClosed) return;
    // No socket, or one that is closing/closed: nothing to probe.
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      this.forceReconnect();
      return;
    }
    this.sendHeartbeat();
  }

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
    // Stop the existing heartbeat timers; the new connection's HELLO
    // will start fresh ones.
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatStartTimer) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
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

    // Every listener is guarded by `this.ws === ws`. A socket can be
    // SUPERSEDED while still settling: forceReconnect() closes the old socket
    // and opens a new one in the SAME tick, so the old socket's `close` (and a
    // racing new socket's `open`) can fire after `this.ws` already points at
    // the replacement. Without the guard, a superseded socket's `close` would
    // run cleanupSocket() — nulling the LIVE socket's reference — and schedule
    // another reconnect, orphaning sockets. Worse, if the new socket's `open`
    // lost the race it would RESUME on a stale reference and the server's
    // live-session takeover would ping-pong the orphans forever (~1s resume
    // storm). Ignoring non-current sockets makes replacement clean.
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return; // superseded before it opened
      this.log('debug', 'gateway: socket open');
      // Wait for HELLO before doing anything else.
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return; // frame from a superseded socket
      this.handleFrame(ev.data);
    });

    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) {
        // A superseded socket finally closed. forceReconnect() already tore
        // down its timers and started the replacement; touching state or
        // scheduling another reconnect here would clobber the live socket.
        this.log('debug', 'gateway: superseded socket closed', { code: ev.code });
        return;
      }
      this.log('debug', 'gateway: socket closed', { code: ev.code, reason: ev.reason });
      this.cleanupSocket();
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    ws.addEventListener('error', (ev) => {
      if (this.ws !== ws) return; // error on a superseded socket
      this.log('warn', 'gateway: socket error', { ev });
      // 'close' will follow; reconnect logic lives there.
    });
  }

  private cleanupSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatStartTimer) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
    }
    // A watchdog armed by a heartbeat on the dying socket must not fire
    // during the reconnect backoff — it would forceReconnect immediately,
    // resetting the backoff to 1s and defeating exponential backoff right
    // when the server is down (thundering-herd window), or tear down a
    // fresh healthy socket if the reconnect already succeeded.
    if (this.ackWatchdogTimer) {
      clearTimeout(this.ackWatchdogTimer);
      this.ackWatchdogTimer = null;
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
      const text = typeof raw === 'string' ? raw : this.decoder.decode(raw as ArrayBuffer);
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      this.log('warn', 'gateway: malformed frame');
      return;
    }

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
        // Only DISPATCH frames carry a sequence — advance lastSeq here, AFTER
        // the op is validated, so a malformed non-dispatch frame can't corrupt
        // the resume cursor.
        if (typeof frame.s === 'number') this.lastSeq = frame.s;
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
    if (this.heartbeatStartTimer) clearTimeout(this.heartbeatStartTimer);
    // Send first heartbeat at a random offset 0..interval so multiple clients
    // don't synchronize on reconnect storms.
    const initialDelay = Math.floor(Math.random() * intervalMs);
    this.heartbeatStartTimer = setTimeout(() => {
      this.heartbeatStartTimer = null;
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
      this.sendHeartbeat();
      // Defensive: never let two intervals exist, even if a stale
      // initial-delay timeout slipped through a reconnect.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
    // Scope the watchdog to THIS socket: if the socket is replaced (closed +
    // reconnected) before the watchdog fires, a late callback must NOT tear down
    // the healthy replacement and reset backoff (that's a reconnect storm).
    const ws = this.ws;
    this.send({ op: GatewayOp.HEARTBEAT, d: { seq: this.lastSeq } });
    if (this.ackWatchdogTimer) clearTimeout(this.ackWatchdogTimer);
    this.ackWatchdogTimer = setTimeout(() => {
      this.ackWatchdogTimer = null;
      if (this.ws !== ws) return; // stale watchdog from a since-replaced socket
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
    // Snapshot before iterating: a handler may unsubscribe itself/another
    // during dispatch, which would mutate the live Set mid-iteration and skip
    // handlers.
    for (const h of [...this.statusHandlers]) {
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
    // Snapshot before iterating (see setStatus) — a throwing handler whose
    // error path unsubscribes a not-yet-called handler would otherwise skip it.
    for (const h of [...set]) {
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
