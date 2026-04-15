/**
 * Multi-instance merge test: one "local" Navidrome + one "peer-via-proxy"
 * Navidrome merge into the expected unified rows.
 *
 * Tests readNavidromeViaProxy() directly using a ProxyFetch backed by a real
 * HTTP server, confirming the full pipeline from proxy response → instance_*
 * tables → unified_* merge.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { readNavidromeViaProxy } from "../src/library/sync-instance.js";
import { mergeLibraries } from "../src/library/merge.js";
import type { ProxyFetch } from "../src/library/sync-instance.js";

// ── Fake Navidrome helpers ────────────────────────────────────────────────────

function subsonicOk(data: Record<string, unknown>): string {
  return JSON.stringify({
    "subsonic-response": { status: "ok", version: "1.16.1", ...data },
  });
}

function startFakeNavidrome(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function makeSubsonicHandler(opts: {
  artistId: string;
  artistName: string;
  albumId: string;
  albumName: string;
  trackId: string;
  trackTitle: string;
  format: string;
  bitrate: number;
  durationMs: number;
}): http.RequestListener {
  const { artistId, artistName, albumId, albumName, trackId, trackTitle, format, bitrate, durationMs } = opts;

  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p.includes("getArtists")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({
        artists: {
          index: [{ name: artistName[0], artist: [{ id: artistId, name: artistName, albumCount: 1 }] }],
        },
      }));
      return;
    }

    if (p.includes("getArtist")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({
        artist: {
          id: artistId,
          name: artistName,
          albumCount: 1,
          album: [{ id: albumId, name: albumName, songCount: 1, duration: Math.round(durationMs / 1000) }],
        },
      }));
      return;
    }

    if (p.includes("getAlbum")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({
        album: {
          id: albumId,
          name: albumName,
          artist: artistName,
          artistId,
          songCount: 1,
          duration: Math.round(durationMs / 1000),
          song: [{
            id: trackId,
            title: trackTitle,
            artist: artistName,
            track: 1,
            duration: Math.round(durationMs / 1000),
            bitRate: bitrate,
            suffix: format,
          }],
        },
      }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(subsonicOk({}));
  };
}

function makeProxyFetch(port: number): ProxyFetch {
  return async (subPath: string) => {
    return fetch(`http://127.0.0.1:${port}${subPath}`);
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("multi-instance merge via proxy", () => {
  let db: Database.Database;
  let localNav: http.Server;
  let peerNav: http.Server;
  let localPort: number;
  let peerPort: number;
  let ownerId: string;

  beforeEach(async () => {
    db = createDatabase(":memory:");

    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);

    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("local", "Local Navidrome", "http://local", "subsonic", "", ownerId, "online");

    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("peer-hub", "Peer Hub", "http://peer", "subsonic", "", ownerId, "online");

    // Local Navidrome: same artist/album as peer (shared track, different quality)
    ({ server: localNav, port: localPort } = await startFakeNavidrome(
      makeSubsonicHandler({
        artistId: "art-local",
        artistName: "Shared Artist",
        albumId: "alb-local",
        albumName: "Shared Album",
        trackId: "trk-local",
        trackTitle: "Shared Track",
        format: "mp3",
        bitrate: 320,
        durationMs: 240000,
      }),
    ));

    // Peer Navidrome: same artist/album/track (higher quality FLAC)
    ({ server: peerNav, port: peerPort } = await startFakeNavidrome(
      makeSubsonicHandler({
        artistId: "art-peer",
        artistName: "Shared Artist",  // same normalized name → will merge artist
        albumId: "alb-peer",
        albumName: "Shared Album",    // same normalized name → will merge album
        trackId: "trk-peer",
        trackTitle: "Shared Track",   // same title + same duration → will merge track
        format: "flac",
        bitrate: 1000,
        durationMs: 240000,           // same duration → merges with local
      }),
    ));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => localNav.close(() => resolve()));
    await new Promise<void>((resolve) => peerNav.close(() => resolve()));
  });

  it("two Navidrome instances (local + peer) merge into one unified artist/album/track with two sources", async () => {
    // Read local Navidrome into instance_* tables
    const localResult = await readNavidromeViaProxy(
      db,
      "local",
      makeProxyFetch(localPort),
    );
    expect(localResult.errors).toHaveLength(0);
    expect(localResult.artistCount).toBe(1);
    expect(localResult.albumCount).toBe(1);
    expect(localResult.trackCount).toBe(1);

    // Read peer Navidrome into instance_* tables
    const peerResult = await readNavidromeViaProxy(
      db,
      "peer-hub",
      makeProxyFetch(peerPort),
    );
    expect(peerResult.errors).toHaveLength(0);
    expect(peerResult.artistCount).toBe(1);
    expect(peerResult.albumCount).toBe(1);
    expect(peerResult.trackCount).toBe(1);

    // Merge all instance_* data into unified_* tables
    mergeLibraries(db);

    // One unified artist (merged by normalized name)
    const artists = db.prepare("SELECT * FROM unified_artists").all() as Array<Record<string, unknown>>;
    expect(artists).toHaveLength(1);
    expect(artists[0].name_normalized).toBe("shared artist");

    // One unified release group
    const rgs = db.prepare("SELECT * FROM unified_release_groups").all();
    expect(rgs).toHaveLength(1);

    // One unified track with two sources
    const tracks = db.prepare("SELECT * FROM unified_tracks").all();
    expect(tracks).toHaveLength(1);

    const sources = db.prepare("SELECT * FROM track_sources ORDER BY instance_id").all() as Array<{
      instance_id: string;
      format: string;
      bitrate: number;
      source_kind: string;
      peer_id: string | null;
    }>;
    expect(sources).toHaveLength(2);

    // Local source
    const localSrc = sources.find((s) => s.instance_id === "local");
    expect(localSrc).toBeDefined();
    expect(localSrc?.format).toBe("mp3");
    expect(localSrc?.bitrate).toBe(320);
    expect(localSrc?.source_kind).toBe("local");
    expect(localSrc?.peer_id).toBeNull();

    // Peer source
    const peerSrc = sources.find((s) => s.instance_id === "peer-hub");
    expect(peerSrc).toBeDefined();
    expect(peerSrc?.format).toBe("flac");
    expect(peerSrc?.bitrate).toBe(1000);
    expect(peerSrc?.source_kind).toBe("peer");
    expect(peerSrc?.peer_id).toBe("peer-hub");
  });

  it("local-only instance results in one unified track with one local source", async () => {
    await readNavidromeViaProxy(db, "local", makeProxyFetch(localPort));
    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks").all();
    expect(tracks).toHaveLength(1);

    const sources = db.prepare("SELECT * FROM track_sources").all() as Array<{
      source_kind: string;
      peer_id: string | null;
    }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].source_kind).toBe("local");
    expect(sources[0].peer_id).toBeNull();
  });
});
