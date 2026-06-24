import { useEffect, useState } from 'react';
import { onPokeFlash } from '../lib/pokeFlash';

/**
 * The transient "you got poked" flash — the enlarged emoji (no text) springs
 * in, holds, then fades. Mounted once at the Shell root; driven by the
 * pokeFlash bus the gateway handler emits on. Mirrors the native PokeFlashView.
 */
export function PokeFlashOverlay() {
  const [flash, setFlash] = useState<{ id: number; emoji: string } | null>(null);

  useEffect(
    () =>
      onPokeFlash((emoji) => {
        const id = Date.now();
        setFlash({ id, emoji });
        // Clear after the animation (matches the 1.5s keyframe), unless a
        // newer poke replaced it.
        window.setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), 1500);
      }),
    [],
  );

  if (!flash) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center"
      aria-hidden
    >
      <span key={flash.id} className="zk-poke-flash select-none" style={{ fontSize: 140, lineHeight: 1 }}>
        {flash.emoji}
      </span>
    </div>
  );
}
