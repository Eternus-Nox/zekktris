import { useState } from 'react';
import { X } from '../lib/icons';
import { useAuth } from '../auth/AuthContext';
import { DateOfBirthField, composeDob } from '../auth/AuthScreens';

/**
 * One-time "confirm your date of birth" nudge for grandfathered accounts.
 *
 * Shows only while `canChangeDob` is true (legacy accounts unlocked by
 * migration 0096 and defaulted to 18). Saving calls the dedicated one-time
 * endpoint, which re-locks — so `canChangeDob` flips to false and this
 * unmounts. Dismiss is session-only (not persisted): it reappears on the next
 * load until they actually set a date, per the chosen non-blocking behavior.
 */
export function DobBanner() {
  const { user, rest, updateUser } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || user.canChangeDob !== true || dismissed) return null;

  const dob = composeDob(month, day, year);

  const save = async () => {
    if (!dob || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await rest.updateDateOfBirth(dob);
      updateUser(r.user); // canChangeDob → false, banner unmounts
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your date of birth.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-x-0 top-0 z-50" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="bg-bg-2/95 backdrop-blur border-b border-line px-3 py-2.5">
        <div className="mx-auto max-w-3xl flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink-1 font-medium">Confirm your date of birth</p>
            <p className="text-xs text-ink-3 leading-relaxed">
              We set a default age for your account. You can correct it once — after
              that, an admin has to reset it.
            </p>
            {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
          </div>
          <div className="w-full sm:w-72 shrink-0">
            <DateOfBirthField
              month={month}
              day={day}
              year={year}
              onMonth={setMonth}
              onDay={setDay}
              onYear={setYear}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!dob || busy}
              onClick={() => void save()}
              className="px-3 py-2 rounded-md text-sm font-medium bg-accent text-bg-0 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
              className="p-2 rounded-md text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
