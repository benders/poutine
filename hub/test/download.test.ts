/**
 * Tests for /rest/download (#35) — Navidrome-style download semantics.
 *
 * Covers:
 *   - sanitizeFilename / attachmentDisposition unit behavior
 *   - Bad / missing ID → 400; unknown track/album → 404
 *   - Track download: original bytes, attachment disposition, transcode
 *     params ignored (raw fetch upstream)
 *   - Album download: streaming ZIP with one stored entry per track
 *
 * Peer-path coverage (download routed raw through /federation/stream) rides
 * the two-hub harness in stream.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { mergeLibraries } from "../src/library/merge.js";
import {
  sanitizeFilename,
  attachmentDisposition,
} from "../src/routes/subsonic/download.js";

const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb, 0xcc, 0xdd]);

// ── Unit: filename helpers ────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("strips path separators and Windows-forbidden characters", () => {
    expect(sanitizeFilename('AC/DC: "Back*|<in>" Black?')).toBe(
      "AC_DC_ _Back___in__ Black_",
    );
  });

  it("collapses whitespace and falls back on empty input", () => {
    expect(sanitizeFilename("  a   b  ")).toBe("a b");
    expect(sanitizeFilename("///")).toBe("___");
    expect(sanitizeFilename("   ")).toBe("untitled");
  });
});

describe("attachmentDisposition", () => {
  it("emits ASCII fallback plus RFC 5987 UTF-8 filename*", () => {
    const d = attachmentDisposition("Sigur Rós - Ágætis.flac");
    expect(d).toMatch(/^attachment; filename="Sigur R_s - _g_tis\.flac"/);
    expect(d).toContain("filename*=UTF-8''Sigur%20R%C3%B3s%20-%20%C3%81g%C3%A6tis.flac");
  });

  it("never emits a double quote in the ASCII fallback", () => {
    const d = attachmentDisposition('a"b.mp3');
    expect(d).toContain(`filename="a'b.mp3"`);
  });
});

// ── Integration harness ───────────────────────────────────────────────────────

/**
 * Fake Navidrome that serves audio bytes for every request and records each
 * request URL so tests can assert which params Poutine forwarded upstream.
 */
function startCapturingNavidrome(): Promise<{
  server: http.Server;
  port: number;
  requests: string[];
}> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "/");
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(FAKE_AUDIO.length),
      });
      res.end(FAKE_AUDIO);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

function seedUser(app: FastifyInstance) {
  const enc = setPassword("secret", app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("user-1", "tester", enc);
}

/** Seed a local two-track album and merge. */
function seedLocalAlbum(app: FastifyInstance) {
  app.db
    .prepare(
      `INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count)
       VALUES ('local:art-1', 'local', 'art-1', 'Test Artist', 1)`,
    )
    .run();
  app.db
    .prepare(
      `INSERT INTO instance_albums
       (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
       VALUES ('local:alb-1', 'local', 'alb-1', 'Test Album', 'local:art-1', 'Test Artist', 2, NULL)`,
    )
    .run();
  const insertTrack = app.db.prepare(
    `INSERT INTO instance_tracks
     (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
     VALUES (?, 'local', ?, 'local:alb-1', ?, 'Test Artist', ?, 180000, 'mp3', 320)`,
  );
  insertTrack.run("local:trk-1", "trk-1", "First Track", 1);
  insertTrack.run("local:trk-2", "trk-2", "Second Track", 2);
  mergeLibraries(app.db);
}

describe("download — /rest/download", () => {
  let app: FastifyInstance;
  let navidrome: http.Server;
  let navRequests: string[];

  beforeEach(async () => {
    const nav = await startCapturingNavidrome();
    navidrome = nav.server;
    navRequests = nav.requests;

    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "test-secret",
      navidromeUrl: `http://127.0.0.1:${nav.port}`,
      navidromeUsername: "admin",
      navidromePassword: "admin",
    });
    await app.ready();
    seedUser(app);
    seedLocalAlbum(app);
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => navidrome.close(() => resolve()));
  });

  function trackId(title: string): string {
    const row = app.db
      .prepare("SELECT id FROM unified_tracks WHERE title = ?")
      .get(title) as { id: string };
    expect(row).toBeDefined();
    return row.id;
  }

  function albumId(): string {
    const row = app.db
      .prepare("SELECT id FROM unified_release_groups LIMIT 1")
      .get() as { id: string };
    expect(row).toBeDefined();
    return row.id;
  }

  it("missing id → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/download?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown-prefix id → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/download?u=tester&p=secret&f=json&id=xyz999",
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown track → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/download?u=tester&p=secret&f=json&id=t00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("unknown album → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/download?u=tester&p=secret&f=json&id=al00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("track download → original bytes, attachment disposition, named from metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/download?u=tester&p=secret&f=json&id=t${trackId("First Track")}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.headers["content-length"]).toBe(String(FAKE_AUDIO.length));
    expect(res.headers["content-disposition"]).toBe(
      attachmentDisposition("Test Artist - First Track.mp3"),
    );
    expect(Buffer.from(res.rawPayload)).toEqual(FAKE_AUDIO);
  });

  it("track download ignores transcode params — upstream fetch is raw", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/download?u=tester&p=secret&f=json&id=t${trackId("First Track")}&format=opus&maxBitRate=64`,
    });

    expect(res.statusCode).toBe(200);
    const streamReq = navRequests.find((u) => u.includes("/rest/stream"));
    expect(streamReq).toBeDefined();
    expect(streamReq).not.toContain("format=");
    expect(streamReq).not.toContain("maxBitRate=");
  });

  it("album download → streaming ZIP with one stored entry per track", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/download?u=tester&p=secret&f=json&id=al${albumId()}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toBe(
      attachmentDisposition("Test Artist - Test Album.zip"),
    );

    const zip = Buffer.from(res.rawPayload);
    // Local file header + end-of-central-directory signatures.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from("PK\x03\x04", "binary"));
    expect(zip.includes(Buffer.from("PK\x05\x06", "binary"))).toBe(true);
    // Entry names are stored verbatim in the archive.
    expect(zip.includes(Buffer.from("01 - First Track.mp3"))).toBe(true);
    expect(zip.includes(Buffer.from("02 - Second Track.mp3"))).toBe(true);
    // Audio bytes appear once per entry (stored, not deflated).
    expect(zip.includes(FAKE_AUDIO)).toBe(true);
    // Both tracks were fetched raw from Navidrome.
    const streamReqs = navRequests.filter((u) => u.includes("/rest/stream"));
    expect(streamReqs).toHaveLength(2);
    for (const u of streamReqs) {
      expect(u).not.toContain("format=");
      expect(u).not.toContain("maxBitRate=");
    }
  });
});
