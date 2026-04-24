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

// Lossy codecs — transcoding a lossy source to a different lossy codec
// costs CPU and always degrades quality. If the source already fits under
// the bitrate cap, drop the requested `format` so upstream Navidrome serves
// the raw bytes. Lossless sources (flac, wav, alac) honor the request so
// the client actually receives the compressed format it asked for.
const LOSSY_FORMATS = new Set(["mp3", "opus", "aac", "ogg", "m4a"]);

/**
 * Rewrite a set of Subsonic stream params in light of what the hub knows
 * about the source file. The rule (issue #94):
 *
 *   - Source lossy AND source bitrate <= requested maxBitRate → drop
 *     `format` so upstream serves raw bytes. `maxBitRate` is kept (it's a
 *     ceiling; upstream will still transcode if the source exceeds it).
 *   - Source lossless → keep `format` as-is (honor the request).
 *   - Source format unknown → no change (defer to upstream).
 *
 * The hub applies this for every /rest/stream caller — SPA and 3rd-party
 * Subsonic clients alike — because the calling hub is the only party that
 * knows source format/bitrate for peer-routed tracks.
 */
export function applyTranscodeRule(
  params: URLSearchParams,
  source: { format: string | null; bitrate: number | null },
): URLSearchParams {
  const out = new URLSearchParams(params);
  const reqFmt = out.get("format");
  const srcFmt = source.format?.toLowerCase() ?? null;
  if (!reqFmt || !srcFmt) return out;
  if (reqFmt.toLowerCase() === srcFmt) {
    // Already asking for the source format; let upstream passthrough.
    out.delete("format");
    return out;
  }
  if (!LOSSY_FORMATS.has(srcFmt)) return out; // lossless — honor request
  const cap = Number(out.get("maxBitRate")) || Infinity;
  const srcBr = source.bitrate ?? Infinity;
  if (srcBr <= cap) out.delete("format");
  return out;
}
