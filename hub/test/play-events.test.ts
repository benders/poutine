import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { PlayEventService } from "../src/services/play-events.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

const QS = "u=tester&p=secret&f=json&c=spa";

const ARTIST_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RG1_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const REL1_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const T1_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const RG2_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const REL2_ID = "ffffffff-ffff-4fff-ffff-ffffffffffff";
const T2_ID = "11111111-1111-4111-1111-111111111111";

const T1_SUB = `t${T1_ID}`;
const T2_SUB = `t${T2_ID}`;
const RG1_SUB = `al${RG1_ID}`;

function seedUser(app: FastifyInstance, id: string, username: string): void {
  const enc = setPassword("secret", app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
    )
    .run(id, username, enc);
}

function seedLibrary(app: FastifyInstance): void {
  app.db
    .prepare("INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)")
    .run(ARTIST_ID, "Play Artist", "play artist");
  const insRg = app.db.prepare(
    "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
  );
  insRg.run(RG1_ID, "Album One", "album one", ARTIST_ID);
  insRg.run(RG2_ID, "Album Two", "album two", ARTIST_ID);
  const insRel = app.db.prepare(
    "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
  );
  insRel.run(REL1_ID, RG1_ID, "Album One");
  insRel.run(REL2_ID, RG2_ID, "Album Two");
  const insTrack = app.db.prepare(
    "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insTrack.run(T1_ID, REL1_ID, ARTIST_ID, "Track One", "track one", 200000);
  insTrack.run(T2_ID, REL2_ID, ARTIST_ID, "Track Two", "track two", 200000);
}

async function scrobble(app: FastifyInstance, subId: string, qs = QS): Promise<void> {
  const res = await app.inject({
    method: "GET",
    url: `/rest/scrobble?${qs}&id=${subId}`,
  });
  expect(res.json()["subsonic-response"].status).toBe("ok");
}

describe("scrobble + play counts (#197)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedUser(app, "user-1", "tester");
    seedLibrary(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("scrobble records a play; getSong exposes playCount + played", async () => {
    await scrobble(app, T1_SUB);
    const res = await app.inject({ method: "GET", url: `/rest/getSong?${QS}&id=${T1_SUB}` });
    const song = res.json()["subsonic-response"].song;
    expect(song.playCount).toBe(1);
    expect(song.played).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("repeated scrobbles increment the count", async () => {
    await scrobble(app, T1_SUB);
    await scrobble(app, T1_SUB);
    await scrobble(app, T1_SUB);
    const res = await app.inject({ method: "GET", url: `/rest/getSong?${QS}&id=${T1_SUB}` });
    expect(res.json()["subsonic-response"].song.playCount).toBe(3);
  });

  it("submission=false does not record a play (now-playing only)", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/scrobble?${QS}&id=${T1_SUB}&submission=false`,
    });
    const res = await app.inject({ method: "GET", url: `/rest/getSong?${QS}&id=${T1_SUB}` });
    expect(res.json()["subsonic-response"].song.playCount).toBeUndefined();
  });

  it("getAlbum aggregates track plays into album playCount", async () => {
    await scrobble(app, T1_SUB);
    await scrobble(app, T1_SUB);
    const res = await app.inject({ method: "GET", url: `/rest/getAlbum?${QS}&id=${RG1_SUB}` });
    const album = res.json()["subsonic-response"].album;
    expect(album.playCount).toBe(2);
    expect(album.song[0].playCount).toBe(2);
  });

  it("counts are scoped per user", async () => {
    seedUser(app, "user-2", "alice");
    await scrobble(app, T1_SUB); // as tester
    const res = await app.inject({
      method: "GET",
      url: `/rest/getSong?u=alice&p=secret&f=json&id=${T1_SUB}`,
    });
    expect(res.json()["subsonic-response"].song.playCount).toBeUndefined();
  });

  it("honors the Subsonic `time` param to backfill a play's timestamp", async () => {
    const pastMs = Date.parse("2021-06-15T12:00:00.000Z");
    await app.inject({
      method: "GET",
      url: `/rest/scrobble?${QS}&id=${T1_SUB}&time=${pastMs}`,
    });
    const res = await app.inject({ method: "GET", url: `/rest/getSong?${QS}&id=${T1_SUB}` });
    const song = res.json()["subsonic-response"].song;
    expect(song.playCount).toBe(1);
    // Recorded at the supplied time, not "now".
    expect(song.played).toMatch(/^2021-06-15T12:00:00/);
  });

  it("a batch with unknown / malformed ids records only the valid ones", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/scrobble?${QS}&id=${T1_SUB}&id=tomato&id=t99999999-9999-4999-9999-999999999999`,
    });
    expect(res.json()["subsonic-response"].status).toBe("ok");
    const n = (
      app.db
        .prepare("SELECT COUNT(*) AS n FROM play_events WHERE user_id = 'user-1'")
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("getAlbumList2 type=frequent ranks by play count and excludes never-played", async () => {
    // Album Two played twice, Album One once.
    await scrobble(app, T2_SUB);
    await scrobble(app, T2_SUB);
    await scrobble(app, T1_SUB);
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbumList2?${QS}&type=frequent&size=10`,
    });
    const albums = res.json()["subsonic-response"].albumList2.album as Array<{
      id: string;
      playCount?: number;
    }>;
    expect(albums.map((a) => a.id)).toEqual([`al${RG2_ID}`, `al${RG1_ID}`]);
    // playCount comes from the playJoin aggregate reused for display (#197).
    expect(albums[0].playCount).toBe(2);
    expect(albums[1].playCount).toBe(1);
  });

  it("getAlbumList2 type=recent orders by last play and excludes never-played", async () => {
    await scrobble(app, T1_SUB);
    // Pin T1's play into the past so the ordering is independent of how close
    // the two scrobbles land in wall-clock time.
    app.db
      .prepare("UPDATE play_events SET played_at = '2020-01-01 00:00:00.000' WHERE unified_track_id = ?")
      .run(T1_ID);
    await scrobble(app, T2_SUB); // T2 played most recently
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbumList2?${QS}&type=recent&size=10`,
    });
    const albums = res.json()["subsonic-response"].albumList2.album as Array<{
      id: string;
      played?: string;
    }>;
    expect(albums).toHaveLength(2);
    expect(albums[0].id).toBe(`al${RG2_ID}`);
    // `played` (last-play ISO) also comes from the reused playJoin aggregate.
    expect(albums[1].played).toMatch(/^2020-01-01T00:00:00/);
  });

  it("never-played tracks carry no playCount field", async () => {
    const res = await app.inject({ method: "GET", url: `/rest/getSong?${QS}&id=${T2_SUB}` });
    expect(res.json()["subsonic-response"].song.playCount).toBeUndefined();
  });
});

describe("PlayEventService (#197)", () => {
  let app: FastifyInstance;
  let svc: PlayEventService;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedUser(app, "user-1", "tester");
    seedLibrary(app);
    svc = new PlayEventService(app.db);
  });

  afterEach(async () => {
    await app.close();
  });

  it("record persists a play unconditionally", () => {
    svc.record({ userId: "user-1", unifiedTrackId: T1_ID });
    expect(svc.getTrackStats("user-1", [T1_ID]).get(T1_ID)?.playCount).toBe(1);
  });

  it("getAlbumStats sums plays across an album's tracks", () => {
    svc.record({ userId: "user-1", unifiedTrackId: T1_ID });
    svc.record({ userId: "user-1", unifiedTrackId: T1_ID });
    const stats = svc.getAlbumStats("user-1", [RG1_ID]);
    expect(stats.get(RG1_ID)?.playCount).toBe(2);
    expect(stats.get(RG1_ID)?.played).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
