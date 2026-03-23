import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../src/server.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import {
  selectBestSource,
  encodeCoverArtId,
  decodeCoverArtId,
} from "../src/routes/stream.js";
import { encrypt } from "../src/auth/encryption.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
  jwtAccessExpiresIn: "15m",
  jwtRefreshExpiresIn: "7d",
  encryptionKey: "test-encryption-key",
};

// ── Helper: register user and get token ──────────────────────────────────────

async function registerAndGetToken(
  app: FastifyInstance,
  username = "testuser",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "password123" },
  });
  return res.json().accessToken;
}

// ── Helper: seed test data into the database ─────────────────────────────────

function seedLibraryData(app: FastifyInstance, userId: string) {
  const db = app.db;
  const encryptionKey = app.config.encryptionKey;

  const credentials = JSON.stringify({
    username: "navidrome",
    password: "password",
  });

  // Create instances
  db.prepare(
    `INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-1",
    "Instance 1",
    "https://music1.example.com",
    "subsonic",
    encrypt(credentials, encryptionKey),
    userId,
    "online",
  );

  db.prepare(
    `INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-2",
    "Instance 2",
    "https://music2.example.com",
    "subsonic",
    encrypt(credentials, encryptionKey),
    userId,
    "online",
  );

  db.prepare(
    `INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-3",
    "Instance 3",
    "https://music3.example.com",
    "subsonic",
    encrypt(credentials, encryptionKey),
    userId,
    "offline",
  );

  // Create unified artist
  db.prepare(
    `INSERT INTO unified_artists (id, name, name_normalized)
     VALUES (?, ?, ?)`,
  ).run("artist-1", "Radiohead", "radiohead");

  // Create unified release group
  db.prepare(
    `INSERT INTO unified_release_groups (id, name, name_normalized, artist_id, year)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("rg-1", "OK Computer", "ok computer", "artist-1", 1997);

  // Create unified release
  db.prepare(
    `INSERT INTO unified_releases (id, release_group_id, name, track_count)
     VALUES (?, ?, ?, ?)`,
  ).run("release-1", "rg-1", "OK Computer", 12);

  // Create unified tracks
  db.prepare(
    `INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, track_number, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "track-1",
    "Paranoid Android",
    "paranoid android",
    "release-1",
    "artist-1",
    2,
    384000,
  );

  db.prepare(
    `INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, track_number, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "track-2",
    "Karma Police",
    "karma police",
    "release-1",
    "artist-1",
    6,
    263000,
  );

  db.prepare(
    `INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, track_number, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "track-3",
    "No Surprises",
    "no surprises",
    "release-1",
    "artist-1",
    10,
    228000,
  );

  // Create instance_tracks (needed for foreign key)
  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-1:remote-t1",
    "inst-1",
    "remote-t1",
    "inst-1:album-1",
    "Paranoid Android",
    "Radiohead",
    "flac",
    null,
  );

  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-2:remote-t1",
    "inst-2",
    "remote-t1b",
    "inst-2:album-1",
    "Paranoid Android",
    "Radiohead",
    "mp3",
    320,
  );

  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inst-3:remote-t1",
    "inst-3",
    "remote-t1c",
    "inst-3:album-1",
    "Paranoid Android",
    "Radiohead",
    "flac",
    null,
  );

  // We need instance_albums for the foreign key on instance_tracks.album_id
  // But the schema uses TEXT references, so let's insert placeholder albums
  db.prepare(
    `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("inst-1:album-1", "inst-1", "album-1", "OK Computer", "inst-1:artist-1", "Radiohead");

  db.prepare(
    `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("inst-2:album-1", "inst-2", "album-1", "OK Computer", "inst-2:artist-1", "Radiohead");

  db.prepare(
    `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("inst-3:album-1", "inst-3", "album-1", "OK Computer", "inst-3:artist-1", "Radiohead");

  // Create track_sources
  db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, remote_id, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ts-1", "track-1", "inst-1", "inst-1:remote-t1", "remote-t1", "flac", null);

  db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, remote_id, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ts-2", "track-1", "inst-2", "inst-2:remote-t1", "remote-t1b", "mp3", 320);

  db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, remote_id, format, bitrate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ts-3", "track-1", "inst-3", "inst-3:remote-t1", "remote-t1c", "flac", null);
}

// ═════════════════════════════════════════════════════════════════════════════
// Source Selection Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Source selection", () => {
  const makeSource = (
    overrides: Partial<{
      source_id: string;
      remote_id: string;
      format: string | null;
      bitrate: number | null;
      instance_id: string;
      instance_url: string;
      instance_status: string;
      encrypted_credentials: string;
    }>,
  ) => ({
    source_id: "ts-1",
    remote_id: "remote-1",
    format: "mp3",
    bitrate: 320,
    instance_id: "inst-1",
    instance_url: "https://example.com",
    instance_status: "online",
    encrypted_credentials: "",
    ...overrides,
  });

  it("should return null when no sources exist", () => {
    expect(selectBestSource([])).toBeNull();
  });

  it("should return null when all instances are offline", () => {
    const sources = [
      makeSource({ instance_status: "offline" }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        instance_status: "offline",
      }),
    ];
    expect(selectBestSource(sources)).toBeNull();
  });

  it("should filter to online instances only", () => {
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        instance_status: "offline",
        format: "flac",
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        instance_status: "online",
        format: "mp3",
        bitrate: 128,
      }),
    ];
    const result = selectBestSource(sources);
    expect(result).not.toBeNull();
    expect(result!.instance_id).toBe("inst-2");
  });

  it("should prefer matching format when requested", () => {
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        format: "flac",
        bitrate: null,
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        format: "mp3",
        bitrate: 320,
      }),
    ];
    const result = selectBestSource(sources, "mp3");
    expect(result).not.toBeNull();
    expect(result!.source_id).toBe("ts-2");
  });

  it("should prefer higher quality format when no format requested", () => {
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        format: "mp3",
        bitrate: 128,
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        format: "flac",
        bitrate: null,
      }),
    ];
    const result = selectBestSource(sources);
    expect(result).not.toBeNull();
    expect(result!.source_id).toBe("ts-2");
  });

  it("should prefer higher bitrate among same format", () => {
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        format: "mp3",
        bitrate: 128,
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        format: "mp3",
        bitrate: 320,
      }),
    ];
    const result = selectBestSource(sources);
    expect(result).not.toBeNull();
    expect(result!.source_id).toBe("ts-2");
  });

  it("should prefer FLAC over high bitrate MP3", () => {
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        format: "mp3",
        bitrate: 320,
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        format: "flac",
        bitrate: 0,
      }),
    ];
    const result = selectBestSource(sources);
    expect(result).not.toBeNull();
    expect(result!.source_id).toBe("ts-2");
  });

  it("should handle matching format preference overriding quality", () => {
    // If mp3 is requested, prefer mp3 320 over flac even though flac is higher quality
    const sources = [
      makeSource({
        source_id: "ts-1",
        instance_id: "inst-1",
        format: "flac",
        bitrate: 0,
      }),
      makeSource({
        source_id: "ts-2",
        instance_id: "inst-2",
        format: "mp3",
        bitrate: 320,
      }),
    ];
    const result = selectBestSource(sources, "mp3");
    expect(result).not.toBeNull();
    expect(result!.source_id).toBe("ts-2");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cover Art ID Encoding/Decoding
// ═════════════════════════════════════════════════════════════════════════════

describe("Cover art ID encoding/decoding", () => {
  it("should encode and decode correctly", () => {
    const encoded = encodeCoverArtId("inst-123", "al-456");
    expect(encoded).toBe("inst-123:al-456");

    const decoded = decodeCoverArtId(encoded);
    expect(decoded.instanceId).toBe("inst-123");
    expect(decoded.coverArtId).toBe("al-456");
  });

  it("should handle cover art IDs that contain colons", () => {
    const encoded = encodeCoverArtId("inst-1", "al:art:789");
    const decoded = decodeCoverArtId(encoded);
    expect(decoded.instanceId).toBe("inst-1");
    expect(decoded.coverArtId).toBe("al:art:789");
  });

  it("should throw on invalid format", () => {
    expect(() => decodeCoverArtId("nocolon")).toThrow("Invalid cover art ID format");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Queue API Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Queue API", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();

    // Register user
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "queueuser", password: "password123" },
    });
    const body = res.json();
    token = body.accessToken;
    userId = body.user.id;

    // Seed library data
    seedLibraryData(app, userId);
  });

  afterEach(async () => {
    await app.close();
  });

  it("should return empty queue initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tracks).toEqual([]);
  });

  it("should replace queue with POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2", "track-3"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(3);

    // Verify queue contents
    const getRes = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = getRes.json();
    expect(body.tracks).toHaveLength(3);
    expect(body.tracks[0].trackId).toBe("track-1");
    expect(body.tracks[0].title).toBe("Paranoid Android");
    expect(body.tracks[0].artistName).toBe("Radiohead");
    expect(body.tracks[0].albumName).toBe("OK Computer");
    expect(body.tracks[1].trackId).toBe("track-2");
    expect(body.tracks[2].trackId).toBe("track-3");
  });

  it("should replace existing queue with new one", async () => {
    // Set initial queue
    await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2", "track-3"] },
    });

    // Replace with new queue
    const res = await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-2"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.json().tracks).toHaveLength(1);
    expect(getRes.json().tracks[0].trackId).toBe("track-2");
  });

  it("should add a track to queue", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "add", trackId: "track-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().position).toBe(0);

    // Add another
    const res2 = await app.inject({
      method: "PATCH",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "add", trackId: "track-2" },
    });

    expect(res2.json().position).toBe(1);

    // Verify
    const getRes = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.json().tracks).toHaveLength(2);
  });

  it("should remove a track from queue and reorder", async () => {
    // Set queue
    await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2", "track-3"] },
    });

    // Remove middle track
    const res = await app.inject({
      method: "PATCH",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "remove", position: 1 },
    });

    expect(res.statusCode).toBe(200);

    // Verify reordering
    const getRes = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    const tracks = getRes.json().tracks;
    expect(tracks).toHaveLength(2);
    expect(tracks[0].trackId).toBe("track-1");
    expect(tracks[0].position).toBe(0);
    expect(tracks[1].trackId).toBe("track-3");
    expect(tracks[1].position).toBe(1);
  });

  it("should clear queue", async () => {
    // Set queue
    await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2"] },
    });

    // Clear
    const res = await app.inject({
      method: "PATCH",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "clear" },
    });

    expect(res.statusCode).toBe(200);

    // Verify
    const getRes = await app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.json().tracks).toHaveLength(0);
  });

  it("should require auth for queue endpoints", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/queue",
    });
    expect(res.statusCode).toBe(401);
  });

  it("should return current track info", async () => {
    // Set queue and state
    await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2"] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/queue/current",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentTrack).not.toBeNull();
    expect(body.currentTrack.trackId).toBe("track-1");
    expect(body.currentTrack.title).toBe("Paranoid Android");
    expect(body.currentTrack.streamUrl).toBe("/api/stream/track-1");
    expect(body.state.shuffle).toBe(false);
    expect(body.state.repeatMode).toBe("none");
  });

  it("should return null current track when queue is empty", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/queue/current",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentTrack).toBeNull();
  });

  it("should update queue state", async () => {
    // Set queue first
    await app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { authorization: `Bearer ${token}` },
      payload: { trackIds: ["track-1", "track-2", "track-3"] },
    });

    // Update state
    const res = await app.inject({
      method: "PATCH",
      url: "/api/queue/state",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPosition: 2, shuffle: true, repeatMode: "all" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentPosition).toBe(2);
    expect(body.shuffle).toBe(true);
    expect(body.repeatMode).toBe("all");

    // Verify current reflects the update
    const currentRes = await app.inject({
      method: "GET",
      url: "/api/queue/current",
      headers: { authorization: `Bearer ${token}` },
    });

    const current = currentRes.json();
    expect(current.currentTrack.trackId).toBe("track-3");
    expect(current.state.shuffle).toBe(true);
    expect(current.state.repeatMode).toBe("all");
  });

  it("should partially update queue state", async () => {
    // Update only shuffle
    const res = await app.inject({
      method: "PATCH",
      url: "/api/queue/state",
      headers: { authorization: `Bearer ${token}` },
      payload: { shuffle: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shuffle).toBe(true);
    expect(body.currentPosition).toBe(0);
    expect(body.repeatMode).toBe("none");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Stream Proxy Route Tests (with mocked SubsonicClient)
// ═════════════════════════════════════════════════════════════════════════════

describe("Stream route", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "streamuser", password: "password123" },
    });
    const body = res.json();
    token = body.accessToken;
    userId = body.user.id;

    seedLibraryData(app, userId);
  });

  afterEach(async () => {
    await app.close();
  });

  it("should require auth for stream endpoint", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stream/track-1",
    });
    expect(res.statusCode).toBe(401);
  });

  it("should return 404 for nonexistent track", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stream/nonexistent-track",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("should return 503 when all instances are offline", async () => {
    // Set all instances to offline
    app.db
      .prepare("UPDATE instances SET status = 'offline'")
      .run();

    const res = await app.inject({
      method: "GET",
      url: "/api/stream/track-1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it("should require auth for cover art endpoint", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/art/inst-1:cover-1",
    });
    expect(res.statusCode).toBe(401);
  });

  it("should return 400 for invalid cover art ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/art/nocolon",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("should return 404 for cover art from nonexistent instance", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/art/nonexistent:cover-1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
