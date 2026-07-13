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
  path?: string;
}): http.RequestListener {
  const { artistId, artistName, albumId, albumName, trackId, trackTitle, format, bitrate, durationMs, path: songPath } = opts;

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
            ...(songPath !== undefined ? { path: songPath } : {}),
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
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
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
    }>;
    expect(sources).toHaveLength(2);

    // Local source
    const localSrc = sources.find((s) => s.instance_id === "local");
    expect(localSrc).toBeDefined();
    expect(localSrc?.format).toBe("mp3");
    expect(localSrc?.bitrate).toBe(320);

    // Peer source
    const peerSrc = sources.find((s) => s.instance_id === "peer-hub");
    expect(peerSrc).toBeDefined();
    expect(peerSrc?.format).toBe("flac");
    expect(peerSrc?.bitrate).toBe(1000);
  });

  it("unreachable peer at probe time → cached library wiped, unified merge excludes it", async () => {
    // First sync: peer is reachable and populates instance_* rows.
    await readNavidromeViaProxy(db, "local", makeProxyFetch(localPort));
    await readNavidromeViaProxy(db, "peer-hub", makeProxyFetch(peerPort));
    mergeLibraries(db);

    expect(db.prepare("SELECT COUNT(*) AS c FROM instance_tracks WHERE instance_id = 'peer-hub'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM track_sources WHERE instance_id = 'peer-hub'").get()).toEqual({ c: 1 });

    // Second sync: peer is unreachable — point ProxyFetch at a closed port.
    const deadFetch: ProxyFetch = async () => { throw new Error("ECONNREFUSED"); };
    const result = await readNavidromeViaProxy(db, "peer-hub", deadFetch);
    expect(result.errors.length).toBeGreaterThan(0);

    // Peer's instance_* rows must be gone.
    expect(db.prepare("SELECT COUNT(*) AS c FROM instance_tracks  WHERE instance_id = 'peer-hub'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM instance_albums  WHERE instance_id = 'peer-hub'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM instance_artists WHERE instance_id = 'peer-hub'").get()).toEqual({ c: 0 });

    // Instance row marked offline with cleared track_count.
    const row = db.prepare("SELECT status, last_sync_ok, track_count FROM instances WHERE id = 'peer-hub'").get() as {
      status: string; last_sync_ok: number; track_count: number;
    };
    expect(row.status).toBe("offline");
    expect(row.last_sync_ok).toBe(0);
    expect(row.track_count).toBe(0);

    // After a remerge, unified_* has no peer source.
    mergeLibraries(db);
    const peerSources = db.prepare("SELECT COUNT(*) AS c FROM track_sources WHERE instance_id = 'peer-hub'").get();
    expect(peerSources).toEqual({ c: 0 });
    // Local source survives.
    const localSources = db.prepare("SELECT COUNT(*) AS c FROM track_sources WHERE instance_id = 'local'").get();
    expect(localSources).toEqual({ c: 1 });
  });

  it("local-only instance results in one unified track with one local source", async () => {
    await readNavidromeViaProxy(db, "local", makeProxyFetch(localPort));
    mergeLibraries(db);

    const tracks = db.prepare("SELECT * FROM unified_tracks").all();
    expect(tracks).toHaveLength(1);

    const sources = db.prepare("SELECT * FROM track_sources").all() as Array<{
      instance_id: string;
    }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].instance_id).toBe("local");
  });
});

// ── #157: track_count must be the deduplicated count ─────────────────────────

describe("readNavidromeViaProxy trackCount de-duplication (#157)", () => {
  let db: Database.Database;
  let nav: http.Server;
  let port: number;
  let ownerId: string;

  beforeEach(async () => {
    db = createDatabase(":memory:");
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("dup-inst", "Dup Instance", "http://dup", "subsonic", "", ownerId, "online");

    // One artist with two albums whose track listings both include the same
    // song id — reproduces the overlapping-album-listing condition from #157
    // (multi-disc / compilation quirks in real Navidrome data).
    ({ server: nav, port } = await startFakeNavidrome((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const albumId = url.searchParams.get("id");

      if (p.includes("getArtists")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(subsonicOk({
          artists: { index: [{ name: "D", artist: [{ id: "art1", name: "Dup Artist", albumCount: 2 }] }] },
        }));
        return;
      }
      if (p.includes("getArtist")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(subsonicOk({
          artist: {
            id: "art1",
            name: "Dup Artist",
            albumCount: 2,
            album: [
              { id: "alb1", name: "Album One", songCount: 1, duration: 240 },
              { id: "alb2", name: "Album Two", songCount: 1, duration: 240 },
            ],
          },
        }));
        return;
      }
      if (p.includes("getAlbum")) {
        // Both albums list the SAME song id — the duplicate-upsert condition.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(subsonicOk({
          album: {
            id: albumId,
            name: albumId === "alb1" ? "Album One" : "Album Two",
            artist: "Dup Artist",
            artistId: "art1",
            songCount: 1,
            duration: 240,
            song: [{
              id: "dup-song",
              title: "Duplicated Track",
              artist: "Dup Artist",
              track: 1,
              duration: 240,
              bitRate: 320,
              suffix: "mp3",
            }],
          },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(subsonicOk({}));
    }));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => nav.close(() => resolve()));
  });

  it("reports the deduplicated track count, not the visit count", async () => {
    const result = await readNavidromeViaProxy(db, "dup-inst", makeProxyFetch(port));
    expect(result.errors).toHaveLength(0);
    // The song was visited twice (once per album) but is one distinct track.
    expect(result.trackCount).toBe(1);

    const rowCount = db
      .prepare("SELECT COUNT(*) AS c FROM instance_tracks WHERE instance_id = 'dup-inst'")
      .get() as { c: number };
    expect(rowCount.c).toBe(1);

    const instanceRow = db
      .prepare("SELECT track_count FROM instances WHERE id = 'dup-inst'")
      .get() as { track_count: number };
    expect(instanceRow.track_count).toBe(1);
  });
});

// ── #252: library-relative file path ingestion ───────────────────────────────

describe("readNavidromeViaProxy instance_tracks.path ingestion (#252)", () => {
  let db: Database.Database;
  let nav: http.Server;
  let port: number;
  let ownerId: string;

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => nav.close(() => resolve()));
  });

  async function setup(songPath?: string): Promise<void> {
    db = createDatabase(":memory:");
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);
    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("path-inst", "Path Instance", "http://path", "subsonic", "", ownerId, "online");

    ({ server: nav, port } = await startFakeNavidrome(
      makeSubsonicHandler({
        artistId: "art-path",
        artistName: "Epsilon Artist",
        albumId: "alb-path",
        albumName: "Big Album",
        trackId: "trk-path",
        trackTitle: "Echo Track",
        format: "mp3",
        bitrate: 320,
        durationMs: 240000,
        path: songPath,
      }),
    ));
  }

  it("stores the song's library-relative path in instance_tracks.path", async () => {
    const songPath = "Epsilon Artist/Big Album/05 - Echo Track.mp3";
    await setup(songPath);

    const result = await readNavidromeViaProxy(db, "path-inst", makeProxyFetch(port));
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare("SELECT path FROM instance_tracks WHERE instance_id = 'path-inst' AND remote_id = 'trk-path'")
      .get() as { path: string | null };
    expect(row.path).toBe(songPath);
  });

  it("stores NULL when the song has no path and does not error", async () => {
    await setup(undefined);

    const result = await readNavidromeViaProxy(db, "path-inst", makeProxyFetch(port));
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare("SELECT path FROM instance_tracks WHERE instance_id = 'path-inst' AND remote_id = 'trk-path'")
      .get() as { path: string | null };
    expect(row.path).toBeNull();
  });
});
