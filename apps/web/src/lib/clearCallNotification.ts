/**
 * Ask the service worker to close any open OS notifications tagged
 * for the given channel's incoming-call ring. Called when the call
 * ends from any cause — recipient accepts, recipient declines, caller
 * hangs up, partner leaves mid-call. Without this, the
 * `requireInteraction: true` push notification stays visible on the
 * OS UI long after the call is over (it never auto-dismisses on its
 * own, which is intentional for ringing but obviously wrong post-call).
 *
 * Silent no-op when there's no active service worker (PWA not
 * installed, browser doesn't support SW, etc.). The user simply
 * doesn't get the dismiss but nothing breaks.
 */
export function clearCallNotification(channelId: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker.controller;
  if (!sw) return;
  try {
    sw.postMessage({ type: 'CLEAR_CALL_NOTIFICATION', channelId });
  } catch {
    // postMessage can throw if the controller's port is gone; ignore.
  }
}
