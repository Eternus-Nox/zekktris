/**
 * Tiny pub/sub for the transient "you got poked" emoji flash. The gateway
 * handler emits an emoji; a single <PokeFlashOverlay> mounted at the Shell
 * root listens and animates it. Kept out of the AppState reducer/context —
 * it's a fire-and-forget visual effect, not persistent state.
 */
type Listener = (emoji: string) => void;

const listeners = new Set<Listener>();

export function emitPokeFlash(emoji: string): void {
  for (const l of listeners) l(emoji);
}

export function onPokeFlash(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
