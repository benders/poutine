/**
 * Unit/integration tests for the DLNA ContentDirectory service
 * (`DlnaObjectService`), promoted from the #213 spike when the service was
 * rewritten against the Subsonic HTTP client (#219).
 *
 * The service does no direct DB access — every browse / search call goes
 * through a `SubsonicCaller`. The tests boot a real `buildApp()` and wire
 * the service to an `app.inject()`-backed caller, which is also what
 * production does (server.ts). Fixture data is seeded directly into the
 * unified library tables; the Subsonic route handlers serialize it back
 * out exactly as they do in production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import {
  DlnaObjectService,
  parseObjectId,
  artistObjectId,
  albumObjectId,
  ROOT_ID,
  MUSIC_ID,
  ARTISTS_ID,
  ALBUMS_ID,
  type SubsonicCaller,
  type SubsonicResponse,
} from "../src/services/dlna-objects.js";

const SUB_USER = "tester";
const SUB_PASS = "testerpw";
const BASE_URL = "http://lan:3000";
const SECRET = Buffer.from("a".repeat(32));

const opts = {
  startIndex: 0,
  requestedCount: 0,
  baseUrl: BASE_URL,
  castSecret: SECRET,
  username: "tester",
};

function seedFixtures(app: FastifyInstance): void {
  const db = app.db;
  const enc = setPassword(SUB_PASS, app.passwordKey);
  db.prepare(
    "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
  ).run("u-tester", SUB_USER, enc);

  // buildApp() already seeds a `__system__` user + local instance row with
  // musicfolder_id=1. Update that row so the fixtures below resolve against
  // `instance_id='local'`.
  db.prepare(
    `UPDATE instances
       SET id = 'local', owner_id = 'u-tester', status = 'online'
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

  // t3 credits 'a3' (the orphan) on 'a1'-owned rg2, simulating a featured-
  // artist credit. 'a3' should NOT appear in the artist list.
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
        c: "dlna-test",
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

describe("parseObjectId", () => {
  it("recognizes the static container IDs", () => {
    expect(parseObjectId(ROOT_ID)?.kind).toBe("root");
    expect(parseObjectId(MUSIC_ID)?.kind).toBe("music");
    expect(parseObjectId(ARTISTS_ID)?.kind).toBe("artists");
    expect(parseObjectId(ALBUMS_ID)?.kind).toBe("albums");
  });
  it("parses dynamic artist/album IDs", () => {
    expect(parseObjectId(artistObjectId("a1"))).toEqual({ kind: "artist", id: "a1" });
    expect(parseObjectId(albumObjectId("rg1"))).toEqual({ kind: "album", id: "rg1" });
  });
  it("returns null for unknown IDs", () => {
    expect(parseObjectId("nope")).toBeNull();
  });
  it("returns null for the retired All Tracks container ID", () => {
    // #219: "All Tracks" was dropped from the hierarchy — Subsonic has no
    // global track enumeration endpoint and the only synthesis is N+1.
    expect(parseObjectId("0/music/tracks")).toBeNull();
  });
});

describe("DlnaObjectService.browse (Subsonic-backed)", () => {
  let app: FastifyInstance;
  let svc: DlnaObjectService;
  const tmp = mkdtempSync(join(tmpdir(), "poutine-dlna-svc-"));

  beforeAll(async () => {
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "x",
      poutinePrivateKeyPath: join(tmp, "ed.pem"),
      poutinePasswordKeyPath: join(tmp, "pwkey"),
      poutineInstanceId: "dlna-svc-test",
      poutineOwnerUsername: "owner-unused",
    });
    await app.ready();
    seedFixtures(app);
    svc = new DlnaObjectService(makeInjectCaller(app));
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── BrowseDirectChildren ──────────────────────────────────────────────

  it("root → BrowseDirectChildren lists the Music container", async () => {
    const out = await svc.browse(ROOT_ID, "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.totalMatches).toBe(1);
    expect(out.result).toContain(`id="${MUSIC_ID}"`);
    expect(out.result).toContain("<dc:title>Music</dc:title>");
  });

  it("music → BrowseDirectChildren lists Artists + Albums (no All Tracks)", async () => {
    const out = await svc.browse(MUSIC_ID, "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(2);
    expect(out.result).toContain(`id="${ARTISTS_ID}"`);
    expect(out.result).toContain(`id="${ALBUMS_ID}"`);
    // #219: All Tracks container is intentionally absent.
    expect(out.result).not.toContain("All Tracks");
    expect(out.result).not.toContain("0/music/tracks");
  });

  it("artists → returns one container per unified artist, ordered by name", async () => {
    const out = await svc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(2);
    expect(out.totalMatches).toBe(2);
    const idx1 = out.result.indexOf("Artist One");
    const idx2 = out.result.indexOf("Artist Two");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(out.result).toContain(`id="${artistObjectId("a1")}"`);
    expect(out.result).toContain(`id="${artistObjectId("a2")}"`);
  });

  it("artists → excludes track-only credits with no release group of their own", async () => {
    const out = await svc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    expect(out.result).not.toContain("Featured Only");
  });

  it("albums → BrowseDirectChildren returns release groups via getAlbumList2", async () => {
    const out = await svc.browse(ALBUMS_ID, "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(3);
    expect(out.result).toContain(`id="${albumObjectId("rg1")}"`);
    expect(out.result).toContain(`id="${albumObjectId("rg2")}"`);
    expect(out.result).toContain(`id="${albumObjectId("rg3")}"`);
    // Short page (3 albums in fixture < requested 500) → known end, so
    // totalMatches is the accurate total. Returning -1 here violates UPnP
    // CDS:1 §2.2.2 (TotalMatches is ui4) and trips renderers into a
    // Browse retry loop — see services/dlna-objects.ts comment.
    expect(out.totalMatches).toBe(3);
  });

  it("artist/<id> → lists release groups for that artist", async () => {
    const out = await svc.browse(artistObjectId("a1"), "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    expect(out.result).toContain("Album One");
    expect(out.result).toContain("Album Two");
    expect(out.result).toContain(`id="${albumObjectId("rg1")}"`);
  });

  it("album/<id> → lists tracks in disc/track order with stream URLs + MIME", async () => {
    const out = await svc.browse(albumObjectId("rg1"), "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    const idx1 = out.result.indexOf("Track One");
    const idx2 = out.result.indexOf("Track Two");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    // #218: stream URL points at Hub's Subsonic /rest/stream.view with
    // id=t<unifiedId>, an embedded castToken, and dlna=1 marker.
    expect(out.result).toContain(`${BASE_URL}/rest/stream.view?id=tt1`);
    expect(out.result).toContain(`${BASE_URL}/rest/stream.view?id=tt2`);
    expect(out.result).toContain("castToken=");
    expect(out.result).toContain("dlna=1");
    expect(out.result).toContain("&amp;");
    expect(out.result).toContain(
      'protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_OP=01',
    );
    // FLAC source → audio/flac MIME.
    expect(out.result).toContain("audio/flac");
    expect(out.result).toContain("audio/mpeg");
  });

  // ── BrowseMetadata ────────────────────────────────────────────────────

  it("BrowseMetadata on root returns a single container describing root", async () => {
    const out = await svc.browse(ROOT_ID, "BrowseMetadata", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.result).toContain(`id="${ROOT_ID}"`);
    expect(out.result).toContain('parentID="-1"');
  });

  it("BrowseMetadata(artist/a1) returns one container with album count", async () => {
    const out = await svc.browse(artistObjectId("a1"), "BrowseMetadata", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.result).toContain(`id="${artistObjectId("a1")}"`);
    expect(out.result).toContain("Artist One");
  });

  it("BrowseMetadata(album/rg1) returns one container with song count", async () => {
    const out = await svc.browse(albumObjectId("rg1"), "BrowseMetadata", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.result).toContain(`id="${albumObjectId("rg1")}"`);
    expect(out.result).toContain("Album One");
  });

  // ── Search ───────────────────────────────────────────────────────────

  it("Search by title surfaces a song item with a stream URL", async () => {
    const out = await svc.search("Track One", { ...opts, requestedCount: 10 });
    expect(out.numberReturned).toBeGreaterThan(0);
    expect(out.result).toContain("Track One");
    expect(out.result).toContain(`${BASE_URL}/rest/stream.view?id=tt1`);
  });

  it("Search by artist surfaces an artist container", async () => {
    const out = await svc.search("Artist One", { ...opts, requestedCount: 10 });
    expect(out.result).toContain("Artist One");
  });

  // ── Pagination ───────────────────────────────────────────────────────

  it("pagination via startIndex/requestedCount on artists", async () => {
    const page1 = await svc.browse(ARTISTS_ID, "BrowseDirectChildren", {
      ...opts,
      requestedCount: 1,
    });
    expect(page1.numberReturned).toBe(1);
    expect(page1.totalMatches).toBe(2);
    expect(page1.result).toContain("Artist One");
    expect(page1.result).not.toContain("Artist Two");

    const page2 = await svc.browse(ARTISTS_ID, "BrowseDirectChildren", {
      ...opts,
      startIndex: 1,
      requestedCount: 1,
    });
    expect(page2.numberReturned).toBe(1);
    expect(page2.result).toContain("Artist Two");
  });

  // ── Error cases ──────────────────────────────────────────────────────

  it("unknown object ID returns an empty DIDL envelope", async () => {
    const out = await svc.browse("nope", "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(0);
    expect(out.totalMatches).toBe(0);
    expect(out.result).toMatch(/<DIDL-Lite[^/]*\/>|<DIDL-Lite[^>]*><\/DIDL-Lite>/);
  });

  it("missing artist returns an empty DIDL envelope", async () => {
    const out = await svc.browse(artistObjectId("nosuch"), "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(0);
  });

  it("missing album returns an empty DIDL envelope", async () => {
    const out = await svc.browse(albumObjectId("nosuch"), "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(0);
  });
});
