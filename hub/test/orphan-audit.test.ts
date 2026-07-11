import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { mergeLibraries } from "../src/library/merge.js";
import { auditOrphans, totalOrphans } from "../src/library/orphan-audit.js";
import { runMergePipeline } from "../src/library/merge-pipeline.js";
import { SyncOperationService } from "../src/services/sync-operations.js";

describe("orphan-audit", () => {
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
  });

  function insertArtist(remoteId: string, name: string) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    ).run(id, inst1, remoteId, name, 1);
    return id;
  }

  function insertAlbum(remoteId: string, name: string, artistId: string) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, inst1, remoteId, name, artistId, "Artist", 1);
    return id;
  }

  function insertTrack(remoteId: string, albumId: string, title: string) {
    const id = `${inst1}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, inst1, remoteId, albumId, title, "Artist", 1, 1, 240000, "flac");
    return id;
  }

  /** Seed one artist/album/track and merge, returning the resulting unified ids. */
  function seedAndMerge() {
    const artistId = insertArtist("a1", "Radiohead");
    const albumId = insertAlbum("al1", "OK Computer", artistId);
    insertTrack("t1", albumId, "Paranoid Android");
    mergeLibraries(db);

    const unifiedTrack = db.prepare("SELECT id FROM unified_tracks").get() as { id: string };
    const unifiedAlbum = db.prepare("SELECT id FROM unified_release_groups").get() as { id: string };
    const unifiedArtist = db.prepare("SELECT id FROM unified_artists").get() as { id: string };
    return { trackId: unifiedTrack.id, albumId: unifiedAlbum.id, artistId: unifiedArtist.id };
  }

  function starTarget(kind: "track" | "album" | "artist", targetId: string) {
    db.prepare(
      "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    ).run(ownerId, kind, targetId);
  }

  it("reports zero orphans when everything points at live unified rows", () => {
    const { trackId, albumId, artistId } = seedAndMerge();
    starTarget("track", trackId);
    starTarget("album", albumId);
    starTarget("artist", artistId);

    db.prepare(
      "INSERT INTO playlists (id, owner_id, name) VALUES (?, ?, ?)",
    ).run("pl1", ownerId, "My Playlist");
    db.prepare(
      "INSERT INTO playlist_tracks (playlist_id, position, unified_track_id) VALUES (?, ?, ?)",
    ).run("pl1", 0, trackId);
    db.prepare(
      "INSERT INTO play_events (id, user_id, unified_track_id) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), ownerId, trackId);

    const report = auditOrphans(db);
    expect(report.total).toBe(0);
    expect(totalOrphans(report)).toBe(0);
    expect(report.starsTrack.count).toBe(0);
    expect(report.starsAlbum.count).toBe(0);
    expect(report.starsArtist.count).toBe(0);
    expect(report.playlistTracks.count).toBe(0);
    expect(report.playEvents.count).toBe(0);
  });

  it("counts and samples stars/playlist/play_events pointing at deleted unified ids", () => {
    seedAndMerge();

    // These target ids never existed in any unified table post-merge —
    // simulates rows left behind by a prior merge cycle whose unified rows
    // were rebuilt away.
    for (let i = 0; i < 3; i++) starTarget("track", `deleted-track-${i}`);
    for (let i = 0; i < 2; i++) starTarget("album", `deleted-album-${i}`);
    starTarget("artist", "deleted-artist-0");

    db.prepare(
      "INSERT INTO playlists (id, owner_id, name) VALUES (?, ?, ?)",
    ).run("pl1", ownerId, "My Playlist");
    // playlist_tracks has a real FK+cascade to unified_tracks (unlike
    // user_stars/play_events), so an orphan can't arise through normal
    // merge behavior — toggle FK enforcement off just for this insert to
    // exercise the audit query defensively, per #242 scope.
    db.pragma("foreign_keys = OFF");
    for (let i = 0; i < 4; i++) {
      db.prepare(
        "INSERT INTO playlist_tracks (playlist_id, position, unified_track_id) VALUES (?, ?, ?)",
      ).run("pl1", i, `deleted-track-${i}`);
    }
    db.pragma("foreign_keys = ON");

    for (let i = 0; i < 2; i++) {
      db.prepare(
        "INSERT INTO play_events (id, user_id, unified_track_id) VALUES (?, ?, ?)",
      ).run(crypto.randomUUID(), ownerId, `deleted-track-${i}`);
    }

    const report = auditOrphans(db);
    expect(report.starsTrack.count).toBe(3);
    expect(report.starsTrack.samples.sort()).toEqual(
      ["deleted-track-0", "deleted-track-1", "deleted-track-2"].sort(),
    );
    expect(report.starsAlbum.count).toBe(2);
    expect(report.starsArtist.count).toBe(1);
    expect(report.playlistTracks.count).toBe(4);
    expect(report.playEvents.count).toBe(2);
    expect(report.total).toBe(3 + 2 + 1 + 4 + 2);
  });

  it("caps samples at 10 even when more orphans exist in one category", () => {
    seedAndMerge();
    for (let i = 0; i < 11; i++) starTarget("track", `deleted-track-${i}`);

    const report = auditOrphans(db);
    expect(report.starsTrack.count).toBe(11);
    expect(report.starsTrack.samples).toHaveLength(10);
  });

  it("runMergePipeline returns the report and a fresh merge over intact data reports 0 orphans", () => {
    const artistId = insertArtist("a1", "Radiohead");
    const albumId = insertAlbum("al1", "OK Computer", artistId);
    insertTrack("t1", albumId, "Paranoid Android");

    const report = runMergePipeline(db);
    expect(report.orphans.total).toBe(0);

    const unifiedTrack = db.prepare("SELECT id FROM unified_tracks").get() as { id: string };
    expect(unifiedTrack).toBeDefined();
  });

  it("persists the orphan report as details JSON on a sync_operations row", () => {
    seedAndMerge();
    starTarget("track", "deleted-track-0");

    const svc = new SyncOperationService(db);
    const opId = svc.start("manual", "local");
    const report = auditOrphans(db);
    svc.setDetails(opId, report);

    const row = db
      .prepare("SELECT details FROM sync_operations WHERE id = ?")
      .get(opId) as { details: string | null };
    expect(row.details).not.toBeNull();
    const parsed = JSON.parse(row.details!) as typeof report;
    expect(parsed.starsTrack.count).toBe(1);
    expect(parsed.total).toBe(report.total);
  });
});
