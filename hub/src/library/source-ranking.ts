/**
 * Source ranking for `track_sources` (#241).
 *
 * One rule, two consumers: merge picks the `preferred = 1` row with it, and
 * `/rest/stream` walks the full ranked list when that row's source is
 * unreachable. Both derive from FORMAT_RANK so they can never drift — the SQL
 * fragment and the comparator are asserted equivalent in
 * test/source-ranking.test.ts.
 *
 * Rule:
 *   1. Higher-quality format wins (FLAC > WAV > ALAC > Opus > AAC > MP3 > Ogg).
 *   2. Tie → higher bitrate.
 *   3. Tie → local instance.
 *   4. Tie → lowest id (stable).
 */

export const FORMAT_RANK: Readonly<Record<string, number>> = {
  flac: 100,
  wav: 90,
  alac: 85,
  opus: 70,
  aac: 60,
  mp3: 50,
  ogg: 45,
};

/** Rank for a format absent from FORMAT_RANK (including null). */
export const UNKNOWN_FORMAT_RANK = 30;

export function formatRank(format: string | null): number {
  return FORMAT_RANK[(format ?? "").toLowerCase()] ?? UNKNOWN_FORMAT_RANK;
}

const formatCases = Object.entries(FORMAT_RANK)
  .map(([fmt, rank]) => `WHEN '${fmt}' THEN ${rank}`)
  .join(" ");

/**
 * `ORDER BY` terms (no keyword) ranking `track_sources` rows best-first.
 * Expects the table aliased as `ts`.
 */
export const SOURCE_RANK_ORDER_BY = `
  CASE LOWER(COALESCE(ts.format, '')) ${formatCases} ELSE ${UNKNOWN_FORMAT_RANK} END DESC,
  COALESCE(ts.bitrate, 0) DESC,
  CASE WHEN ts.instance_id = 'local' THEN 1 ELSE 0 END DESC,
  ts.id ASC`;

export interface RankableSource {
  id: string;
  instance_id: string;
  format: string | null;
  bitrate: number | null;
}

/** Array.sort comparator equivalent to SOURCE_RANK_ORDER_BY (best first). */
export function compareSources(a: RankableSource, b: RankableSource): number {
  return (
    formatRank(b.format) - formatRank(a.format) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
    Number(b.instance_id === "local") - Number(a.instance_id === "local") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
