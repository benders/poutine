/**
 * Sonos firmware-level audio capability gate (#199).
 *
 * Sonos accepts FLAC bytes via `ConnectionManager:GetProtocolInfo` but the
 * device firmware silently STOPs playback when the FLAC exceeds line-specific
 * ceilings (24/48 on S2, 16/48 on S1, stereo only on every line). protocolInfo
 * does not surface those ceilings — they are derived from the device model
 * string out of `/xml/device_description.xml`.
 *
 * This module is pure: model string + Subsonic `getSong` metadata in, a
 * pass-through / transcode decision out. No I/O, no app state.
 */
export type SonosLine = "s2" | "s1" | "unknown";

export interface SonosCapability {
  maxBitDepth: number;
  maxSampleRate: number;
  maxChannels: number;
}

const S2: SonosCapability = { maxBitDepth: 24, maxSampleRate: 48000, maxChannels: 2 };
const S1: SonosCapability = { maxBitDepth: 16, maxSampleRate: 48000, maxChannels: 2 };

// S2-era model tokens. Substring match against the lowercased model string.
// Roam, Move, Era 100/300, Beam Gen2, Arc, Five, Sub Mini, One SL (post-firmware),
// Symfonisk Gen2, Ray. Conservative: anything we don't recognise → S1.
const S2_TOKENS = [
  "era",
  "arc",
  "beam",
  "move",
  "roam",
  "five",
  "ray",
  "sub mini",
  "one sl",
  "symfonisk",
];

// Explicit S1-era model tokens. Used only to disambiguate vs. unknown — both
// map to the S1 capability set, but classifying lets us log the line cleanly.
const S1_TOKENS = ["play:1", "play:3", "play:5", "playbar", "playbase", "connect"];

export function classifyModel(model: string | undefined): SonosLine {
  if (!model) return "unknown";
  const lower = model.toLowerCase();
  if (S2_TOKENS.some((t) => lower.includes(t))) return "s2";
  if (S1_TOKENS.some((t) => lower.includes(t))) return "s1";
  return "unknown";
}

export function capabilityFor(model: string | undefined): SonosCapability {
  return classifyModel(model) === "s2" ? S2 : S1;
}

/**
 * True when the source exceeds the target's ceiling and must be transcoded
 * (currently → MP3 via Subsonic `format=mp3`).
 *
 * - `bitDepth === 0` is treated as lossy (MP3/AAC report 0). Lossy never
 *   triggers a bit-depth transcode on its own.
 * - Missing samplingRate is treated as "no signal" → pass-through. We never
 *   transcode a track we can't reason about; worst case is the existing
 *   silent-STOP behaviour, which is what we already had pre-fix.
 * - `channelCount > 2` (any multi-channel source) → force MP3 on every Sonos
 *   line. No Sonos generation plays multi-channel FLAC locally.
 */
export function shouldForceMp3(
  model: string | undefined,
  samplingRate: number | undefined,
  bitDepth: number | undefined,
  channelCount: number | undefined,
): boolean {
  const cap = capabilityFor(model);
  if (typeof channelCount === "number" && channelCount > cap.maxChannels) return true;
  if (typeof samplingRate === "number" && samplingRate > cap.maxSampleRate) return true;
  if (typeof bitDepth === "number" && bitDepth > 0 && bitDepth > cap.maxBitDepth) return true;
  return false;
}
