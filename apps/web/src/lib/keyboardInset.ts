/**
 * On-screen-keyboard tracking via the VisualViewport API.
 *
 * The message composer carries a home-indicator bottom padding (≈40px) so it
 * clears the iOS home gesture / Siri edge-swipe area. But while the virtual
 * keyboard is OPEN that padding is dead space wedged between the textbox and
 * the keyboard — the "textbox sits half an inch above the keyboard" gap.
 *
 * When the keyboard opens, `visualViewport.height` shrinks below the layout
 * viewport. We measure that overlap, and once it clears a threshold (so a
 * collapsing URL bar doesn't count) we toggle `.zk-vkb-open` on <html>. CSS
 * then drops the composer's bottom padding to a minimal value. No-op where
 * VisualViewport is unavailable (older browsers / SSR).
 */
export function initKeyboardInset(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const root = document.documentElement;

  const apply = () => {
    // How much of the layout viewport the visual viewport no longer covers at
    // the bottom (the keyboard, mostly).
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // >120px of overlap ⇒ a real keyboard, not a toolbar collapse.
    const open = overlap > 120;
    root.classList.toggle('zk-vkb-open', open);
    root.style.setProperty('--zk-vkb', `${open ? overlap : 0}px`);
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
