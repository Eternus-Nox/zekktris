/**
 * AvatarImage
 * -----------
 * Thin wrapper around <img> that hides itself on load failure so the
 * parent's initials/fallback shows through. Used everywhere we render
 * a user avatar — guards against transient CDN failures, expired URLs,
 * deleted files, etc.
 *
 * Usage pattern (the parent renders both the AvatarImage AND a sibling
 * fallback; the image overlays the fallback when it loads, and hides
 * itself when it errors):
 *
 *   <div className="relative ...">
 *     <span>{initials}</span>     // fallback layer
 *     <AvatarImage src={user.avatarUrl} />
 *   </div>
 *
 * The image is positioned absolutely-inset by default so the parent
 * container's existing layout doesn't shift.
 */
import { useState, useEffect } from 'react';

export function AvatarImage({
  src,
  alt = '',
  className = 'absolute inset-0 w-full h-full rounded-full object-cover',
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
}) {
  // Reset the error state when the URL changes — avatars rotate
  // (user uploads a new one) and we want the new URL to get a fresh
  // chance to load even if a prior one failed.
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (!src || errored) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setErrored(true)}
      // Defer images outside the viewport — chat scrollback and large
      // member lists can render hundreds of avatars at once; eager
      // loading blocks the main thread on decode. Native lazy loading
      // is supported in every browser Zekktris targets.
      loading="lazy"
      // Decode on a background thread when possible. Without this,
      // the synchronous img-decode pipeline can stutter the first
      // paint of a heavy chat scrollback.
      decoding="async"
    />
  );
}
