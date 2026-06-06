/**
 * Voice quality settings
 * ----------------------
 * User-tunable audio/video bitrate caps for voice and screen-share. The
 * settings persist in localStorage and apply at the moment a Room is
 * constructed — changing them requires leaving and rejoining voice for
 * the new caps to take effect (LiveKit doesn't surface a runtime
 * publishDefaults setter).
 *
 * Three presets:
 *   - high:   96 kbps stereo audio,  720p video, 1.5 Mbps cap
 *   - normal: 64 kbps mono   audio,  480p video, 800 kbps cap (default)
 *   - low:    24 kbps mono   audio,  360p video, 300 kbps cap
 *
 * The presets are coarse on purpose. Most users don't care about
 * specific bitrates; they care about "audio sounds good" vs "stop
 * eating my data plan." Three options is enough granularity.
 *
 * The "high" preset is a meaningful jump for music + group voice.
 * "low" is for users on metered cellular connections — speech-only,
 * low CPU, low data.
 */

export type VoiceQuality = 'high' | 'normal' | 'low';

const KEY = 'zekktris.voice.quality';
const DEFAULT: VoiceQuality = 'normal';

interface QualityPreset {
  /** Audio bitrate in bps. Applied to the published mic track. */
  audioBitrate: number;
  /** Channels: 1 = mono (smaller), 2 = stereo (better for music). */
  audioChannels: 1 | 2;
  /** Video resolution width — used for camera + screen share publish. */
  videoWidth: number;
  videoHeight: number;
  /** Video bitrate cap in bps. */
  videoBitrate: number;
  /** Display label shown in settings. */
  label: string;
  /** Help text under the option. */
  help: string;
}

export const QUALITY_PRESETS: Record<VoiceQuality, QualityPreset> = {
  high: {
    audioBitrate: 96_000,
    audioChannels: 2,
    videoWidth: 1280,
    videoHeight: 720,
    videoBitrate: 1_500_000,
    label: 'High',
    help: 'Stereo 96 kbps audio, 720p video. Best on wifi.',
  },
  normal: {
    audioBitrate: 64_000,
    audioChannels: 1,
    videoWidth: 854,
    videoHeight: 480,
    videoBitrate: 800_000,
    label: 'Normal',
    help: 'Mono 64 kbps audio, 480p video. Balanced default.',
  },
  low: {
    audioBitrate: 24_000,
    audioChannels: 1,
    videoWidth: 640,
    videoHeight: 360,
    videoBitrate: 300_000,
    label: 'Low',
    help: 'Mono 24 kbps audio, 360p video. Best on cellular.',
  },
};

export function getVoiceQuality(): VoiceQuality {
  if (typeof localStorage === 'undefined') return DEFAULT;
  const v = localStorage.getItem(KEY);
  if (v === 'high' || v === 'normal' || v === 'low') return v;
  return DEFAULT;
}

export function setVoiceQuality(q: VoiceQuality): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, q);
}

export function getCurrentPreset(): QualityPreset {
  return QUALITY_PRESETS[getVoiceQuality()];
}
