/**
 * useGuildDragReorder
 * --------------------
 * Pointer-events drag-and-drop for the guild rail. Simpler than the
 * channel reorder hook: a flat list with no nesting, no parenting,
 * no per-row permission gating (every user can rearrange their own
 * rail since the order is per-user). Mouse + touch supported via
 * Pointer Events; HTML5 native DnD is avoided because iOS Safari
 * silently drops touch-initiated drag events.
 *
 * UX:
 *   - Touch: 250ms long-press on a tile starts the drag. Prevents
 *     accidental drags from scroll attempts.
 *   - Mouse: drag starts after 5px movement. Sub-threshold movement
 *     is a click and routes to the tile's <Link>.
 *   - During drag: source tile dims; the target tile gets a
 *     horizontal accent line above (drop-before) or below
 *     (drop-after) depending on which half of its bounding rect the
 *     pointer is in.
 *   - On drop: compute the new order with the source spliced into
 *     its target position, fire `onReorder(newIds)` once. Throwing
 *     from onReorder rolls back the visual state.
 *
 * The DOM contract: each tile has `data-zk-guild-drag-id="<id>"`.
 * That single attribute identifies the tile as both a drag source
 * and a drop target — the rail is flat so there's no need to
 * distinguish.
 *
 * Document-level pointermove/pointerup listeners run while a drag is
 * in progress so the drag continues even if the pointer leaves the
 * tile's bounding box.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type GuildDropPosition = 'before' | 'after';

export interface GuildDragState {
  draggingId: string | null;
  targetId: string | null;
  position: GuildDropPosition | null;
  pointer: { x: number; y: number } | null;
}

interface UseGuildDragReorderArgs {
  /** Current rail order. Source-of-truth; the hook reads, computes a
      mutated copy on drop, and hands it to onReorder. */
  guildIds: string[];
  /** When false, pointerdown is a no-op — used to disable while a
      modal or other interaction is active. */
  enabled: boolean;
  /** Fired once on a successful drop with the full new ordering. */
  onReorder: (newOrder: string[]) => void;
}

const TOUCH_LONG_PRESS_MS = 250;
const MOUSE_DRAG_THRESHOLD_PX = 5;

export function useGuildDragReorder({
  guildIds,
  enabled,
  onReorder,
}: UseGuildDragReorderArgs) {
  const [state, setState] = useState<GuildDragState>({
    draggingId: null,
    targetId: null,
    position: null,
    pointer: null,
  });

  // Refs for fast access in document handlers without stale closures.
  const guildIdsRef = useRef(guildIds);
  guildIdsRef.current = guildIds;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const dragRef = useRef<{
    sourceId: string | null;
    startX: number;
    startY: number;
    started: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    pointerType: 'mouse' | 'touch' | 'pen';
    targetId: string | null;
    targetPosition: GuildDropPosition | null;
  }>({
    sourceId: null,
    startX: 0,
    startY: 0,
    started: false,
    longPressTimer: null,
    pointerType: 'mouse',
    targetId: null,
    targetPosition: null,
  });

  // True for ~250ms after a drag completes. The tile's onClick
  // handler reads this to swallow the synthetic `click` event the
  // browser fires after pointerup on `<a>`/`<Link>` elements, which
  // would otherwise navigate to the dragged server. The doc-level
  // capture-phase suppressor in onPointerUp catches most cases, but
  // `<Link>`'s React Router click plumbing occasionally races past
  // it; this is the explicit guard the components opt into.
  const justDraggedRef = useRef(false);
  const wasJustDragging = useCallback(() => justDraggedRef.current, []);

  /** Reset visual + transient state. Called on drop, on cancel, and
      on clean-up. Idempotent. */
  const reset = useCallback(() => {
    if (dragRef.current.longPressTimer) {
      clearTimeout(dragRef.current.longPressTimer);
    }
    dragRef.current = {
      sourceId: null,
      startX: 0,
      startY: 0,
      started: false,
      longPressTimer: null,
      pointerType: 'mouse',
      targetId: null,
      targetPosition: null,
    };
    setState({ draggingId: null, targetId: null, position: null, pointer: null });
  }, []);

  /** Find the tile under the pointer, if any. Walks up from the
      target element so we accept clicks on inner spans/imgs. */
  const findTarget = useCallback((x: number, y: number): { id: string; position: GuildDropPosition } | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const tile = (el as Element).closest('[data-zk-guild-drag-id]') as HTMLElement | null;
    if (!tile) return null;
    const id = tile.dataset['zkGuildDragId'];
    if (!id) return null;
    const rect = tile.getBoundingClientRect();
    // Vertical rail — split before/after by Y midpoint.
    const position: GuildDropPosition = y < rect.top + rect.height / 2 ? 'before' : 'after';
    return { id, position };
  }, []);

  // Document-level handlers, registered once on mount.
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d.sourceId) return;
      // Pre-start: track threshold/long-press distance.
      if (!d.started) {
        const dx = Math.abs(e.clientX - d.startX);
        const dy = Math.abs(e.clientY - d.startY);
        if (d.pointerType === 'mouse') {
          if (Math.max(dx, dy) >= MOUSE_DRAG_THRESHOLD_PX) {
            d.started = true;
            // Source visual: flag in state so the tile dims.
            setState((s) => ({ ...s, draggingId: d.sourceId, pointer: { x: e.clientX, y: e.clientY } }));
          } else {
            return;
          }
        } else {
          // For touch, long-press fires the start; a moving finger
          // before that means the user wanted to scroll — abort.
          if (Math.max(dx, dy) > 8) {
            reset();
          }
          return;
        }
      }
      // Started: update target.
      const t = findTarget(e.clientX, e.clientY);
      if (t && t.id !== d.sourceId) {
        d.targetId = t.id;
        d.targetPosition = t.position;
        setState({
          draggingId: d.sourceId,
          targetId: t.id,
          position: t.position,
          pointer: { x: e.clientX, y: e.clientY },
        });
      } else {
        d.targetId = null;
        d.targetPosition = null;
        setState((s) => ({
          ...s,
          targetId: null,
          position: null,
          pointer: { x: e.clientX, y: e.clientY },
        }));
      }
    }

    function onPointerUp() {
      const d = dragRef.current;
      if (!d.sourceId) return;
      const sourceId = d.sourceId;
      const targetId = d.targetId;
      const position = d.targetPosition;
      const wasStarted = d.started;
      reset();
      if (!wasStarted) return;
      // Belt-and-suspenders: arm the per-tile onClick guard for a
      // brief window. The capture-phase doc listener below catches
      // most clicks; this ref backstops the cases where a `<Link>`
      // navigates anyway. Auto-clears so a real click ~250ms later
      // still works normally.
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 250);

      // We crossed the threshold — the synthetic click that fires
      // next would otherwise navigate the <Link> wrapping the tile.
      // Suppress it once at capture phase so the user's drag doesn't
      // also boot them into a different server. Stale handler self-
      // removes if the click never fires (e.g. pointer left the
      // tile mid-drag).
      const suppressClick = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        document.removeEventListener('click', suppressClick, true);
      };
      document.addEventListener('click', suppressClick, true);
      // Belt-and-suspenders: if no click arrives within a frame,
      // tear down the listener so it can't accidentally swallow a
      // future click on something unrelated.
      setTimeout(() => document.removeEventListener('click', suppressClick, true), 250);

      if (!targetId || !position) return;
      // Compute the new order.
      const cur = guildIdsRef.current.slice();
      const fromIdx = cur.indexOf(sourceId);
      if (fromIdx < 0) return;
      cur.splice(fromIdx, 1);
      let toIdx = cur.indexOf(targetId);
      if (toIdx < 0) return;
      if (position === 'after') toIdx += 1;
      cur.splice(toIdx, 0, sourceId);
      // No-op if drop position equals current position (e.g.
      // dropping a tile right back where it came from).
      const orig = guildIdsRef.current;
      let changed = false;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] !== orig[i]) {
          changed = true;
          break;
        }
      }
      if (changed) onReorderRef.current(cur);
    }

    function onPointerCancel() {
      reset();
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [findTarget, reset]);

  /** Attach to the tile's onPointerDown. Captures the source and
      arms the long-press timer for touch. Mouse waits for a small
      movement before activating so single-clicks still navigate. */
  const startDrag = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (!enabledRef.current) return;
      // Right-click should never start a drag.
      if (e.button !== 0 && e.button !== undefined && e.pointerType === 'mouse') return;
      const d = dragRef.current;
      d.sourceId = id;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.started = false;
      d.pointerType = e.pointerType as 'mouse' | 'touch' | 'pen';
      if (d.pointerType === 'touch') {
        d.longPressTimer = setTimeout(() => {
          d.started = true;
          setState((s) => ({
            ...s,
            draggingId: d.sourceId,
            pointer: { x: d.startX, y: d.startY },
          }));
        }, TOUCH_LONG_PRESS_MS);
      }
    },
    [],
  );

  return { state, startDrag, wasJustDragging };
}
