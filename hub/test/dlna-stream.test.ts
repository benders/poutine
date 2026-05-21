/**
 * Positive-path test for /dlna/stream/:trackId. Pairs the existing
 * fake-Navidrome harness from stream.test.ts with a buildApp that has
 * DLNA_ENABLED=true. Locks in:
 *
 *  - 200 + audio bytes from the upstream
 *  - Required DLNA response headers (`contentFeatures.dlna.org`,
 *    `transferMode.dlna.org`) — strict clients (WMP) reject responses
 *    missing these.
 *  - 503 (not 404) when the unified library knows the track but no source
 *    instance is currently advertising it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { mergeLibraries } from "../src/library/merge.js";

const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

function startFakeNavidrome(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rangeHeader = req.headers.range;
      if (typeof rangeHeader === "string") {
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (m) {
          const start = Number(m[1]);
          const end =
            m[2] === ""
              ? FAKE_AUDIO.length - 1
              : Math.min(Number(m[2]), FAKE_AUDIO.length - 1);
          const slice = FAKE_AUDIO.subarray(start, end + 1);
          res.writeHead(206, {
            "content-type": "audio/mpeg",
            "content-length": String(slice.length),
            "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${FAKE_AUDIO.length}`,
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(FAKE_AUDIO.length),
        "accept-ranges": "bytes",
      });
      res.end(FAKE_AUDIO);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-dlna-stream-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
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

describe("/dlna/stream/:trackId — positive path", () => {
  let app: FastifyInstance;
  let navidrome: http.Server;

  beforeEach(async () => {
    const { server, port } = await startFakeNavidrome();
    navidrome = server;

    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "test-secret",
      navidromeUrl: `http://127.0.0.1:${port}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
      poutinePrivateKeyPath: tmpPath("ed.pem"),
      poutinePasswordKeyPath: tmpPath("pwkey"),
      poutineInstanceId: "dlna-stream-test",
      poutineOwnerUsername: "owner",
      poutineOwnerPassword: "secret",
      dlnaEnabled: true,
      // lan_url unset → no SSDP advertiser. The stream route doesn't
      // need it; res@uri construction happens in Browse, not here.
      initialLanUrl: undefined,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
  });

  it("streams local audio and sets the required DLNA response headers", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/dlna/stream/${track.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.headers["contentfeatures.dlna.org"]).toContain(
      "DLNA.ORG_OP=01",
    );
    expect(res.headers["transfermode.dlna.org"]).toBe("Streaming");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("echoes a non-default transferMode.dlna.org request header", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/dlna/stream/${track.id}`,
      headers: { "transfermode.dlna.org": "Interactive" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["transfermode.dlna.org"]).toBe("Interactive");
  });

  it("forwards Range and returns 206 + content-range", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/dlna/stream/${track.id}`,
      headers: { range: "bytes=2-5" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes 2-5/${FAKE_AUDIO.length}`,
    );
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO.subarray(2, 6));
  });

  it("404 for an unknown trackId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/dlna/stream/no-such-track`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("503 when the track exists but has no preferred source", async () => {
    // Seed only the unified row, not instance_tracks / track_sources.
    app.db
      .prepare(
        `INSERT INTO unified_artists (id, name, name_normalized)
         VALUES ('ua-orphan', 'Orphan', 'orphan')`,
      )
      .run();
    app.db
      .prepare(
        `INSERT INTO unified_release_groups (id, artist_id, name, name_normalized)
         VALUES ('urg-orphan', 'ua-orphan', 'Orphan Album', 'orphan album')`,
      )
      .run();
    app.db
      .prepare(
        `INSERT INTO unified_releases (id, release_group_id, name)
         VALUES ('ur-orphan', 'urg-orphan', 'Orphan Release')`,
      )
      .run();
    app.db
      .prepare(
        `INSERT INTO unified_tracks (id, artist_id, release_id, title, title_normalized, duration_ms)
         VALUES ('ut-orphan', 'ua-orphan', 'ur-orphan', 'Orphan Track', 'orphan track', 1000)`,
      )
      .run();

    const res = await app.inject({
      method: "GET",
      url: `/dlna/stream/ut-orphan`,
    });
    expect(res.statusCode).toBe(503);
  });
});
