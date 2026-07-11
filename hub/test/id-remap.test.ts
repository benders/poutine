import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { runMergePipeline } from "../src/library/merge-pipeline.js";
import * as idGenerator from "../src/library/id-generator.js";

describe("id-remap", () => {
  let db: Database.Database;
  let ownerId: string;
  const inst1 = "instance-1";

  beforeEach(() => {
    db = createDatabase(":memory:");

    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);

    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(inst1, "Instance 1", "https://music1.example.com", "subsonic", "encrypted", ownerId, "online");
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function insertArtist(remoteId: string, name: string) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    ).run(id, inst1, remoteId, name, 1);
    return id;
  }

  function insertAlbum(remoteId: string, name: string, artistId: string, artistName: string, trackCount = 1) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, inst1, remoteId, name, artistId, artistName, trackCount);
    return id;
  }

  function insertTrack(
    remoteId: string,
    albumId: string,
    title: string,
    artistName: string,
    opts: { trackNumber?: number; durationMs?: number } = {},
  ) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, inst1, remoteId, albumId, title, artistName, opts.trackNumber ?? 1, 1, opts.durationMs ?? 240000, "flac");
    return id;
  }

  function starTarget(kind: "track" | "album" | "artist", targetId: string, userId = ownerId) {
    db.prepare(
      "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    ).run(userId, kind, targetId);
  }

  function addPlayEvent(trackId: string, userId = ownerId) {
    db.prepare(
      "INSERT INTO play_events (id, user_id, unified_track_id) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), userId, trackId);
  }

  function addPlaylistTrack(playlistId: string, position: number, trackId: string) {
    db.prepare(
      "INSERT OR IGNORE INTO playlists (id, owner_id, name) VALUES (?, ?, ?)",
    ).run(playlistId, ownerId, "My Playlist");
    db.prepare(
      "INSERT INTO playlist_tracks (playlist_id, position, unified_track_id) VALUES (?, ?, ?)",
    ).run(playlistId, position, trackId);
  }

  function unifiedIds() {
    const track = db.prepare("SELECT id FROM unified_tracks").get() as { id: string } | undefined;
    const album = db.prepare("SELECT id FROM unified_release_groups").get() as { id: string } | undefined;
    const artist = db.prepare("SELECT id FROM unified_artists").get() as { id: string } | undefined;
    return { track, album, artist };
  }

  it("carries stars, play_events, and playlist_tracks across a metadata edit that changes all three ids", () => {
    const artistId = insertArtist("a1", "Radiohead");
    const albumId = insertAlbum("al1", "OK Computer", artistId, "Radiohead");
    insertTrack("t1", albumId, "Paranoid Android", "Radiohead");
    runMergePipeline(db);

    const before = unifiedIds();
    expect(before.track).toBeDefined();
    expect(before.album).toBeDefined();
    expect(before.artist).toBeDefined();

    starTarget("track", before.track!.id);
    starTarget("album", before.album!.id);
    starTarget("artist", before.artist!.id);
    addPlayEvent(before.track!.id);
    addPlaylistTrack("pl1", 0, before.track!.id);

    // Rename artist, album, and track — none carry an MBID, so every one of
    // these hashes to a new id on the next merge (id-generator.ts). The
    // track's own artist_name must be kept in sync with the artist rename —
    // it (not instance_artists.name) is what generateTrackId's artistId
    // input resolves from (#142).
    db.prepare("UPDATE instance_artists SET name = ? WHERE id = ?").run("Radiohead (Remastered)", artistId);
    db.prepare("UPDATE instance_albums SET name = ? WHERE id = ?").run("OK Computer (Remastered)", albumId);
    db.prepare("UPDATE instance_tracks SET title = ?, artist_name = ? WHERE id = ?").run(
      "Paranoid Android (Remaster)",
      "Radiohead (Remastered)",
      `${inst1}:t1`,
    );

    const report = runMergePipeline(db);

    const after = unifiedIds();
    expect(after.track!.id).not.toBe(before.track!.id);
    expect(after.album!.id).not.toBe(before.album!.id);
    expect(after.artist!.id).not.toBe(before.artist!.id);

    expect(report.orphans.total).toBe(0);
    expect(report.remap.tracks.changed).toBeGreaterThanOrEqual(1);
    expect(report.remap.albums.changed).toBeGreaterThanOrEqual(1);
    expect(report.remap.artists.changed).toBeGreaterThanOrEqual(1);

    const stars = db
      .prepare("SELECT kind, target_id FROM user_stars WHERE user_id = ? ORDER BY kind")
      .all(ownerId) as Array<{ kind: string; target_id: string }>;
    expect(stars).toEqual(
      [
        { kind: "album", target_id: after.album!.id },
        { kind: "artist", target_id: after.artist!.id },
        { kind: "track", target_id: after.track!.id },
      ].sort((a, b) => a.kind.localeCompare(b.kind)),
    );

    const playEvent = db.prepare("SELECT unified_track_id FROM play_events").get() as { unified_track_id: string };
    expect(playEvent.unified_track_id).toBe(after.track!.id);

    const playlistTrack = db
      .prepare("SELECT unified_track_id FROM playlist_tracks WHERE playlist_id = ? AND position = 0")
      .get("pl1") as { unified_track_id: string };
    expect(playlistTrack.unified_track_id).toBe(after.track!.id);
  });

  it("remaps the whole library when the dedup-key shape itself changes", () => {
    insertArtist("a1", "Radiohead");
    const albumId = insertAlbum("al1", "OK Computer", `${inst1}:a1`, "Radiohead");
    insertTrack("t1", albumId, "Paranoid Android", "Radiohead");
    runMergePipeline(db);

    const before = unifiedIds();
    starTarget("track", before.track!.id);
    addPlayEvent(before.track!.id);
    addPlaylistTrack("pl1", 0, before.track!.id);

    // Simulate a dedup-key change: every track id now salts in an extra
    // component, as if a future PR widened the key shape.
    vi.spyOn(idGenerator, "generateTrackId").mockImplementation(
      (titleNormalized, artistId, releaseId, mbid, trackNumber, discNumber, durationMs) =>
        idGenerator.generateDeterministicId(
          "track-v2",
          titleNormalized,
          artistId,
          releaseId,
          mbid ?? "null",
          trackNumber?.toString() ?? "null",
          discNumber?.toString() ?? "null",
          durationMs?.toString() ?? "null",
        ),
    );

    const report = runMergePipeline(db);
    const after = unifiedIds();
    expect(after.track!.id).not.toBe(before.track!.id);
    expect(report.orphans.total).toBe(0);
    expect(report.remap.tracks.changed).toBe(1);

    const star = db.prepare("SELECT target_id FROM user_stars WHERE kind = 'track'").get() as { target_id: string };
    expect(star.target_id).toBe(after.track!.id);
  });

  it("picks the majority-instance-row winner and logs the rest when one old id splits into two", () => {
    const artistId = insertArtist("a1", "Pink Floyd");
    const albumId = insertAlbum("al1", "The Wall", artistId, "Pink Floyd", 2);
    // Two instance tracks that fuzzy-match into ONE unified track (same
    // title/trackNumber/duration, different remote ids).
    insertTrack("t1", albumId, "Comfortably Numb", "Pink Floyd", { trackNumber: 1, durationMs: 382000 });
    insertTrack("t2", albumId, "Comfortably Numb", "Pink Floyd", { trackNumber: 1, durationMs: 382000 });
    runMergePipeline(db);

    const before = unifiedIds();
    const sourcesBefore = db.prepare("SELECT COUNT(*) AS n FROM track_sources").get() as { n: number };
    expect(sourcesBefore.n).toBe(2);

    starTarget("track", before.track!.id);

    // Split: retitle BOTH instance tracks to diverge from each other AND
    // from the original matched title, so the merged id disappears
    // entirely rather than one branch reproducing it unchanged — a real
    // split, not just a rename of the loser.
    db.prepare("UPDATE instance_tracks SET title = ? WHERE id = ?").run(
      "Comfortably Numb (2011 Remaster)",
      `${inst1}:t1`,
    );
    db.prepare("UPDATE instance_tracks SET title = ? WHERE id = ?").run(
      "Comfortably Numb (Live)",
      `${inst1}:t2`,
    );

    const report = runMergePipeline(db);
    const tracks = db.prepare("SELECT id FROM unified_tracks").all() as Array<{ id: string }>;
    expect(tracks).toHaveLength(2);

    expect(report.remap.tracks.changed).toBe(1);
    expect(report.remap.tracks.splitsLogged).toBeGreaterThanOrEqual(1);
    expect(report.orphans.total).toBe(0);

    // The star followed one of the two split tracks — not orphaned, not
    // duplicated.
    const stars = db.prepare("SELECT target_id FROM user_stars WHERE kind = 'track'").all();
    expect(stars).toHaveLength(1);
  });

  it("drops the collision loser and keeps exactly one star when two old ids merge into one", () => {
    const artistId = insertArtist("a1", "Pink Floyd");
    const albumId = insertAlbum("al1", "The Wall", artistId, "Pink Floyd", 2);
    insertTrack("t1", albumId, "Comfortably Numb", "Pink Floyd", { trackNumber: 1, durationMs: 382000 });
    insertTrack("t2", albumId, "Hey You", "Pink Floyd", { trackNumber: 2, durationMs: 279000 });
    runMergePipeline(db);

    const tracksBefore = db.prepare("SELECT id FROM unified_tracks ORDER BY id").all() as Array<{ id: string }>;
    expect(tracksBefore).toHaveLength(2);

    // Same user stars both distinct tracks.
    for (const t of tracksBefore) starTarget("track", t.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_stars").get()).toEqual({ n: 2 });

    // Collision: retitle track 2 to exactly match track 1's fuzzy-match key,
    // so the next merge folds them into a single unified track.
    db.prepare("UPDATE instance_tracks SET title = ?, track_number = ?, duration_ms = ? WHERE id = ?").run(
      "Comfortably Numb",
      1,
      382000,
      `${inst1}:t2`,
    );

    const report = runMergePipeline(db);
    const tracksAfter = db.prepare("SELECT id FROM unified_tracks").all() as Array<{ id: string }>;
    expect(tracksAfter).toHaveLength(1);

    expect(report.remap.collisionsDropped).toBe(1);
    expect(report.orphans.total).toBe(0);

    const stars = db.prepare("SELECT target_id FROM user_stars WHERE user_id = ?").all(ownerId);
    expect(stars).toHaveLength(1);
    expect((stars[0] as { target_id: string }).target_id).toBe(tracksAfter[0].id);

    // No constraint error was thrown getting here — collision handled
    // without violating the (user_id, kind, target_id) PK.
  });

  it("swaps both stars correctly when a tag fix swaps two tracks' titles (cycle, not a collision)", () => {
    const artistId = insertArtist("a1", "Pink Floyd");
    const albumId = insertAlbum("al1", "The Wall", artistId, "Pink Floyd", 2);
    insertTrack("t1", albumId, "Alpha", "Pink Floyd", { trackNumber: 1, durationMs: 200000 });
    insertTrack("t2", albumId, "Beta", "Pink Floyd", { trackNumber: 2, durationMs: 300000 });
    runMergePipeline(db);

    const tracksBefore = db
      .prepare(
        `SELECT ts.instance_track_id AS instance_track_id, ut.id AS id, ut.title AS title
         FROM track_sources ts JOIN unified_tracks ut ON ut.id = ts.unified_track_id
         ORDER BY ut.title`,
      )
      .all() as Array<{ instance_track_id: string; id: string; title: string }>;
    expect(tracksBefore).toHaveLength(2);
    const idAlpha = tracksBefore.find((t) => t.title === "Alpha")!.id;
    const idBeta = tracksBefore.find((t) => t.title === "Beta")!.id;
    expect(idAlpha).not.toBe(idBeta);

    // Same user stars both — the scenario the naive UPDATE OR IGNORE +
    // DELETE approach loses: both rows collide with each other mid-remap.
    starTarget("track", idAlpha);
    starTarget("track", idBeta);

    // Tag fix: the two tracks' titles/track numbers/durations were swapped
    // in the source library. t1 now carries exactly what t2 had, and vice
    // versa — hashes swap too (A->B, B->A), a cycle rather than a
    // one-directional collision.
    db.prepare("UPDATE instance_tracks SET title = ?, track_number = ?, duration_ms = ? WHERE id = ?").run(
      "Beta",
      2,
      300000,
      `${inst1}:t1`,
    );
    db.prepare("UPDATE instance_tracks SET title = ?, track_number = ?, duration_ms = ? WHERE id = ?").run(
      "Alpha",
      1,
      200000,
      `${inst1}:t2`,
    );

    const report = runMergePipeline(db);

    // Same two unified track ids exist post-merge, just backed by the
    // other instance track now.
    const tracksAfter = db.prepare("SELECT id, title FROM unified_tracks").all() as Array<{ id: string; title: string }>;
    const idsAfter = new Set(tracksAfter.map((t) => t.id));
    expect(idsAfter).toEqual(new Set([idAlpha, idBeta]));

    expect(report.remap.collisionsDropped).toBe(0);
    expect(report.orphans.total).toBe(0);

    const stars = db.prepare("SELECT target_id FROM user_stars WHERE user_id = ?").all(ownerId) as Array<{ target_id: string }>;
    expect(stars).toHaveLength(2);
    expect(new Set(stars.map((s) => s.target_id))).toEqual(new Set([idAlpha, idBeta]));
  });

  it("survives playlist_tracks across a re-merge (would CASCADE-delete pre-#242)", () => {
    const artistId = insertArtist("a1", "Radiohead");
    const albumId = insertAlbum("al1", "OK Computer", artistId, "Radiohead");
    insertTrack("t1", albumId, "Paranoid Android", "Radiohead");
    runMergePipeline(db);

    const before = unifiedIds();
    addPlaylistTrack("pl1", 0, before.track!.id);

    db.prepare("UPDATE instance_tracks SET title = ? WHERE id = ?").run(
      "Paranoid Android (2024 Remaster)",
      `${inst1}:t1`,
    );
    runMergePipeline(db);

    const after = unifiedIds();
    expect(after.track!.id).not.toBe(before.track!.id);

    const row = db
      .prepare("SELECT unified_track_id FROM playlist_tracks WHERE playlist_id = ? AND position = 0")
      .get("pl1") as { unified_track_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.unified_track_id).toBe(after.track!.id);
  });
});
