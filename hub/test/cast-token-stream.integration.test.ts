/**
 * #218 — End-to-end smoke test for the cast-token handoff at
 * `/rest/stream.view`. Locks in the contract that Player's only job is
 * to mint a URL — bytes flow direct from Hub Subsonic to the device.
 *
 * The Sonos route's URL builder is exercised by `sonos-routes.test.ts`;
 * this file boots an in-process app + fake Navidrome and confirms the
 * resulting URL actually streams when followed by a non-Subsonic client.
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

const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xde, 0xad, 0xbe, 0xef]);

function startFakeNavidrome(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
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
    `poutine-cast-token-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

function seedTrack(app: FastifyInstance) {
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_artists
       (id, instance_id, remote_id, name, album_count)
       VALUES ('local:a1', 'local', 'a1', 'A', 1)`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_albums
       (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
       VALUES ('local:al1', 'local', 'al1', 'Album', 'local:a1', 'A', 1, NULL)`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR IGNORE INTO instance_tracks
       (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
       VALUES ('local:t1', 'local', 't1', 'local:al1', 'Track', 'A', 1, 180000, 'mp3', 320)`,
    )
    .run();
  mergeLibraries(app.db);
}

describe("Cast-token stream handoff at /rest/stream.view (#218)", () => {
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
      poutineInstanceId: "cast-stream-test",
      poutineOwnerUsername: "owner",
      poutineOwnerPassword: "secret",
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
  });

  it("buildStreamUrl produces a URL that streams bytes via cast-token auth", async () => {
    seedTrack(app);
    const track = app.db.prepare("SELECT id FROM unified_tracks LIMIT 1").get() as { id: string };

    const url = buildStreamUrl({
      lanUrl: "http://hub.test:3000",
      castSecret: app.castSecret,
      unifiedTrackId: track.id,
      username: "owner",
      client: "poutine-sonos",
    });

    // URL must target the Hub Subsonic endpoint, not the deleted /cast/* relay.
    expect(url).toMatch(/^http:\/\/hub\.test:3000\/rest\/stream\.view\?/);
    expect(url).toContain(`id=t${track.id}`);
    expect(url).toContain("castToken=");
    expect(url).not.toContain("/cast/stream/");
    expect(url).not.toContain("/dlna/stream/");

    // Strip host → app.inject simulates the device's GET.
    const u = new URL(url);
    const res = await app.inject({ method: "GET", url: `${u.pathname}${u.search}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("a token bound to track A cannot stream track B", async () => {
    seedTrack(app);
    // Sign a token for a different (non-existent) track id.
    const token = signCastToken(app.castSecret, {
      trackId: "wrong-track-id",
      username: "owner",
    });
    const realTrack = app.db.prepare("SELECT id FROM unified_tracks LIMIT 1").get() as { id: string };
    const url = `/rest/stream.view?id=${encodeURIComponent("t" + realTrack.id)}&castToken=${encodeURIComponent(token)}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("cast tokens are NOT accepted on /rest/getCoverArt", async () => {
    seedTrack(app);
    const track = app.db.prepare("SELECT id FROM unified_tracks LIMIT 1").get() as { id: string };
    const token = signCastToken(app.castSecret, {
      trackId: track.id,
      username: "owner",
    });
    const res = await app.inject({
      method: "GET",
      url: `/rest/getCoverArt?id=foo&castToken=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
