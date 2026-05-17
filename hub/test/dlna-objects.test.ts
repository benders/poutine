import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DlnaObjectService,
  parseObjectId,
  artistObjectId,
  albumObjectId,
  ROOT_ID,
  MUSIC_ID,
  ARTISTS_ID,
  ALBUMS_ID,
  TRACKS_ID,
} from "../src/services/dlna-objects.js";

const SCHEMA = readFileSync(
  resolve(__dirname, "..", "src", "db", "schema.sql"),
  "utf8",
);

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  // One user (FK target for instances).
  db.prepare(
    "INSERT INTO users (id, username, is_admin) VALUES ('u', 'admin', 1)",
  ).run();
  // Synthetic local instance.
  db.prepare(
    `INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, status)
     VALUES ('local', 'local', 'http://nav', '', 'u', 'online')`,
  ).run();
  // Artist / album / release / track all wired together.
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
    `INSERT INTO unified_releases (id, release_group_id, name)
     VALUES ('r1', 'rg1', 'Album One'),
            ('r2', 'rg2', 'Album Two')`,
  ).run();
  // t3 credits 'a3' (the orphan) on 'a1'-owned rg2, simulating a featured-
  // artist credit. 'a3' should NOT appear in the artist list.
  db.prepare(
    `INSERT INTO unified_tracks (id, title, title_normalized, release_id, artist_id, track_number, duration_ms)
     VALUES ('t1', 'Track One', 'track one', 'r1', 'a1', 1, 180000),
            ('t2', 'Track Two', 'track two', 'r1', 'a1', 2, 200000),
            ('t3', 'Guest Spot', 'guest spot', 'r2', 'a3', 1, 150000)`,
  ).run();
  // Make t1 streamable via a preferred local source.
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
  return db;
}

describe("parseObjectId", () => {
  it("recognizes the static container IDs", () => {
    expect(parseObjectId(ROOT_ID)?.kind).toBe("root");
    expect(parseObjectId(MUSIC_ID)?.kind).toBe("music");
    expect(parseObjectId(ARTISTS_ID)?.kind).toBe("artists");
    expect(parseObjectId(ALBUMS_ID)?.kind).toBe("albums");
    expect(parseObjectId(TRACKS_ID)?.kind).toBe("tracks");
  });
  it("parses dynamic artist/album IDs", () => {
    expect(parseObjectId(artistObjectId("a1"))).toEqual({
      kind: "artist",
      id: "a1",
    });
    expect(parseObjectId(albumObjectId("rg1"))).toEqual({
      kind: "album",
      id: "rg1",
    });
  });
  it("returns null for unknown IDs", () => {
    expect(parseObjectId("nope")).toBeNull();
  });
});

describe("DlnaObjectService.browse", () => {
  let db: Database.Database;
  let svc: DlnaObjectService;
  const opts = { startIndex: 0, requestedCount: 0, baseUrl: "http://lan:3000" };

  beforeEach(() => {
    db = seedDb();
    svc = new DlnaObjectService(db);
  });

  it("root → BrowseDirectChildren lists the Music container", () => {
    const out = svc.browse(ROOT_ID, "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.totalMatches).toBe(1);
    expect(out.result).toContain(`id="${MUSIC_ID}"`);
    expect(out.result).toContain("<dc:title>Music</dc:title>");
  });

  it("artists → returns one container per unified artist, ordered by name", () => {
    const out = svc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    expect(out.numberReturned).toBe(2);
    const idx1 = out.result.indexOf("Artist One");
    const idx2 = out.result.indexOf("Artist Two");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(out.result).toContain(`id="${artistObjectId("a1")}"`);
  });

  it("artists → excludes track-only credits with no release group of their own", () => {
    const out = svc.browse(ARTISTS_ID, "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    expect(out.result).not.toContain("Featured Only");
  });

  it("artist/<id> → lists release groups for that artist", () => {
    const out = svc.browse(artistObjectId("a1"), "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    expect(out.result).toContain("Album One");
    expect(out.result).toContain("Album Two");
    expect(out.result).toContain(`id="${albumObjectId("rg1")}"`);
  });

  it("album/<id> → lists tracks for that release group, ordered by disc/track", () => {
    const out = svc.browse(albumObjectId("rg1"), "BrowseDirectChildren", opts);
    expect(out.totalMatches).toBe(2);
    const idx1 = out.result.indexOf("Track One");
    const idx2 = out.result.indexOf("Track Two");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(out.result).toContain("http://lan:3000/dlna/stream/t1");
    expect(out.result).toContain("http://lan:3000/dlna/stream/t2");
    expect(out.result).toContain(
      'protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_OP=01',
    );
    // FLAC source → audio/flac MIME.
    expect(out.result).toContain("audio/flac");
  });

  it("BrowseMetadata on root returns a single container describing root", () => {
    const out = svc.browse(ROOT_ID, "BrowseMetadata", opts);
    expect(out.numberReturned).toBe(1);
    expect(out.result).toContain(`id="${ROOT_ID}"`);
    expect(out.result).toContain('parentID="-1"');
  });

  it("pagination via startIndex/requestedCount", () => {
    const page1 = svc.browse(ARTISTS_ID, "BrowseDirectChildren", {
      ...opts,
      requestedCount: 1,
    });
    expect(page1.numberReturned).toBe(1);
    expect(page1.totalMatches).toBe(2);
    expect(page1.result).toContain("Artist One");
    expect(page1.result).not.toContain("Artist Two");

    const page2 = svc.browse(ARTISTS_ID, "BrowseDirectChildren", {
      ...opts,
      startIndex: 1,
      requestedCount: 1,
    });
    expect(page2.numberReturned).toBe(1);
    expect(page2.result).toContain("Artist Two");
  });

  it("unknown object ID returns an empty DIDL envelope", () => {
    const out = svc.browse("nope", "BrowseDirectChildren", opts);
    expect(out.numberReturned).toBe(0);
    expect(out.totalMatches).toBe(0);
    expect(out.result).toMatch(/<DIDL-Lite[^/]*\/>|<DIDL-Lite[^>]*><\/DIDL-Lite>/);
  });
});
