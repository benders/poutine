import type Database from "better-sqlite3";

/** Per-category orphan count with a capped sample of offending target IDs. */
export interface OrphanCategory {
  count: number;
  samples: string[];
}

/**
 * Post-merge orphan audit. `unified_*` tables are cleared and rebuilt on
 * every merge (merge.ts), so any row elsewhere in the DB that references a
 * unified id by value (no FK — user_stars, play_events; FK exists on
 * playlist_tracks but cascades can still leave stale references mid-sync)
 * can end up pointing at nothing. This never fixes anything — it just
 * counts and samples so callers can log/report.
 */
export interface OrphanReport {
  starsTrack: OrphanCategory;
  starsAlbum: OrphanCategory;
  starsArtist: OrphanCategory;
  playlistTracks: OrphanCategory;
  playEvents: OrphanCategory;
  total: number;
}

const SAMPLE_LIMIT = 10;

function auditStars(db: Database.Database, kind: "track" | "album" | "artist", unifiedTable: string): OrphanCategory {
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM user_stars s
         WHERE s.kind = ?
           AND NOT EXISTS (SELECT 1 FROM ${unifiedTable} u WHERE u.id = s.target_id)`,
      )
      .get(kind) as { n: number }
  ).n;
  const samples = (
    db
      .prepare(
        `SELECT DISTINCT s.target_id AS id FROM user_stars s
         WHERE s.kind = ?
           AND NOT EXISTS (SELECT 1 FROM ${unifiedTable} u WHERE u.id = s.target_id)
         LIMIT ?`,
      )
      .all(kind, SAMPLE_LIMIT) as Array<{ id: string }>
  ).map((r) => r.id);
  return { count, samples };
}

function auditPlaylistTracks(db: Database.Database): OrphanCategory {
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM playlist_tracks pt
         WHERE NOT EXISTS (SELECT 1 FROM unified_tracks u WHERE u.id = pt.unified_track_id)`,
      )
      .get() as { n: number }
  ).n;
  const samples = (
    db
      .prepare(
        `SELECT DISTINCT pt.unified_track_id AS id FROM playlist_tracks pt
         WHERE NOT EXISTS (SELECT 1 FROM unified_tracks u WHERE u.id = pt.unified_track_id)
         LIMIT ?`,
      )
      .all(SAMPLE_LIMIT) as Array<{ id: string }>
  ).map((r) => r.id);
  return { count, samples };
}

function auditPlayEvents(db: Database.Database): OrphanCategory {
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM play_events pe
         WHERE NOT EXISTS (SELECT 1 FROM unified_tracks u WHERE u.id = pe.unified_track_id)`,
      )
      .get() as { n: number }
  ).n;
  const samples = (
    db
      .prepare(
        `SELECT DISTINCT pe.unified_track_id AS id FROM play_events pe
         WHERE NOT EXISTS (SELECT 1 FROM unified_tracks u WHERE u.id = pe.unified_track_id)
         LIMIT ?`,
      )
      .all(SAMPLE_LIMIT) as Array<{ id: string }>
  ).map((r) => r.id);
  return { count, samples };
}

/** Sum of per-category counts. */
export function totalOrphans(report: OrphanReport): number {
  return (
    report.starsTrack.count +
    report.starsAlbum.count +
    report.starsArtist.count +
    report.playlistTracks.count +
    report.playEvents.count
  );
}

/**
 * Scan for rows whose target unified id no longer exists. Intended to run
 * immediately after `mergeLibraries()` rebuilds the unified_* tables.
 */
export function auditOrphans(db: Database.Database): OrphanReport {
  const starsTrack = auditStars(db, "track", "unified_tracks");
  const starsAlbum = auditStars(db, "album", "unified_release_groups");
  const starsArtist = auditStars(db, "artist", "unified_artists");
  const playlistTracks = auditPlaylistTracks(db);
  const playEvents = auditPlayEvents(db);

  const report: OrphanReport = {
    starsTrack,
    starsAlbum,
    starsArtist,
    playlistTracks,
    playEvents,
    total: 0,
  };
  report.total = totalOrphans(report);
  return report;
}
