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
import { GatewayClient, RestClient, type SelfUser } from '@zekktris/client';
import { clearDecryptedMediaCache } from '../lib/e2ee';
import { setMonetization, setUserTier } from '../lib/voice';

const TOKEN_STORAGE_KEY = 'zekktris.accessToken';
const USER_STORAGE_KEY = 'zekktris.user';

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
  /** Sign in by redeeming a quick-login code shown on another (logged-in)
      device. Mints a session exactly like a password login. */
  loginWithDeviceCode: (code: string) => Promise<void>;
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
      setState((s) => ({ ...s, hydrating: false }));
      return;
    }
    let cancelled = false;
    rest
      .getMe()
      .then((r) => {
        if (cancelled) return;
        setToken(tokenRef.current, r.user);
      })
      .catch(() => {
        if (cancelled) return;
        // Token is invalid (expired, revoked, server reset). Wipe and
        // leave the user on the login screen.
        setToken(null, null);
      });
    return () => {
      cancelled = true;
    };
  }, [rest, setToken]);

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
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        gateway.forceReconnect();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

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

  const loginWithDeviceCode = useCallback<AuthContextValue['loginWithDeviceCode']>(
    async (code) => {
      const r = await rest.redeemQuickLoginCode(code);
      setToken(r.accessToken, r.user);
    },
    [rest, setToken],
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
    () => ({ ...state, rest, gateway, login, loginWithPasskey, loginWithDeviceCode, register, logout, updateUser, emailVerificationRequired }),
    [state, rest, gateway, login, loginWithPasskey, loginWithDeviceCode, register, logout, updateUser, emailVerificationRequired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
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
