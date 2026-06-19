/**
 * useKeyboardInset
 * ----------------
 * On mobile, when the soft keyboard slides up, iOS Safari (in particular)
 * may keep the layout viewport at full height while the visual viewport
 * shrinks — leaving anything anchored at the bottom of the layout
 * viewport (composer, voice controls, etc.) hidden under the keyboard.
 *
 * Both `interactive-widget=resizes-content` in the viewport meta and the
 * `dvh` length unit are SUPPOSED to handle this; in practice iOS Safari
 * support is uneven. As a safety net we observe `window.visualViewport`
 * directly and publish the keyboard height as a CSS custom property
 * (`--kb-inset`) on the document root. Anything that needs to stay above
 * the keyboard can then `padding-bottom: var(--kb-inset, 0px)` or
 * equivalent, and stay glued to the visual-viewport bottom even when
 * the layout viewport doesn't budge.
 *
 * The hook is a singleton — called once from Shell. The listener is
 * cleaned up on unmount, and the CSS var is cleared so the inset
 * doesn't bleed into post-mount pages.
 *
 * No-op in the native Capacitor app (the Keyboard plugin's `resize: 'native'`
 * already squeezes the WebView, so a second inset would double-count and push
 * the composer above the keyboard), and outside browsers that support
 * visualViewport (basically every mobile browser in the last several years;
 * the typeof check guards Safari < 13 and any SSR pre-hydration pass).
 */

import { useEffect } from 'react';
import { isNative } from './native';

export function useKeyboardInset(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // The native iOS shell runs the Capacitor Keyboard plugin in
    // `resize: 'native'` mode, which shrinks the WKWebView frame itself when
    // the keyboard opens — so the layout already fits above the keyboard.
    // Publishing our own visual-viewport inset on top of that double-counts
    // the keyboard height (Shell squeezes by `calc(100% - var(--kb-inset))`)
    // and shoves the composer + its caret far above the keyboard. The manual
    // inset is only a fallback for web/PWA browsers whose layout viewport
    // doesn't shrink, so skip it entirely in the native app.
    if (isNative()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    // Capture the non-null reference for the inner closure — TS doesn't
    // carry the truthy narrowing through nested function definitions.
    const viewport = vv;

    function apply() {
      const inset = Math.max(
        0,
        // Total height not covered by the visual viewport. window.innerHeight
        // is the layout viewport's height; viewport.height is the visible
        // portion. offsetTop accounts for pinch-zoom panning so we don't
        // over-correct when the user has zoomed in on iOS.
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
    }

    // iOS Safari frequently fails to fire visualViewport `resize`/`scroll`
    // when the keyboard DISMISSES (it fires reliably on open, not on close).
    // The inset then stays frozen at the keyboard height and the layout grid
    // is left permanently squeezed upward until something else forces a
    // recompute — exactly the "screen pushed up and never recovers" report.
    //
    // The focused field losing focus is the one reliable "keyboard is
    // closing" signal, so we use `focusout` as a fallback. We defer one tick
    // because `focusout` fires before the next field's `focusin`; if focus is
    // just moving to another text field the keyboard stays up and we leave the
    // inset alone. Otherwise we snap the inset to 0 immediately (instant
    // visual recovery) and re-measure once the viewport has settled, which
    // corrects either direction without trusting the flaky resize event.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    function isEditable(el: Element | null): boolean {
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable
      );
    }
    function onFocusOut() {
      settleTimer = setTimeout(() => {
        if (isEditable(document.activeElement)) return; // moved to another field
        document.documentElement.style.setProperty('--kb-inset', '0px');
        settleTimer = setTimeout(() => {
          if (!isEditable(document.activeElement)) apply();
        }, 250);
      }, 0);
    }

    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      document.removeEventListener('focusout', onFocusOut);
      if (settleTimer) clearTimeout(settleTimer);
      document.documentElement.style.removeProperty('--kb-inset');
    };
  }, []);
}
