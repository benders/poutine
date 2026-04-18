import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

async function seedUser(
  app: FastifyInstance,
  username = "tester",
  password = "secret",
) {
  const hash = await hashPassword(password);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("user-1", username, hash);
}

describe("Subsonic routes — auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedUser(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("ping with correct credentials → status ok", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].version).toBe("1.16.1");
  });

  it("ping with wrong password → status failed, error code 40", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?u=tester&p=wrong&f=json",
    });
    expect(res.statusCode).toBe(200); // Subsonic always returns 200
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(40);
  });

  it("ping with enc: hex-encoded password → status ok", async () => {
    const hex = Buffer.from("secret", "utf8").toString("hex");
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=tester&p=enc:${hex}&f=json`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("ping with .view suffix → status ok", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping.view?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("ping with f=xml → XML content-type and correct envelope", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?u=tester&p=secret&f=xml",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/xml/);
    expect(res.body).toMatch(/^<\?xml/);
    expect(res.body).toContain('status="ok"');
    expect(res.body).toContain("subsonic-response");
  });

  it("ping with missing credentials → error code 10", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(10);
  });

  it("ping with unknown username → error code 40", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?u=nobody&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(40);
  });
});

describe("Subsonic routes — endpoints", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    await seedUser(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it("getGenres → ok envelope with genres key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getGenres?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("genres");
    expect(body["subsonic-response"].genres).toHaveProperty("genre");
  });

  it("getLicense → valid license", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getLicense?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].license.valid).toBe(true);
  });

  it("getMusicFolders → returns a music folder", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getMusicFolders?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].musicFolders.musicFolder).toHaveLength(1);
    expect(body["subsonic-response"].musicFolders.musicFolder[0].name).toBe("Music");
  });

  it("getArtists → ok envelope with artists key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtists?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("artists");
  });

  it("getIndexes → ok envelope with indexes key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getIndexes?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("indexes");
  });

  it("getArtist with unknown id → error 70", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtist?u=tester&p=secret&f=json&id=arnobody",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("getArtistInfo2 with unknown id → error 70", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtistInfo2?u=tester&p=secret&f=json&id=arnobody",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("getArtistInfo2 with valid id → returns artist info structure", async () => {
    // First create a test artist in the database (use raw ID without prefix)
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized, musicbrainz_id, image_url) VALUES (?, ?, ?, ?, ?)",
      )
      .run("test-1", "Radiohead", "radiohead", "a74b1b7f-71a5-4011-9441-d0b5e4122711", "https://last.fm/music/Radiohead");

    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtistInfo2?u=tester&p=secret&f=json&id=artest-1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("artistInfo2");
    expect(body["subsonic-response"].artistInfo2).toHaveProperty("artist");
    expect(body["subsonic-response"].artistInfo2.artist.name).toBe("Radiohead");
    expect(body["subsonic-response"].artistInfo2.largeImageUrl).toBe("https://last.fm/music/Radiohead");
    expect(body["subsonic-response"].artistInfo2.musicBrainzId).toBe("a74b1b7f-71a5-4011-9441-d0b5e4122711");
  });

  it("getArtistInfo2 with Last.fm URL → returns URL directly", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized, image_url) VALUES (?, ?, ?, ?)",
      )
      .run("test-2", "Thom Yorke", "thom-yorke", "https://last.fm/music/Thom+Yorke");

    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtistInfo2?u=tester&p=secret&f=json&id=artest-2",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].artistInfo2.largeImageUrl).toBe("https://last.fm/music/Thom+Yorke");
  });

  it("getArtistInfo2 with encoded cover art ID → returns encoded ID", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized, image_url) VALUES (?, ?, ?, ?)",
      )
      .run("test-3", "Atoms for Peace", "atoms-for-peace", "instance-1:cover-art-123");

    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtistInfo2?u=tester&p=secret&f=json&id=artest-3",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].artistInfo2.largeImageUrl).toBe("instance-1:cover-art-123");
  });

  it("getArtistInfo2 without image_url → undefined image URLs", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
      )
      .run("test-4", "Unknown Artist", "unknown-artist");

    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtistInfo2?u=tester&p=secret&f=json&id=artest-4",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].artistInfo2.largeImageUrl).toBeUndefined();
    expect(body["subsonic-response"].artistInfo2.mediumImageUrl).toBeUndefined();
    expect(body["subsonic-response"].artistInfo2.smallImageUrl).toBeUndefined();
  });

  it("getAlbum with bad id prefix → error 70", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getAlbum?u=tester&p=secret&f=json&id=wrongprefix",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error.code).toBe(70);
  });

  it("getPlaylists → ok with empty playlist array", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getPlaylists?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].playlists.playlist).toEqual([]);
  });

  it("scrobble → ok empty response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/scrobble?u=tester&p=secret&f=json&id=t123",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("getNowPlaying → ok with empty entry array", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getNowPlaying?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].nowPlaying.entry).toEqual([]);
  });

  it("getAlbumList2 → ok with albumList2 key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getAlbumList2?u=tester&p=secret&f=json&type=newest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("albumList2");
  });

  it("search3 → ok with searchResult3 key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=test",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"]).toHaveProperty("searchResult3");
  });
});
