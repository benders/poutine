/**
 * Integration tests for /rest/stream (and /rest/download alias).
 *
 * Covers:
 *   - Bad / missing ID → Subsonic error 70
 *   - Valid ID with no track sources → Subsonic error 70
 *   - Local source path: Poutine proxies to a fake Navidrome HTTP server
 *   - Peer source path: Poutine-A routes through Poutine-B → fake Navidrome
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

function startFakeNavidrome(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(FAKE_AUDIO.length),
      });
      res.end(FAKE_AUDIO);
    });
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

  it("missing id parameter → Subsonic error 70", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("id with wrong prefix → Subsonic error 70", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json&id=xyz999",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("valid prefixed id with no matching track sources → Subsonic error 70", async () => {
    // "t" prefix but UUID that doesn't exist in the DB
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?u=tester&p=secret&f=json&id=t00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
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
    // Start fake Navidrome (serves B's audio)
    ({ server: navidrome, port: navidromePort } = await startFakeNavidrome());

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
        `instance_id: "poutine-b"`,
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
        `instance_id: "poutine-a"`,
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

    // Seed B's library and merge it so B has a real unified track + local source
    appB.db
      .prepare(
        `INSERT OR IGNORE INTO instance_artists
         (id, instance_id, remote_id, name, album_count)
         VALUES ('local:art-1', 'local', 'art-1', 'Remote Artist', 1)`,
      )
      .run();
    appB.db
      .prepare(
        `INSERT OR IGNORE INTO instance_albums
         (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
         VALUES ('local:alb-1', 'local', 'alb-1', 'Remote Album', 'local:art-1', 'Remote Artist', 1, NULL)`,
      )
      .run();
    appB.db
      .prepare(
        `INSERT OR IGNORE INTO instance_tracks
         (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
         VALUES ('local:trk-1', 'local', 'trk-1', 'local:alb-1', 'Remote Track', 'Remote Artist', 1, 200000, 'flac', 1000)`,
      )
      .run();
    mergeLibraries(appB.db);

    // A syncs B, then merges — this gives A a peer track_source pointing to B
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
        "SELECT source_kind, peer_id FROM track_sources WHERE unified_track_id = ?",
      )
      .get(track.id) as { source_kind: string; peer_id: string } | undefined;
    expect(source?.source_kind).toBe("peer");
    expect(source?.peer_id).toBe("poutine-b");

    const res = await appA.inject({
      method: "GET",
      url: `/rest/stream?u=tester&p=secret&f=json&id=t${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });
});
