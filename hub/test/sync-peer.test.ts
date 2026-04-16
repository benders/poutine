/**
 * Tests for syncPeer — reading a peer's Navidrome library via /proxy/*.
 *
 * Each test starts a real HTTP server as a fake Navidrome B. The fake server
 * responds to Subsonic catalog API calls (getArtists / getArtist / getAlbum)
 * with configurable JSON. Hub B's /proxy/* forwards these calls to the fake
 * Navidrome; hub A calls syncPeer() which reads through B's proxy with signed
 * Ed25519 requests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { syncPeer } from "../src/library/sync-peer.js";
import { mergeLibraries } from "../src/library/merge.js";
import type { Config } from "../src/config.js";

// ── Fake Navidrome helpers ────────────────────────────────────────────────────

function subsonicOk(data: Record<string, unknown>): string {
  return JSON.stringify({
    "subsonic-response": { status: "ok", version: "1.16.1", ...data },
  });
}

interface FakeSong {
  id: string;
  title: string;
  format: string;
  bitrate: number;
  durationMs: number;
  trackNumber: number;
}

interface FakeAlbum {
  id: string;
  name: string;
  songs: FakeSong[];
}

interface FakeArtist {
  id: string;
  name: string;
  albums: FakeAlbum[];
}

/**
 * Build a configurable fake Navidrome request handler.
 * Call setArtists() to change what the server returns between syncs.
 */
function buildConfigurableFakeNavidrome(): {
  handler: http.RequestListener;
  setArtists: (artists: FakeArtist[]) => void;
} {
  let artists: FakeArtist[] = [];

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p.includes("getArtists")) {
      const indexes = artists.map((a) => ({
        name: a.name[0].toUpperCase(),
        artist: [{ id: a.id, name: a.name, albumCount: a.albums.length }],
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({ artists: { index: indexes } }));
      return;
    }

    if (p.includes("getArtist")) {
      const artistId = url.searchParams.get("id") ?? "";
      const artist = artists.find((a) => a.id === artistId);
      if (!artist) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          "subsonic-response": {
            status: "failed",
            error: { code: 70, message: "not found" },
          },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({
        artist: {
          id: artist.id,
          name: artist.name,
          albumCount: artist.albums.length,
          album: artist.albums.map((al) => ({
            id: al.id,
            name: al.name,
            songCount: al.songs.length,
            duration: Math.round(al.songs.reduce((s, t) => s + t.durationMs, 0) / 1000),
          })),
        },
      }));
      return;
    }

    if (p.includes("getAlbum")) {
      const albumId = url.searchParams.get("id") ?? "";
      let found: { artist: FakeArtist; album: FakeAlbum } | undefined;
      for (const a of artists) {
        const al = a.albums.find((x) => x.id === albumId);
        if (al) { found = { artist: a, album: al }; break; }
      }
      if (!found) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          "subsonic-response": {
            status: "failed",
            error: { code: 70, message: "not found" },
          },
        }));
        return;
      }
      const { artist, album } = found;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({
        album: {
          id: album.id,
          name: album.name,
          artist: artist.name,
          artistId: artist.id,
          songCount: album.songs.length,
          duration: Math.round(album.songs.reduce((s, t) => s + t.durationMs, 0) / 1000),
          song: album.songs.map((s) => ({
            id: s.id,
            title: s.title,
            artist: artist.name,
            track: s.trackNumber,
            duration: Math.round(s.durationMs / 1000),
            bitRate: s.bitrate,
            suffix: s.format,
          })),
        },
      }));
      return;
    }

    // All other requests → simple 200
    res.writeHead(200, { "content-type": "application/json" });
    res.end(subsonicOk({}));
  };

  return {
    handler,
    setArtists: (a) => { artists = a; },
  };
}

// ── Test utilities ────────────────────────────────────────────────────────────

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-sp-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("sync-peer (via /proxy/*)", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let portB: number;
  let fakeNavidrome: http.Server;
  let setArtists: (artists: FakeArtist[]) => void;
  let keyPathA: string;
  let keyPathB: string;
  let peersYamlA: string;
  let peersYamlB: string;

  const defaultArtist: FakeArtist = {
    id: "art-1",
    name: "Test Artist",
    albums: [
      {
        id: "alb-1",
        name: "Test Album",
        songs: [
          { id: "trk-1", title: "Test Track", format: "flac", bitrate: 1000, durationMs: 240000, trackNumber: 1 },
        ],
      },
    ],
  };

  beforeEach(async () => {
    keyPathA = tmpPath("key-a.pem");
    keyPathB = tmpPath("key-b.pem");
    peersYamlA = tmpPath("peers-a.yaml");
    peersYamlB = tmpPath("peers-b.yaml");

    const { publicKeyBase64: pubA } = loadOrCreatePrivateKey(keyPathA);
    const { publicKeyBase64: pubB } = loadOrCreatePrivateKey(keyPathB);

    // Build configurable fake Navidrome
    const fake = buildConfigurableFakeNavidrome();
    setArtists = fake.setArtists;
    setArtists([defaultArtist]); // default: 1 artist, 1 album, 1 track

    fakeNavidrome = http.createServer(fake.handler);
    await new Promise<void>((resolve) => fakeNavidrome.listen(0, "127.0.0.1", () => resolve()));
    const fakePort = (fakeNavidrome.address() as AddressInfo).port;

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

    // Build and start B (B's Navidrome is the fake server)
    const configB: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-b",
      poutinePrivateKeyPath: keyPathB,
      poutinePeersConfig: peersYamlB,
      poutineInstanceId: "poutine-b",
      navidromeUrl: `http://127.0.0.1:${fakePort}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    };
    appB = await buildApp(configB);
    await appB.ready();
    await appB.listen({ port: 0, host: "127.0.0.1" });
    portB = (appB.server.address() as AddressInfo).port;

    // A knows B's URL
    writeYaml(
      peersYamlA,
      [
        `peers:`,
        `  - id: "poutine-b"`,
        `    url: "http://127.0.0.1:${portB}"`,
        `    public_key: "ed25519:${pubB}"`,
      ].join("\n"),
    );

    const configA: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-a",
      poutinePrivateKeyPath: keyPathA,
      poutinePeersConfig: peersYamlA,
      poutineInstanceId: "poutine-a",
    };
    appA = await buildApp(configA);
    await appA.ready();
  });

  afterEach(async () => {
    await appA.close();
    await appB.close();
    await new Promise<void>((resolve) => fakeNavidrome.close(() => resolve()));
    for (const f of [keyPathA, keyPathB, peersYamlA, peersYamlB]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("reads B's Navidrome via /proxy/* and populates A's instance_* tables", async () => {
    const peerB = appA.peerRegistry.peers.get("poutine-b");
    expect(peerB).toBeDefined();

    const result = await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");

    expect(result.errors).toHaveLength(0);
    expect(result.artistCount).toBeGreaterThan(0);
    expect(result.albumCount).toBeGreaterThan(0);
    expect(result.trackCount).toBeGreaterThan(0);

    const artists = appA.db
      .prepare("SELECT * FROM instance_artists WHERE instance_id = 'poutine-b'")
      .all();
    expect(artists.length).toBeGreaterThan(0);

    const albums = appA.db
      .prepare("SELECT * FROM instance_albums WHERE instance_id = 'poutine-b'")
      .all();
    expect(albums.length).toBeGreaterThan(0);

    const tracks = appA.db
      .prepare("SELECT * FROM instance_tracks WHERE instance_id = 'poutine-b'")
      .all();
    expect(tracks.length).toBeGreaterThan(0);
  });

  it("after mergeLibraries, track_sources are keyed by instance_id=poutine-b", async () => {
    const peerB = appA.peerRegistry.peers.get("poutine-b");
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");

    mergeLibraries(appA.db);

    const peerSources = appA.db
      .prepare(
        `SELECT * FROM track_sources WHERE instance_id = 'poutine-b'`,
      )
      .all() as Array<{ instance_id: string }>;

    expect(peerSources.length).toBeGreaterThan(0);
    expect(peerSources[0].instance_id).toBe("poutine-b");
  });

  it("second sync prunes stale tracks removed from peer Navidrome", async () => {
    const peerB = appA.peerRegistry.peers.get("poutine-b");

    // First sync: fake Navidrome has 1 track (trk-1)
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");
    mergeLibraries(appA.db);

    const countAfterFirst = (
      appA.db
        .prepare("SELECT COUNT(*) AS n FROM instance_tracks WHERE instance_id = 'poutine-b'")
        .get() as { n: number }
    ).n;
    expect(countAfterFirst).toBe(1);

    // Add a second track to B's fake Navidrome
    setArtists([{
      id: "art-1",
      name: "Test Artist",
      albums: [{
        id: "alb-1",
        name: "Test Album",
        songs: [
          { id: "trk-1", title: "Test Track", format: "flac", bitrate: 1000, durationMs: 240000, trackNumber: 1 },
          { id: "trk-2", title: "Second Track", format: "flac", bitrate: 1000, durationMs: 180000, trackNumber: 2 },
        ],
      }],
    }]);

    // Second sync: B now has 2 tracks
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");
    const countAfterSecond = (
      appA.db
        .prepare("SELECT COUNT(*) AS n FROM instance_tracks WHERE instance_id = 'poutine-b'")
        .get() as { n: number }
    ).n;
    expect(countAfterSecond).toBe(2);

    // Remove trk-1 from B's fake Navidrome (only trk-2 remains)
    setArtists([{
      id: "art-1",
      name: "Test Artist",
      albums: [{
        id: "alb-1",
        name: "Test Album",
        songs: [
          { id: "trk-2", title: "Second Track", format: "flac", bitrate: 1000, durationMs: 180000, trackNumber: 2 },
        ],
      }],
    }]);

    // Third sync: trk-1 should be pruned from A
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");
    const countAfterThird = (
      appA.db
        .prepare("SELECT COUNT(*) AS n FROM instance_tracks WHERE instance_id = 'poutine-b'")
        .get() as { n: number }
    ).n;
    expect(countAfterThird).toBe(1);

    const remaining = appA.db
      .prepare("SELECT remote_id FROM instance_tracks WHERE instance_id = 'poutine-b'")
      .all() as Array<{ remote_id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].remote_id).toBe("trk-2");
  });
});
