import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { mergeLibraries } from "../src/library/merge.js";
import {
  generateArtistId,
  generateReleaseGroupId,
  generateReleaseId,
  generateTrackId,
  generateTrackSourceId,
} from "../src/library/id-generator.js";

describe("mergeLibraries", () => {
  let db: Database.Database;
  let ownerId: string;
  const inst1 = "instance-1";
  const inst2 = "instance-2";

  beforeEach(() => {
    db = createDatabase(":memory:");

    // Create a user
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);

    // Create two instances
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(inst1, "Instance 1", "https://music1.example.com", "subsonic", "encrypted", ownerId, "online");
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(inst2, "Instance 2", "https://music2.example.com", "subsonic", "encrypted", ownerId, "online");
  });

  afterEach(() => {
    db.close();
  });

  function insertArtist(instanceId: string, remoteId: string, name: string, mbid?: string) {
    const id = `${instanceId}:${remoteId}`;
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, musicbrainz_id, album_count) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, instanceId, remoteId, name, mbid ?? null, 1);
    return id;
  }

  function insertAlbum(
    instanceId: string,
    remoteId: string,
    name: string,
    artistId: string,
    opts: { mbid?: string; rgMbid?: string; trackCount?: number; year?: number } = {},
  ) {
    const id = `${instanceId}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, year, musicbrainz_id, release_group_mbid, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, instanceId, remoteId, name, artistId, "Artist",
      opts.year ?? 2000, opts.mbid ?? null, opts.rgMbid ?? null, opts.trackCount ?? 10,
    );
    return id;
  }

  function insertTrack(
    instanceId: string,
    remoteId: string,
    albumId: string,
    title: string,
    opts: { mbid?: string; trackNumber?: number; durationMs?: number; format?: string; bitrate?: number } = {},
  ) {
    const id = `${instanceId}:${remoteId}`;
    db.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format, bitrate, musicbrainz_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, instanceId, remoteId, albumId, title, "Artist",
      opts.trackNumber ?? 1, 1, opts.durationMs ?? 240000,
      opts.format ?? "flac", opts.bitrate ?? null, opts.mbid ?? null,
    );
    return id;
  }

  it("should merge artists with same MusicBrainz ID", () => {
    const mbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", mbid);
    insertArtist(inst2, "a1", "Radiohead", mbid);

    // Need albums and tracks so the merge pipeline has data to work with
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Paranoid Android", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Paranoid Android", { trackNumber: 1 });

    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists").all() as Array<Record<string, unknown>>;
    expect(artists).toHaveLength(1);
    expect(artists[0].musicbrainz_id).toBe(mbid);

    const sources = db.prepare("SELECT * FROM unified_artist_sources").all();
    expect(sources).toHaveLength(2);
  });

  it("should merge artists with same normalized name (no MBID)", () => {
    insertArtist(inst1, "a1", "The Beatles");
    insertArtist(inst2, "a1", "Beatles");

    const album1 = insertAlbum(inst1, "al1", "Abbey Road", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "Abbey Road", `${inst2}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Come Together", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Come Together", { trackNumber: 1 });

    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists").all() as Array<Record<string, unknown>>;
    expect(artists).toHaveLength(1);
    expect(artists[0].name_normalized).toBe("beatles");

    const sources = db.prepare("SELECT * FROM unified_artist_sources").all();
    expect(sources).toHaveLength(2);
  });

  it("should group albums with same release group MBID", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const rgMbid = "rg-mbid-1";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, {
      rgMbid,
      trackCount: 12,
    });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, {
      rgMbid,
      trackCount: 12,
    });
    insertTrack(inst1, "t1", album1, "Airbag", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Airbag", { trackNumber: 1 });

    mergeLibraries(db);

    const releaseGroups = db.prepare("SELECT * FROM unified_release_groups").all() as Array<Record<string, unknown>>;
    expect(releaseGroups).toHaveLength(1);
    expect(releaseGroups[0].musicbrainz_id).toBe(rgMbid);
  });

  it("should create one unified track with 2 track_sources for same recording MBID", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const rgMbid = "rg-mbid-1";
    const releaseMbid = "release-mbid-1";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, {
      mbid: releaseMbid,
      rgMbid,
      trackCount: 1,
    });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, {
      mbid: releaseMbid,
      rgMbid,
      trackCount: 1,
    });

    const recordingMbid = "recording-mbid-1";
    insertTrack(inst1, "t1", album1, "Paranoid Android", {
      mbid: recordingMbid,
      trackNumber: 1,
      durationMs: 384000,
      format: "flac",
    });
    insertTrack(inst2, "t1", album2, "Paranoid Android", {
      mbid: recordingMbid,
      trackNumber: 1,
      durationMs: 384000,
      format: "mp3",
    });

    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks").all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].musicbrainz_id).toBe(recordingMbid);

    const sources = db.prepare("SELECT * FROM track_sources").all() as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);

    // Verify sources reference different instances
    const instanceIds = sources.map((s) => s.instance_id);
    expect(instanceIds).toContain(inst1);
    expect(instanceIds).toContain(inst2);
  });

  it("should match tracks without MBIDs by normalized title + track number + duration", () => {
    insertArtist(inst1, "a1", "Pink Floyd");
    insertArtist(inst2, "a1", "Pink Floyd");

    const album1 = insertAlbum(inst1, "al1", "The Wall", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "The Wall", `${inst2}:a1`, { trackCount: 1 });

    // Same track, slightly different duration (within 3s tolerance)
    insertTrack(inst1, "t1", album1, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 382000,
    });
    insertTrack(inst2, "t1", album2, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 384000, // 2 seconds difference, within 3s tolerance
    });

    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks").all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);

    const sources = db.prepare("SELECT * FROM track_sources").all() as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
  });

  it("should NOT merge tracks with duration outside tolerance", () => {
    insertArtist(inst1, "a1", "Pink Floyd");
    insertArtist(inst2, "a1", "Pink Floyd");

    const album1 = insertAlbum(inst1, "al1", "The Wall", `${inst1}:a1`, { trackCount: 2 });
    const album2 = insertAlbum(inst2, "al1", "The Wall", `${inst2}:a1`, { trackCount: 2 });

    // Same title but very different duration -> should NOT merge
    insertTrack(inst1, "t1", album1, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 382000,
    });
    insertTrack(inst2, "t1", album2, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 500000, // way outside 3s tolerance
    });

    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks").all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(2);
  });

  it("should keep different artists as separate unified artists", () => {
    insertArtist(inst1, "a1", "Radiohead");
    insertArtist(inst1, "a2", "Pink Floyd");

    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst1, "al2", "The Wall", `${inst1}:a2`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Airbag", { trackNumber: 1 });
    insertTrack(inst1, "t2", album2, "Another Brick", { trackNumber: 1 });

    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists").all();
    expect(artists).toHaveLength(2);
  });

  it("should handle empty database without errors", () => {
    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists").all();
    expect(artists).toHaveLength(0);
  });

  it("marks exactly one preferred source per unified track, favoring higher-quality format", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const releaseMbid = "release-mbid-1";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { mbid: releaseMbid, trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, { mbid: releaseMbid, trackCount: 1 });

    const recordingMbid = "recording-mbid-1";
    // inst1 has MP3 320, inst2 has FLAC 1000. FLAC wins regardless of instance.
    insertTrack(inst1, "t1", album1, "Paranoid Android", { mbid: recordingMbid, format: "mp3", bitrate: 320 });
    insertTrack(inst2, "t1", album2, "Paranoid Android", { mbid: recordingMbid, format: "flac", bitrate: 1000 });

    mergeLibraries(db);

    const preferred = db
      .prepare("SELECT instance_id, format FROM track_sources WHERE preferred = 1")
      .all() as Array<{ instance_id: string; format: string }>;
    expect(preferred).toHaveLength(1);
    expect(preferred[0].instance_id).toBe(inst2);
    expect(preferred[0].format).toBe("flac");
  });

  it("breaks format/bitrate ties in favor of the local instance", () => {
    // Create a "local" instance alongside the peer.
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("local", "Local", "https://local.example.com", "subsonic", "encrypted", ownerId, "online");

    const artistMbid = "artist-mbid-1";
    insertArtist("local", "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const releaseMbid = "release-mbid-1";
    const albumLocal = insertAlbum("local", "al1", "OK Computer", "local:a1", { mbid: releaseMbid, trackCount: 1 });
    const albumPeer = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, { mbid: releaseMbid, trackCount: 1 });

    const recordingMbid = "recording-mbid-1";
    insertTrack("local", "t1", albumLocal, "Paranoid Android", { mbid: recordingMbid, format: "flac", bitrate: 1000 });
    insertTrack(inst2, "t1", albumPeer, "Paranoid Android", { mbid: recordingMbid, format: "flac", bitrate: 1000 });

    mergeLibraries(db);

    const preferred = db
      .prepare("SELECT instance_id FROM track_sources WHERE preferred = 1")
      .all() as Array<{ instance_id: string }>;
    expect(preferred).toHaveLength(1);
    expect(preferred[0].instance_id).toBe("local");
  });

  it("should not collide on PK when one source splits an album into multiple instance_albums sharing name+artist+RG but with different track counts (no MBIDs)", () => {
    // Reproduces the Leonard Cohen "Old Ideas" failure: a single physical album
    // gets split by Navidrome into N instance_albums (because of inconsistent
    // per-track date tags) — same name, same artist, no MBID. They land in the
    // same release group, then in different byTrackCount buckets, and used to
    // hash to the same unified_releases.id.
    insertArtist(inst1, "lc", "Leonard Cohen");
    const aBig = insertAlbum(inst1, "ol-big", "Old Ideas", `${inst1}:lc`, { trackCount: 8 });
    const aSmallA = insertAlbum(inst1, "ol-a", "Old Ideas", `${inst1}:lc`, { trackCount: 1 });
    const aSmallB = insertAlbum(inst1, "ol-b", "Old Ideas", `${inst1}:lc`, { trackCount: 1 });
    insertTrack(inst1, "t-big-1", aBig, "Going Home", { trackNumber: 1 });
    insertTrack(inst1, "t-a-1", aSmallA, "Show Me the Place", { trackNumber: 3 });
    insertTrack(inst1, "t-b-1", aSmallB, "Darkness", { trackNumber: 4 });

    expect(() => mergeLibraries(db)).not.toThrow();

    // The two trackCount=1 splits collapse together (same RG, same name, same
    // count); the trackCount=8 split stays separate. Two unified releases, both
    // named "Old Ideas", with distinct ids.
    const releases = db.prepare("SELECT id, name, track_count FROM unified_releases ORDER BY track_count").all() as Array<Record<string, unknown>>;
    expect(releases).toHaveLength(2);
    const ids = new Set(releases.map(r => r.id as string));
    expect(ids.size).toBe(2);
    expect(releases.every(r => r.name === "Old Ideas")).toBe(true);
    expect(releases.map(r => r.track_count)).toEqual([1, 8]);
  });

  it("should not collide on PK when the same recording MBID appears on two different releases", () => {
    // Reproduces the Chemical Brothers "Setting Sun" failure: the same recording
    // MBID exists on a single (322s) and on the album (329s). Two distinct
    // releases → must produce two unified_tracks rather than colliding.
    const recordingMbid = "7a7d7fb7-075b-4fdc-8c5e-9b5e03ee00b3";
    insertArtist(inst1, "cb", "The Chemical Brothers");
    const single = insertAlbum(inst1, "ss-single", "Setting Sun", `${inst1}:cb`, { trackCount: 1, mbid: "release-mbid-single" });
    const album = insertAlbum(inst1, "dig-your-own-hole", "Dig Your Own Hole", `${inst1}:cb`, { trackCount: 11, mbid: "release-mbid-album" });
    insertTrack(inst1, "t-single", single, "Setting Sun (full length version)", { mbid: recordingMbid, trackNumber: 1, durationMs: 322000 });
    insertTrack(inst1, "t-album", album, "Setting Sun", { mbid: recordingMbid, trackNumber: 5, durationMs: 329000 });

    expect(() => mergeLibraries(db)).not.toThrow();

    const tracks = db.prepare("SELECT id, title, release_id, musicbrainz_id, duration_ms FROM unified_tracks ORDER BY duration_ms").all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(2);
    expect(new Set(tracks.map(t => t.id))).toHaveProperty("size", 2);
    expect(tracks.every(t => t.musicbrainz_id === recordingMbid)).toBe(true);
    expect(new Set(tracks.map(t => t.release_id)).size).toBe(2);
  });

  it("should clear and rebuild on re-merge", () => {
    insertArtist(inst1, "a1", "Radiohead");
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Airbag", { trackNumber: 1 });

    mergeLibraries(db);
    let artists = db.prepare("SELECT * FROM unified_artists").all();
    expect(artists).toHaveLength(1);

    // Merge again - should still have exactly 1
    mergeLibraries(db);
    artists = db.prepare("SELECT * FROM unified_artists").all();
    expect(artists).toHaveLength(1);
  });

  it("should generate deterministic artist IDs based on MBID", () => {
    const mbid = "artist-mbid-deterministic-test";
    insertArtist(inst1, "a1", "Radiohead", mbid);
    insertArtist(inst2, "a1", "Radiohead", mbid);

    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Paranoid Android", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Paranoid Android", { trackNumber: 1 });

    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists")
      .all() as Array<Record<string, unknown>>;
    expect(artists).toHaveLength(1);

    // Verify ID matches expected deterministic generation
    const expectedId = generateArtistId("Radiohead", mbid);
    expect(artists[0].id).toBe(expectedId);
  });

  it("should generate deterministic artist IDs based on name when no MBID", () => {
    insertArtist(inst1, "a1", "The Beatles");
    insertArtist(inst2, "a1", "Beatles");

    const album1 = insertAlbum(inst1, "al1", "Abbey Road", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "Abbey Road", `${inst2}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Come Together", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Come Together", { trackNumber: 1 });

    mergeLibraries(db);

    const artists = db.prepare("SELECT * FROM unified_artists")
      .all() as Array<Record<string, unknown>>;
    expect(artists).toHaveLength(1);

    // ID should be generated from the normalized name
    const expectedId = generateArtistId("beatles", null);
    expect(artists[0].id).toBe(expectedId);
  });

  it("should generate deterministic release group IDs based on MBID", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const rgMbid = "rg-mbid-deterministic-test";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, {
      rgMbid,
      trackCount: 12,
    });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, {
      rgMbid,
      trackCount: 12,
    });
    insertTrack(inst1, "t1", album1, "Airbag", { trackNumber: 1 });
    insertTrack(inst2, "t1", album2, "Airbag", { trackNumber: 1 });

    mergeLibraries(db);

    const releaseGroups = db.prepare("SELECT * FROM unified_release_groups")
      .all() as Array<Record<string, unknown>>;
    expect(releaseGroups).toHaveLength(1);

    // Get the unified artist ID first
    const artists = db.prepare("SELECT id FROM unified_artists WHERE musicbrainz_id = ?")
      .get(artistMbid) as { id: string };
    const expectedId = generateReleaseGroupId("ok computer", artists.id, rgMbid);
    expect(releaseGroups[0].id).toBe(expectedId);
  });

  it("should generate deterministic track IDs based on recording MBID", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const rgMbid = "rg-mbid-1";
    const releaseMbid = "release-mbid-1";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, {
      mbid: releaseMbid,
      rgMbid,
      trackCount: 1,
    });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, {
      mbid: releaseMbid,
      rgMbid,
      trackCount: 1,
    });

    const recordingMbid = "recording-mbid-deterministic-test";
    insertTrack(inst1, "t1", album1, "Paranoid Android", {
      mbid: recordingMbid,
      trackNumber: 1,
      durationMs: 384000,
      format: "flac",
    });
    insertTrack(inst2, "t1", album2, "Paranoid Android", {
      mbid: recordingMbid,
      trackNumber: 1,
      durationMs: 384000,
      format: "mp3",
    });

    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks")
      .all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);

    // Get artist and release IDs to compute expected track ID
    const artists = db.prepare("SELECT id FROM unified_artists WHERE musicbrainz_id = ?")
      .get(artistMbid) as { id: string };
    const releases = db.prepare("SELECT id FROM unified_releases WHERE musicbrainz_id = ?")
      .get(releaseMbid) as { id: string };
    const expectedId = generateTrackId("paranoid android", artists.id, releases.id, recordingMbid, 1, 1, 384000);
    expect(tracks[0].id).toBe(expectedId);
  });

  it("should generate deterministic track IDs based on metadata when no MBID", () => {
    insertArtist(inst1, "a1", "Pink Floyd");
    insertArtist(inst2, "a1", "Pink Floyd");

    const album1 = insertAlbum(inst1, "al1", "The Wall", `${inst1}:a1`, { trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "The Wall", `${inst2}:a1`, { trackCount: 1 });

    insertTrack(inst1, "t1", album1, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 382000,
    });
    insertTrack(inst2, "t1", album2, "Comfortably Numb", {
      trackNumber: 1,
      durationMs: 384000,
    });

    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks")
      .all() as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);

    // Get artist and release IDs to compute expected track ID
    const artists = db.prepare("SELECT id FROM unified_artists WHERE name_normalized = ?")
      .get("pink floyd") as { id: string };
    const releases = db.prepare("SELECT id FROM unified_releases")
      .get() as { id: string };
    const expectedId = generateTrackId("comfortably numb", artists.id, releases.id, null, 1, 1, 382000);
    expect(tracks[0].id).toBe(expectedId);
  });

  it("should generate deterministic track source IDs", () => {
    const artistMbid = "artist-mbid-1";
    insertArtist(inst1, "a1", "Radiohead", artistMbid);
    insertArtist(inst2, "a1", "Radiohead", artistMbid);

    const releaseMbid = "release-mbid-1";
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { mbid: releaseMbid, trackCount: 1 });
    const album2 = insertAlbum(inst2, "al1", "OK Computer", `${inst2}:a1`, { mbid: releaseMbid, trackCount: 1 });

    const recordingMbid = "recording-mbid-1";
    insertTrack(inst1, "t1", album1, "Paranoid Android", { mbid: recordingMbid, format: "flac" });
    insertTrack(inst2, "t1", album2, "Paranoid Android", { mbid: recordingMbid, format: "mp3" });

    mergeLibraries(db);

    const sources = db.prepare("SELECT * FROM track_sources")
      .all() as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);

    // Get the unified track ID
    const tracks = db.prepare("SELECT id FROM unified_tracks WHERE musicbrainz_id = ?")
      .all(recordingMbid) as Array<{ id: string }>;
    const trackId = tracks[0].id;

    // Verify each source has deterministic ID
    const source1Expected = generateTrackSourceId(trackId, inst1);
    const source2Expected = generateTrackSourceId(trackId, inst2);

    const sourceIds = sources.map((s) => s.id).sort();
    expect(sourceIds).toContain(source1Expected);
    expect(sourceIds).toContain(source2Expected);
  });

  it("should produce identical IDs on repeated merges (stability across rebuilds)", () => {
    insertArtist(inst1, "a1", "Radiohead", "artist-mbid-stable");
    const album1 = insertAlbum(inst1, "al1", "OK Computer", `${inst1}:a1`, { trackCount: 1 });
    insertTrack(inst1, "t1", album1, "Airbag", { trackNumber: 1, mbid: "track-mbid-stable" });

    mergeLibraries(db);
    const firstArtists = db.prepare("SELECT id FROM unified_artists").all() as Array<{ id: string }>;
    const firstTracks = db.prepare("SELECT id FROM unified_tracks").all() as Array<{ id: string }>;

    // Merge again
    mergeLibraries(db);
    const secondArtists = db.prepare("SELECT id FROM unified_artists").all() as Array<{ id: string }>;
    const secondTracks = db.prepare("SELECT id FROM unified_tracks").all() as Array<{ id: string }>;

    // IDs should be identical across merges
    expect(firstArtists[0].id).toBe(secondArtists[0].id);
    expect(firstTracks[0].id).toBe(secondTracks[0].id);
  });
});
