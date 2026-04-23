/**
 * Single place that decides which Subsonic passthrough params are forwarded
 * to an upstream Navidrome (local or via a peer's /federation/stream).
 *
 * Raw-vs-transcode decisions are delegated to Navidrome: it returns raw bytes
 * when the requested format matches the source and the bitrate cap is not
 * exceeded, and transcodes otherwise.
 */
const PASSTHROUGH_PARAMS = [
  "format",
  "maxBitRate",
  "timeOffset",
  "estimateContentLength",
  "converted",
] as const;

export function buildStreamParams(
  q: Record<string, string | undefined>,
): URLSearchParams {
  const p = new URLSearchParams();
  for (const key of PASSTHROUGH_PARAMS) {
    const val = q[key];
    if (val !== undefined && val !== "") p.set(key, val);
  }
  return p;
}
