/**
 * useStepUpPassword — a tiny re-auth prompt for sensitive account actions.
 *
 * Some mutations (adding/removing a passkey, arming 2FA) plant or strip a
 * *login factor*. A transient stolen session must not be enough to do them —
 * the server re-verifies the account password (see auth/stepUp.ts). This hook
 * collects that password without a full-page form:
 *
 *   const stepUp = useStepUpPassword();
 *   const pw = await stepUp.request({ message: 'Enter your password to add a passkey.' });
 *   if (!pw) return;                       // user cancelled
 *   await rest.passkeyRegisterVerify({ ..., currentPassword: pw });
 *   // render {stepUp.element} somewhere in the component's tree
 *
 * The modal renders through a Portal (body-level) so it's never clipped by a
 * transformed drawer ancestor, and it owns its own overlay dismiss — do not
 * nest it inside a popover that has its own outside-click handler.
 */
import { useCallback, useRef, useState } from 'react';
import { Portal } from './Portal';

interface Prompt {
  title: string;
  message: string;
}

export function useStepUpPassword() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [value, setValue] = useState('');
  const resolverRef = useRef<((v: string | null) => void) | null>(null);

  const request = useCallback((opts?: { title?: string; message?: string }) => {
    return new Promise<string | null>((resolve) => {
      // If a prompt is somehow already open, cancel the stale one first.
      resolverRef.current?.(null);
      resolverRef.current = resolve;
      setValue('');
      setPrompt({
        title: opts?.title ?? "Confirm it's you",
        message: opts?.message ?? 'Enter your account password to continue.',
      });
    });
  }, []);

  const settle = useCallback((v: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    setValue('');
    resolve?.(v);
  }, []);

  const element = prompt ? (
    <Portal>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4"
        onMouseDown={() => settle(null)}
      >
        <form
          onMouseDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (value) settle(value);
          }}
          className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-bg-1 p-4 shadow-xl"
        >
          <div className="text-sm font-medium text-ink-1">{prompt.title}</div>
          <p className="text-xs leading-relaxed text-ink-3">{prompt.message}</p>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Account password"
            className="w-full rounded-md border border-line bg-bg-2 px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => settle(null)}
              className="rounded-md px-3 py-1.5 text-sm text-ink-3 hover:text-ink-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Confirm
            </button>
          </div>
        </form>
      </div>
    </Portal>
  ) : null;

  return { request, element };
}
