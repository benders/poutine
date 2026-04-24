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

const LOSSY_FORMATS = new Set(["mp3", "opus", "aac", "ogg"]);

/**
 * Drop the `format` param when transcoding would be wasteful:
 * the source is already lossy and is already below the bitrate cap.
 * Keeps `maxBitRate` so Navidrome still enforces the ceiling if needed.
 *
 * Lossless sources (flac/wav/alac) are always transcoded when the client
 * asks for a different format. Unknown source formats defer to the upstream.
 */
export function adjustStreamParamsForSource(
  params: URLSearchParams,
  source: { format: string | null; bitrate: number | null },
): URLSearchParams {
  const reqFormat = params.get("format");
  if (!reqFormat) return params;
  const sf = source.format?.toLowerCase();
  if (!sf) return params;
  if (sf === reqFormat.toLowerCase()) {
    params.delete("format");
    return params;
  }
  if (!LOSSY_FORMATS.has(sf)) return params;
  const maxBr = params.get("maxBitRate");
  const cap = maxBr ? parseInt(maxBr, 10) : null;
  if (cap != null && source.bitrate != null && source.bitrate > cap) {
    return params;
  }
  params.delete("format");
  return params;
}
