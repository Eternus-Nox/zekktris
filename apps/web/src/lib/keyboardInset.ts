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
    // >60px of overlap ⇒ a real keyboard, not a toolbar collapse. The old
    // 120px threshold desynced from the grid-lift (which fires at any inset),
    // so a short/split/floating keyboard would lift the layout but NOT collapse
    // the composer's ~46px home-indicator padding, leaving the "half inch above
    // the keyboard" gap. 60px still clears a collapsing URL bar while catching
    // every real keyboard. The composer padding is now fully collapsed (0) when
    // this fires, so there is no residual gap either.
    const open = overlap > 60;
    root.classList.toggle('zk-vkb-open', open);
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}
