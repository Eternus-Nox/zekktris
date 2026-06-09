/**
 * Gateway RESUME support
 * ----------------------
 * Per-session replay buffer + the bounds that make it safe.
 *
 * The buffer holds the exact JSON of DISPATCH frames we sent (or would have
 * sent) to one connection, each tagged with its sequence number. Because we
 * buffer what was ALREADY permission-filtered for that connection at fan-out
 * time, replay is inherently visibility-correct — we never re-filter, we just
 * re-send the same bytes in order.
 *
 * Lifecycle: a connection appends to its buffer on every DISPATCH. When the
 * socket drops, the connection becomes "detached" but stays in the registry's
 * fan-out indexes for a short window, so events that occur DURING the gap keep
 * being buffered (this is what RESUME actually recovers). On RESUME within the
 * window we replay the suffix the client missed; otherwise the client falls
 * back to a fresh IDENTIFY.
 *
 * Bounds (memory + correctness):
 *   - MAX_FRAMES   cap per buffer (ring — oldest dropped first)
 *   - MAX_AGE_MS   frames older than this are pruned (a long-idle resume can't
 *                  replay ancient state)
 *   - RESUME_WINDOW_MS  how long a detached session is retained for resume
 *                  before the registry evicts it
 */

/** Max buffered frames per session. A ring — appending past this drops the
 *  oldest, which makes that prefix un-resumable (client falls back). */
export const RESUME_MAX_FRAMES = 1024;

/** Frames older than this are pruned on append. Keeps a stale detached
 *  session from replaying minutes-old events. */
export const RESUME_MAX_AGE_MS = 3 * 60 * 1000;

/** How long the registry keeps a detached session around for a possible
 *  RESUME before evicting it (full cleanup). Comfortably covers a mobile
 *  network handoff / tab refocus; bounded so memory can't grow without end. */
export const RESUME_WINDOW_MS = 60 * 1000;

/** Global safety cap on retained detached sessions. Under a mass disconnect
 *  (LB drain, client deploy) this bounds total buffer memory; the oldest
 *  detached session is evicted when the cap is exceeded. */
export const RESUME_MAX_DETACHED_SESSIONS = 20_000;

interface BufferedFrame {
  seq: number;
  json: string;
  at: number;
}

export class ResumeBuffer {
  private frames: BufferedFrame[] = [];

  constructor(
    private readonly maxFrames = RESUME_MAX_FRAMES,
    private readonly maxAgeMs = RESUME_MAX_AGE_MS,
  ) {}

  /** Record a frame we sent (or buffered while detached). `now` is injected
   *  so tests are deterministic. Prunes by age and size. */
  append(seq: number, json: string, now: number): void {
    this.frames.push({ seq, json, at: now });
    // Prune by age from the front (frames are append-only ascending in time).
    const cutoff = now - this.maxAgeMs;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop]!.at < cutoff) drop++;
    // Prune by size.
    const overflow = this.frames.length - drop - this.maxFrames;
    if (overflow > 0) drop += overflow;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Lowest seq still retained, or null if empty. */
  get firstSeq(): number | null {
    return this.frames.length ? this.frames[0]!.seq : null;
  }

  /** Highest seq retained, or null if empty. */
  get lastSeq(): number | null {
    return this.frames.length ? this.frames[this.frames.length - 1]!.seq : null;
  }

  get size(): number {
    return this.frames.length;
  }

  /**
   * Whether a client that last saw `afterSeq` can be resumed, given the
   * connection's current seq (`connSeq`). Rules:
   *   - client ahead of us (afterSeq > connSeq)               → no (bogus)
   *   - client fully caught up (afterSeq === connSeq)         → yes (0 replay)
   *   - buffer rolled past what they need (afterSeq < first-1) → no (gap too large)
   *   - otherwise                                              → yes
   */
  canResume(afterSeq: number, connSeq: number): boolean {
    if (afterSeq > connSeq) return false;
    if (afterSeq === connSeq) return true;
    // Client is behind; we need frames after `afterSeq` to exist contiguously.
    const first = this.firstSeq;
    if (first === null) return false; // behind but we have nothing to replay
    return afterSeq >= first - 1;
  }

  /** The frames with seq strictly greater than `afterSeq`, in order. */
  framesAfter(afterSeq: number): string[] {
    const out: string[] = [];
    for (const f of this.frames) {
      if (f.seq > afterSeq) out.push(f.json);
    }
    return out;
  }
}
