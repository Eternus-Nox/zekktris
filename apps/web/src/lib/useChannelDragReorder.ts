/**
 * useChannelDragReorder
 * ---------------------
 * Pointer-events-based drag-and-drop for the channel list. Works on
 * mouse + touch uniformly (HTML5 native DnD doesn't fire on iOS Safari
 * for touch input — Pointer Events do). Supports:
 *
 *   - Drag a channel up/down within its sibling group (reorder)
 *   - Drag a channel onto a category header to move it INTO that category
 *   - Drag a channel out of a category onto top-level space to UN-parent it
 *   - Drag a category to reorder among other categories (categories
 *     can't be parented to other categories — server enforces)
 *
 * UX details:
 *   - Touch: 200ms long-press on a row before drag starts. Prevents
 *     accidental drags from scroll attempts.
 *   - Mouse: drag starts immediately on pointerdown + 5px movement.
 *     Sub-threshold movement is treated as a click.
 *   - During drag: the source row dims (opacity 50%); the drop target
 *     gets a colored line above or below depending on which half of
 *     its bounding rect the pointer is in. Category headers light up
 *     fully when the pointer is over them (drop-INTO target).
 *   - On drop: compute minimal diff vs. starting order, send to the
 *     reorder API in one shot.
 *
 * Permission gate: the hook accepts `enabled` (typically isOwner ||
 * hasPermissionBit(perms, 4) for MANAGE_CHANNELS). When disabled,
 * pointerdown is a no-op so rows stay clickable links.
 *
 * The DOM contract:
 *   - Each draggable row has `data-zk-drag-id="<channel-id>"`
 *     AND `data-zk-drag-kind="channel" | "category"`
 *   - Each drop-INTO target (category header) has
 *     `data-zk-drop-into="<category-id>"`
 *   - The empty-area-after-category drop target has
 *     `data-zk-drop-tail="<category-id>"` (or `"root"`)
 *
 * The hook installs document-level pointermove/pointerup listeners so
 * the drag continues even if the pointer leaves the row's bounding box
 * — important for slow or wide drags.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Channel } from '@zekktris/client';

export type DropPosition = 'before' | 'after' | 'into';

export interface DragState {
  draggingId: string | null;
  /** The drop target id (channel id OR category id when 'into'). */
  targetId: string | null;
  position: DropPosition | null;
  /** Pointer X/Y in viewport coordinates — drives the floating preview pill. */
  pointer: { x: number; y: number } | null;
  /** Display label for the floating preview. */
  draggingLabel: string | null;
}

interface UseChannelDragReorderArgs {
  channels: Channel[];
  /** When false, pointerdown is a no-op — gates the whole feature behind perms. */
  enabled: boolean;
  /**
   * Called once on successful drop with the minimal diff (channels whose
   * position OR parentId changed). The implementation should POST to the
   * reorder API. Throwing rolls back the optimistic UI state.
   */
  onReorder: (
    changes: Array<{ id: string; position: number; parentId?: string | null }>,
  ) => Promise<void>;
}

const TOUCH_LONG_PRESS_MS = 200;
const MOUSE_DRAG_THRESHOLD_PX = 5;

export function useChannelDragReorder({
  channels,
  enabled,
  onReorder,
}: UseChannelDragReorderArgs) {
  const [state, setState] = useState<DragState>({
    draggingId: null,
    targetId: null,
    position: null,
    pointer: null,
    draggingLabel: null,
  });

  // Refs for fast access in document handlers (avoid stale closures).
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  // Per-drag transient state. Held in a ref because the document
  // handlers run outside React's render cycle and we don't want to
  // re-render on every mouse move (state drives only what should
  // visibly update).
  const dragRef = useRef<{
    sourceId: string | null;
    sourceKind: 'channel' | 'category' | null;
    startX: number;
    startY: number;
    started: boolean; // crossed the threshold / long-press fired
    longPressTimer: ReturnType<typeof setTimeout> | null;
    pointerType: 'mouse' | 'touch' | 'pen';
    /** Current target — kept in ref to avoid setState in pointermove. */
    targetId: string | null;
    targetPosition: DropPosition | null;
  }>({
    sourceId: null,
    sourceKind: null,
    startX: 0,
    startY: 0,
    started: false,
    longPressTimer: null,
    pointerType: 'mouse',
    targetId: null,
    targetPosition: null,
  });

  // Set briefly after a drag completes so the row's onClick handler
  // can check it and swallow the synthetic click that the browser
  // fires on `<a>`/`<Link>` elements following a pointerup. The
  // document-level capture-phase suppressor in onPointerUp catches
  // most cases, but React Router's `<Link>` plays tricks with
  // pointer/click events that occasionally evade it; this ref is a
  // belt-and-suspenders guard the components opt into. Reset to
  // false after a short timeout — a single click is all we need to
  // swallow.
  const justDraggedRef = useRef(false);
  const wasJustDragging = useCallback(() => justDraggedRef.current, []);

  // Public handler — wire to onPointerDown on each draggable row.
  const startDrag = useCallback(
    (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => {
      if (!enabledRef.current) return;
      // Only left-click for mouse. Touch + pen always start.
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      // Capture the pointer on the source element. This binds all
      // subsequent pointermove / pointerup events to this element
      // even if the pointer leaves its bounding box — critical for
      // drag operations where the user moves the finger/cursor
      // anywhere on the screen. Without capture, on some browsers
      // a pointer that leaves the source element while held will
      // stop firing events on that element AND the document hears
      // them only intermittently, leaving the drop-target hit
      // detection to update less often than the pointer position.
      // Capture also keeps long-press drags reliable on iOS, where
      // the touch handler is otherwise vulnerable to passive event
      // optimization disconnecting the listener mid-gesture.
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // Older browsers / pointers don't always allow capture;
        // the document-level fallback still works.
      }

      const ref = dragRef.current;
      ref.sourceId = channelId;
      ref.sourceKind = kind;
      ref.startX = e.clientX;
      ref.startY = e.clientY;
      ref.started = false;
      ref.pointerType = e.pointerType as 'mouse' | 'touch' | 'pen';
      ref.targetId = null;
      ref.targetPosition = null;

      // Touch path: arm the long-press timer. If pointerup fires
      // before this elapses, we treat it as a tap (no drag), and the
      // wrapping <Link> handles the click as normal.
      if (e.pointerType === 'touch') {
        ref.longPressTimer = setTimeout(() => {
          ref.longPressTimer = null;
          ref.started = true;
          // Vibrate as a tactile cue that drag mode engaged. iOS Safari
          // ignores navigator.vibrate, but Android honors it; either
          // way we don't depend on it.
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
              navigator.vibrate?.(10);
            } catch {
              // ignore — feature-detection isn't 100% reliable
            }
          }
          setState({
            draggingId: channelId,
            targetId: null,
            position: null,
            pointer: { x: ref.startX, y: ref.startY },
            draggingLabel: label,
          });
        }, TOUCH_LONG_PRESS_MS);
      }
      // Stash the label on the ref so pointermove can use it without
      // recomputing.
      (ref as unknown as { label: string }).label = label;
    },
    [],
  );

  // Document-level pointermove + pointerup. Bound once on mount; we
  // gate logic by checking dragRef.sourceId.
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const ref = dragRef.current;
      if (!ref.sourceId) return;

      // Mouse: cross the threshold to start.
      if (!ref.started && ref.pointerType !== 'touch') {
        const dx = e.clientX - ref.startX;
        const dy = e.clientY - ref.startY;
        if (Math.hypot(dx, dy) < MOUSE_DRAG_THRESHOLD_PX) return;
        ref.started = true;
        setState({
          draggingId: ref.sourceId,
          targetId: null,
          position: null,
          pointer: { x: e.clientX, y: e.clientY },
          draggingLabel: (ref as unknown as { label: string }).label,
        });
      }
      if (!ref.started) {
        // Touch: if the user moves before the long-press timer fires,
        // they were probably trying to scroll — cancel the timer so
        // the gesture stays a scroll. (We use a generous 8px tolerance
        // so micro-jitter on the press doesn't kill the drag.)
        if (ref.longPressTimer) {
          const dx = Math.abs(e.clientX - ref.startX);
          const dy = Math.abs(e.clientY - ref.startY);
          if (dx > 8 || dy > 8) {
            clearTimeout(ref.longPressTimer);
            ref.longPressTimer = null;
            ref.sourceId = null;
            ref.sourceKind = null;
          }
        }
        return;
      }

      e.preventDefault();

      // Resolve drop target via DOM. We walk the elements at the
      // pointer coordinates from topmost down, looking for one of our
      // drag-data attributes. Skipping past anything we don't own
      // (icons, text spans, etc.) keeps the lookup robust against
      // arbitrary nesting.
      let targetId: string | null = null;
      let position: DropPosition | null = null;
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      // Track whether the cursor is anywhere over the channel list
      // nav. We use that as the gate for the Y-axis fallback below
      // — if the user's finger is in the channel list (even slightly
      // off a row / tail), we still snap to the closest target. If
      // they've dragged outside the list entirely (e.g. floating the
      // preview pill over the message view), no fallback fires.
      let inChannelNav = false;
      for (const el of stack) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.dataset.zkChannelNav !== undefined) {
          inChannelNav = true;
        }
        const intoId = el.dataset.zkDropInto;
        const tailId = el.dataset.zkDropTail;
        const dragId = el.dataset.zkDragId;
        if (intoId) {
          // Drop INTO a category. Don't allow dragging a category
          // into another category (no nesting), and don't allow self.
          if (ref.sourceKind === 'category' || ref.sourceId === intoId) continue;
          targetId = intoId;
          position = 'into';
          break;
        }
        if (tailId) {
          // The empty space below a category's last channel — treat
          // as "after the last child" so dropping there places the
          // dragged item at the bottom of that category. Skip if the
          // tail belongs to a category we're dragging.
          if (ref.sourceId === tailId) continue;
          targetId = tailId;
          position = 'after';
          // For tails, we encode the destination as a category id;
          // the diff builder treats it specially.
          break;
        }
        if (dragId) {
          if (dragId === ref.sourceId) continue; // can't drop on self
          // Compute before/after by which half the pointer is in.
          const rect = el.getBoundingClientRect();
          position = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
          targetId = dragId;
          break;
        }
      }

      // Y-axis snap fallback: when the cursor is somewhere within
      // the channel list but not directly over a row or tail (e.g.
      // touch device where the finger is near the right edge or in
      // the gap between rows), find the closest drop target by Y
      // distance. This is what makes "drag anywhere in the column"
      // feel natural — without it, the user has to land precisely
      // on the dashed bar, which is visually narrow and easy to miss.
      if (!targetId && inChannelNav) {
        const candidates = document.querySelectorAll<HTMLElement>(
          '[data-zk-drag-id], [data-zk-drop-tail]',
        );
        let best: { id: string; pos: DropPosition; dist: number } | null = null;
        for (const el of Array.from(candidates)) {
          // Skip targets that aren't inside the channel list nav —
          // we don't want to snap to a guild tile or some unrelated
          // element. data-zk-channel-nav is the sentinel.
          if (!el.closest('[data-zk-channel-nav]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.height === 0) continue;
          const cy = rect.top + rect.height / 2;
          const dist = Math.abs(e.clientY - cy);
          // Resolve attributes: tail → after, drag-id → before/after
          // by which half of the row Y is on.
          const tailId = el.dataset.zkDropTail;
          const dragId = el.dataset.zkDragId;
          if (tailId) {
            if (ref.sourceId === tailId) continue;
            if (!best || dist < best.dist) {
              best = { id: tailId, pos: 'after', dist };
            }
          } else if (dragId) {
            if (dragId === ref.sourceId) continue;
            const pos: DropPosition = e.clientY < cy ? 'before' : 'after';
            if (!best || dist < best.dist) {
              best = { id: dragId, pos, dist };
            }
          }
        }
        if (best) {
          targetId = best.id;
          position = best.pos;
        }
      }

      if (
        targetId !== ref.targetId ||
        position !== ref.targetPosition
      ) {
        ref.targetId = targetId;
        ref.targetPosition = position;
        setState((prev) => ({
          ...prev,
          targetId,
          position,
          pointer: { x: e.clientX, y: e.clientY },
        }));
      } else {
        setState((prev) => ({ ...prev, pointer: { x: e.clientX, y: e.clientY } }));
      }
    }

    function onPointerUp(_e: PointerEvent) {
      const ref = dragRef.current;
      // Long-press not yet fired — clear and let the click pass.
      if (ref.longPressTimer) {
        clearTimeout(ref.longPressTimer);
        ref.longPressTimer = null;
      }
      const sourceId = ref.sourceId;
      const sourceKind = ref.sourceKind;
      const started = ref.started;
      const targetId = ref.targetId;
      const position = ref.targetPosition;
      // Reset state regardless of whether we drop or cancel.
      ref.sourceId = null;
      ref.sourceKind = null;
      ref.started = false;
      ref.targetId = null;
      ref.targetPosition = null;

      setState({
        draggingId: null,
        targetId: null,
        position: null,
        pointer: null,
        draggingLabel: null,
      });

      if (!started || !sourceId) return;

      // Belt-and-suspenders click-swallow path. The document-level
      // capture suppressor below covers most cases; for `<Link>`
      // children that synthesize their own click handling we ALSO
      // expose a ref the row's onClick can check to bail out
      // explicitly. Both layers reset within ~250ms.
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 250);

      // We crossed the threshold — the synthetic click that fires
      // next would otherwise navigate the <Link> wrapping the row.
      // Suppress it once at capture phase so completing a drag
      // doesn't ALSO open the channel. Self-removes after 250ms in
      // case the click never arrives (pointer left the row mid-drag).
      const suppressClick = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        document.removeEventListener('click', suppressClick, true);
      };
      document.addEventListener('click', suppressClick, true);
      setTimeout(() => document.removeEventListener('click', suppressClick, true), 250);

      if (!targetId || !position) return;

      // Compute the new ordering. Build a flat ordered list, splice
      // the source out, splice it back at the chosen position, then
      // recompute per-group positions and diff against the initial
      // state. Send only the deltas.
      const changes = computeReorder(channelsRef.current, {
        sourceId,
        sourceKind: sourceKind ?? 'channel',
        targetId,
        position,
      });
      if (changes.length === 0) return;
      onReorderRef.current(changes).catch(() => {
        // Caller surfaces the error toast; we just don't dirty the
        // local state. The next gateway CHANNEL_UPDATE will refresh
        // the canonical order anyway.
      });
    }

    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return { state, startDrag, wasJustDragging };
}

// ── Position computation ───────────────────────────────────────────────────
//
// The reorder API expects {id, position, parentId?} per changed channel.
// `position` is the index within the sibling group (top-level categories,
// top-level non-categories, or children-of-category). We compute the new
// ordering, then diff against the channels' pre-drag positions to keep
// the wire payload minimal.

export function computeReorder(
  channels: readonly Channel[],
  drop: {
    sourceId: string;
    sourceKind: 'channel' | 'category';
    /** Either a channel id (for before/after) or a category id (for into / tail-after) */
    targetId: string;
    position: DropPosition;
  },
): Array<{ id: string; position: number; parentId?: string | null }> {
  const all = [...channels];
  const source = all.find((c) => c.id === drop.sourceId);
  if (!source) return [];

  // Helper: get a channel's effective parent id (null = top-level).
  // For a category, parentId is always null; for non-category, it's
  // either set or null.
  const parentOf = (c: Channel): string | null =>
    c.type === 'guild_category' ? null : (c.parentId ?? null);

  // Determine the destination parent + the target index within that
  // parent's sibling group.
  let destParentId: string | null;
  let destIndex: number;

  if (drop.position === 'into') {
    // Drop INTO a category — append to the end of its children.
    if (drop.sourceKind === 'category') return []; // no nesting
    destParentId = drop.targetId;
    const siblings = all
      .filter((c) => c.id !== source.id && c.type !== 'guild_category' && (c.parentId ?? null) === destParentId)
      .sort((a, b) => a.position - b.position);
    destIndex = siblings.length; // append
  } else if (drop.targetId === 'root' && drop.position === 'after') {
    // Root-level tail drop: append at the bottom of the
    // top-level non-category channel group. The 'root' literal is
    // a sentinel (no real channel has that id); the ChannelList
    // renders a tail <li data-zk-drop-tail="root"> just below
    // the uncategorized rows so users have a visible target for
    // un-parenting a channel back to top-level.
    if (drop.sourceKind === 'category') {
      // Categories can't move into "root" parenting (categories are
      // always top-level by definition); fall through to no-op.
      return [];
    }
    destParentId = null;
    const siblings = all
      .filter((c) => c.id !== source.id && c.type !== 'guild_category' && (c.parentId ?? null) === null)
      .sort((a, b) => a.position - b.position);
    destIndex = siblings.length;
  } else {
    // before/after another row (channel or category) OR after a tail
    const target = all.find((c) => c.id === drop.targetId);
    if (target && drop.sourceKind !== 'category' && target.type === 'guild_category' && drop.position === 'after') {
      // "after a category" with tail semantics — append to that category's children
      destParentId = target.id;
      const siblings = all
        .filter((c) => c.id !== source.id && c.type !== 'guild_category' && (c.parentId ?? null) === destParentId)
        .sort((a, b) => a.position - b.position);
      destIndex = siblings.length;
    } else if (target) {
      // Both source and target end up in the target's sibling group.
      // For a non-category source, the target's parent (or null for top-level)
      // is the destination. For a category source, destination is always top-level.
      destParentId = drop.sourceKind === 'category' ? null : parentOf(target);
      const siblings = all
        .filter((c) => {
          if (c.id === source.id) return false;
          if (drop.sourceKind === 'category') return c.type === 'guild_category';
          return c.type !== 'guild_category' && (c.parentId ?? null) === destParentId;
        })
        .sort((a, b) => a.position - b.position);
      const targetIdx = siblings.findIndex((c) => c.id === target.id);
      // Categories sliding into a non-category siblings list (or vice
      // versa) — fall back to appending. Shouldn't happen in practice
      // because `into` is the only category-target case for non-cat
      // sources.
      if (targetIdx === -1) {
        destIndex = siblings.length;
      } else {
        destIndex = drop.position === 'before' ? targetIdx : targetIdx + 1;
      }
    } else {
      return [];
    }
  }

  // Mutate a copy of the canonical sibling array to reflect the drop,
  // then assign positions 0..N-1 in that order. We only emit changes
  // for rows whose position OR parentId differs from before.
  const sourceParentBefore = parentOf(source);
  const allWithoutSource = all.filter((c) => c.id !== source.id);

  // Build ordered sibling lists for BEFORE (canonical) and AFTER (post-drop).
  // We track only the affected groups: source's old parent + dest parent.
  // Plus, if the source is a category, the top-level-categories group.

  function siblingsOf(parent: string | null, kind: 'category' | 'channel'): Channel[] {
    return allWithoutSource
      .filter((c) =>
        kind === 'category'
          ? c.type === 'guild_category'
          : c.type !== 'guild_category' && (c.parentId ?? null) === parent,
      )
      .sort((a, b) => a.position - b.position);
  }

  const sourceKind: 'category' | 'channel' =
    source.type === 'guild_category' ? 'category' : 'channel';

  // Compute the post-drop ordering for each affected group.
  const groups: Map<string, Channel[]> = new Map();

  if (sourceKind === 'category') {
    // Categories live in their own sibling group (top-level).
    const list = siblingsOf(null, 'category');
    list.splice(destIndex, 0, source);
    groups.set('cat', list);
  } else {
    // The source's old parent — drop the source out, leave others
    // alone.
    const oldParentList = siblingsOf(sourceParentBefore, 'channel');
    groups.set(`p:${sourceParentBefore ?? 'root'}`, oldParentList);
    // The destination parent — splice the source in at destIndex.
    const destList =
      sourceParentBefore === destParentId
        ? oldParentList // same group; reuse
        : siblingsOf(destParentId, 'channel');
    destList.splice(destIndex, 0, source);
    groups.set(`p:${destParentId ?? 'root'}`, destList);
  }

  // Emit changes: per group, walk in order, diff each row's new
  // position against its existing one.
  const changes: Array<{ id: string; position: number; parentId?: string | null }> = [];
  for (const list of groups.values()) {
    list.forEach((ch, idx) => {
      const newParent =
        ch.type === 'guild_category' ? null : ch.id === source.id ? destParentId : (ch.parentId ?? null);
      const positionChanged = ch.position !== idx;
      const parentChanged =
        ch.type !== 'guild_category' && (ch.parentId ?? null) !== newParent;
      if (positionChanged || parentChanged) {
        const entry: { id: string; position: number; parentId?: string | null } = {
          id: ch.id,
          position: idx,
        };
        if (parentChanged) entry.parentId = newParent;
        changes.push(entry);
      }
    });
  }

  return changes;
}
