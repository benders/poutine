import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

const QS = "u=tester&p=secret&f=json";

function seedUser(app: FastifyInstance, id: string, username: string): void {
  const enc = setPassword("secret", app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 0)",
    )
    .run(id, username, enc);
}

// IDs match the UUID v4 shape that `generateDeterministicId` produces — the
// star route classifier rejects anything else, so test fixtures must conform.
const ARTIST_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RG_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const REL_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const TRACK_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

function seedLibrary(app: FastifyInstance): void {
  // Minimal: one artist, one release group, one release, one track
  app.db
    .prepare(
      "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
    )
    .run(ARTIST_ID, "Star Artist", "star artist");
  app.db
    .prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
    )
    .run(RG_ID, "Star Album", "star album", ARTIST_ID);
  app.db
    .prepare(
      "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
    )
    .run(REL_ID, RG_ID, "Star Album");
  app.db
    .prepare(
      "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized) VALUES (?, ?, ?, ?, ?)",
    )
    .run(TRACK_ID, REL_ID, ARTIST_ID, "Star Track", "star track");
}

describe("star / unstar / getStarred2 (#104)", () => {
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

  const TRACK_SUB_ID = `t${TRACK_ID}`;
  const ALBUM_SUB_ID = `al${RG_ID}`;
  const ARTIST_SUB_ID = `ar${ARTIST_ID}`;

  it("star + getStarred2 round-trip for a track", async () => {
    const star = await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=${TRACK_SUB_ID}`,
    });
    expect(star.json()["subsonic-response"].status).toBe("ok");

    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.song).toHaveLength(1);
    expect(env.song[0].id).toBe(TRACK_SUB_ID);
    expect(env.song[0].title).toBe("Star Track");
    expect(env.song[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.album).toEqual([]);
    expect(env.artist).toEqual([]);
  });

  it("star album via id=al<uuid> classifies as album", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.album[0].id).toBe(ALBUM_SUB_ID);
    // getStarred2 returns only directly-starred songs; the SPA composes
    // album-track expansion client-side via getAlbum.
    expect(env.song).toEqual([]);
  });

  it("star artist via id=ar<uuid> classifies as artist", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${ARTIST_SUB_ID}` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.artist).toHaveLength(1);
    expect(env.artist[0].id).toBe(ARTIST_SUB_ID);
    expect(env.artist[0].name).toBe("Star Artist");
  });

  it("unstar removes the row", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${TRACK_SUB_ID}` });
    await app.inject({ method: "GET", url: `/rest/unstar?${QS}&id=${TRACK_SUB_ID}` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    expect(got.json()["subsonic-response"].starred2.song).toEqual([]);
  });

  it("malformed ids are rejected (do not insert garbage rows)", async () => {
    // "tomato" historically classified as track with raw "omato"; the
    // tightened classifier requires a UUID-shaped suffix, so this is a no-op.
    const res = await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=tomato&id=alfoo&id=ar&id=`,
    });
    expect(res.json()["subsonic-response"].status).toBe("ok");
    const count = (
      app.db
        .prepare("SELECT COUNT(*) AS n FROM user_stars WHERE user_id = 'user-1'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("orphan stars (target gone) are filtered out by the JOIN", async () => {
    app.db
      .prepare(
        "INSERT INTO user_stars (user_id, kind, target_id) VALUES ('user-1','track','gone')",
      )
      .run();
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    expect(got.json()["subsonic-response"].starred2.song).toEqual([]);
  });

  it("stars are scoped per user", async () => {
    seedUser(app, "user-2", "alice");
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${TRACK_SUB_ID}` });
    const aliceGot = await app.inject({
      method: "GET",
      url: "/rest/getStarred2?u=alice&p=secret&f=json",
    });
    expect(aliceGot.json()["subsonic-response"].starred2.song).toEqual([]);
  });

  it("getStarred returns the same envelope under the legacy 'starred' key", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${TRACK_SUB_ID}` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred?${QS}`,
    });
    const body = got.json()["subsonic-response"];
    expect(body.starred.song).toHaveLength(1);
    expect(body.starred2).toBeUndefined();
  });

  it("getAlbumList2?type=starred returns only starred albums", async () => {
    // Seed a second album the user does NOT star
    const RG2_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    app.db
      .prepare(
        "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
      )
      .run(RG2_ID, "Other Album", "other album", ARTIST_ID);

    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}` });
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbumList2?${QS}&type=starred`,
    });
    const albums = res.json()["subsonic-response"].albumList2.album as Array<{
      id: string;
      starred?: string;
    }>;
    expect(albums).toHaveLength(1);
    expect(albums[0].id).toBe(ALBUM_SUB_ID);
    expect(albums[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getAlbum annotates starred on the album and on starred tracks", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}&id=${TRACK_SUB_ID}`,
    });
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbum?${QS}&id=${ALBUM_SUB_ID}`,
    });
    const album = res.json()["subsonic-response"].album;
    expect(album.starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(album.song[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("albumId / artistId params still classify correctly", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&albumId=${ALBUM_SUB_ID}&artistId=${ARTIST_SUB_ID}`,
    });
    const env = (
      await app.inject({ method: "GET", url: `/rest/getStarred2?${QS}` })
    ).json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.artist).toHaveLength(1);
  });

  it("albumId / artistId accept bare-UUID forms (no prefix)", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&albumId=${RG_ID}&artistId=${ARTIST_ID}`,
    });
    const env = (
      await app.inject({ method: "GET", url: `/rest/getStarred2?${QS}` })
    ).json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.artist).toHaveLength(1);
  });
});
