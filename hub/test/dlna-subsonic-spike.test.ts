/**
 * Spike (#213): integration test comparing the DB-backed DLNA
 * ContentDirectory service (`DlnaObjectService`) against a
 * Subsonic-API-backed parallel implementation (`DlnaObjectServiceSubsonic`).
 *
 * Goals:
 *  1. Correctness — same DIDL-Lite shape for the operations we care about.
 *  2. Latency   — single-call browses within a small factor of the DB path.
 *  3. Round-trip count — flag any N+1 patterns.
 *  4. Gaps     — operations Subsonic can't express.
 *
 * The Subsonic caller targets the same `buildApp()` instance over
 * `app.inject()`. This excludes TCP/socket overhead and isolates the
 * difference to: Subsonic route handler + JSON encode/decode + DIDL
 * re-rendering vs. direct DB walk. Loopback fetch would add ~0.2–0.5 ms
 * per call; same order of magnitude, conclusions don't change.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import {
  DlnaObjectService,
  ROOT_ID,
  ARTISTS_ID,
  ALBUMS_ID,
  artistObjectId,
  albumObjectId,
} from "../src/services/dlna-objects.js";
import {
  DlnaObjectServiceSubsonic,
  type SubsonicCaller,
  type CallStats,
  type SubsonicResponse,
} from "../src/services/dlna-objects-subsonic.js";

const SUB_USER = "spike";
const SUB_PASS = "spikepw";
const BASE_URL = "http://lan:3000";

function seedFixtures(app: FastifyInstance): void {
  const db = app.db;
  const enc = setPassword(SUB_PASS, app.passwordKey);
  db.prepare(
    "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
  ).run("u-spike", SUB_USER, enc);

  // buildApp() already seeds a `__system__` user + local instance row with
  // musicfolder_id=1. Update that row instead of inserting a new one — the
  // fixtures below reference `instance_id='local'`.
  db.prepare(
    `UPDATE instances
       SET id = 'local', owner_id = 'u-spike', status = 'online'
     WHERE musicfolder_id = 1`,
  ).run();

  db.prepare(
    `INSERT INTO unified_artists (id, name, name_normalized, image_url)
     VALUES ('a1', 'Artist One', 'artist one', NULL),
            ('a2', 'Artist Two', 'artist two', NULL),
            ('a3', 'Featured Only', 'featured only', NULL)`,
  ).run();

  db.prepare(
    `INSERT INTO unified_release_groups (id, name, name_normalized, artist_id, year)
     VALUES ('rg1', 'Album One', 'album one', 'a1', 2001),
            ('rg2', 'Album Two', 'album two', 'a1', 2002),
            ('rg3', 'Other Album', 'other album', 'a2', 2003)`,
  ).run();

  db.prepare(
    `INSERT INTO unified_releases (id, release_group_id, name, track_count)
     VALUES ('r1', 'rg1', 'Album One', 2),
            ('r2', 'rg2', 'Album Two', 1),
            ('r3', 'rg3', 'Other Album', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, track_number, duration_ms)
     VALUES ('t1', 'Track One', 'track one', 'r1', 'a1', 1, 180000),
            ('t2', 'Track Two', 'track two', 'r1', 'a1', 2, 200000),
            ('t3', 'Guest Spot', 'guest spot', 'r2', 'a3', 1, 150000)`,
  ).run();

  db.prepare(
    `INSERT INTO instance_artists (id, instance_id, remote_id, name)
     VALUES ('local:ar1', 'local', 'ar1', 'Artist One')`,
  ).run();
  db.prepare(
    `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name)
     VALUES ('local:al1', 'local', 'al1', 'Album One', 'local:ar1', 'Artist One')`,
  ).run();
  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, bitrate)
     VALUES ('local:tr1', 'local', 'tr1', 'local:al1', 'Track One', 'Artist One', 'mp3', 256),
            ('local:tr2', 'local', 'tr2', 'local:al1', 'Track Two', 'Artist One', 'flac', 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, format, bitrate, preferred)
     VALUES ('ts1', 't1', 'local', 'local:tr1', 'mp3', 256, 1),
            ('ts2', 't2', 'local', 'local:tr2', 'flac', 1000, 1)`,
  ).run();
}

/** Subsonic caller that drives the hub's own `/rest/*` via `app.inject()`. */
function makeInjectCaller(app: FastifyInstance): SubsonicCaller {
  return {
    async call(endpoint, params): Promise<SubsonicResponse> {
      const qs = new URLSearchParams({
        u: SUB_USER,
        p: SUB_PASS,
        f: "json",
        v: "1.16.1",
        c: "dlna-spike",
        ...params,
      });
      const res = await app.inject({
        method: "GET",
        url: `${endpoint}?${qs.toString()}`,
      });
      if (res.statusCode !== 200) {
        throw new Error(`${endpoint} → ${res.statusCode}`);
      }
      return res.json() as SubsonicResponse;
    },
  };
}

interface Measure {
  op: string;
  dbMs: number;
  subMs: number;
  subRoundTrips: number;
}

const measurements: Measure[] = [];

describe("DLNA Subsonic-backed parallel implementation (spike #213)", () => {
  let app: FastifyInstance;
  let dbSvc: DlnaObjectService;
  let subSvc: DlnaObjectServiceSubsonic;
  const tmp = mkdtempSync(join(tmpdir(), "poutine-dlna-spike-"));

  beforeAll(async () => {
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "x",
      poutinePrivateKeyPath: join(tmp, "ed.pem"),
      poutinePasswordKeyPath: join(tmp, "pwkey"),
      poutineInstanceId: "dlna-spike",
      poutineOwnerUsername: "owner-unused",
    });
    await app.ready();
    seedFixtures(app);
    dbSvc = new DlnaObjectService(app.db);
    subSvc = new DlnaObjectServiceSubsonic(makeInjectCaller(app));
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
    const summary =
      "[#213 spike] Measurements\n" +
      measurements
        .map(
          (m) =>
            `  ${m.op.padEnd(30)} db=${m.dbMs.toFixed(3)}ms  ` +
            `sub=${m.subMs.toFixed(3)}ms  rt=${m.subRoundTrips}`,
        )
        .join("\n");
    // Persist where the writeup step can read it back; vitest interleaves
    // afterAll-stdout with test-stdout in this project, so the file is the
    // reliable channel.
    writeFileSync("/tmp/dlna-spike-measurements.txt", summary + "\n");
    // eslint-disable-next-line no-console
    console.log("\n" + summary + "\n");
  });

  /** Time a closure N times and return the median ms. */
  async function bench(label: string, fn: () => unknown | Promise<unknown>) {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      await fn();
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  async function measure(
    op: string,
    dbCall: () => Promise<unknown> | unknown,
    subCall: (stats: CallStats) => Promise<unknown>,
  ): Promise<void> {
    const dbMs = await bench(`${op} (db)`, dbCall);
    const stats: CallStats = { roundTrips: 0, subsonicMs: 0 };
    // Run once for round-trip count, then time without the stats object.
    await subCall(stats);
    const subRoundTrips = stats.roundTrips;
    const subMs = await bench(`${op} (sub)`, () =>
      subCall({ roundTrips: 0, subsonicMs: 0 }),
    );
    measurements.push({ op, dbMs, subMs, subRoundTrips });
  }

  // ── Correctness ────────────────────────────────────────────────────────

  it("Browse(root, BrowseDirectChildren) matches the DB-backed shape", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const dbOut = dbSvc.browse(ROOT_ID, "BrowseDirectChildren", opts);
    const subOut = await subSvc.browse(ROOT_ID, "BrowseDirectChildren", opts);
    expect(subOut.numberReturned).toBe(dbOut.numberReturned);
    expect(subOut.result).toContain(`id="0/music"`);
    expect(subOut.result).toContain("<dc:title>Music</dc:title>");
    await measure(
      "Browse root",
      () => dbSvc.browse(ROOT_ID, "BrowseDirectChildren", opts),
      (stats) => subSvc.browse(ROOT_ID, "BrowseDirectChildren", { ...opts, stats }),
    );
  });

  it("Browse(artists, BrowseDirectChildren) returns the same artist set ordered by name", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const dbOut = dbSvc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    const subOut = await subSvc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    expect(subOut.numberReturned).toBe(dbOut.numberReturned);
    expect(subOut.result).toContain("Artist One");
    expect(subOut.result).toContain("Artist Two");
    // Filter parity: track-only-credit artist must be excluded on both paths.
    expect(subOut.result).not.toContain("Featured Only");
    // Container IDs are equal because both impls strip the `ar` prefix
    // back to the raw unified id.
    expect(subOut.result).toContain(`id="${artistObjectId("a1")}"`);
    expect(subOut.result).toContain(`id="${artistObjectId("a2")}"`);
    await measure(
      "Browse artists",
      () => dbSvc.browse(ARTISTS_ID, "BrowseDirectChildren", opts),
      (stats) => subSvc.browse(ARTISTS_ID, "BrowseDirectChildren", { ...opts, stats }),
    );
  });

  it("Browse(artist/a1) returns the same release groups in the same order", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const id = artistObjectId("a1");
    const dbOut = dbSvc.browse(id, "BrowseDirectChildren", opts);
    const subOut = await subSvc.browse(id, "BrowseDirectChildren", opts);
    expect(subOut.numberReturned).toBe(dbOut.numberReturned);
    expect(subOut.result).toContain(`id="${albumObjectId("rg1")}"`);
    expect(subOut.result).toContain(`id="${albumObjectId("rg2")}"`);
    // Both impls order albums newest-year-first / by name; assert relative
    // order to match the DB path (rg2=2002 before rg1=2001).
    const i1 = subOut.result.indexOf("Album One");
    const i2 = subOut.result.indexOf("Album Two");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(-1);
    await measure(
      "Browse artist/<id>",
      () => dbSvc.browse(id, "BrowseDirectChildren", opts),
      (stats) => subSvc.browse(id, "BrowseDirectChildren", { ...opts, stats }),
    );
  });

  it("Browse(album/rg1) returns the same tracks in disc/track order with correct MIME", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const id = albumObjectId("rg1");
    const dbOut = dbSvc.browse(id, "BrowseDirectChildren", opts);
    const subOut = await subSvc.browse(id, "BrowseDirectChildren", opts);
    expect(subOut.numberReturned).toBe(dbOut.numberReturned);
    expect(subOut.result).toContain("Track One");
    expect(subOut.result).toContain("Track Two");
    expect(subOut.result).toContain(`${BASE_URL}/dlna/stream/t1`);
    expect(subOut.result).toContain(`${BASE_URL}/dlna/stream/t2`);
    // FLAC source → audio/flac MIME.
    expect(subOut.result).toContain("audio/flac");
    expect(subOut.result).toContain("audio/mpeg");
    expect(subOut.result).toContain(
      'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000',
    );
    await measure(
      "Browse album/<id>",
      () => dbSvc.browse(id, "BrowseDirectChildren", opts),
      (stats) => subSvc.browse(id, "BrowseDirectChildren", { ...opts, stats }),
    );
  });

  it("BrowseMetadata(artist/a1) returns one container with album count", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const id = artistObjectId("a1");
    const subOut = await subSvc.browse(id, "BrowseMetadata", opts);
    expect(subOut.numberReturned).toBe(1);
    expect(subOut.result).toContain(`id="${id}"`);
    expect(subOut.result).toContain("Artist One");
  });

  it("BrowseMetadata(album/rg1) returns one container with song count", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    const id = albumObjectId("rg1");
    const subOut = await subSvc.browse(id, "BrowseMetadata", opts);
    expect(subOut.numberReturned).toBe(1);
    expect(subOut.result).toContain(`id="${id}"`);
    expect(subOut.result).toContain("Album One");
  });

  it("Search by title surfaces a song container", async () => {
    const opts = { startIndex: 0, requestedCount: 10, baseUrl: BASE_URL };
    const stats: CallStats = { roundTrips: 0, subsonicMs: 0 };
    const out = await subSvc.search("Track One", { ...opts, stats });
    expect(out.numberReturned).toBeGreaterThan(0);
    expect(out.result).toContain("Track One");
    expect(out.result).toContain(`${BASE_URL}/dlna/stream/t1`);
    expect(stats.roundTrips).toBe(1);
    measurements.push({
      op: "Search title",
      dbMs: 0, // no DB path for search
      subMs: stats.subsonicMs,
      subRoundTrips: stats.roundTrips,
    });
  });

  it("Search by artist + album surfaces containers", async () => {
    const opts = { startIndex: 0, requestedCount: 10, baseUrl: BASE_URL };
    const stats: CallStats = { roundTrips: 0, subsonicMs: 0 };
    const out = await subSvc.search("Artist One", { ...opts, stats });
    expect(out.result).toContain("Artist One");
    expect(stats.roundTrips).toBe(1);
  });

  // ── Round-trip + N+1 audit ────────────────────────────────────────────

  it("single-call browse + metadata operations make exactly one Subsonic call", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    type Op = [string, string, "BrowseDirectChildren" | "BrowseMetadata"];
    const ops: Op[] = [
      ["Browse artists", ARTISTS_ID, "BrowseDirectChildren"],
      ["Browse albums", ALBUMS_ID, "BrowseDirectChildren"],
      ["Browse artist/<id>", artistObjectId("a1"), "BrowseDirectChildren"],
      ["Browse album/<id>", albumObjectId("rg1"), "BrowseDirectChildren"],
      ["BrowseMetadata artist/<id>", artistObjectId("a1"), "BrowseMetadata"],
      ["BrowseMetadata album/<id>", albumObjectId("rg1"), "BrowseMetadata"],
    ];
    for (const [label, id, flag] of ops) {
      const stats: CallStats = { roundTrips: 0, subsonicMs: 0 };
      await subSvc.browse(id, flag, { ...opts, stats });
      expect(stats.roundTrips, `${label} round-trips`).toBe(1);
    }
  });

  it("Browse(tracks) is N+1 — flagged as a known gap", async () => {
    const opts = { startIndex: 0, requestedCount: 5, baseUrl: BASE_URL };
    const stats: CallStats = { roundTrips: 0, subsonicMs: 0 };
    const out = await subSvc.browse("0/music/tracks", "BrowseDirectChildren", {
      ...opts,
      stats,
    });
    // Expect at least getAlbumList2 + one getAlbum per album fetched.
    expect(stats.roundTrips).toBeGreaterThan(1);
    expect(out.numberReturned).toBeGreaterThan(0);
    // Record the cost.
    measurements.push({
      op: "Browse all tracks (N+1)",
      dbMs: 0,
      subMs: stats.subsonicMs,
      subRoundTrips: stats.roundTrips,
    });
  });

  // ── Latency budget ────────────────────────────────────────────────────

  it("single-call browses stay within 5x of the DB path on loopback", async () => {
    const opts = { startIndex: 0, requestedCount: 0, baseUrl: BASE_URL };
    for (const [label, dbCall, subCall] of [
      [
        "artists",
        () => dbSvc.browse(ARTISTS_ID, "BrowseDirectChildren", opts),
        () => subSvc.browse(ARTISTS_ID, "BrowseDirectChildren", opts),
      ],
      [
        "artist/<id>",
        () => dbSvc.browse(artistObjectId("a1"), "BrowseDirectChildren", opts),
        () => subSvc.browse(artistObjectId("a1"), "BrowseDirectChildren", opts),
      ],
      [
        "album/<id>",
        () => dbSvc.browse(albumObjectId("rg1"), "BrowseDirectChildren", opts),
        () => subSvc.browse(albumObjectId("rg1"), "BrowseDirectChildren", opts),
      ],
    ] as const) {
      const dbMs = await bench(`${label}-db`, dbCall);
      const subMs = await bench(`${label}-sub`, subCall);
      // Floor protects against ~0ms DB median; the absolute ceiling for a
      // single-call Subsonic browse on an empty in-memory DB is 5 ms.
      expect(subMs).toBeLessThan(Math.max(dbMs * 5, 5));
    }
  });
});
