/**
 * Typing context
 * --------------
 * Tracks who's typing in each channel. Lives outside AppState because the
 * data is ephemeral (auto-expires after 8s, or the moment the typist's
 * message arrives) and not part of any persisted shape — it doesn't
 * belong in the same reducer.
 *
 * Sender side: a `useTypingPing(channelId)` hook returns a function that
 * fires `POST /channels/:id/typing` at most once every 4s. Components
 * (specifically the composer) call it on every keystroke; the throttle
 * means we don't drown the server in pings.
 *
 * Receiver side: `useTypingUsers(channelId)` returns the set of user ids
 * currently typing in that channel. The component re-renders when entries
 * arrive or expire.
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
import { GatewayEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';

// Receiver-side expiry window after the last TYPING_START. 8s matches
// iOS (AppStore.handleTypingStart) so all clients drop a stalled typist
// at the same moment. Senders ping every 3-4s, so a live typist always
// refreshes well inside the window.
const TYPING_TTL_MS = 8_000;
const PING_INTERVAL_MS = 4_000;

interface TypingState {
  /** channelId → userId → expiry timestamp (ms). */
  byChannel: Map<string, Map<string, number>>;
}

interface TypingValue {
  /** Snapshot used by selectors. Mutated in place on event delivery; we
   *  bump a revision counter to drive React re-renders. */
  rev: number;
  state: TypingState;
}

const TypingContext = createContext<TypingValue | null>(null);

export function TypingProvider({ children }: { children: ReactNode }) {
  const { gateway, token, user } = useAuth();
  const stateRef = useRef<TypingState>({ byChannel: new Map() });
  const [rev, setRev] = useState(0);

  // Sweep expired entries periodically so selectors stay accurate even
  // when no new events arrive.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [chId, users] of stateRef.current.byChannel) {
        for (const [uid, exp] of users) {
          if (exp <= now) {
            users.delete(uid);
            dirty = true;
          }
        }
        if (users.size === 0) stateRef.current.byChannel.delete(chId);
      }
      if (dirty) setRev((v) => v + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to TYPING_START.
  useEffect(() => {
    if (!token || !user) return;
    const selfId = user.id;
    const unsubscribe = gateway.on<{ channel_id: string; user_id: string }>(
      GatewayEvent.TYPING_START,
      (d) => {
        // Don't show "you are typing" to yourself — silly UX.
        if (d.user_id === selfId) return;
        let users = stateRef.current.byChannel.get(d.channel_id);
        if (!users) {
          users = new Map();
          stateRef.current.byChannel.set(d.channel_id, users);
        }
        users.set(d.user_id, Date.now() + TYPING_TTL_MS);
        setRev((v) => v + 1);
      },
    );
    // A user's message supersedes their typing indicator (iOS parity —
    // AppStore clears the entry the moment their MESSAGE_CREATE lands).
    // Without this, "X is typing…" lingers up to TYPING_TTL_MS after
    // the message is already on screen.
    const unsubscribeMsg = gateway.on<{ channelId: string; authorId?: string | null }>(
      GatewayEvent.MESSAGE_CREATE,
      (m) => {
        if (!m.authorId) return;
        const users = stateRef.current.byChannel.get(m.channelId);
        if (users?.delete(m.authorId)) {
          if (users.size === 0) stateRef.current.byChannel.delete(m.channelId);
          setRev((v) => v + 1);
        }
      },
    );
    return () => {
      unsubscribe();
      unsubscribeMsg();
      // Wipe typing state on auth change so a logout → relogin
      // cycle doesn't surface up to TYPING_TTL_MS of stale
      // indicators from the previous user's session before the
      // sweep expires them. Same pattern as voicePrefs's cancel
      // flag from round 15 — ephemeral session-scoped state needs
      // active cleanup, not just passive expiry.
      stateRef.current.byChannel.clear();
      setRev((v) => v + 1);
    };
  }, [gateway, token, user]);

  const value = useMemo<TypingValue>(() => ({ rev, state: stateRef.current }), [rev]);

  return <TypingContext.Provider value={value}>{children}</TypingContext.Provider>;
}

/** Returns the user IDs currently typing in `channelId`. */
export function useTypingUsers(channelId: string | undefined): string[] {
  const ctx = useContext(TypingContext);
  if (!ctx || !channelId) return [];
  // Reading the rev triggers re-render when state changes; the actual
  // computation reads from the mutable map.
  void ctx.rev;
  const users = ctx.state.byChannel.get(channelId);
  if (!users) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const [uid, exp] of users) {
    if (exp > now) out.push(uid);
  }
  return out;
}

/**
 * Returns a throttled ping function. Calling it at any keystroke is fine;
 * the function ensures at most one POST per PING_INTERVAL_MS per channel.
 */
export function useTypingPing(channelId: string | undefined): () => void {
  const { rest } = useAuth();
  const lastPingRef = useRef<{ channelId: string; at: number } | null>(null);

  return useCallback(() => {
    if (!channelId) return;
    const now = Date.now();
    const last = lastPingRef.current;
    if (last && last.channelId === channelId && now - last.at < PING_INTERVAL_MS) {
      return;
    }
    lastPingRef.current = { channelId, at: now };
    rest.startTyping(channelId).catch(() => {
      // Typing pings are best-effort; failures are silent. Reset the
      // throttle so the next keystroke retries promptly.
      lastPingRef.current = null;
    });
  }, [channelId, rest]);
}
