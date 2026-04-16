/**
 * Integration tests for /rest/stream (and /rest/download alias).
 *
 * Covers:
 *   - Bad / missing ID → Subsonic error 70
 *   - Valid ID with no track sources → Subsonic error 70
 *   - Local source path: Poutine proxies to a fake Navidrome HTTP server
 *   - Peer source path: Poutine-A routes through Poutine-B → fake Navidrome
 *   - Source selection: identical quality on local and peer → local preferred
 *   - Source selection: peer has higher-quality recording → peer preferred
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { hashPassword } from "../src/auth/passwords.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { syncPeer } from "../src/library/sync-peer.js";
import { mergeLibraries } from "../src/library/merge.js";
import type { Config } from "../src/config.js";

// ── Fake Navidrome ────────────────────────────────────────────────────────────

/** Minimal valid MP3 frame header bytes — recognisable as audio/mpeg. */
const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * Distinct audio payloads for local vs peer fake Navidromes.
 * The differing trailing bytes let tests assert which source was actually used.
 */
const FAKE_AUDIO_LOCAL = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb, 0xcc, 0xdd]);
const FAKE_AUDIO_PEER  = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

// ── Subsonic JSON helpers ─────────────────────────────────────────────────────

function subsonicOk(data: Record<string, unknown>): string {
  return JSON.stringify({
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      ...data,
    },
  });
}

/**
 * Build a fake Navidrome that handles Subsonic catalog API calls (getArtists,
 * getArtist, getAlbum) with a single artist/album/song, and serves audio bytes
 * for all other requests (stream, getCoverArt, etc.).
 *
 * trackData controls the song metadata returned by getAlbum (format/bitrate).
 * audioPayload is what gets served for stream requests.
 */
function buildFakeNavidromeHandler(opts: {
  trackId?: string;
  albumId?: string;
  artistId?: string;
  format?: string;
  bitrate?: number;
  audioPayload?: Buffer;
  audioContentType?: string;
}): http.RequestListener {
  const {
    trackId = "trk-1",
    albumId = "alb-1",
    artistId = "art-1",
    format = "mp3",
    bitrate = 320,
    audioPayload = FAKE_AUDIO,
    audioContentType = "audio/mpeg",
  } = opts;

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.includes("getArtists")) {
      const body = subsonicOk({
        artists: {
          index: [
            {
              name: "S",
              artist: [{ id: artistId, name: "Shared Artist", albumCount: 1 }],
            },
          ],
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    if (path.includes("getArtist")) {
      const body = subsonicOk({
        artist: {
          id: artistId,
          name: "Shared Artist",
          albumCount: 1,
          album: [{ id: albumId, name: "Shared Album", songCount: 1, duration: 200 }],
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    if (path.includes("getAlbum")) {
      const body = subsonicOk({
        album: {
          id: albumId,
          name: "Shared Album",
          artist: "Shared Artist",
          artistId,
          songCount: 1,
          duration: 200,
          song: [
            {
              id: trackId,
              title: "Shared Track",
              artist: "Shared Artist",
              track: 1,
              duration: 200,
              bitRate: bitrate,
              suffix: format,
            },
          ],
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    // All other requests (stream, getCoverArt, ping, etc.) → audio bytes
    res.writeHead(200, {
      "content-type": audioContentType,
      "content-length": String(audioPayload.length),
    });
    res.end(audioPayload);
  };
}

function startFakeNavidrome(opts: {
  format?: string;
  bitrate?: number;
  audioPayload?: Buffer;
  audioContentType?: string;
} = {}): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(
      buildFakeNavidromeHandler({
        audioPayload: opts.audioPayload ?? FAKE_AUDIO,
        audioContentType: opts.audioContentType ?? "audio/mpeg",
        format: opts.format ?? "mp3",
        bitrate: opts.bitrate ?? 320,
      }),
    );
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-stream-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

async function seedUser(
  app: FastifyInstance,
  username = "tester",
  password = "secret",
) {
  const hash = await hashPassword(password);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("user-1", username, hash);
}

function seedLocalTrack(app: FastifyInstance) {
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_artists
       (id, instance_id, remote_id, name, album_count)
       VALUES ('local:art-1', 'local', 'art-1', 'Test Artist', 1)`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_albums
       (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
       VALUES ('local:alb-1', 'local', 'alb-1', 'Test Album', 'local:art-1', 'Test Artist', 1, NULL)`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_tracks
       (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
       VALUES ('local:trk-1', 'local', 'trk-1', 'local:alb-1', 'Test Track', 'Test Artist', 1, 180000, 'mp3', 320)`,
    )
    .run();
  mergeLibraries(app.db);
}

// ── Error cases ───────────────────────────────────────────────────────────────

describe("stream — error cases", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ databasePath: ":memory:", jwtSecret: "test-secret" });
    await app.ready();
    await seedUser(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("missing id parameter → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("id with wrong prefix → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json&id=xyz999",
    });
    expect(res.statusCode).toBe(400);
  });

  it("valid prefixed id with no matching track sources → 404", async () => {
    // "t" prefix but UUID that doesn't exist in the DB
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json&id=t00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Local source ──────────────────────────────────────────────────────────────

describe("stream — local source", () => {
  let app: FastifyInstance;
  let navidrome: http.Server;
  let navidromePort: number;

  beforeEach(async () => {
    ({ server: navidrome, port: navidromePort } = await startFakeNavidrome());

    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "test-secret",
      navidromeUrl: `http://127.0.0.1:${navidromePort}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    });
    await app.ready();

    await seedUser(app);
    seedLocalTrack(app);
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
  });

  it("streams audio bytes from local Navidrome with correct content-type", async () => {
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };
    expect(track).toBeDefined();

    const res = await app.inject({
      method: "GET",
      url: `/rest/stream?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("/rest/download alias behaves identically to /rest/stream", async () => {
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/rest/download?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });
});

// ── Peer source ───────────────────────────────────────────────────────────────

describe("stream — peer source", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let portB: number;
  let navidrome: http.Server;
  let navidromePort: number;
  let keyPathA: string;
  let keyPathB: string;
  let peersYamlA: string;
  let peersYamlB: string;

  beforeEach(async () => {
    // Start fake Navidrome B — responds to Subsonic JSON catalog API + audio stream
    ({ server: navidrome, port: navidromePort } = await startFakeNavidrome({
      format: "flac",
      bitrate: 1000,
      audioPayload: FAKE_AUDIO,
      audioContentType: "audio/mpeg",
    }));

    keyPathA = tmpPath("key-a.pem");
    keyPathB = tmpPath("key-b.pem");
    peersYamlA = tmpPath("peers-a.yaml");
    peersYamlB = tmpPath("peers-b.yaml");

    const { publicKeyBase64: pubA } = loadOrCreatePrivateKey(keyPathA);
    const { publicKeyBase64: pubB } = loadOrCreatePrivateKey(keyPathB);

    // B trusts A
    writeYaml(
      peersYamlB,
      [
        `peers:`,
        `  - id: "poutine-a"`,
        `    url: "http://localhost"`,
        `    public_key: "ed25519:${pubA}"`,
      ].join("\n"),
    );

    // Build B with fake Navidrome, then start listening
    const configB: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-b",
      poutinePrivateKeyPath: keyPathB,
      poutinePeersConfig: peersYamlB,
      poutineInstanceId: "poutine-b",
      navidromeUrl: `http://127.0.0.1:${navidromePort}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    };
    appB = await buildApp(configB);
    await appB.ready();
    await appB.listen({ port: 0, host: "127.0.0.1" });
    portB = (appB.server.address() as AddressInfo).port;

    // A knows B's URL (now that B is listening)
    writeYaml(
      peersYamlA,
      [
        `peers:`,
        `  - id: "poutine-b"`,
        `    url: "http://127.0.0.1:${portB}"`,
        `    public_key: "ed25519:${pubB}"`,
      ].join("\n"),
    );

    // Build A (no listening needed — we use inject)
    const configA: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-a",
      poutinePrivateKeyPath: keyPathA,
      poutinePeersConfig: peersYamlA,
      poutineInstanceId: "poutine-a",
    };
    appA = await buildApp(configA);
    await appA.ready();

    // A syncs B via /proxy/* — reads catalog from B's fake Navidrome, then merges
    const peerB = appA.peerRegistry.peers.get("poutine-b");
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "tester");
    mergeLibraries(appA.db);

    // Seed A's user so Subsonic auth passes
    await seedUser(appA);
  });

  afterEach(async () => {
    await appA.close();
    await appB.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
    for (const f of [keyPathA, keyPathB, peersYamlA, peersYamlB]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("routes audio through federation to the peer's Navidrome", async () => {
    // Get A's unified_track_id for the peer-sourced track
    const track = appA.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };
    expect(track).toBeDefined();

    // Confirm A sees it as a peer source
    const source = appA.db
      .prepare(
        "SELECT instance_id FROM track_sources WHERE unified_track_id = ?",
      )
      .get(track.id) as { instance_id: string } | undefined;
    expect(source?.instance_id).toBe("poutine-b");

    const res = await appA.inject({
      method: "GET",
      url: `/rest/stream?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });
});

// ── Source selection: shared track helpers ────────────────────────────────────

/**
 * Build a two-hub test setup where both A and B have the same track
 * (same artist / album / title / track-number / duration) but potentially
 * different quality, then have A sync B so it holds both a local source and
 * a peer source for that unified track.
 *
 * Returns the two apps and servers so the caller can make assertions and
 * then tear everything down.
 */
async function buildSharedTrackSetup(opts: {
  /** format/bitrate for hub-b's copy of the track */
  bFormat: string;
  bBitrate: number;
  /** content-type that hub-b's fake Navidrome reports when streaming */
  bContentType: string;
}): Promise<{
  appA: FastifyInstance;
  appB: FastifyInstance;
  navA: http.Server;
  navB: http.Server;
  keyPathA: string;
  keyPathB: string;
  peersYamlA: string;
  peersYamlB: string;
}> {
  // Fake Navidrome A — serves local audio as audio/mpeg + Subsonic JSON for catalog
  const navA = http.createServer(
    buildFakeNavidromeHandler({
      audioPayload: FAKE_AUDIO_LOCAL,
      audioContentType: "audio/mpeg",
      format: "mp3",
      bitrate: 320,
    }),
  );
  await new Promise<void>((resolve) => navA.listen(0, "127.0.0.1", () => resolve()));
  const navAPort = (navA.address() as AddressInfo).port;

  // Fake Navidrome B — serves peer audio + Subsonic JSON for catalog
  const navB = http.createServer(
    buildFakeNavidromeHandler({
      audioPayload: FAKE_AUDIO_PEER,
      audioContentType: opts.bContentType,
      format: opts.bFormat,
      bitrate: opts.bBitrate,
    }),
  );
  await new Promise<void>((resolve) => navB.listen(0, "127.0.0.1", () => resolve()));
  const navBPort = (navB.address() as AddressInfo).port;

  const keyPathA = tmpPath("key-a.pem");
  const keyPathB = tmpPath("key-b.pem");
  const peersYamlA = tmpPath("peers-a.yaml");
  const peersYamlB = tmpPath("peers-b.yaml");

  const { publicKeyBase64: pubA } = loadOrCreatePrivateKey(keyPathA);
  const { publicKeyBase64: pubB } = loadOrCreatePrivateKey(keyPathB);

  writeYaml(peersYamlB, [
    `peers:`,
    `  - id: "poutine-a"`,
    `    url: "http://localhost"`,
    `    public_key: "ed25519:${pubA}"`,
  ].join("\n"));

  const configB: Partial<Config> = {
    databasePath: ":memory:",
    jwtSecret: "test-b",
    poutinePrivateKeyPath: keyPathB,
    poutinePeersConfig: peersYamlB,
    poutineInstanceId: "poutine-b",
    navidromeUrl: `http://127.0.0.1:${navBPort}`,
    navidromeUsername: "admin",
    navidromePassword: "admin",
  };
  const appB = await buildApp(configB);
  await appB.ready();
  await appB.listen({ port: 0, host: "127.0.0.1" });
  const portB = (appB.server.address() as AddressInfo).port;

  writeYaml(peersYamlA, [
    `peers:`,
    `  - id: "poutine-b"`,
    `    url: "http://127.0.0.1:${portB}"`,
    `    public_key: "ed25519:${pubB}"`,
  ].join("\n"));

  const configA: Partial<Config> = {
    databasePath: ":memory:",
    jwtSecret: "test-a",
    poutinePrivateKeyPath: keyPathA,
    poutinePeersConfig: peersYamlA,
    poutineInstanceId: "poutine-a",
    navidromeUrl: `http://127.0.0.1:${navAPort}`,
    navidromeUsername: "admin",
    navidromePassword: "admin",
  };
  const appA = await buildApp(configA);
  await appA.ready();

  // Seed A's local library: MP3 @ 320 kbps via direct DB insert (local sync reads Navidrome directly).
  appA.db.prepare(
    `INSERT OR IGNORE INTO instance_artists
     (id, instance_id, remote_id, name, album_count)
     VALUES ('local:art-1', 'local', 'art-1', 'Shared Artist', 1)`,
  ).run();
  appA.db.prepare(
    `INSERT OR IGNORE INTO instance_albums
     (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
     VALUES ('local:alb-1', 'local', 'alb-1', 'Shared Album', 'local:art-1', 'Shared Artist', 1, NULL)`,
  ).run();
  appA.db.prepare(
    `INSERT OR IGNORE INTO instance_tracks
     (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
     VALUES ('local:trk-1', 'local', 'trk-1', 'local:alb-1', 'Shared Track', 'Shared Artist', 1, 200000, 'mp3', 320)`,
  ).run();

  // A syncs B → reads B's catalog via /proxy/rest/* (fake navB responds to Subsonic JSON queries)
  // This populates A's instance_* tables with poutine-b rows, then merges into unified_*.
  const peerB = appA.peerRegistry.peers.get("poutine-b");
  await syncPeer(appA.db, peerB!, appA.federatedFetch, "tester");
  mergeLibraries(appA.db);

  await seedUser(appA);

  return { appA, appB, navA, navB, keyPathA, keyPathB, peersYamlA, peersYamlB };
}

async function teardownSharedTrackSetup(setup: {
  appA: FastifyInstance;
  appB: FastifyInstance;
  navA: http.Server;
  navB: http.Server;
  keyPathA: string;
  keyPathB: string;
  peersYamlA: string;
  peersYamlB: string;
}) {
  await setup.appA.close();
  await setup.appB.close();
  await new Promise<void>((resolve) => setup.navA.close(() => resolve()));
  await new Promise<void>((resolve) => setup.navB.close(() => resolve()));
  for (const f of [setup.keyPathA, setup.keyPathB, setup.peersYamlA, setup.peersYamlB]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ── Source selection: identical quality → local preferred ─────────────────────

describe("stream — identical track on local and peer → local source preferred", () => {
  let setup: Awaited<ReturnType<typeof buildSharedTrackSetup>>;

  beforeEach(async () => {
    setup = await buildSharedTrackSetup({
      bFormat: "mp3",
      bBitrate: 320,
      bContentType: "audio/mpeg",
    });
  });

  afterEach(async () => {
    await teardownSharedTrackSetup(setup);
  });

  it("merged into one unified track with both local and peer sources", () => {
    const tracks = setup.appA.db
      .prepare("SELECT id FROM unified_tracks")
      .all() as { id: string }[];
    expect(tracks).toHaveLength(1);

    const sources = setup.appA.db
      .prepare(
        "SELECT instance_id FROM track_sources WHERE unified_track_id = ? ORDER BY instance_id",
      )
      .all(tracks[0].id) as { instance_id: string }[];
    expect(sources.map((s) => s.instance_id)).toEqual(["local", "poutine-b"]);
  });

  it("streams from local Navidrome (local tie-break beats equal-quality peer)", async () => {
    const track = setup.appA.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await setup.appA.inject({
      method: "GET",
      url: `/rest/stream?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    // Audio bytes must come from hub-a's own Navidrome, not hub-b's
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO_LOCAL);
  });
});

// ── Source selection: peer is higher quality → peer preferred ─────────────────

describe("stream — peer has higher-quality recording → peer source preferred", () => {
  let setup: Awaited<ReturnType<typeof buildSharedTrackSetup>>;

  beforeEach(async () => {
    setup = await buildSharedTrackSetup({
      bFormat: "flac",
      bBitrate: 1000,
      bContentType: "audio/flac",
    });
  });

  afterEach(async () => {
    await teardownSharedTrackSetup(setup);
  });

  it("merged into one unified track with both local and peer sources", () => {
    const tracks = setup.appA.db
      .prepare("SELECT id FROM unified_tracks")
      .all() as { id: string }[];
    expect(tracks).toHaveLength(1);

    const sources = setup.appA.db
      .prepare(
        "SELECT instance_id, format FROM track_sources WHERE unified_track_id = ? ORDER BY instance_id",
      )
      .all(tracks[0].id) as { instance_id: string; format: string }[];
    expect(sources.map((s) => s.instance_id)).toEqual(["local", "poutine-b"]);

    const localSrc = sources.find((s) => s.instance_id === "local");
    const peerSrc  = sources.find((s) => s.instance_id === "poutine-b");
    expect(localSrc?.format).toBe("mp3");
    expect(peerSrc?.format).toBe("flac");
  });

  it("streams from peer Navidrome (FLAC format quality beats local MP3)", async () => {
    const track = setup.appA.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await setup.appA.inject({
      method: "GET",
      url: `/rest/stream?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    // Content-type must reflect hub-b's FLAC source
    expect(res.headers["content-type"]).toMatch(/audio\/flac/);
    // Audio bytes must come from hub-b's Navidrome, not hub-a's
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO_PEER);
  });
});
