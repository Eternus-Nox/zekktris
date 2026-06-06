/**
 * One-shot storage-key migration: commune.* → zekktris.*
 *
 * The rebrand to Zekktris renamed every localStorage key the web
 * client uses. Without migration, every existing user would silently
 * lose their session, voice preferences, audio device selections,
 * guild folder/order layouts, and theme settings on first load
 * after the update — because the new code reads from `zekktris.*`
 * keys that don't exist yet.
 *
 * This module runs ONCE at app boot (imported by main.tsx). For each
 * known legacy key, if the new `zekktris.*` slot is empty AND the old
 * `commune.*` slot has a value, copy the value over. Then delete the
 * old key. Idempotent: re-running does nothing because the source
 * keys are removed after the first successful copy.
 *
 * Safe to remove a few releases after the rebrand once no users are
 * still on a pre-migration version. Until then, leaving this in
 * costs us a handful of synchronous localStorage reads at boot.
 */

// Keys to migrate. Add to this list when renaming additional keys;
// pairs are [oldKey, newKey]. We do an explicit allowlist (rather
// than "rename any commune.* key") because future code might use the
// `commune.` prefix for unrelated reasons; explicit is safer.
const MIGRATIONS: Array<[string, string]> = [
  // Auth — token + cached self user
  ['commune.accessToken', 'zekktris.accessToken'],
  ['commune.user', 'zekktris.user'],

  // Voice — input/output device selections, video quality, voice prefs,
  // audio mode (push-to-talk vs always-on), PTT keybinding
  ['commune.audio.input', 'zekktris.audio.input'],
  ['commune.audio.output', 'zekktris.audio.output'],
  ['commune.audio.mode', 'zekktris.audio.mode'],
  ['commune.audio.pttKey', 'zekktris.audio.pttKey'],
  ['commune.video.camera_quality', 'zekktris.video.camera_quality'],
  ['commune.video.screen_quality', 'zekktris.video.screen_quality'],
  ['commune.voice.prefs.v1', 'zekktris.voice.prefs.v1'],

  // Sidebar — guild reorder, folder layout, collapsed-folder state,
  // channel reorder per-guild
  ['commune.guild.order.v1', 'zekktris.guild.order.v1'],
  ['commune.guild.folders.v1', 'zekktris.guild.folders.v1'],
  ['commune.rail.collapsedFolders.v1', 'zekktris.rail.collapsedFolders.v1'],
  ['commune.channel.order.v1', 'zekktris.channel.order.v1'],
];

let didRun = false;

export function migrateLegacyStorageKeys(): void {
  if (didRun) return;
  didRun = true;
  // Guard for non-browser contexts (SSR, tests). localStorage isn't
  // defined and the rest of the function would throw — bail silently
  // since there's nothing to migrate anyway.
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  for (const [oldKey, newKey] of MIGRATIONS) {
    try {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue === null) continue;
      // Only copy if the new slot is unset — never overwrite a value
      // the user has already produced under the new key (which would
      // happen if they logged in / changed prefs between the rebrand
      // and this migration running, e.g. via a partial sync).
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldValue);
      }
      // Drop the old key regardless so the migration is idempotent
      // and we don't carry around dead localStorage indefinitely.
      localStorage.removeItem(oldKey);
    } catch {
      // localStorage can throw in private-browsing modes or quota-
      // exceeded states. Each key is independent; a failure on one
      // shouldn't stop the others. Silent: the user simply gets
      // the new-default behavior for that one preference, no
      // surprises elsewhere.
    }
  }
}
