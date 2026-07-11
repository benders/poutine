import type Database from "better-sqlite3";

/**
 * Snapshot of the stable per-instance identities that survive a re-merge,
 * mapped to the unified id they currently resolve to. Unified ids are
 * deterministic metadata hashes (id-generator.ts) — a metadata edit or a
 * dedup-key change can silently produce a different id on the next merge,
 * stranding `user_stars` / `playlist_tracks` / `play_events` rows that
 * reference the old one. Take this snapshot BEFORE `mergeLibraries()` rebuilds
 * the unified_* tables, then diff against a post-merge snapshot in
 * `applyRemap` to recover the old_id -> new_id pairs.
 */
export interface IdentitySnapshot {
  /** instance_tracks.id -> unified_tracks.id (via track_sources) */
  tracks: Map<string, string>;
  /** instance_albums.id -> unified_release_groups.id (via unified_release_sources + unified_releases) */
  albums: Map<string, string>;
  /** instance_artists.id -> unified_artists.id (via unified_artist_sources) */
  artists: Map<string, string>;
}

export function snapshotIdentity(db: Database.Database): IdentitySnapshot {
  const tracks = new Map<string, string>();
  for (const row of db
    .prepare("SELECT instance_track_id, unified_track_id FROM track_sources")
    .all() as Array<{ instance_track_id: string; unified_track_id: string }>) {
    tracks.set(row.instance_track_id, row.unified_track_id);
  }

  const albums = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT urs.instance_album_id AS instance_album_id, ur.release_group_id AS release_group_id
       FROM unified_release_sources urs
       JOIN unified_releases ur ON ur.id = urs.unified_release_id`,
    )
    .all() as Array<{ instance_album_id: string; release_group_id: string }>) {
    albums.set(row.instance_album_id, row.release_group_id);
  }

  const artists = new Map<string, string>();
  for (const row of db
    .prepare("SELECT instance_artist_id, unified_artist_id FROM unified_artist_sources")
    .all() as Array<{ instance_artist_id: string; unified_artist_id: string }>) {
    artists.set(row.instance_artist_id, row.unified_artist_id);
  }

  return { tracks, albums, artists };
}

/** Per-entity-class remap outcome. */
export interface RemapClassSummary {
  /** Distinct old ids that now resolve to a different id. */
  changed: number;
  /** Old ids that fanned out to more than one new id — only the
   *  majority-instance-row winner is remapped; the rest are counted here. */
  splitsLogged: number;
}

export interface RemapReport {
  tracks: RemapClassSummary;
  albums: RemapClassSummary;
  artists: RemapClassSummary;
  /** user_stars rows whose target_id moved to a new id (all three kinds). */
  userStarsUpdated: number;
  /** user_stars rows dropped because their remap target collided with a
   *  row the same user already had at the winning new id. */
  collisionsDropped: number;
  playlistTracksUpdated: number;
  playEventsUpdated: number;
}

/**
 * old_id -> new_id pairs for one entity class, derived by diffing the same
 * per-instance identity key across two snapshots. When one old id fans out
 * to multiple new ids (a merge decision split what used to be one unified
 * row), the new id backed by the most instance rows wins — ties broken by
 * lexicographically smallest new id for determinism — and the rest are
 * logged as splits rather than remapped.
 */
function computeChangedPairs(
  before: Map<string, string>,
  after: Map<string, string>,
): { pairs: Array<{ oldId: string; newId: string }>; splits: number } {
  // Group every instance key that existed before the merge by the old id it
  // resolved to, then tally the new id(s) it resolves to now. Candidates
  // include the old id itself when an instance key still reproduces it
  // unchanged — that's not a split, just one branch of a fan-out that
  // happens to keep the original hash.
  const byOldId = new Map<string, Map<string, number>>();
  for (const [instanceKey, oldId] of before) {
    const newId = after.get(instanceKey);
    if (!newId) continue; // instance row disappeared entirely — nothing to remap
    let counts = byOldId.get(oldId);
    if (!counts) {
      counts = new Map();
      byOldId.set(oldId, counts);
    }
    counts.set(newId, (counts.get(newId) ?? 0) + 1);
  }

  const pairs: Array<{ oldId: string; newId: string }> = [];
  let splits = 0;
  for (const [oldId, counts] of byOldId) {
    if (counts.size === 1) {
      const [[onlyNewId]] = counts;
      if (onlyNewId !== oldId) pairs.push({ oldId, newId: onlyNewId });
      continue;
    }
    // Fan-out: the old id split across multiple new ids. Majority instance
    // count wins; ties broken lexicographically for determinism. If the
    // winner happens to be the old id itself (unchanged), no remap is
    // needed — the old id is still a live unified id — but the other
    // branch(es) still count as logged splits.
    const ranked = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    splits += ranked.length - 1;
    const [winnerId] = ranked[0];
    if (winnerId !== oldId) pairs.push({ oldId, newId: winnerId });
  }
  return { pairs, splits };
}

/**
 * Recompute the identity snapshot after `mergeLibraries()` and remap every
 * changed old_id -> new_id into `user_stars`, `playlist_tracks`, and
 * `play_events` — set-based, so this stays cheap at ~600k-track scale. Must
 * run in the same transaction as the merge it follows.
 */
export function applyRemap(db: Database.Database, before: IdentitySnapshot): RemapReport {
  const after = snapshotIdentity(db);

  const trackDelta = computeChangedPairs(before.tracks, after.tracks);
  const albumDelta = computeChangedPairs(before.albums, after.albums);
  const artistDelta = computeChangedPairs(before.artists, after.artists);

  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS id_remap_pairs (
      kind TEXT NOT NULL,
      old_id TEXT NOT NULL,
      new_id TEXT NOT NULL,
      PRIMARY KEY (kind, old_id)
    );
    DELETE FROM id_remap_pairs;
  `);

  const insertPair = db.prepare(
    "INSERT INTO id_remap_pairs (kind, old_id, new_id) VALUES (?, ?, ?)",
  );
  for (const p of trackDelta.pairs) insertPair.run("track", p.oldId, p.newId);
  for (const p of albumDelta.pairs) insertPair.run("album", p.oldId, p.newId);
  for (const p of artistDelta.pairs) insertPair.run("artist", p.oldId, p.newId);

  // user_stars remap: an in-place UPDATE OR IGNORE breaks on a swap/cycle
  // (A->B, B->A) — each row's UPDATE collides with the *other* row still
  // sitting at its pre-update value, both get IGNOREd, and the naive
  // "still at an old id" cleanup then deletes both, losing real stars on an
  // ordinary tag-fix. Stage every remapped row's final target first, delete
  // every row touched by the remap, then reinsert from the stage — reinserts
  // can't collide with rows that no longer exist, so swaps/chains land
  // correctly; only a genuine collision (two old ids landing on one target
  // the user already starred) falls out of INSERT OR IGNORE.
  db.exec(`
    CREATE TEMP TABLE remapped_stars AS
    SELECT s.user_id, s.kind, p.new_id AS target_id, s.starred_at
    FROM user_stars s
    JOIN id_remap_pairs p ON p.kind = s.kind AND p.old_id = s.target_id;
  `);
  const stagedCount = (
    db.prepare("SELECT COUNT(*) AS n FROM remapped_stars").get() as { n: number }
  ).n;
  db.exec(`
    DELETE FROM user_stars
    WHERE EXISTS (
      SELECT 1 FROM id_remap_pairs p
      WHERE p.kind = user_stars.kind AND p.old_id = user_stars.target_id
    );
  `);
  const insertedCount = db
    .prepare(
      `INSERT OR IGNORE INTO user_stars (user_id, kind, target_id, starred_at)
       SELECT user_id, kind, target_id, starred_at FROM remapped_stars`,
    )
    .run().changes;
  db.exec("DROP TABLE IF EXISTS remapped_stars");

  const userStarsUpdated = insertedCount;
  const collisionsDropped = stagedCount - insertedCount;

  const playlistTracksUpdated = db
    .prepare(`
      UPDATE playlist_tracks
      SET unified_track_id = (
        SELECT new_id FROM id_remap_pairs WHERE kind = 'track' AND old_id = playlist_tracks.unified_track_id
      )
      WHERE unified_track_id IN (SELECT old_id FROM id_remap_pairs WHERE kind = 'track')
    `)
    .run().changes;

  const playEventsUpdated = db
    .prepare(`
      UPDATE play_events
      SET unified_track_id = (
        SELECT new_id FROM id_remap_pairs WHERE kind = 'track' AND old_id = play_events.unified_track_id
      )
      WHERE unified_track_id IN (SELECT old_id FROM id_remap_pairs WHERE kind = 'track')
    `)
    .run().changes;

  db.exec("DROP TABLE IF EXISTS id_remap_pairs");

  return {
    tracks: { changed: trackDelta.pairs.length, splitsLogged: trackDelta.splits },
    albums: { changed: albumDelta.pairs.length, splitsLogged: albumDelta.splits },
    artists: { changed: artistDelta.pairs.length, splitsLogged: artistDelta.splits },
    userStarsUpdated,
    collisionsDropped,
    playlistTracksUpdated,
    playEventsUpdated,
  };
}
