/**
 * CreateEventModal
 * ----------------
 * Create OR edit a scheduled event. Single component handles both
 * flows — `event` prop present = edit mode.
 *
 * Validation strategy: local checks for the obvious cases (name
 * non-empty, end > start, location-kind field pair) so the user
 * gets immediate feedback. Server runs the canonical validation
 * (including the past-time clamp with 60s slack and the voice
 * channel ownership check) and surfaces errors via toast.
 *
 * Date/time: native `datetime-local` inputs. The value format
 * (YYYY-MM-DDTHH:mm) is local-timezone — we convert to/from
 * Date for the API which uses ISO strings (UTC). Native picker
 * gives us the desktop calendar widget and mobile spinner free.
 */
import { useState, useMemo } from 'react';
import { ApiError, type Guild, type ScheduledEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { Portal } from '../lib/Portal';
import { X, Calendar } from '../lib/icons';

export function CreateEventModal({
  guild,
  event,
  onClose,
  onCreated,
}: {
  guild: Guild;
  /** When present, the form edits this event instead of creating. */
  event?: ScheduledEvent;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { rest } = useAuth();
  const { state } = useAppState();

  // Helpers for the datetime-local input format. The native input
  // takes/produces "YYYY-MM-DDTHH:mm" in LOCAL time; we convert
  // to/from ISO (UTC) for the API.
  const toLocalInputValue = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    // Pad helpers — Date methods return numbers, native input wants 2-digit.
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInputValue = (s: string): string | null => {
    if (!s) return null;
    // datetime-local strings are parsed as local time when fed to
    // the Date constructor.
    return new Date(s).toISOString();
  };

  // Default start: nearest 15-minute slot in the next hour (gives
  // admins a sane preset for "I'm scheduling something for soon").
  const defaultStart = useMemo(() => {
    if (event) return toLocalInputValue(event.startAt);
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15);
    d.setSeconds(0, 0);
    d.setHours(d.getHours() + 1);
    return toLocalInputValue(d.toISOString());
  }, [event]);

  const [name, setName] = useState(event?.name ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [startLocal, setStartLocal] = useState(defaultStart);
  const [endLocal, setEndLocal] = useState(event?.endAt ? toLocalInputValue(event.endAt) : '');
  const [locationKind, setLocationKind] = useState<'voice_channel' | 'external'>(
    event?.locationKind ?? 'voice_channel',
  );
  const [locationChannelId, setLocationChannelId] = useState<string>(
    event?.locationChannelId ?? '',
  );
  const [locationText, setLocationText] = useState(event?.locationText ?? '');
  const [imageUrl, setImageUrl] = useState(event?.imageUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Available voice/stage channels for the picker.
  const voiceChannels = useMemo(() => {
    const channels = state.channelsByGuild[guild.id] ?? [];
    return channels.filter((c) => c.type === 'guild_voice' || c.type === 'guild_stage');
  }, [state.channelsByGuild, guild.id]);

  const isEdit = !!event;

  async function handleSubmit() {
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError('Name is required');
      return;
    }
    if (trimmedName.length > 100) {
      setError('Name is too long (max 100 chars)');
      return;
    }
    const startAt = fromLocalInputValue(startLocal);
    if (!startAt) {
      setError('Start time is required');
      return;
    }
    const endAt = fromLocalInputValue(endLocal);
    if (endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      setError('End time must be after start time');
      return;
    }
    if (locationKind === 'voice_channel' && !locationChannelId) {
      setError('Pick a voice channel for this event');
      return;
    }
    if (locationKind === 'external' && !locationText.trim()) {
      setError('Enter a location for this event');
      return;
    }

    const payload = {
      name: trimmedName,
      description: description.trim() ? description : null,
      startAt,
      endAt,
      locationKind,
      locationChannelId: locationKind === 'voice_channel' ? locationChannelId : null,
      locationText: locationKind === 'external' ? locationText.trim() : null,
      imageUrl: imageUrl.trim() ? imageUrl.trim() : null,
    };

    setBusy(true);
    try {
      if (isEdit && event) {
        await rest.updateEvent(guild.id, event.id, payload);
      } else {
        await rest.createEvent(guild.id, payload);
      }
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[60] bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-event-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-xl max-h-[88vh] flex flex-col shadow-2xl">
          {/* Header */}
          <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
            <span className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
              <Calendar size={16} className="text-accent" />
            </span>
            <h2 id="create-event-title" className="text-base font-semibold text-ink-1 flex-1">
              {isEdit ? 'Edit event' : 'Create event'}
            </h2>
            <button
              onClick={onClose}
              className="shrink-0 w-7 h-7 rounded-md hover:bg-bg-3 text-ink-2 flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Form body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <Field label="Name">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="e.g. Friday Movie Night"
                className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
              />
            </Field>

            <Field
              label="Description"
              hint="What's the event about? Show notes, links, or context."
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder="(optional)"
                rows={4}
                className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent resize-y"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Start">
                <input
                  type="datetime-local"
                  value={startLocal}
                  onChange={(e) => setStartLocal(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
                />
              </Field>
              <Field label="End" hint="Optional. Leave blank for open-ended events.">
                <input
                  type="datetime-local"
                  value={endLocal}
                  onChange={(e) => setEndLocal(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
                />
              </Field>
            </div>

            <Field label="Location">
              <div className="space-y-2">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setLocationKind('voice_channel')}
                    className={`flex-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                      locationKind === 'voice_channel'
                        ? 'bg-accent/15 border-accent text-accent'
                        : 'bg-bg-3 border-line text-ink-2 hover:bg-bg-3/80'
                    }`}
                  >
                    Voice channel
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocationKind('external')}
                    className={`flex-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                      locationKind === 'external'
                        ? 'bg-accent/15 border-accent text-accent'
                        : 'bg-bg-3 border-line text-ink-2 hover:bg-bg-3/80'
                    }`}
                  >
                    Somewhere else
                  </button>
                </div>

                {locationKind === 'voice_channel' ? (
                  voiceChannels.length === 0 ? (
                    <p className="text-xs text-ink-3 italic">
                      This server has no voice channels yet. Create one first, or pick
                      "Somewhere else" for an external event.
                    </p>
                  ) : (
                    <select
                      value={locationChannelId}
                      onChange={(e) => setLocationChannelId(e.target.value)}
                      className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
                    >
                      <option value="">— Pick a voice channel —</option>
                      {voiceChannels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          #{ch.name}
                        </option>
                      ))}
                    </select>
                  )
                ) : (
                  <input
                    type="text"
                    value={locationText}
                    onChange={(e) => setLocationText(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. Twitter Spaces, Zoom link, or an address"
                    className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
                  />
                )}
              </div>
            </Field>

            <Field
              label="Banner image"
              hint="Optional. Upload an image (PNG / JPEG / GIF / WebP). A 16:9 image looks best."
            >
              {isEdit && event ? (
                <EventImageUploader
                  guildId={guild.id}
                  eventId={event.id}
                  currentUrl={imageUrl || null}
                  onUpload={(url) => setImageUrl(url)}
                  onError={(msg) => setError(msg)}
                />
              ) : (
                <EventImageUploaderPrecreate
                  guildId={guild.id}
                  currentUrl={imageUrl || null}
                  onUpload={(url) => setImageUrl(url)}
                  onError={(msg) => setError(msg)}
                />
              )}
            </Field>

            {error && (
              <p className="text-xs text-red-300" role="alert">
                {error}
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-line shrink-0 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-4 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2 disabled:opacity-60 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={busy}
              className="px-4 py-1.5 rounded-md bg-accent hover:bg-accent/85 text-bg-1 text-sm font-medium disabled:opacity-60 transition-colors"
            >
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-ink-3 mt-1">{hint}</span>}
    </label>
  );
}

/**
 * EventImageUploader — preview + multipart upload affordance for the
 * edit flow. Upload fires immediately on file selection (not deferred
 * to the parent submit) because the server endpoint takes effect
 * atomically and broadcasts to other clients. The parent's local
 * imageUrl state is updated via the callback so a subsequent edit
 * save doesn't accidentally clear the just-uploaded image.
 */
function EventImageUploader({
  guildId,
  eventId,
  currentUrl,
  onUpload,
  onError,
}: {
  guildId: string;
  eventId: string;
  currentUrl: string | null;
  onUpload: (url: string) => void;
  onError: (msg: string) => void;
}) {
  const { rest } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    onError('');
    try {
      const r = await rest.uploadEventImage(guildId, eventId, file);
      onUpload(r.event.imageUrl ?? '');
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {currentUrl && (
        <div className="w-full h-28 rounded-md overflow-hidden border border-line bg-bg-3">
          <img
            src={currentUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}
      <label
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
          busy
            ? 'bg-bg-3 border-line text-ink-3 cursor-wait'
            : 'bg-bg-3 border-line text-ink-1 hover:bg-bg-3/80 cursor-pointer'
        }`}
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so re-selecting the same file triggers change again.
            e.target.value = '';
          }}
        />
        {busy ? 'Uploading…' : currentUrl ? 'Replace image' : 'Choose image'}
      </label>
    </div>
  );
}

/**
 * EventImageUploaderPrecreate — banner upload for the CREATE flow.
 * Same shape as EventImageUploader but uses the pre-create endpoint
 * (no eventId needed). The returned URL is held in parent state
 * and embedded in createEvent's imageUrl when the user submits.
 *
 * If the user uploads an image then cancels the create form, the
 * file sits on the CDN unreferenced — a known v1 limitation. A
 * follow-up sweep can GC any attachment not referenced by any
 * entity (event imageUrl, guild icon, user avatar, etc.).
 */
function EventImageUploaderPrecreate({
  guildId,
  currentUrl,
  onUpload,
  onError,
}: {
  guildId: string;
  currentUrl: string | null;
  onUpload: (url: string) => void;
  onError: (msg: string) => void;
}) {
  const { rest } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setBusy(true);
    onError('');
    try {
      const r = await rest.uploadEventImagePrecreate(guildId, file);
      onUpload(r.url);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {currentUrl && (
        <div className="w-full h-28 rounded-md overflow-hidden border border-line bg-bg-3">
          <img
            src={currentUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}
      <label
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
          busy
            ? 'bg-bg-3 border-line text-ink-3 cursor-wait'
            : 'bg-bg-3 border-line text-ink-1 hover:bg-bg-3/80 cursor-pointer'
        }`}
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so re-selecting the same file triggers change again.
            e.target.value = '';
          }}
        />
        {busy ? 'Uploading…' : currentUrl ? 'Replace image' : 'Choose image'}
      </label>
    </div>
  );
}
