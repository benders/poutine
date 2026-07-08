import type Database from "better-sqlite3";
import { audioSourceFields } from "../../routes/subsonic/builders.js";

// ── Source selection subquery ─────────────────────────────────────────────────
// Returns the best source for a track (highest bitrate). Used for format,
// bitrate, size, and instance_name. Copy-pasted 3x in getAlbum, getSong,
// search3 — fine for now, could be a CTE/lateral join if query plans get heavy.
const BEST_SOURCE_SUBQUERY = `
  (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ?
   ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1)
`;

const BEST_SOURCE_INSTANCE_SUBQUERY = `
  (SELECT i.name FROM track_sources ts
   JOIN instances i ON i.id = ts.instance_id
   WHERE ts.unified_track_id = ?
   ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1)
`;

/**
 * Prepared-statement factory for hub/src/routes/subsonic.ts (#243 phase 2).
 *
 * All statements here are prepared eagerly, at plugin-init call time — this
 * extends the #130 hoisting convention (see docs/pitfalls.md "Concurrency")
 * from the star/unstar hot path to every static-SQL query in the route file.
 * Safe because SQLite statement preparation is idempotent and none of these
 * SQL strings are built from per-request input.
 *
 * Dynamic-SQL queries (e.g. getAlbumList2's WHERE/ORDER BY assembly) are NOT
 * here — they stay inline in subsonic.ts where the SQL is built.
 */
// Explicit interface (rather than an inferred return type, which trips TS4058
// under declaration emit; rather than Record<string, Statement>, which would
// let a misspelled statement name type-check at the call site).
export interface SubsonicQueries {
  starInsert: Database.Statement;
  starDelete: Database.Statement;
  starredArtists: Database.Statement;
  starredAlbums: Database.Statement;
  starredSongs: Database.Statement;
  userByUsername: Database.Statement;
  musicFolders: Database.Statement;
  genres: Database.Statement;
  artistsWithAlbumCount: Database.Statement;
  artistIndexRows: Database.Statement;
  artistById: Database.Statement;
  albumsForArtist: Database.Statement;
  artistInfoById: Database.Statement;
  updateArtistImageUrl: Database.Statement;
  instanceByMusicFolderId: Database.Statement;
  releaseGroupById: Database.Statement;
  bestReleaseForGroup: Database.Statement;
  tracksForRelease: Database.Statement;
  trackForSong: Database.Statement;
  searchArtists: Database.Statement;
  searchAlbums: Database.Statement;
  searchSongs: Database.Statement;
  trackForStream: Database.Statement;
  preferredSourceForStream: Database.Statement;
  trackExists: Database.Statement;
  sourceForScrobble: Database.Statement;
}

export function createSubsonicQueries(db: Database.Database): SubsonicQueries {
  return {
    // ── star / unstar / getStarred2 (#104, hoisted since #130) ───────────────
    starInsert: db.prepare(
      "INSERT OR IGNORE INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    ),
    starDelete: db.prepare(
      "DELETE FROM user_stars WHERE user_id = ? AND kind = ? AND target_id = ?",
    ),
    starredArtists: db.prepare(
      `SELECT ua.id, ua.name, ua.image_url,
        COUNT(urg.id) AS albumCount,
        us.starred_at
      FROM user_stars us
      JOIN unified_artists ua ON ua.id = us.target_id
      LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
      WHERE us.user_id = ? AND us.kind = 'artist'
      GROUP BY ua.id, ua.name, ua.image_url, us.starred_at
      ORDER BY us.starred_at DESC`,
    ),
    starredAlbums: db.prepare(
      `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
        urg.year, urg.genre, urg.image_url, urg.created_at,
        (SELECT COUNT(*) FROM unified_tracks ut
         JOIN unified_releases ur ON ur.id = ut.release_id
         WHERE ur.release_group_id = urg.id) AS songCount,
        us.starred_at
      FROM user_stars us
      JOIN unified_release_groups urg ON urg.id = us.target_id
      JOIN unified_artists ua ON ua.id = urg.artist_id
      WHERE us.user_id = ? AND us.kind = 'album'
      ORDER BY us.starred_at DESC`,
    ),
    starredSongs: db.prepare(
      `SELECT
        ut.id, ut.title, ut.track_number, ut.disc_number,
        ut.duration_ms, ut.genre, ut.musicbrainz_id,
        ut.artist_id, ua.name AS artist_name,
        urg.id AS rg_id, urg.name AS rg_name,
        urg.year AS rg_year, urg.image_url AS rg_image_url,
        urg.artist_id AS rg_artist_id, ua2.name AS rg_artist_name,
        (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
        (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
        (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
        ${audioSourceFields("ut.id")}
        (SELECT i.name FROM track_sources ts
         JOIN instances i ON i.id = ts.instance_id
         WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS instance_name,
        us.starred_at
      FROM user_stars us
      JOIN unified_tracks ut ON ut.id = us.target_id
      JOIN unified_artists ua ON ua.id = ut.artist_id
      JOIN unified_releases ur ON ur.id = ut.release_id
      JOIN unified_release_groups urg ON urg.id = ur.release_group_id
      JOIN unified_artists ua2 ON ua2.id = urg.artist_id
      WHERE us.user_id = ? AND us.kind = 'track'
      ORDER BY us.starred_at DESC`,
    ),

    // ── getUser ────────────────────────────────────────────────────────────────
    userByUsername: db.prepare("SELECT username, is_admin FROM users WHERE username = ?"),

    // ── getMusicFolders ──────────────────────────────────────────────────────────
    musicFolders: db.prepare(
      `SELECT musicfolder_id AS id, name FROM instances
       WHERE musicfolder_id IS NOT NULL
       ORDER BY musicfolder_id`,
    ),

    // ── getGenres ────────────────────────────────────────────────────────────────
    genres: db.prepare(
      `SELECT g.genre,
        (SELECT COUNT(*) FROM unified_release_groups WHERE genre = g.genre) AS albumCount,
        (SELECT COUNT(*) FROM unified_tracks WHERE genre = g.genre) AS songCount
      FROM (
        SELECT DISTINCT genre FROM unified_release_groups WHERE genre IS NOT NULL
        UNION
        SELECT DISTINCT genre FROM unified_tracks WHERE genre IS NOT NULL
      ) g
      ORDER BY g.genre`,
    ),

    // ── getArtists ─────────────────────────────────────────────────────────────
    // INNER JOIN drops artists with no release group of their own — see
    // subsonic.ts route comment for rationale.
    artistsWithAlbumCount: db.prepare(
      `SELECT ua.id, ua.name, ua.image_url,
        COUNT(urg.id) AS albumCount
      FROM unified_artists ua
      JOIN unified_release_groups urg ON urg.artist_id = ua.id
      GROUP BY ua.id, ua.name
      ORDER BY ua.name_normalized`,
    ),

    // ── getIndexes ─────────────────────────────────────────────────────────────
    artistIndexRows: db.prepare(
      `SELECT ua.id, ua.name,
        COUNT(urg.id) AS albumCount
      FROM unified_artists ua
      JOIN unified_release_groups urg ON urg.artist_id = ua.id
      GROUP BY ua.id, ua.name
      ORDER BY ua.name_normalized`,
    ),

    // ── getArtist ──────────────────────────────────────────────────────────────
    artistById: db.prepare("SELECT id, name, image_url FROM unified_artists WHERE id = ?"),
    albumsForArtist: db.prepare(
      `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
        urg.year, urg.genre, urg.image_url, urg.created_at,
        COUNT(ut.id) AS songCount
      FROM unified_release_groups urg
      JOIN unified_artists ua ON ua.id = urg.artist_id
      LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
      LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
      WHERE urg.artist_id = ?
      GROUP BY urg.id
      ORDER BY urg.year DESC, urg.name_normalized`,
    ),

    // ── getArtistInfo2 ─────────────────────────────────────────────────────────
    artistInfoById: db.prepare(
      "SELECT id, name, musicbrainz_id, image_url FROM unified_artists WHERE id = ?",
    ),
    updateArtistImageUrl: db.prepare("UPDATE unified_artists SET image_url = ? WHERE id = ?"),

    // ── getAlbumList2 (musicFolderId → instance alias, #123) ────────────────────
    instanceByMusicFolderId: db.prepare("SELECT id FROM instances WHERE musicfolder_id = ?"),
    // NOTE: getAlbumList2's main query is NOT here — its WHERE/ORDER BY/playJoin
    // are assembled per-request from a type/params switch. Left inline in
    // subsonic.ts.

    // ── getAlbum ───────────────────────────────────────────────────────────────
    releaseGroupById: db.prepare(
      `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
        urg.year, urg.genre, urg.image_url, urg.created_at
      FROM unified_release_groups urg
      JOIN unified_artists ua ON ua.id = urg.artist_id
      WHERE urg.id = ?`,
    ),
    // Pick the release with the most tracks (fall back to first by id)
    bestReleaseForGroup: db.prepare(
      `SELECT id FROM unified_releases
      WHERE release_group_id = ?
      ORDER BY track_count DESC, id ASC
      LIMIT 1`,
    ),
    tracksForRelease: db.prepare(
      `SELECT
        ut.id, ut.title, ut.track_number, ut.disc_number,
        ut.duration_ms, ut.genre, ut.musicbrainz_id,
        ut.artist_id, ua.name AS artist_name,
        urg.id AS rg_id, urg.name AS rg_name,
        urg.year AS rg_year, urg.image_url AS rg_image_url,
        urg.artist_id AS rg_artist_id, ua2.name AS rg_artist_name,
        (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
        (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
        (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
        ${audioSourceFields("ut.id")}
        ${BEST_SOURCE_INSTANCE_SUBQUERY.replace("?", "ut.id")} AS instance_name
      FROM unified_tracks ut
      JOIN unified_artists ua ON ua.id = ut.artist_id
      JOIN unified_releases ur ON ur.id = ut.release_id
      JOIN unified_release_groups urg ON urg.id = ur.release_group_id
      JOIN unified_artists ua2 ON ua2.id = urg.artist_id
      WHERE ut.release_id = ?
      ORDER BY ut.disc_number, ut.track_number, ut.id`,
    ),

    // ── getSong ────────────────────────────────────────────────────────────────
    trackForSong: db.prepare(
      `SELECT
        ut.id, ut.title, ut.track_number, ut.disc_number,
        ut.duration_ms, ut.genre, ut.musicbrainz_id,
        ut.artist_id, ua.name AS artist_name,
        urg.id AS rg_id, urg.name AS rg_name,
        urg.year AS rg_year, urg.image_url AS rg_image_url,
        urg.artist_id AS rg_artist_id, ua2.name AS rg_artist_name,
        (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
        (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
        (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
        ${audioSourceFields("ut.id")}
        ${BEST_SOURCE_INSTANCE_SUBQUERY.replace("?", "ut.id")} AS instance_name
      FROM unified_tracks ut
      JOIN unified_artists ua ON ua.id = ut.artist_id
      JOIN unified_releases ur ON ur.id = ut.release_id
      JOIN unified_release_groups urg ON urg.id = ur.release_group_id
      JOIN unified_artists ua2 ON ua2.id = urg.artist_id
      WHERE ut.id = ?`,
    ),

    // ── search3 ────────────────────────────────────────────────────────────────
    searchArtists: db.prepare(
      `SELECT ua.id, ua.name, ua.image_url, COUNT(urg.id) AS albumCount
      FROM unified_artists ua
      LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
      WHERE ua.name_normalized LIKE ?
        OR ua.id = ? OR ua.id = ?
        OR ua.musicbrainz_id = ? OR ua.musicbrainz_id = ?
        OR EXISTS (
          SELECT 1 FROM unified_artist_sources uas
          JOIN instance_artists iar ON iar.id = uas.instance_artist_id
          WHERE uas.unified_artist_id = ua.id AND iar.remote_id = ?
        )
      GROUP BY ua.id
      ORDER BY ua.name_normalized
      LIMIT ? OFFSET ?`,
    ),
    searchAlbums: db.prepare(
      `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
        urg.year, urg.genre, urg.image_url, urg.created_at,
        COUNT(ut.id) AS songCount
      FROM unified_release_groups urg
      JOIN unified_artists ua ON ua.id = urg.artist_id
      LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
      LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
      WHERE urg.name_normalized LIKE ?
        OR urg.id = ? OR urg.id = ?
        OR urg.musicbrainz_id = ? OR urg.musicbrainz_id = ?
        OR EXISTS (
          SELECT 1 FROM unified_release_sources urs
          JOIN unified_releases ur2 ON ur2.id = urs.unified_release_id
          JOIN instance_albums ial ON ial.id = urs.instance_album_id
          WHERE ur2.release_group_id = urg.id AND ial.remote_id = ?
        )
      GROUP BY urg.id
      ORDER BY urg.name_normalized
      LIMIT ? OFFSET ?`,
    ),
    searchSongs: db.prepare(
      `SELECT
        ut.id, ut.title, ut.track_number, ut.disc_number,
        ut.duration_ms, ut.genre, ut.musicbrainz_id,
        ut.artist_id, ua.name AS artist_name,
        urg.id AS rg_id, urg.name AS rg_name,
        urg.year AS rg_year, urg.image_url AS rg_image_url,
        urg.artist_id AS rg_artist_id, ua2.name AS rg_artist_name,
        (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
        (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
        (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
         ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
        ${audioSourceFields("ut.id")}
        ${BEST_SOURCE_INSTANCE_SUBQUERY.replace("?", "ut.id")} AS instance_name
      FROM unified_tracks ut
      JOIN unified_artists ua ON ua.id = ut.artist_id
      JOIN unified_releases ur ON ur.id = ut.release_id
      JOIN unified_release_groups urg ON urg.id = ur.release_group_id
      JOIN unified_artists ua2 ON ua2.id = urg.artist_id
      WHERE ut.title_normalized LIKE ?
        OR ut.id = ? OR ut.id = ?
        OR ut.musicbrainz_id = ? OR ut.musicbrainz_id = ?
        OR EXISTS (
          SELECT 1 FROM track_sources ts2
          JOIN instance_tracks it ON it.id = ts2.instance_track_id
          WHERE ts2.unified_track_id = ut.id AND it.remote_id = ?
        )
      ORDER BY ut.title_normalized
      LIMIT ? OFFSET ?`,
    ),

    // ── stream / download ──────────────────────────────────────────────────────
    trackForStream: db.prepare(
      `SELECT ut.id, ut.title, ut.artist_id, ua.name AS artist_name, ut.duration_ms
       FROM unified_tracks ut
       JOIN unified_artists ua ON ua.id = ut.artist_id
       WHERE ut.id = ?`,
    ),
    // Source selection happens at merge time (merge.ts sets preferred = 1).
    // At stream time we just look up THE source for this unified track.
    preferredSourceForStream: db.prepare(
      `SELECT ts.instance_id, ts.format, ts.bitrate, it.remote_id
       FROM track_sources ts
       JOIN instance_tracks it ON it.id = ts.instance_track_id
       WHERE ts.unified_track_id = ? AND ts.preferred = 1
       LIMIT 1`,
    ),

    // ── scrobble (#197) ──────────────────────────────────────────────────────────
    trackExists: db.prepare("SELECT 1 FROM unified_tracks WHERE id = ?"),
    // Attribute a scrobble to the source we'd stream from (preferred source),
    // local or peer. Distinct from preferredSourceForStream: no `preferred = 1`
    // filter, so a known track with no preferred row still resolves to a
    // best-effort source instead of scrobbling with a null source.
    sourceForScrobble: db.prepare(
      `SELECT instance_id FROM track_sources
       WHERE unified_track_id = ?
       ORDER BY preferred DESC, instance_id = 'local' DESC LIMIT 1`,
    ),
  };
}


// Re-exported so BEST_SOURCE_SUBQUERY's original module-load site (subsonic.ts)
// isn't left with an orphaned unused constant if something outside this phase
// still references it.
export { BEST_SOURCE_SUBQUERY, BEST_SOURCE_INSTANCE_SUBQUERY };
