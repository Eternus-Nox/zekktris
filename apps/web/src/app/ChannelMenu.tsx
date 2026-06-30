/**
 * ChannelMenu
 * -----------
 * Small right-click / long-press context menu anchored to a channel
 * row. Surfaces actions that don't deserve a hover-bar slot but are
 * still useful enough to need a fast path:
 *
 *   - Mark as read
 *   - Mute / Unmute
 *   - Edit channel (only when the viewer can manage it)
 *
 * Mirrors GuildInfoCard's anchor pattern (click coords → flip-up if
 * near viewport bottom). Click-outside closes; Esc closes.
 *
 * Right-click is the discovery path on desktop. On touch devices it
 * fires from a long-press if the row uses onContextMenu — most mobile
 * browsers map a long-press to a contextmenu event after ~500ms.
 * That's good enough for v1; a true touch-friendly affordance would
 * also expose this menu from the channel header dropdown but we don't
 * have one yet.
 */
import { useEffect } from 'react';
import { Portal } from '../lib/Portal';

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

const MENU_WIDTH = 200;
const MENU_HEIGHT_ESTIMATE = 140;
const VIEWPORT_PADDING = 8;

export function ChannelMenu({
  anchor,
  onClose,
  items,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  items: MenuItem[];
}) {
  // Esc to close — same dismissal path as the surrounding card
  // pattern. Click-outside is handled by the backdrop layer below.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Position: prefer below-right of click, flip up if near viewport
  // bottom, clamp horizontally so the menu never escapes the screen.
  const flipUp = anchor.y + MENU_HEIGHT_ESTIMATE > window.innerHeight - VIEWPORT_PADDING;
  const top = flipUp
    ? Math.max(VIEWPORT_PADDING, anchor.y - MENU_HEIGHT_ESTIMATE)
    : anchor.y;
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(anchor.x, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING),
  );

  return (
    <Portal>
      {/* Backdrop captures any click off the menu — closes without
          firing any sub-action. We also intercept contextmenu so a
          second right-click somewhere else closes cleanly instead of
          stacking another menu underneath. */}
      <div
        className="fixed inset-0 z-[80]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-[81] bg-bg-1 border border-line rounded-md shadow-2xl overflow-hidden py-1"
        style={{ top, left, width: MENU_WIDTH }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              item.destructive
                ? 'text-red-400 hover:bg-red-950/40'
                : 'text-ink-1 hover:bg-bg-3'
            }`}
            role="menuitem"
          >
            {item.icon && <span className="shrink-0 text-ink-3">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
          </button>
        ))}
      </div>
    </Portal>
  );
}
