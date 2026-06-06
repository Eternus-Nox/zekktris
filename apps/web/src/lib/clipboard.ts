/**
 * Copy text to the clipboard, working across environments.
 *
 * The async Clipboard API (`navigator.clipboard.writeText`) is the preferred
 * path but it requires a secure context AND a granted permission. In the
 * Electron desktop shell the renderer's clipboard permission is denied by the
 * main process, and on iOS Safari / insecure origins the API is unavailable —
 * in all those cases it throws "clipboard access declined" or is simply absent.
 *
 * So we fall back to the legacy `document.execCommand('copy')` path: drop an
 * off-screen <textarea>, select it, and run the copy command. It's deprecated
 * but still universally supported and works where the async API is blocked,
 * because it copies the current DOM selection rather than going through the
 * permission-gated async API.
 *
 * Throws if BOTH paths fail, so existing `try/catch` (and `.then(ok, err)`)
 * call-sites keep behaving as they did with `navigator.clipboard.writeText`.
 */
export async function copyText(text: string): Promise<void> {
  // 1. Preferred async Clipboard API.
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Permission denied (Electron) or blocked — fall through to legacy path.
  }

  // 2. Legacy execCommand fallback.
  if (typeof document === 'undefined') {
    throw new Error('Clipboard is unavailable in this environment');
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  // Preserve whatever the user had selected so copying doesn't disturb it.
  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  ta.select();
  ta.setSelectionRange(0, ta.value.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }

  if (!ok) throw new Error('Copy command was rejected');
}
