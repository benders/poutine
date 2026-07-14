/**
 * Cover art size normalization for `/rest/getCoverArt`.
 *
 * The SPA (and third-party clients) request a handful of distinct sizes
 * (48/80/300/400) plus unsized requests for embedded art. Caching whatever
 * bytes the upstream happens to hand back — keyed by the raw `size` string —
 * meant an unsized request cached full original bytes (sometimes several MB)
 * and every distinct size string produced its own cache entry even when the
 * upstream ignored `size` entirely (the external fanart.tv/Last.fm branch).
 * Normalizing to a clamped integer gives every request a bounded, dedupable
 * cache key.
 */

const MIN_SIZE = 16;
const MAX_SIZE = 1024;
const DEFAULT_SIZE = 1024;

/**
 * Parse and clamp the `size` query param to `[MIN_SIZE, MAX_SIZE]`.
 * Absent, empty, non-numeric, or <= 0 falls back to `DEFAULT_SIZE`.
 */
export function effectiveArtSize(sizeParam: string | undefined): number {
  if (!sizeParam) return DEFAULT_SIZE;

  const parsed = parseInt(sizeParam, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SIZE;

  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, parsed));
}
