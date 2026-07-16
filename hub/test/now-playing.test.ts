import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import {
  NowPlayingService,
  NOW_PLAYING_TTL_MS,
} from "../src/services/now-playing.js";
import { seedAdminUser } from "./helpers/admin-user.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

const QS = "u=tester&p=secret&f=json&c=spa";

const ARTIST_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RG_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const REL_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const T1_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const T2_ID = "11111111-1111-4111-1111-111111111111";
const T1_SUB = `t${T1_ID}`;
const T2_SUB = `t${T2_ID}`;

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
    .run(ARTIST_ID, "Now Artist", "now artist");
  app.db
    .prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
    )
    .run(RG_ID, "Now Album", "now album", ARTIST_ID);
  app.db
    .prepare("INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)")
    .run(REL_ID, RG_ID, "Now Album");
  const insTrack = app.db.prepare(
    "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insTrack.run(T1_ID, REL_ID, ARTIST_ID, "Now Track", "now track", 200000);
  insTrack.run(T2_ID, REL_ID, ARTIST_ID, "Other Track", "other track", 180000);
}

// ── Service unit tests ───────────────────────────────────────────────────────

// Source-snapshot fields (#263) are irrelevant to the slot/TTL mechanics
// under test here.
const npDefaults = {
  trackTitle: "A",
  artistName: "X",
  albumId: null,
  clientName: "spa",
  sourceKind: null,
  sourcePeerId: null,
  format: null,
  bitrate: null,
} as const;

describe("NowPlayingService", () => {
  it("keeps one entry per (user, client), newest ping wins", () => {
    const svc = new NowPlayingService();
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" });
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-b", trackTitle: "B" });
    const all = svc.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].trackId).toBe("t-b");
  });

  it("separate clients for the same user are separate players", () => {
    const svc = new NowPlayingService();
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" });
    svc.record({
      ...npDefaults,
      userId: "u1",
      username: "alice",
      trackId: "t-b",
      trackTitle: "B",
      clientName: "phone",
    });
    expect(svc.getAll()).toHaveLength(2);
    const ids = svc.getAll().map((e) => e.playerId);
    expect(new Set(ids).size).toBe(2);
  });

  it("playerId is stable across pings from the same player", () => {
    const svc = new NowPlayingService();
    const input = { ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" };
    svc.record(input);
    const first = svc.getAll()[0].playerId;
    svc.record({ ...input, trackId: "t-b" });
    expect(svc.getAll()[0].playerId).toBe(first);
  });

  it("re-ping of the same track keeps startedAt but refreshes the TTL", () => {
    let nowMs = 1_000_000;
    const svc = new NowPlayingService(() => nowMs);
    const input = { ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" };
    svc.record(input);
    const startedAt = svc.getAll()[0].startedAt;

    nowMs += NOW_PLAYING_TTL_MS - 1_000;
    svc.record(input); // refresh just before expiry
    expect(svc.getAll()[0].startedAt).toBe(startedAt);

    nowMs += NOW_PLAYING_TTL_MS - 1_000;
    // Still alive only because the second ping refreshed it.
    expect(svc.getAll()).toHaveLength(1);
  });

  it("entries expire after the TTL", () => {
    let nowMs = 1_000_000;
    const svc = new NowPlayingService(() => nowMs);
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" });
    nowMs += NOW_PLAYING_TTL_MS + 1;
    expect(svc.getAll()).toHaveLength(0);
  });

  it("getForUser filters to that user only", () => {
    const svc = new NowPlayingService();
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" });
    svc.record({ ...npDefaults, userId: "u2", username: "bob", trackId: "t-b", trackTitle: "B" });
    expect(svc.getForUser("u1")).toHaveLength(1);
    expect(svc.getForUser("u1")[0].username).toBe("alice");
  });

  it("minutesAgo counts whole minutes since the last ping", () => {
    let nowMs = 1_000_000;
    const svc = new NowPlayingService(() => nowMs);
    svc.record({ ...npDefaults, userId: "u1", username: "alice", trackId: "t-a" });
    nowMs += 150_000; // 2.5 min
    expect(svc.minutesAgo(svc.getAll()[0])).toBe(2);
  });
});

// ── Endpoint tests ───────────────────────────────────────────────────────────

describe("getNowPlaying (#237)", () => {
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

  async function ping(subId: string, qs = QS): Promise<void> {
    const res = await app.inject({
      method: "GET",
      url: `/rest/scrobble?${qs}&id=${subId}&submission=false`,
    });
    expect(res.json()["subsonic-response"].status).toBe("ok");
  }

  it("empty when no pings", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?${QS}`,
    });
    const body = res.json()["subsonic-response"];
    expect(body.status).toBe("ok");
    expect(body.nowPlaying.entry).toEqual([]);
  });

  it("submission=false ping surfaces a full song entry", async () => {
    await ping(T1_SUB);
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?${QS}`,
    });
    const entries = res.json()["subsonic-response"].nowPlaying.entry;
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.id).toBe(T1_SUB);
    expect(e.title).toBe("Now Track");
    expect(e.artist).toBe("Now Artist");
    expect(e.album).toBe("Now Album");
    expect(e.username).toBe("tester");
    expect(e.minutesAgo).toBe(0);
    expect(e.playerId).toBeTypeOf("number");
    expect(e.playerName).toBe("spa");
  });

  it("is per-user: another user's playback is not visible", async () => {
    seedUser(app, "user-2", "alice");
    await ping(T1_SUB); // as tester
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?u=alice&p=secret&f=json&c=phone`,
    });
    expect(res.json()["subsonic-response"].nowPlaying.entry).toEqual([]);
  });

  it("a newer ping from the same client replaces the entry", async () => {
    await ping(T1_SUB);
    await ping(T2_SUB);
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?${QS}`,
    });
    const entries = res.json()["subsonic-response"].nowPlaying.entry;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(T2_SUB);
  });

  it("unknown or malformed ids are ignored", async () => {
    await ping("tomato");
    await ping("t99999999-9999-4999-9999-999999999999");
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?${QS}`,
    });
    expect(res.json()["subsonic-response"].nowPlaying.entry).toEqual([]);
  });

  it("submission=False (py-sonic capitalization) is parsed as a ping, not a play", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/scrobble?${QS}&id=${T1_SUB}&submission=False`,
    });
    const now = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?${QS}`,
    });
    expect(now.json()["subsonic-response"].nowPlaying.entry).toHaveLength(1);
    const song = await app.inject({
      method: "GET",
      url: `/rest/getSong?${QS}&id=${T1_SUB}`,
    });
    expect(song.json()["subsonic-response"].song.playCount).toBeUndefined();
  });

  it("submission=false records no durable play", async () => {
    await ping(T1_SUB);
    const res = await app.inject({
      method: "GET",
      url: `/rest/getSong?${QS}&id=${T1_SUB}`,
    });
    expect(res.json()["subsonic-response"].song.playCount).toBeUndefined();
  });

  it("XML envelope nests entry elements under nowPlaying", async () => {
    await ping(T1_SUB);
    const res = await app.inject({
      method: "GET",
      url: `/rest/getNowPlaying?u=tester&p=secret&c=spa&f=xml`,
    });
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.body).toContain("<nowPlaying>");
    expect(res.body).toContain('username="tester"');
    expect(res.body).toContain(`id="${T1_SUB}"`);
  });

  it("admin activity/active exposes the cross-user view", async () => {
    seedUser(app, "user-2", "alice");
    await ping(T1_SUB); // tester
    await ping(T2_SUB, "u=alice&p=secret&f=json&c=phone"); // alice
    const { token } = await seedAdminUser(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/activity/active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      nowPlaying: Array<{ username: string; trackTitle: string; minutesAgo: number }>;
    };
    expect(body.nowPlaying).toHaveLength(2);
    const users = body.nowPlaying.map((e) => e.username).sort();
    expect(users).toEqual(["alice", "tester"]);
    expect(body.nowPlaying[0].minutesAgo).toBe(0);
  });

  it("admin entries carry album + preferred-source snapshot (#263)", async () => {
    app.db
      .prepare(
        `INSERT INTO instance_tracks
         (id, instance_id, remote_id, album_id, title, artist_name, format, bitrate)
         VALUES ('local:trk-1', 'local', 'trk-1', 'local:alb-1', 'Now Track', 'Now Artist', 'flac', 1411)`,
      )
      .run();
    app.db
      .prepare(
        `INSERT INTO track_sources
         (id, unified_track_id, instance_id, instance_track_id, format, bitrate, preferred)
         VALUES ('src-1', ?, 'local', 'local:trk-1', 'flac', 1411, 1)`,
      )
      .run(T1_ID);
    await ping(T1_SUB);
    const { token } = await seedAdminUser(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hub/activity/active",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as {
      nowPlaying: Array<{
        albumId: string | null;
        sourceKind: string | null;
        sourcePeerId: string | null;
        format: string | null;
        bitrate: number | null;
      }>;
    };
    expect(body.nowPlaying).toHaveLength(1);
    const e = body.nowPlaying[0];
    expect(e.albumId).toBe(RG_ID);
    expect(e.sourceKind).toBe("local");
    expect(e.sourcePeerId).toBeNull();
    expect(e.format).toBe("flac");
    expect(e.bitrate).toBe(1411);
  });
});
