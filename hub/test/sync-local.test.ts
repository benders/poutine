/**
 * sync-local.test.ts (#252 rework)
 *
 * Drives syncLocal() against a single fake server that implements BOTH the
 * Subsonic /rest/* endpoints AND Navidrome's native /auth/login + /api/player
 * API. Verifies that the real-path provisioning handshake happens in the right
 * order — ping (which lazily creates the poutine-sync player record) → native
 * PUT flipping reportRealPath=true → first album read — and that syncLocal
 * degrades gracefully (no throw, still ingests) when the native API 404s.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { syncLocal } from "../src/library/sync-local.js";
import { _resetWarnedOnce } from "../src/services/navidrome-native.js";
import type { Config } from "../src/config.js";

function subsonicOk(data: Record<string, unknown>): string {
  return JSON.stringify({
    "subsonic-response": { status: "ok", version: "1.16.1", ...data },
  });
}

interface FakeServer {
  server: http.Server;
  url: string;
  order: string[]; // sequence of "METHOD path" (no query string)
  puts: Array<{ id: string; body: Record<string, unknown> }>;
}

/**
 * @param nativeEnabled when false, /auth/login and /api/player both 404 —
 *   models a Navidrome whose native API is unavailable (degradation path).
 */
function startFake(nativeEnabled: boolean): Promise<FakeServer> {
  const order: string[] = [];
  const puts: Array<{ id: string; body: Record<string, unknown> }> = [];
  // The poutine-sync player record, lazily created on first Subsonic hit that
  // presents c=poutine-sync (mirrors Navidrome creating the record on demand).
  let syncPlayer: { id: string; client: string; reportRealPath: boolean } | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    order.push(`${req.method} ${p}`);

    // ── Subsonic ──────────────────────────────────────────────────────────
    if (p.startsWith("/rest/")) {
      if (url.searchParams.get("c") === "poutine-sync" && !syncPlayer) {
        syncPlayer = { id: "pl-sync", client: "poutine-sync", reportRealPath: false };
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (p.includes("getArtists")) {
        res.end(subsonicOk({ artists: { index: [{ name: "A", artist: [{ id: "ar1", name: "Artist One", albumCount: 1 }] }] } }));
      } else if (p.includes("getArtist")) {
        res.end(subsonicOk({ artist: { id: "ar1", name: "Artist One", albumCount: 1, album: [{ id: "al1", name: "Album One", songCount: 1, duration: 240 }] } }));
      } else if (p.includes("getAlbum")) {
        res.end(subsonicOk({
          album: {
            id: "al1", name: "Album One", artist: "Artist One", artistId: "ar1", songCount: 1, duration: 240,
            song: [{ id: "tr1", title: "Track One", artist: "Artist One", track: 1, duration: 240, bitRate: 320, suffix: "mp3", path: "/music/Artist One/Album One/01 - Track One.mp3" }],
          },
        }));
      } else {
        res.end(subsonicOk({})); // ping and anything else
      }
      return;
    }

    // ── Native API ────────────────────────────────────────────────────────
    if (!nativeEnabled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method === "POST" && p === "/auth/login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "jwt" }));
      return;
    }
    if (req.method === "GET" && p === "/api/player") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(syncPlayer ? [syncPlayer] : []));
      return;
    }
    if (req.method === "PUT" && p.startsWith("/api/player/")) {
      const id = decodeURIComponent(p.slice("/api/player/".length));
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        puts.push({ id, body });
        if (syncPlayer && syncPlayer.id === id) syncPlayer.reportRealPath = body.reportRealPath === true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(raw);
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, order, puts });
    });
  });
}

function configFor(url: string): Config {
  return {
    databasePath: ":memory:",
    navidromeUrl: url,
    navidromeUsername: "admin",
    navidromePassword: "secret",
    poutineInstanceId: "test-instance",
    instanceConcurrency: 1,
  } as unknown as Config;
}

function seedLocalInstance(db: Database.Database): void {
  const ownerId = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)").run(ownerId, "admin", "fakehash", 1);
  db.prepare("INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("local", "Local Navidrome", "http://local", "subsonic", "", ownerId, "online");
}

describe("syncLocal real-path provisioning (#252)", () => {
  let db: Database.Database;
  let fake: FakeServer | null = null;

  beforeEach(() => {
    _resetWarnedOnce();
    db = createDatabase(":memory:");
    seedLocalInstance(db);
  });

  afterEach(async () => {
    db.close();
    if (fake) await new Promise<void>((r) => fake!.server.close(() => r()));
    fake = null;
  });

  it("pings, then flips reportRealPath via the native API, before the first album read", async () => {
    fake = await startFake(true);

    const result = await syncLocal(db, configFor(fake.url));
    expect(result.errors).toHaveLength(0);
    expect(result.trackCount).toBe(1);

    // The player record was flipped to real paths.
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0].id).toBe("pl-sync");
    expect(fake.puts[0].body.reportRealPath).toBe(true);
    expect(fake.puts[0].body.client).toBe("poutine-sync"); // full record spread

    // Ordering: ping → native PUT → first getArtists.
    const pingIdx = fake.order.indexOf("GET /rest/ping");
    const putIdx = fake.order.indexOf("PUT /api/player/pl-sync");
    const artistsIdx = fake.order.findIndex((e) => e.startsWith("GET /rest/getArtists"));
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(pingIdx);
    expect(artistsIdx).toBeGreaterThan(putIdx);

    // The ingested track carries the real /music/ path.
    const row = db.prepare("SELECT path FROM instance_tracks WHERE instance_id = 'local'").get() as { path: string };
    expect(row.path).toBe("/music/Artist One/Album One/01 - Track One.mp3");
  });

  it("completes fine when the native endpoints 404 (degradation)", async () => {
    fake = await startFake(false);

    const result = await syncLocal(db, configFor(fake.url));
    expect(result.errors).toHaveLength(0);
    expect(result.trackCount).toBe(1);

    // No provisioning PUT happened, but sync still ingested the library.
    expect(fake.puts).toHaveLength(0);
    const count = db.prepare("SELECT COUNT(*) AS c FROM instance_tracks WHERE instance_id = 'local'").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
