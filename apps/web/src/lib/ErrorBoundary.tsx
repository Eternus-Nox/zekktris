/**
 * ErrorBoundary
 * -------------
 * Generic React error boundary. Renders a minimal "something broke"
 * fallback when a descendant throws during render or in an effect's
 * commit phase. Without this, any uncaught render error tears down
 * the entire React tree above to the root, manifesting as a blank
 * grey screen — which is what users see when they don't yet have
 * dev tools open to inspect the actual exception.
 *
 * The boundary is intentionally minimal: there's no retry button or
 * session reload, just a small notice with the error message. Apps
 * that want richer recovery (route-level reset, "report this bug")
 * should wrap their own boundaries; this one is the safety net for
 * leaf components like MessageItem.
 *
 * Chunk-load recovery
 * -------------------
 * Lazy routes and modals (see the React.lazy call sites + vite.config)
 * are split into content-hashed chunks. After a deploy, a browser tab
 * still running the PREVIOUS build holds references to old chunk hashes
 * that no longer exist on the server, so the next dynamic import rejects
 * with a "failed to fetch dynamically imported module" error. That's not
 * a code bug — it's a stale client. This boundary recognises those
 * specific errors and reloads once to pull the fresh assets, guarded by
 * a short sessionStorage window so a genuinely persistent failure (the
 * user is offline, or a CDN outage) shows a calm "reload" notice instead
 * of looping. Because every lazy boundary in the app ultimately bubbles
 * to one of these boundaries (per-view in Shell, plus the top-level one
 * in App), this single class covers all of them.
 *
 * Class component because hook-equivalent error boundaries don't exist
 * in React yet.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Recognise the dynamic-import failures browsers throw when a lazy chunk's
 * URL 404s (a deploy replaced it) or the network drops mid-fetch. The exact
 * message differs by engine (Chrome/Firefox/Safari) and bundler, so match the
 * known union rather than a single string.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    error.name === 'ChunkLoadError' ||
    msg.includes('dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('loading chunk ') ||
    msg.includes('loading css chunk ')
  );
}

const RELOAD_GUARD_KEY = 'zk:chunk-reload-at';
const RELOAD_GUARD_MS = 10_000;

/**
 * Reload once to fetch fresh assets after a stale-chunk error. Guards against a
 * reload loop: if we already reloaded within RELOAD_GUARD_MS (i.e. the failure
 * is persistent, not a one-off stale deploy), it suppresses the reload so the
 * caller can show a manual-refresh notice instead. sessionStorage survives a
 * reload within the same tab but clears when the tab closes, which is exactly
 * the lifetime we want for the guard. Returns true if a reload was triggered.
 */
function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0');
    if (Number.isFinite(last) && Date.now() - last <= RELOAD_GUARD_MS) {
      return false; // reloaded very recently — don't loop on a persistent failure
    }
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Storage unavailable (rare: locked-down private mode). Without it we can't
    // guard against a loop across reloads, so don't auto-reload — fall through
    // to the notice whose manual "Reload" button is the safe escape hatch.
    return false;
  }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
  /** Optional override for the fallback. When provided, receives the
      error so callers can render a custom panel. Not used for chunk-load
      errors, which always render the recovery notice. */
  fallback?: (error: Error) => ReactNode;
  /** Optional callback fired on every (non-chunk) catch. Useful for telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  /** True when `error` is a lazy-chunk load failure (stale deploy / network).
      We recover by reloading rather than showing the red crash panel. */
  chunkError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, chunkError: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, chunkError: isChunkLoadError(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isChunkLoadError(error)) {
      // Expected stale-client event, not a bug: reload for fresh assets
      // (loop-guarded). No console.error/onError — keep it out of crash
      // telemetry. render() shows a calm notice for the frame before reload,
      // or permanently if the guard suppressed the reload.
      reloadForStaleChunk();
      return;
    }
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught:', error, info);
    this.props.onError?.(error, info);
  }

  reset = () => {
    this.setState({ error: null, chunkError: false });
  };

  override render(): ReactNode {
    const { error, chunkError } = this.state;
    if (error) {
      if (chunkError) {
        // Either a reload is imminent (fired in componentDidCatch), or the
        // loop-guard suppressed it and the user must refresh manually. Either
        // way show a calm update notice — never the red crash panel, since
        // this isn't a code fault.
        return (
          <div className="p-4 m-2 rounded-md bg-bg-2 border border-line text-sm flex flex-col items-start gap-2">
            <div className="font-semibold text-ink-1">A new version is available</div>
            <div className="text-ink-2 text-xs">Reloading to get the latest update…</div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1 rounded text-xs bg-accent text-white hover:opacity-90"
            >
              Reload now
            </button>
          </div>
        );
      }
      if (this.props.fallback) return this.props.fallback(error);
      return (
        <div className="p-4 m-2 rounded-md bg-red-500/10 border border-red-500/40 text-sm">
          <div className="font-semibold text-red-300 mb-1">Something broke rendering this view.</div>
          <div className="text-ink-2 text-xs font-mono break-all">
            {error.message || 'Unknown error'}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="mt-2 px-3 py-1 rounded text-xs bg-bg-3 hover:bg-bg-3/80 text-ink-1"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
