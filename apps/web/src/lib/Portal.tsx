/**
 * Portal — escape the React tree so children render directly into
 * `document.body`.
 *
 * Why: modals use `position: fixed inset-0` to cover the viewport, but
 * CSS `position: fixed` is contained by the nearest ancestor that
 * establishes a containing block — including ancestors with
 * `transform`, `filter`, `perspective`, or `will-change` set. The Shell
 * uses `transition-transform` on the channel/member drawers to slide
 * them in/out on mobile, which means modals rendered inside those
 * asides would get clipped to the aside on every screen size.
 *
 * Rendering into `document.body` sidesteps that entirely: the modal
 * always covers the actual viewport regardless of where in the React
 * tree the trigger lives.
 *
 * Implementation note: we render only after mount so SSR (if ever
 * added) doesn't try to access `document` during render. The first
 * client render returns null, then `useEffect` flips `mounted` true
 * and the portal materialises. This is the standard idiom.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
