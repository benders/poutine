/**
 * #218 — DLNA stream handoff via Hub Subsonic. Replaces the deleted
 * `/dlna/stream/:trackId` Player relay.
 *
 * Validates that:
 *  - `buildStreamUrl({ dlna: true })` produces a URL that authenticates
 *    against `/rest/stream.view` via the cast token (no Subsonic
 *    `u+t+s` / `u+p` required).
 *  - The Subsonic stream handler emits DLNA-specific response headers
 *    (`contentFeatures.dlna.org`, `transferMode.dlna.org`,
 *    `accept-ranges: bytes`) when the URL carries `dlna=1`.
 *  - Range forwarding still works on the new path.
 *  - Unknown tokens / unknown tracks fail closed (401 / 404).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { mergeLibraries } from "../src/library/merge.js";
import { buildStreamUrl, signCastToken } from "../src/services/cast-tokens.js";

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

/**
 * Strip the host off a `buildStreamUrl` result so we can pass the rest
 * straight to `app.inject`. lanUrl is irrelevant for in-process injection.
 */
function stripHost(absoluteUrl: string): string {
  const u = new URL(absoluteUrl);
  return `${u.pathname}${u.search}`;
}

describe("/rest/stream.view — DLNA cast-token handoff (#218)", () => {
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
      initialLanUrl: undefined,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
  });

  it("streams local audio and emits DLNA response headers when dlna=1", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const url = buildStreamUrl({
      lanUrl: "http://test",
      castSecret: app.castSecret,
      unifiedTrackId: track.id,
      username: "owner",
      dlna: true,
    });

    const res = await app.inject({ method: "GET", url: stripHost(url) });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.headers["contentfeatures.dlna.org"]).toContain("DLNA.ORG_OP=01");
    expect(res.headers["transfermode.dlna.org"]).toBe("Streaming");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("echoes a non-default transferMode.dlna.org request header", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };

    const url = buildStreamUrl({
      lanUrl: "http://test",
      castSecret: app.castSecret,
      unifiedTrackId: track.id,
      username: "owner",
      dlna: true,
    });

    const res = await app.inject({
      method: "GET",
      url: stripHost(url),
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

    const url = buildStreamUrl({
      lanUrl: "http://test",
      castSecret: app.castSecret,
      unifiedTrackId: track.id,
      username: "owner",
      dlna: true,
    });

    const res = await app.inject({
      method: "GET",
      url: stripHost(url),
      headers: { range: "bytes=2-5" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes 2-5/${FAKE_AUDIO.length}`,
    );
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO.subarray(2, 6));
  });

  it("404 for an unknown trackId (token verifies, source absent)", async () => {
    // Sign a token for a track id that doesn't exist in the unified library.
    // The cast-token auth still passes (token is valid for that string), but
    // source-selection inside the stream handler returns 404.
    const badId = "no-such-track-uuid";
    const token = signCastToken(app.castSecret, {
      trackId: badId,
      username: "owner",
    });
    const url = `/rest/stream.view?id=${encodeURIComponent("t" + badId)}&castToken=${encodeURIComponent(token)}&dlna=1&u=owner&v=1.16.1&c=poutine-dlna`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(404);
  });

  it("401 when the cast token is invalid", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };
    const url = `/rest/stream.view?id=${encodeURIComponent("t" + track.id)}&castToken=bogus&dlna=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("401 when the cast token is bound to a different trackId", async () => {
    seedLocalTrack(app);
    const track = app.db
      .prepare("SELECT id FROM unified_tracks LIMIT 1")
      .get() as { id: string };
    const tokenForOtherTrack = signCastToken(app.castSecret, {
      trackId: "some-other-id",
      username: "owner",
    });
    const url = `/rest/stream.view?id=${encodeURIComponent("t" + track.id)}&castToken=${encodeURIComponent(tokenForOtherTrack)}&dlna=1`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });
});
