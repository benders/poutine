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

  it("star album via id=al<uuid> classifies as album and pulls its tracks into song list", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.album[0].id).toBe(ALBUM_SUB_ID);
    // The track on this album is included via album-expansion, but with no
    // direct `starred` annotation (the user starred the album, not the track).
    expect(env.song).toHaveLength(1);
    expect(env.song[0].id).toBe(TRACK_SUB_ID);
    expect(env.song[0].starred).toBeUndefined();
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

  it("getStarred2 song list includes tracks from starred albums (#104)", async () => {
    // Seed a second track on the same album, plus a track on an unrelated album
    const TRACK2_ID = "ffffffff-ffff-4fff-ffff-ffffffffffff";
    const RG_OTHER = "11111111-1111-4111-1111-111111111111";
    const REL_OTHER = "22222222-2222-4222-2222-222222222222";
    const TRACK_OTHER = "33333333-3333-4333-3333-333333333333";

    app.db
      .prepare(
        "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized, track_number) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(TRACK2_ID, REL_ID, ARTIST_ID, "Side B", "side b", 2);
    app.db
      .prepare(
        "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
      )
      .run(RG_OTHER, "Other RG", "other rg", ARTIST_ID);
    app.db
      .prepare(
        "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
      )
      .run(REL_OTHER, RG_OTHER, "Other RG");
    app.db
      .prepare(
        "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized) VALUES (?, ?, ?, ?, ?)",
      )
      .run(TRACK_OTHER, REL_OTHER, ARTIST_ID, "Unrelated", "unrelated");

    // Star the album (pulls in TRACK_ID + TRACK2_ID) and TRACK_OTHER directly
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}&id=t${TRACK_OTHER}`,
    });

    const env = (
      await app.inject({ method: "GET", url: `/rest/getStarred2?${QS}` })
    ).json()["subsonic-response"].starred2;

    const ids = (env.song as Array<{ id: string }>).map((s) => s.id).sort();
    expect(ids).toEqual(
      [`t${TRACK_ID}`, `t${TRACK2_ID}`, `t${TRACK_OTHER}`].sort(),
    );

    // The directly-starred track has a starred timestamp; album-pulled
    // tracks do not (their per-row star icon must read as un-starred).
    const byId = new Map(
      (env.song as Array<{ id: string; starred?: string }>).map((s) => [
        s.id,
        s.starred,
      ]),
    );
    expect(byId.get(`t${TRACK_OTHER}`)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byId.get(`t${TRACK_ID}`)).toBeUndefined();
    expect(byId.get(`t${TRACK2_ID}`)).toBeUndefined();
  });

  it("a track that is BOTH directly starred AND on a starred album dedupes to one row with its star intact", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=${ALBUM_SUB_ID}&id=${TRACK_SUB_ID}`,
    });
    const env = (
      await app.inject({ method: "GET", url: `/rest/getStarred2?${QS}` })
    ).json()["subsonic-response"].starred2;

    const matches = (env.song as Array<{ id: string; starred?: string }>).filter(
      (s) => s.id === TRACK_SUB_ID,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
