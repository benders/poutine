import type Database from "better-sqlite3";
import { sqliteToIso } from "../util/time.js";

// Last.fm-style scrobble threshold: a play counts once the listener has heard
// at least half the track, capped at 4 minutes (so very long tracks still
// count after a reasonable listen). When the track length is unknown we fall
// back to the 4-minute floor.
const PLAY_THRESHOLD_CAP_MS = 240_000;

export interface RecordPlayOptions {
  userId: string;
  unifiedTrackId: string;
  sourceInstanceId?: string | null;
  durationPlayedMs?: number | null;
  clientName?: string | null;
}

export interface PlayStats {
  /** Number of times this user has played the target. */
  playCount: number;
  /** ISO 8601 timestamp of the most recent play, or null if never played. */
  played: string | null;
}

/**
 * Canonical per-user play history across the merged catalog (#197).
 *
 * Backs Subsonic `playCount` / `played` and the `getAlbumList2`
 * `type=frequent` / `type=recent` orderings. Distinct from
 * `StreamTrackingService` (ephemeral activity feed): play_events is durable and
 * never pruned. Counts are per-user, matching the Subsonic spec.
 */
export class PlayEventService {
  private readonly insertStmt: Database.Statement;
  private readonly trackDurationStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    // Millisecond precision (strftime %f) so `type=recent` ordering is stable
    // between plays in the same wall-clock second. sqliteToIso turns the
    // "YYYY-MM-DD HH:MM:SS.SSS" form into a valid ISO 8601 timestamp.
    this.insertStmt = db.prepare(
      `INSERT INTO play_events (
         id, user_id, unified_track_id, source_instance_id,
         played_at, duration_played_ms, client_name
       ) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?)`,
    );
    this.trackDurationStmt = db.prepare(
      "SELECT duration_ms FROM unified_tracks WHERE id = ?",
    );
  }

  /** Record a play unconditionally. The caller owns the count decision. */
  record(opts: RecordPlayOptions): void {
    this.insertStmt.run(
      crypto.randomUUID(),
      opts.userId,
      opts.unifiedTrackId,
      opts.sourceInstanceId ?? null,
      opts.durationPlayedMs ?? null,
      opts.clientName ?? null,
    );
  }

  /**
   * Record a play only if the played duration crosses the scrobble threshold.
   * Used by server-driven surfaces (Sonos cast, DLNA) where there is no client
   * scrobble — the played duration is the stream connection lifetime. Returns
   * true if a play was recorded.
   */
  recordIfThreshold(
    opts: RecordPlayOptions & { durationPlayedMs: number },
  ): boolean {
    const row = this.trackDurationStmt.get(opts.unifiedTrackId) as
      | { duration_ms: number | null }
      | undefined;
    const trackMs = row?.duration_ms ?? null;
    const threshold = trackMs
      ? Math.min(Math.floor(trackMs / 2), PLAY_THRESHOLD_CAP_MS)
      : PLAY_THRESHOLD_CAP_MS;
    if (opts.durationPlayedMs < threshold) return false;
    this.record(opts);
    return true;
  }

  /**
   * Per-user play stats for a set of unified track ids. Missing ids return no
   * entry (caller treats as zero plays). `played` is ISO 8601.
   */
  getTrackStats(
    userId: string | undefined,
    trackIds: string[],
  ): Map<string, PlayStats> {
    const out = new Map<string, PlayStats>();
    if (!userId || trackIds.length === 0) return out;
    const placeholders = trackIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT unified_track_id AS tid, COUNT(*) AS cnt, MAX(played_at) AS last
         FROM play_events
         WHERE user_id = ? AND unified_track_id IN (${placeholders})
         GROUP BY unified_track_id`,
      )
      .all(userId, ...trackIds) as Array<{
        tid: string;
        cnt: number;
        last: string;
      }>;
    for (const r of rows) {
      out.set(r.tid, { playCount: r.cnt, played: sqliteToIso(r.last) });
    }
    return out;
  }

  /**
   * Per-user play stats for a set of release-group (album) ids. Album playCount
   * is the sum of plays of its tracks; `played` is the most recent track play.
   */
  getAlbumStats(
    userId: string | undefined,
    releaseGroupIds: string[],
  ): Map<string, PlayStats> {
    const out = new Map<string, PlayStats>();
    if (!userId || releaseGroupIds.length === 0) return out;
    const placeholders = releaseGroupIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ur.release_group_id AS rg, COUNT(*) AS cnt, MAX(pe.played_at) AS last
         FROM play_events pe
         JOIN unified_tracks ut ON ut.id = pe.unified_track_id
         JOIN unified_releases ur ON ur.id = ut.release_id
         WHERE pe.user_id = ? AND ur.release_group_id IN (${placeholders})
         GROUP BY ur.release_group_id`,
      )
      .all(userId, ...releaseGroupIds) as Array<{
        rg: string;
        cnt: number;
        last: string;
      }>;
    for (const r of rows) {
      out.set(r.rg, { playCount: r.cnt, played: sqliteToIso(r.last) });
    }
    return out;
  }
}
