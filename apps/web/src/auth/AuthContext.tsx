/**
 * Auth context
 * ------------
 * Owns the access token and the singletons that depend on it (REST client,
 * gateway client). The token lives in localStorage so a hard refresh keeps
 * the user logged in until the token expires; on expiry the next REST call
 * throws ApiError(401) and the host clears state.
 *
 * Why singletons-in-context rather than per-render fresh clients:
 * the gateway client carries a live WebSocket and reconnect timer; we
 * absolutely don't want to recreate it on every render. The REST client
 * reads the current token via a getter, so it doesn't need to be recreated
 * when the token rotates either.
 *
 * Note: This context is the only file that should touch localStorage. The
 * rest of the app reads `useAuth().token` if needed, never the storage.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, GatewayClient, RestClient, type AuthSession, type SelfUser } from '@zekktris/client';
import { clearDecryptedMediaCache } from '../lib/e2ee';
import { setMonetization, setUserTier } from '../lib/voice';

const TOKEN_STORAGE_KEY = 'zekktris.accessToken';
const USER_STORAGE_KEY = 'zekktris.user';

/**
 * Backoff for the boot /users/@me hydration: 1s, doubling to a 30s ceiling,
 * and it never stops while the tab is open and we still hold a token. This is
 * a reconnect path, not a give-up path — the failures it exists for (app
 * launched before the network is up, api mid-restart, laptop waking on a
 * train) resolve on their own, and the old behaviour of wiping the session on
 * the first failed attempt turned every one of them into a re-login.
 */
const BOOT_HYDRATE_FIRST_RETRY_MS = 1_000;
const BOOT_HYDRATE_MAX_RETRY_MS = 30_000;
/**
 * How many boot hydrations may fail before we stop and show something the user
 * can act on — but ONLY in the case where the retry loop is all there is on
 * screen (a token, no cached user, so the app is sitting on the boot loader).
 * Six attempts at 1/2/4/8/16 s is a bit over half a minute of silent retrying,
 * which comfortably covers a deploy or a laptop waking up; past that, a spinner
 * with no message and no escape is not a state to leave someone in. With a
 * cached user the app is already rendered and the loop is a harmless background
 * refresh, so it is not capped.
 */
const BOOT_HYDRATE_MAX_ATTEMPTS = 6;

interface AuthState {
  /** Null when logged out. */
  token: string | null;
  /** Null until /users/@me hydrates. */
  user: SelfUser | null;
  /** True until the initial token-validate /users/@me call resolves. */
  hydrating: boolean;
}

interface AuthContextValue extends AuthState {
  rest: RestClient;
  gateway: GatewayClient;
  login: (email: string, password: string, code?: string) => Promise<void>;
  /** Sign in with a passkey (WebAuthn). Runs the discoverable-credential
      ceremony then mints a session like a password login. */
  loginWithPasskey: () => Promise<void>;
  /**
   * Install a session this device obtained WITHOUT a local credential — today
   * only the device-approval flow, where an already-signed-in device approved
   * this one and the poll response carried the tokens back.
   *
   * Synchronous and side-effect-free on purpose: the server delivers the
   * approved grant EXACTLY ONCE (it is consumed with GETDEL), so the poller
   * must be able to bank it the instant it arrives. Anything that could throw
   * or await between receiving and persisting risks dropping a session that
   * cannot be re-fetched.
   */
  adoptDeviceSession: (session: AuthSession) => void;
  register: (input: { email: string; username: string; displayName: string; password: string; dateOfBirth: string; code?: string }) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Patch the local SelfUser snapshot. Call after a settings save so the
   * UI reflects the new profile immediately, without waiting for the next
   * /users/@me hydration. Persists to localStorage so a hard refresh
   * preserves the change.
   */
  updateUser: (patch: Partial<SelfUser>) => void;
  /** True when this deployment requires a verified email to proceed. */
  emailVerificationRequired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // The token is held in a ref AND in state. The ref is read by the REST/
  // gateway clients on every request — synchronously, no React re-render
  // needed. The state copy is what triggers UI updates.
  const tokenRef = useRef<string | null>(safeGet(TOKEN_STORAGE_KEY));
  const [state, setState] = useState<AuthState>(() => ({
    token: tokenRef.current,
    user: parseStoredUser(),
    hydrating: tokenRef.current !== null,
  }));
  // Boot hydration gave up with nothing to render — see BOOT_HYDRATE_MAX_ATTEMPTS.
  const [stalled, setStalled] = useState(false);
  // Bumping this restarts the hydration effect from a clean ladder ("Try again").
  const [hydrateAttempt, setHydrateAttempt] = useState(0);
  // Read inside the hydration ladder's async catch, where `state` would be a
  // stale closure. Mirrors "do we have anything to render?".
  const hasUserRef = useRef<boolean>(state.user !== null);
  useEffect(() => {
    hasUserRef.current = state.user !== null;
  }, [state.user]);

  // ── Singletons ────────────────────────────────────────────────────────
  // Created once. The token getter closure reads tokenRef so token rotation
  // works without recreating the clients. The refresh callbacks let the
  // REST client transparently keep the user logged in across access-token
  // expiries — without these, a 15-minute idle would log them out.
  const rest = useMemo(
    () =>
      new RestClient({
        baseUrl: '/api/v1',
        getToken: () => tokenRef.current,
        onTokenRefreshed: (next) => {
          // Store the new access token in both the ref (so subsequent
          // requests use it immediately) and localStorage (so a hard
          // refresh keeps the session). State.token is bumped too so
          // any consumer using it for keys re-renders.
          tokenRef.current = next;
          safeSet(TOKEN_STORAGE_KEY, next);
          setState((s) => ({ ...s, token: next }));
        },
        onRefreshFailed: () => {
          // Refresh token is gone or invalid. Clear local state so the
          // app drops to the login screen on the next render. We use
          // the same path the explicit logout takes — wipe storage,
          // null out state — so behavior is identical regardless of
          // whether the user signed out or the session expired.
          tokenRef.current = null;
          safeRemove(TOKEN_STORAGE_KEY);
          safeRemove(USER_STORAGE_KEY);
          // Session ended — drop decrypted E2EE media blobs so plaintext
          // doesn't outlive the session in this (non-reloading) SPA.
          clearDecryptedMediaCache();
          setState({ token: null, user: null, hydrating: false });
        },
      }),
    [],
  );

  const gateway = useMemo(
    () =>
      new GatewayClient({
        url: gatewayUrl(),
        getToken: () => tokenRef.current,
        // Light dev-only logging; production builds should keep this quiet.
        log: import.meta.env.DEV ? (lvl, msg, meta) => console[lvl === 'error' ? 'error' : 'log'](`[gw] ${msg}`, meta ?? '') : undefined,
      }),
    [],
  );

  // ── Token mutators ────────────────────────────────────────────────────

  const setToken = useCallback((token: string | null, user: SelfUser | null) => {
    tokenRef.current = token;
    if (token) {
      safeSet(TOKEN_STORAGE_KEY, token);
    } else {
      safeRemove(TOKEN_STORAGE_KEY);
    }
    if (user) {
      safeSet(USER_STORAGE_KEY, JSON.stringify(user));
    } else {
      safeRemove(USER_STORAGE_KEY);
    }
    setState({ token, user, hydrating: false });
  }, []);

  // ── Boot: validate stored token on mount ──────────────────────────────

  // Whether this deployment enforces email verification. Fetched once
  // (it's a global server setting). Drives the verify-email gate.
  const [emailVerificationRequired, setEmailVerificationRequired] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rest
      .emailVerificationRequired()
      .then((r) => !cancelled && setEmailVerificationRequired(r.required))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rest]);

  useEffect(() => {
    if (!tokenRef.current) {
      setState((s) => (s.hydrating ? { ...s, hydrating: false } : s));
      return;
    }
    setStalled(false);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = BOOT_HYDRATE_FIRST_RETRY_MS;
    let attempts = 0;

    // Boot hydration is RETRIED, not fatal. Who is allowed to end the session
    // is the whole point here:
    //
    //  - A 403 is a definitive rejection of this identity (banned, deleted) —
    //    no token refresh can fix it, so we clear.
    //  - A 401 is NOT ours to act on. The REST client already tried to refresh
    //    behind this call; if the refresh token was genuinely dead it answered
    //    401/403, onRefreshFailed fired, and our credentials are already gone
    //    (tokenRef is null) — nothing left to do. If the refresh merely
    //    couldn't complete (offline, 5xx, another tab won the rotation race)
    //    we still hold a perfectly good refresh token and must keep it.
    //  - Everything else — ApiError(0, 'NETWORK'), a proxy's 502, a timeout —
    //    says nothing at all about the session. This catch used to treat all
    //    of them as "token is invalid" and wipe, which is why opening the
    //    desktop app at login (before the network stack is up) or reloading
    //    during a deploy dropped people on the login screen.
    const hydrate = () => {
      rest
        .getMe()
        .then((r) => {
          if (cancelled) return;
          setToken(tokenRef.current, r.user);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 403) {
            setToken(null, null);
            return;
          }
          // The refresh path already decided the session was over and cleared
          // everything; stop retrying into a logged-out state.
          if (!tokenRef.current) return;
          // Transient. If we have a cached user we can render the app right
          // now on last-known state rather than sitting on the boot loader —
          // and keep re-hydrating in the background. With no cached user
          // there's nothing to draw, so we stay on the loader until the
          // network comes back (leaving `hydrating` true also keeps the login
          // route from bouncing us back and forth with a token in hand).
          //
          // The `s.hydrating` half of the guard matters: without it this
          // allocated a NEW state object on every single failed attempt even
          // once hydrating was already false, which changed the context value's
          // identity and re-rendered every useAuth() consumer in the app on
          // each rung of the ladder, for the whole outage.
          setState((s) => (s.user && s.hydrating ? { ...s, hydrating: false } : s));
          attempts += 1;
          // BOUNDED only while we are BLOCKING. With a cached user the app is
          // on screen and this is just a background refresh, so it keeps going
          // (giving up there would strand the UI on stale data until a manual
          // reload). With no cached user this loop IS the UI — an unbounded
          // ladder is a spinner with no message, no control, and no way to
          // reach the login screen. So after a bounded number of attempts we
          // stop and render a terminal state the user can act on.
          //
          // Why a state of our own rather than just flipping `hydrating` to
          // false: with a token in hand and no user, the app's auth gate sends
          // us to /login, and /login sends anyone holding a token straight back
          // — an infinite redirect. The terminal panel is rendered here instead,
          // above that whole routing question, and its "Sign in again" button
          // clears the token first so the bounce can't happen.
          if (!hasUserRef.current && attempts >= BOOT_HYDRATE_MAX_ATTEMPTS) {
            setStalled(true);
            return;
          }
          // ±50% jitter, for the same reason the REST client's refresh ladder
          // has it: tabs opened together would otherwise re-hydrate in
          // lockstep, and each of these calls can fan out into its own refresh
          // ladder underneath.
          timer = setTimeout(hydrate, Math.round(retryMs * (0.5 + Math.random())));
          retryMs = Math.min(retryMs * 2, BOOT_HYDRATE_MAX_RETRY_MS);
        });
    };
    hydrate();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rest, setToken, hydrateAttempt]);

  // ── Cross-tab auth sync ───────────────────────────────────────────────
  // The `storage` event fires only in OTHER tabs. If another tab logs out
  // (removes the token) we'd otherwise keep the stale in-memory tokenRef and
  // send it until a 401; clear it here instead. If another tab logs in /
  // rotates the token, adopt the fresh value so our requests use it (user
  // state reconciles on the next getMe/refresh).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== TOKEN_STORAGE_KEY) return;
      if (e.newValue === null) {
        if (tokenRef.current !== null) setToken(null, null);
      } else if (e.newValue !== tokenRef.current) {
        tokenRef.current = e.newValue;
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setToken]);

  // ── Gateway lifecycle: only run when authenticated ────────────────────

  // The socket must open on login, close on logout, and reconnect on a
  // genuine identity change — but NOT churn on profile/status/presence
  // field updates. updateUser() replaces state.user with a NEW object on
  // every such patch, so depending on state.user (or state.token, which
  // rotates on every ~15-min access-token refresh) would tear down and
  // reopen the WebSocket, dropping live events and forcing a full resync.
  // Gate on a STABLE key — the user id — instead. The gateway reads its
  // token fresh on each (re)connect via getToken(), so a token refresh
  // needs no reconnect; identity changes (login/logout/account switch)
  // flip the id and correctly recycle the connection.
  const gatewaySessionKey = gatewayLifecycleKey(state.user);

  useEffect(() => {
    if (!tokenRef.current || !gatewaySessionKey) return;
    gateway.start();

    // Wake-from-background: when iOS Safari (or any mobile browser)
    // backgrounds the tab, the WebSocket is suspended/closed without
    // notifying us. When the user returns we want to reconnect
    // IMMEDIATELY rather than waiting out the exponential backoff
    // (which can be up to 30s after a few attempts). visibilitychange
    // is the cheapest signal — fires synchronously when the tab
    // becomes visible again. We forceReconnect() instead of just
    // start() because the gateway may still be in 'reconnecting'
    // state with a pending timer; force resets that and tries now.
    // Deliberately forceReconnect() here, unlike the 'focus' handler below:
    // visibilitychange fires only on a REAL hide→show, where iOS Safari has
    // very likely already killed the socket silently. Reconnecting outright
    // gets the user's messages back immediately instead of costing a
    // heartbeat round trip first. It is also rare, so the teardown is cheap —
    // which is exactly what is NOT true of 'focus'.
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        gateway.forceReconnect();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    // visibilitychange alone is a DEAD SIGNAL on the desktop app. In Electron
    // an unfocused-but-visible window (the common case: Zekktris behind the
    // browser on a second monitor, or the machine waking from sleep with the
    // window still mapped) never fires it, so a zombie gateway socket sat
    // undetected until the ~40s heartbeat watchdog — or forever, since a socket
    // that dies while unfocused has nothing else to kick it. Meanwhile LiveKit
    // keeps its own connection alive and keeps delivering audio, which is
    // exactly how you end up hearing someone you cannot see.
    //
    // 'focus' fires reliably in Electron on window activation and after wake;
    // 'online' covers a dropped-then-restored network.
    //
    // ensureAlive(), NOT forceReconnect(): the latter ALWAYS closes the socket,
    // so wiring it to 'focus' made every alt-tab back into the app destroy a
    // healthy connection and pay a full HELLO/RESUME handshake — production
    // /gateway sockets were living ~25 s. ensureAlive probes with a HEARTBEAT
    // and only reconnects when the ack doesn't come back, which still catches
    // the zombie sockets this listener exists for.
    function onWake() {
      gateway.ensureAlive();
    }
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);

    // Fast disconnect on tab close: when the user closes the tab/app,
    // fire a synchronous beacon to the API so the server marks them
    // offline immediately rather than waiting out the 40-second
    // heartbeat timeout. sendBeacon is the only reliable way to send
    // a request from a closing page — fetch() with keepalive can drop
    // on iOS Safari. The endpoint accepts an empty body (just the
    // bearer cookie) and decrements this user's online connection
    // count, broadcasting offline if it hits zero.
    function onPageHide() {
      try {
        const url = '/api/v1/auth/disconnect-beacon';
        // sendBeacon doesn't carry our Bearer token — the server
        // accepts the refresh-token cookie (httpOnly, sent automatically)
        // as the auth signal for THIS endpoint only. We POST an empty
        // blob; sendBeacon requires a payload.
        navigator.sendBeacon(url, new Blob([''], { type: 'text/plain' }));
      } catch {
        // sendBeacon failures are best-effort; the heartbeat watchdog
        // is the fallback and will catch the disconnect within 40s.
      }
    }
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('pagehide', onPageHide);
      gateway.stop();
    };
  }, [gateway, gatewaySessionKey]);

  // ── Public methods ────────────────────────────────────────────────────

  const login = useCallback<AuthContextValue['login']>(
    async (email, password, code) => {
      const r = await rest.login({ email, password, code });
      setToken(r.accessToken, r.user);
    },
    [rest, setToken],
  );

  const loginWithPasskey = useCallback<AuthContextValue['loginWithPasskey']>(async () => {
    // Lazy-load the WebAuthn browser lib so it isn't in the main bundle.
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const { challengeId, options } = await rest.passkeyLoginOptions();
    const response = await startAuthentication({ optionsJSON: options as never });
    const r = await rest.passkeyLoginVerify({ challengeId, response });
    setToken(r.accessToken, r.user);
  }, [rest, setToken]);

  const adoptDeviceSession = useCallback<AuthContextValue['adoptDeviceSession']>(
    (session) => {
      setToken(session.accessToken, session.user);
    },
    [setToken],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (input) => {
      const r = await rest.register(input);
      setToken(r.accessToken, r.user);
    },
    [rest, setToken],
  );

  const logout = useCallback<AuthContextValue['logout']>(async () => {
    try {
      await rest.logout();
    } catch {
      // Logout on a dead token is fine; we proceed with local cleanup.
    }
    // Drop decrypted E2EE media blobs — the SPA doesn't reload on logout, so
    // plaintext would otherwise linger in memory for the page lifetime.
    clearDecryptedMediaCache();
    setToken(null, null);
  }, [rest, setToken]);

  const updateUser = useCallback<AuthContextValue['updateUser']>(
    (patch) => {
      setState((prev) => {
        if (!prev.user) return prev;
        const next = { ...prev.user, ...patch };
        // Persist so a hard refresh keeps the change. The token is
        // unchanged, so we don't touch it.
        safeSet(USER_STORAGE_KEY, JSON.stringify(next));
        return { ...prev, user: next };
      });
    },
    [],
  );

  // Premium-streaming entitlement: push the signed-in tier into the voice
  // lib, and fetch the instance's admin-configured monetization matrix
  // (which resolutions need which tier). This is the single chokepoint
  // every user change funnels through — login, getMe refresh, billing
  // success poll, admin gift — so the publish-time clamp in voice.ts
  // always reflects the current tier. Signed-out (null user) resets to
  // rank 0 (free) — fail closed.
  //
  // The config fetch is fire-and-forget: until/unless it succeeds the
  // voice lib keeps its baked-in defaults, which mirror the server's
  // defaults — so offline or against an older server the gate behaves
  // exactly like the old hardcoded one (2K = Guardian, 4K = Legend).
  useEffect(() => {
    setUserTier(state.user?.subscriptionTier ?? null);
    if (!state.user) return;
    rest
      .getMonetization()
      .then((r) => setMonetization(r.config))
      .catch(() => {
        // Keep the defaults — transient failure or a pre-monetization server.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // fields that should trigger a re-push/refetch, not the user object.
  }, [rest, state.user?.id, state.user?.subscriptionTier]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, rest, gateway, login, loginWithPasskey, adoptDeviceSession, register, logout, updateUser, emailVerificationRequired }),
    [state, rest, gateway, login, loginWithPasskey, adoptDeviceSession, register, logout, updateUser, emailVerificationRequired],
  );

  return (
    <AuthContext.Provider value={value}>
      {/* Terminal state for boot hydration. Reached only when we hold a token,
          have no cached user to render, and the ladder above ran out of
          attempts — i.e. exactly the case that used to be an unbounded spinner.
          Rendered here rather than handed to the app's auth gate because that
          gate sends a user-less token holder to /login and /login sends token
          holders back, which would loop; and because "keep hydrating" is this
          provider's job, not a screen's.

          It stands in for the whole tree, which in this state is only ever the
          boot loader. The one cost is that a public route (terms, privacy, a
          password reset) would also be covered for a token-holder in this
          state; "Sign in again" clears the token and restores normal routing,
          so it is recoverable rather than a dead end. */}
      {stalled && state.hydrating ? (
        <HydrationStalled
          onRetry={() => {
            setStalled(false);
            setHydrateAttempt((n) => n + 1);
          }}
          onSignOut={() => setToken(null, null)}
        />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

/**
 * "We couldn't reach the server" screen. Deliberately offers both a retry (the
 * failure is usually transient and the session is usually fine) and a way out
 * to the login screen (for when it isn't), because the state this replaces —
 * an indefinite spinner — offered neither.
 */
function HydrationStalled({
  onRetry,
  onSignOut,
}: {
  onRetry: () => void;
  onSignOut: () => void;
}) {
  // Auto-recover when the network comes back. By far the most common way to
  // reach this panel is an outage that outlasted the ladder — a laptop lid, a
  // tunnel, a captive portal, wi-fi handing over — and in every one of those the
  // machine knows the moment connectivity returns. Making the user click Try
  // again at that point is a manual step for something we were already told
  // about. `online` is edge-triggered and only fires on an offline→online
  // transition, so it cannot spin: while we are still offline nothing fires, and
  // one retry per reconnection is exactly one ladder.
  //
  // It is a supplement, not a replacement: `online` means "the OS has a link",
  // not "the server answers", so the button stays for the case where the link
  // was never the problem (server down, DNS, a proxy 502).
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  useEffect(() => {
    const onOnline = () => retryRef.current();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);
  return (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 sm:p-8 shadow-2xl text-center">
        <h1 className="text-xl font-semibold text-ink-1">Can&rsquo;t reach Zekktris</h1>
        <p className="text-sm text-ink-2 leading-relaxed mt-2">
          We couldn&rsquo;t load your account. This is usually a connection
          problem or the server restarting — your session is probably still
          fine.
        </p>
        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={onRetry}
            className="w-full px-4 py-2.5 rounded-lg bg-gradient-to-br from-accent to-accent-2 text-bg-0 font-semibold hover:brightness-110 transition-all"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="w-full px-4 py-2.5 rounded-lg border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 transition-colors text-sm"
          >
            Sign in again
          </button>
        </div>
      </div>
    </div>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * The gateway socket's lifecycle key. The lifecycle effect re-runs — i.e.
 * tears down and reopens the WebSocket — only when this value changes.
 *
 * Derived from the user's identity (id) alone, so it is STABLE across
 * profile / status / presence field updates (which replace the user object
 * but keep the same id) and across access-token rotation (which the gateway
 * absorbs via getToken() without a reconnect). It changes only on a genuine
 * identity transition: null→id (login), id→null (logout), id→id' (account
 * switch) — exactly the cases that legitimately need a fresh connection.
 *
 * Exported for unit testing; not part of the public auth surface.
 */
export function gatewayLifecycleKey(user: Pick<SelfUser, 'id'> | null): string | null {
  return user?.id ?? null;
}

function gatewayUrl(): string {
  // Same-origin WS URL. In dev Vite's proxy forwards /gateway to the API.
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/gateway`;
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}
function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function parseStoredUser(): SelfUser | null {
  const raw = safeGet(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SelfUser;
  } catch {
    return null;
  }
}
