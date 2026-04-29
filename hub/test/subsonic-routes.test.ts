import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

function seedUser(
  app: FastifyInstance,
  username = "tester",
  password = "secret",
) {
  const enc = setPassword(password, app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("user-1", username, enc);
}

describe("Subsonic routes — auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedUser(app);
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

  // JWT auth on /rest/* was removed in #106 — SPA now uses u+t+s like third-
  // party clients. Authorization headers are ignored on Subsonic endpoints.

  // ── u+t+s (MD5 token+salt) auth — issue #106 ──────────────────────────────
  it("ping with valid u+t+s → status ok", async () => {
    const { createHash } = await import("node:crypto");
    const salt = "abc123";
    const token = createHash("md5").update("secret" + salt).digest("hex");
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=tester&t=${token}&s=${salt}&f=json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].status).toBe("ok");
  });

  it("ping with u+t+s wrong token → error code 40", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=tester&t=${"0".repeat(32)}&s=abc&f=json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].error.code).toBe(40);
  });

  it("ping with u+t+s wrong salt → error code 40", async () => {
    const { createHash } = await import("node:crypto");
    const token = createHash("md5").update("secret" + "good-salt").digest("hex");
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=tester&t=${token}&s=bad-salt&f=json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].error.code).toBe(40);
  });

  it("ping with u+t+s unknown user → error code 40 (no enumeration)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=nobody&t=${"0".repeat(32)}&s=abc&f=json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].error.code).toBe(40);
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
    seedUser(app);
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

  it("getMusicFolders → one folder per known instance", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/rest/getMusicFolders?u=tester&p=secret&f=json",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const folders = body["subsonic-response"].musicFolders.musicFolder as Array<{ id: number; name: string }>;
    // Test fixture seeds only the local instance — peers depend on YAML config.
    expect(folders.length).toBeGreaterThanOrEqual(1);
    expect(folders[0].name).toBe("Local");
    expect(typeof folders[0].id).toBe("number");
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

  it("search3 matches artist by internal id (prefixed and bare)", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized, musicbrainz_id) VALUES (?, ?, ?, ?)",
      )
      .run(
        "artist-uuid-1",
        "Zzz Obscure",
        "zzz obscure",
        "mbid-artist-aaaa",
      );

    const prefixed = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=arartist-uuid-1",
    });
    const prefixedBody = prefixed.json();
    expect(prefixedBody["subsonic-response"].searchResult3.artist).toHaveLength(1);
    expect(prefixedBody["subsonic-response"].searchResult3.artist[0].name).toBe(
      "Zzz Obscure",
    );

    const bare = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=artist-uuid-1",
    });
    expect(bare.json()["subsonic-response"].searchResult3.artist).toHaveLength(1);

    const byMbid = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=mbid-artist-aaaa",
    });
    expect(byMbid.json()["subsonic-response"].searchResult3.artist).toHaveLength(1);
  });

  it("search3 matches album by internal id and MusicBrainz id", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
      )
      .run("artist-a", "Some Artist", "some artist");
    app.db
      .prepare(
        "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id, musicbrainz_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run("rg-uuid-1", "An Album", "an album", "artist-a", "mbid-rg-bbbb");

    const byId = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=alrg-uuid-1",
    });
    expect(byId.json()["subsonic-response"].searchResult3.album).toHaveLength(1);

    const byMbid = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=mbid-rg-bbbb",
    });
    expect(byMbid.json()["subsonic-response"].searchResult3.album).toHaveLength(1);
  });

  it("search3 matches track by internal id (the /stream id workflow)", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
      )
      .run("artist-b", "Track Artist", "track artist");
    app.db
      .prepare(
        "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, ?, ?, ?)",
      )
      .run("rg-b", "RG B", "rg b", "artist-b");
    app.db
      .prepare(
        "INSERT INTO unified_releases (id, release_group_id, name) VALUES (?, ?, ?)",
      )
      .run("rel-b", "rg-b", "RG B");
    app.db
      .prepare(
        `INSERT INTO unified_tracks
          (id, release_id, artist_id, title, title_normalized, musicbrainz_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "track-uuid-1",
        "rel-b",
        "artist-b",
        "Zxcv Unique Title",
        "zxcv unique title",
        "mbid-track-cccc",
      );

    // Prefixed id as seen in /stream?id=... URLs
    const streamId = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=ttrack-uuid-1",
    });
    expect(streamId.json()["subsonic-response"].searchResult3.song).toHaveLength(1);
    expect(streamId.json()["subsonic-response"].searchResult3.song[0].title).toBe(
      "Zxcv Unique Title",
    );

    const byMbid = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=mbid-track-cccc",
    });
    expect(byMbid.json()["subsonic-response"].searchResult3.song).toHaveLength(1);
  });

  // ── Share IDs ─────────────────────────────────────────────────────────────
  // shareId surfaces the Navidrome remote_id of a source. search3 resolves
  // it back to a unified entity via the join through instance_*.

  async function seedShareFixture(app: FastifyInstance) {
    const ownerId = (app.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
    app.db.prepare(
      "INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id) VALUES ('local', 'Local', 'http://nav/', 'subsonic', '', ?)",
    ).run(ownerId);
    app.db.prepare(
      "INSERT OR IGNORE INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id) VALUES ('peer-x', 'Peer X', 'https://x/', 'subsonic', '', ?)",
    ).run(ownerId);

    // Artist: unified + two sources (local + peer-x). Local preferred.
    app.db.prepare(
      "INSERT INTO unified_artists (id, name, name_normalized) VALUES ('ua-1','Share Artist','share artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name) VALUES ('local:LOC-AR-1','local','LOC-AR-1','Share Artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name) VALUES ('peer-x:PX-AR-1','peer-x','PX-AR-1','Share Artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_artist_sources (unified_artist_id, instance_artist_id, instance_id) VALUES ('ua-1','local:LOC-AR-1','local')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_artist_sources (unified_artist_id, instance_artist_id, instance_id) VALUES ('ua-1','peer-x:PX-AR-1','peer-x')",
    ).run();

    // Album: unified release-group with one release + two source albums.
    app.db.prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES ('urg-1','Share Album','share album','ua-1')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_releases (id, release_group_id, name) VALUES ('ur-1','urg-1','Share Album')",
    ).run();
    app.db.prepare(
      "INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name) VALUES ('local:LOC-AL-1','local','LOC-AL-1','Share Album','local:LOC-AR-1','Share Artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name) VALUES ('peer-x:PX-AL-1','peer-x','PX-AL-1','Share Album','peer-x:PX-AR-1','Share Artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_release_sources (unified_release_id, instance_album_id, instance_id) VALUES ('ur-1','local:LOC-AL-1','local')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_release_sources (unified_release_id, instance_album_id, instance_id) VALUES ('ur-1','peer-x:PX-AL-1','peer-x')",
    ).run();
  }

  it("getAlbum surfaces shareId preferring local source", async () => {
    await seedShareFixture(app);
    const res = await app.inject({
      method: "GET",
      url: "/rest/getAlbum?u=tester&p=secret&f=json&id=alurg-1",
    });
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].album.shareId).toBe("LOC-AL-1");
  });

  it("getArtist surfaces shareId preferring local source", async () => {
    await seedShareFixture(app);
    const res = await app.inject({
      method: "GET",
      url: "/rest/getArtist?u=tester&p=secret&f=json&id=arua-1",
    });
    const body = res.json();
    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].artist.shareId).toBe("LOC-AR-1");
  });

  it("search3 resolves album shareId from any source (peer)", async () => {
    await seedShareFixture(app);
    const res = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=PX-AL-1",
    });
    const body = res.json();
    expect(body["subsonic-response"].searchResult3.album).toHaveLength(1);
    expect(body["subsonic-response"].searchResult3.album[0].name).toBe("Share Album");
  });

  it("search3 resolves artist shareId from any source (peer)", async () => {
    await seedShareFixture(app);
    const res = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=PX-AR-1",
    });
    const body = res.json();
    expect(body["subsonic-response"].searchResult3.artist).toHaveLength(1);
  });

  it("search3 matches case-insensitively and across unicode/punctuation", async () => {
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
      )
      .run("artist-bjork", "Björk", "bjork");
    app.db
      .prepare(
        "INSERT INTO unified_artists (id, name, name_normalized) VALUES (?, ?, ?)",
      )
      .run("artist-acdc", "AC/DC", "acdc");

    const mixedCase = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=BJORK",
    });
    expect(
      mixedCase.json()["subsonic-response"].searchResult3.artist?.some(
        (a: { id: string }) => a.id === "arartist-bjork",
      ),
    ).toBe(true);

    const diacritic = await app.inject({
      method: "GET",
      url: `/rest/search3?u=tester&p=secret&f=json&query=${encodeURIComponent("Björk")}`,
    });
    expect(
      diacritic.json()["subsonic-response"].searchResult3.artist?.some(
        (a: { id: string }) => a.id === "arartist-bjork",
      ),
    ).toBe(true);

    const punct = await app.inject({
      method: "GET",
      url: `/rest/search3?u=tester&p=secret&f=json&query=${encodeURIComponent("AC/DC")}`,
    });
    expect(
      punct.json()["subsonic-response"].searchResult3.artist?.some(
        (a: { id: string }) => a.id === "arartist-acdc",
      ),
    ).toBe(true);
  });

  it("getAlbumList2 with instanceId=local returns only local-sourced albums", async () => {
    await seedShareFixture(app);
    // Add a peer-only album (no local source)
    app.db.prepare(
      "INSERT INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES ('urg-2','Peer Only','peer only','ua-1')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_releases (id, release_group_id, name) VALUES ('ur-2','urg-2','Peer Only')",
    ).run();
    app.db.prepare(
      "INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name) VALUES ('peer-x:PX-AL-2','peer-x','PX-AL-2','Peer Only','peer-x:PX-AR-1','Share Artist')",
    ).run();
    app.db.prepare(
      "INSERT INTO unified_release_sources (unified_release_id, instance_album_id, instance_id) VALUES ('ur-2','peer-x:PX-AL-2','peer-x')",
    ).run();

    const local = await app.inject({
      method: "GET",
      url: "/rest/getAlbumList2?u=tester&p=secret&f=json&type=alphabeticalByName&size=50&instanceId=local",
    });
    const localAlbums = local.json()["subsonic-response"].albumList2.album as Array<{ name: string }>;
    expect(localAlbums.map((a) => a.name).sort()).toEqual(["Share Album"]);

    const peer = await app.inject({
      method: "GET",
      url: "/rest/getAlbumList2?u=tester&p=secret&f=json&type=alphabeticalByName&size=50&instanceId=peer-x",
    });
    const peerAlbums = peer.json()["subsonic-response"].albumList2.album as Array<{ name: string }>;
    expect(peerAlbums.map((a) => a.name).sort()).toEqual(["Peer Only", "Share Album"]);

    const all = await app.inject({
      method: "GET",
      url: "/rest/getAlbumList2?u=tester&p=secret&f=json&type=alphabeticalByName&size=50",
    });
    const allAlbums = all.json()["subsonic-response"].albumList2.album as Array<{ name: string }>;
    expect(allAlbums.map((a) => a.name).sort()).toEqual(["Peer Only", "Share Album"]);
  });

  it("search3 with unknown remote_id returns no results", async () => {
    await seedShareFixture(app);
    const res = await app.inject({
      method: "GET",
      url: "/rest/search3?u=tester&p=secret&f=json&query=NOPE-UNKNOWN-9",
    });
    const body = res.json();
    expect(body["subsonic-response"].searchResult3.album ?? []).toHaveLength(0);
    expect(body["subsonic-response"].searchResult3.artist ?? []).toHaveLength(0);
  });
});
