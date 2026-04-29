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

function seedLibrary(app: FastifyInstance): void {
  // Minimal: one artist, one release group, one release, one track
  app.db
    .prepare(
      "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
    )
    .run("art-1", "Star Artist", "star artist");
  app.db
    .prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
    )
    .run("rg-1", "Star Album", "star album", "art-1");
  app.db
    .prepare(
      "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
    )
    .run("rel-1", "rg-1", "Star Album");
  app.db
    .prepare(
      "INSERT INTO unified_tracks (id, release_id, artist_id, title, title_normalized) VALUES (?, ?, ?, ?, ?)",
    )
    .run("trk-1", "rel-1", "art-1", "Star Track", "star track");
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

  it("star + getStarred2 round-trip for a track", async () => {
    const star = await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=ttrk-1`,
    });
    expect(star.json()["subsonic-response"].status).toBe("ok");

    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.song).toHaveLength(1);
    expect(env.song[0].id).toBe("ttrk-1");
    expect(env.song[0].title).toBe("Star Track");
    expect(env.song[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.album).toEqual([]);
    expect(env.artist).toEqual([]);
  });

  it("star album via id=al<uuid> classifies as album", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=alrg-1` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.album[0].id).toBe("alrg-1");
    expect(env.song).toEqual([]);
  });

  it("star artist via id=ar<uuid> classifies as artist", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=arart-1` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    const env = got.json()["subsonic-response"].starred2;
    expect(env.artist).toHaveLength(1);
    expect(env.artist[0].id).toBe("arart-1");
    expect(env.artist[0].name).toBe("Star Artist");
  });

  it("unstar removes the row", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=ttrk-1` });
    await app.inject({ method: "GET", url: `/rest/unstar?${QS}&id=ttrk-1` });
    const got = await app.inject({
      method: "GET",
      url: `/rest/getStarred2?${QS}`,
    });
    expect(got.json()["subsonic-response"].starred2.song).toEqual([]);
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
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=ttrk-1` });
    const aliceGot = await app.inject({
      method: "GET",
      url: "/rest/getStarred2?u=alice&p=secret&f=json",
    });
    expect(aliceGot.json()["subsonic-response"].starred2.song).toEqual([]);
  });

  it("getStarred returns the same envelope under the legacy 'starred' key", async () => {
    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=ttrk-1` });
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
    app.db
      .prepare(
        "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
      )
      .run("rg-2", "Other Album", "other album", "art-1");

    await app.inject({ method: "GET", url: `/rest/star?${QS}&id=alrg-1` });
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbumList2?${QS}&type=starred`,
    });
    const albums = res.json()["subsonic-response"].albumList2.album as Array<{
      id: string;
      starred?: string;
    }>;
    expect(albums).toHaveLength(1);
    expect(albums[0].id).toBe("alrg-1");
    expect(albums[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getAlbum annotates starred on the album and on starred tracks", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&id=alrg-1&id=ttrk-1`,
    });
    const res = await app.inject({
      method: "GET",
      url: `/rest/getAlbum?${QS}&id=alrg-1`,
    });
    const album = res.json()["subsonic-response"].album;
    expect(album.starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(album.song[0].starred).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("albumId / artistId params still classify correctly", async () => {
    await app.inject({
      method: "GET",
      url: `/rest/star?${QS}&albumId=alrg-1&artistId=arart-1`,
    });
    const env = (
      await app.inject({ method: "GET", url: `/rest/getStarred2?${QS}` })
    ).json()["subsonic-response"].starred2;
    expect(env.album).toHaveLength(1);
    expect(env.artist).toHaveLength(1);
  });
});
