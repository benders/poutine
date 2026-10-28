/**
 * Library-shrink guard (issue #297).
 *
 * Unit-tests the pure decision, then drives readNavidromeViaProxy() against a
 * fake Navidrome whose library size and track ids change between syncs — the
 * shapes a share outage, a genuine deletion and an id re-encode each produce.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { readNavidromeViaProxy } from "../src/library/sync-instance.js";
import type { ProxyFetch } from "../src/library/sync-instance.js";
import { mergeLibraries } from "../src/library/merge.js";
import {
  evaluateShrink,
  SHRINK_GUARD_MIN_TRACKS,
} from "../src/library/shrink-guard.js";

describe("evaluateShrink", () => {
  it("never holds a first sync, a growing library or a same-size library", () => {
    expect(evaluateShrink(0, 0, 20).hold).toBe(false);
    expect(evaluateShrink(0, 500, 20).hold).toBe(false);
    expect(evaluateShrink(500, 600, 20).hold).toBe(false);
    expect(evaluateShrink(500, 500, 20).hold).toBe(false);
  });

  it("holds a drop to zero at any library size", () => {
    expect(evaluateShrink(3, 0, 20)).toMatchObject({ hold: true, reason: expect.stringMatching(/to 0/) });
  });

  it("holds a drop over the threshold, applies one at or under it", () => {
    expect(evaluateShrink(1000, 790, 20).hold).toBe(true);
    expect(evaluateShrink(1000, 800, 20).hold).toBe(false);
  });

  it("exempts small libraries from the percentage rule", () => {
    const small = SHRINK_GUARD_MIN_TRACKS - 1;
    expect(evaluateShrink(small, 1, 20).hold).toBe(false);
  });

  it("is disabled by a 0 threshold", () => {
    expect(evaluateShrink(1000, 0, 0).hold).toBe(false);
  });
});

// ── Sync integration ─────────────────────────────────────────────────────────

/**
 * Fake Navidrome serving `library.tracks` songs spread over albums of 10
 * under one artist. `library.idPrefix` changes the remote ids without
 * changing the metadata (Navidrome's re-encode); `library.down` fails the
 * first call like a stopped container.
 */
interface FakeLibrary {
  tracks: number;
  idPrefix: string;
  down: boolean;
}

function subsonicOk(data: Record<string, unknown>): string {
  return JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...data } });
}

function fakeNavidrome(library: FakeLibrary): http.RequestListener {
  const albumCount = () => Math.ceil(library.tracks / 10);
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (library.down) {
      res.writeHead(502);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (p.endsWith("/getArtists")) {
      res.end(subsonicOk({
        artists: library.tracks === 0
          ? {}
          : { index: [{ name: "G", artist: [{ id: "ar-1", name: "Guard Artist", albumCount: albumCount() }] }] },
      }));
      return;
    }
    if (p.endsWith("/getArtist")) {
      res.end(subsonicOk({
        artist: {
          id: "ar-1",
          name: "Guard Artist",
          albumCount: albumCount(),
          album: Array.from({ length: albumCount() }, (_, a) => ({
            id: `al-${a}`,
            name: `Guard Album ${a}`,
            songCount: 10,
            duration: 2400,
          })),
        },
      }));
      return;
    }
    if (p.endsWith("/getAlbum")) {
      const a = Number((url.searchParams.get("id") ?? "al-0").slice(3));
      const first = a * 10;
      const last = Math.min(first + 10, library.tracks);
      res.end(subsonicOk({
        album: {
          id: `al-${a}`,
          name: `Guard Album ${a}`,
          artist: "Guard Artist",
          artistId: "ar-1",
          songCount: last - first,
          duration: 2400,
          song: Array.from({ length: Math.max(0, last - first) }, (_, i) => ({
            id: `${library.idPrefix}-${first + i}`,
            title: `Guard Track ${first + i}`,
            artist: "Guard Artist",
            track: i + 1,
            duration: 240,
            bitRate: 320,
            suffix: "mp3",
          })),
        },
      }));
      return;
    }
    res.end(subsonicOk({}));
  };
}

interface InstanceRow {
  track_count: number;
  last_sync_ok: number;
  last_sync_message: string;
  last_synced_at: string | null;
  shrink_held_at: string | null;
  accept_shrink_once: number;
  status: string;
}

describe("readNavidromeViaProxy shrink guard (#297)", () => {
  let db: Database.Database;
  let server: http.Server;
  let fetchFn: ProxyFetch;
  let library: FakeLibrary;
  let ownerId: string;

  const instanceRow = (id = "local") =>
    db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as InstanceRow;
  const rowCount = (id = "local") =>
    (db.prepare("SELECT COUNT(*) AS n FROM instance_tracks WHERE instance_id = ?").get(id) as { n: number }).n;
  const sync = (id = "local", shrinkGuardPercent?: number) =>
    readNavidromeViaProxy(db, id, fetchFn, { shrinkGuardPercent });

  beforeEach(async () => {
    db = createDatabase(":memory:");
    ownerId = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, 'owner', 'x', 1)").run(ownerId);
    for (const id of ["local", "peer-1"]) {
      db.prepare(
        "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, 'subsonic', '', ?, 'online')",
      ).run(id, id, `http://${id}`, ownerId);
    }
    library = { tracks: 150, idPrefix: "tr", down: false };
    server = http.createServer(fakeNavidrome(library));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    fetchFn = (subPath) => fetch(`http://127.0.0.1:${port}${subPath}`);
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("holds a sync that empties the library: rows, count kept; flagged; last_synced_at advanced", async () => {
    await sync();
    expect(rowCount()).toBe(150);
    db.prepare("UPDATE instances SET last_synced_at = '2000-01-01 00:00:00' WHERE id = 'local'").run();

    library.tracks = 0;
    const result = await sync();

    expect(result.shrinkHeld).toMatch(/150 tracks to 0/);
    expect(result.errors.join()).toMatch(/Shrink guard/);
    expect(rowCount()).toBe(150);
    const row = instanceRow();
    expect(row.track_count).toBe(150);
    expect(row.last_sync_ok).toBe(0);
    expect(row.status).toBe("online");
    expect(row.shrink_held_at).not.toBeNull();
    // AutoSync compares Navidrome's lastScan against this; it must move.
    expect(row.last_synced_at).not.toBe("2000-01-01 00:00:00");
  });

  it("recovers on the next full-size sync, even with re-encoded ids", async () => {
    await sync();
    library.tracks = 0;
    await sync();
    expect(instanceRow().shrink_held_at).not.toBeNull();

    library.tracks = 150;
    library.idPrefix = "reencoded";
    const result = await sync();

    expect(result.shrinkHeld).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    // Old ids are swept, new ids in place — the count never went near zero.
    expect(rowCount()).toBe(150);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM instance_tracks WHERE remote_id LIKE 'tr-%'").get(),
    ).toEqual({ n: 0 });
    const row = instanceRow();
    expect(row.shrink_held_at).toBeNull();
    expect(row.last_sync_ok).toBe(1);
  });

  it("holds a drop over the threshold and applies one under it", async () => {
    await sync();

    library.tracks = 110; // −27%
    expect((await sync()).shrinkHeld).toMatch(/−27%/);
    expect(rowCount()).toBe(150);

    library.tracks = 130; // −13% against the last applied 150
    expect((await sync()).shrinkHeld).toBeUndefined();
    expect(rowCount()).toBe(130);
    expect(instanceRow().track_count).toBe(130);
  });

  it("lets one sync through when the owner accepts the removal, then re-arms", async () => {
    await sync();
    library.tracks = 0;
    await sync();
    expect(rowCount()).toBe(150);

    db.prepare("UPDATE instances SET accept_shrink_once = 1 WHERE id = 'local'").run();
    const accepted = await sync();
    expect(accepted.shrinkHeld).toBeUndefined();
    expect(rowCount()).toBe(0);
    expect(instanceRow().accept_shrink_once).toBe(0);
    expect(instanceRow().shrink_held_at).toBeNull();

    // Re-armed: grow back, then a fresh outage is held again.
    library.tracks = 150;
    await sync();
    library.tracks = 0;
    expect((await sync()).shrinkHeld).toBeDefined();
  });

  it("clears a stale override on any applied sync, so it can't wave through a later outage", async () => {
    await sync();
    db.prepare("UPDATE instances SET accept_shrink_once = 1 WHERE id = 'local'").run();
    await sync(); // nothing to hold — override consumed anyway
    expect(instanceRow().accept_shrink_once).toBe(0);

    library.tracks = 0;
    expect((await sync()).shrinkHeld).toBeDefined();
  });

  it("is disabled by a 0 threshold", async () => {
    await sync("local", 0);
    library.tracks = 0;
    expect((await sync("local", 0)).shrinkHeld).toBeUndefined();
    expect(rowCount()).toBe(0);
  });

  it("guards peers through the same path", async () => {
    await sync("peer-1");
    library.tracks = 0;
    expect((await sync("peer-1")).shrinkHeld).toBeDefined();
    expect(rowCount("peer-1")).toBe(150);
  });

  it("keeps the local catalog when Navidrome is unreachable; a peer is still wiped", async () => {
    await sync("local");
    await sync("peer-1");
    library.down = true;

    await sync("local");
    expect(rowCount("local")).toBe(150);
    expect(instanceRow("local")).toMatchObject({ status: "offline", track_count: 150, last_sync_ok: 0 });

    await sync("peer-1");
    expect(rowCount("peer-1")).toBe(0);
  });

  it("stars survive a wipe and re-ID'd recovery (unified ids are metadata-derived)", async () => {
    await sync();
    mergeLibraries(db);
    const starred = db
      .prepare("SELECT id FROM unified_tracks ORDER BY id LIMIT 1")
      .get() as { id: string };
    db.prepare("INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, 'track', ?)").run(ownerId, starred.id);

    // Worst case: the owner accepted the removal, so the catalog really went.
    library.tracks = 0;
    db.prepare("UPDATE instances SET accept_shrink_once = 1 WHERE id = 'local'").run();
    await sync();
    mergeLibraries(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM unified_tracks").get()).toEqual({ n: 0 });

    library.tracks = 150;
    library.idPrefix = "reencoded";
    await sync();
    mergeLibraries(db);

    expect(db.prepare("SELECT id FROM unified_tracks WHERE id = ?").get(starred.id)).toEqual({ id: starred.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_stars").get()).toEqual({ n: 1 });
  });
});
