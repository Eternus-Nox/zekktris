import { useE2eeLinkPreviews, setE2eeLinkPreviews } from '../lib/e2eeLinkPreviews';

/**
 * Per-device opt-in for link previews in end-to-end encrypted chats (default
 * off). Off means a decrypted link is never sent to /unfurl; on means the
 * link — not the message — goes to the server so it can build the preview.
 * Same label and wording as the iOS Settings toggle.
 */
export function E2eeLinkPreviewsToggle() {
  const on = useE2eeLinkPreviews();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Link previews in encrypted chats</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Off by default. When on, links in end-to-end encrypted chats are sent
          to the server to build a preview. The message itself stays encrypted.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Link previews in encrypted chats"
        onClick={() => setE2eeLinkPreviews(!on)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          on ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            on ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}
