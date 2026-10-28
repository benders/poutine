/**
 * shrink-guard.ts — library-shrink guard (issue #297, parent #296).
 *
 * A sync deletes every `instance_*` row it did not see. When the music share
 * behind Navidrome drops (SMB/NFS outage, sleeping USB volume), Navidrome
 * reports an empty-but-valid library and the sync would delete the whole
 * catalog. On Navidrome 0.64 a single unreadable top-level folder has the
 * same effect, with no scan error to key on. So the hub judges the result
 * itself: a sync that shrinks the library too far is held, not applied.
 *
 * Compares track **counts**, never ids: Navidrome re-encodes ids on some
 * upgrades (0.63 → 0.64) and on purge-and-rediscover, so an id diff would
 * flag a legitimate same-size library as a total loss.
 */

/** Default for `POUTINE_SHRINK_GUARD_PERCENT`. */
export const DEFAULT_SHRINK_GUARD_PERCENT = 20;

/**
 * Below this many tracks the percentage rule is off — a 50-track library
 * losing one album is a normal edit, not an outage. Dropping to zero is
 * still held at any size.
 */
export const SHRINK_GUARD_MIN_TRACKS = 100;

export interface ShrinkDecision {
  hold: boolean;
  /** Operator-facing explanation; present when `hold` is true. */
  reason?: string;
}

/**
 * @param previous Tracks after the last applied sync (`instances.track_count`).
 * @param seen     Distinct tracks this sync read.
 * @param percent  Threshold; 0 disables the guard entirely.
 */
export function evaluateShrink(
  previous: number,
  seen: number,
  percent: number,
): ShrinkDecision {
  if (percent <= 0 || previous <= 0 || seen >= previous) return { hold: false };

  if (seen === 0) {
    return {
      hold: true,
      reason: `library went from ${previous} tracks to 0 — music share unmounted or unreadable?`,
    };
  }

  const dropPercent = ((previous - seen) / previous) * 100;
  if (previous >= SHRINK_GUARD_MIN_TRACKS && dropPercent > percent) {
    return {
      hold: true,
      reason: `library shrank from ${previous} to ${seen} tracks (−${dropPercent.toFixed(0)}%, threshold ${percent}%)`,
    };
  }
  return { hold: false };
}
