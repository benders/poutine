import type Database from "better-sqlite3";
import { sqliteToIso } from "../util/time.js";

export interface RecordPlayOptions {
  userId: string;
  unifiedTrackId: string;
  sourceInstanceId?: string | null;
  durationPlayedMs?: number | null;
  clientName?: string | null;
  /**
   * Epoch milliseconds of when the play actually occurred (Subsonic `time`).
   * Lets offline/batching clients backfill plays at their real time instead of
   * sync time. Omit/null to stamp `now`.
   */
  playedAtMs?: number | null;
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
  private readonly insertAtStmt: Database.Statement;

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
    // Variant that stamps a client-supplied time (epoch ms → unixepoch seconds).
    this.insertAtStmt = db.prepare(
      `INSERT INTO play_events (
         id, user_id, unified_track_id, source_instance_id,
         played_at, duration_played_ms, client_name
       ) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', ? / 1000.0, 'unixepoch'), ?, ?)`,
    );
  }

  /**
   * Record a play. The threshold decision (Last.fm-style: half the track or
   * 4 minutes) is owned by the client that calls /rest/scrobble — every
   * playback surface in this app reports its own position, so the server just
   * persists what it's told. `playedAtMs` backfills the timestamp; absent, the
   * play is stamped now.
   */
  record(opts: RecordPlayOptions): void {
    if (opts.playedAtMs != null) {
      this.insertAtStmt.run(
        crypto.randomUUID(),
        opts.userId,
        opts.unifiedTrackId,
        opts.sourceInstanceId ?? null,
        opts.playedAtMs,
        opts.durationPlayedMs ?? null,
        opts.clientName ?? null,
      );
      return;
    }
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
