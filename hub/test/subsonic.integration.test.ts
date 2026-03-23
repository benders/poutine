import { describe, it, expect } from "vitest";
import { SubsonicClient } from "../src/adapters/subsonic.js";

const client = new SubsonicClient({
  url: "https://navidrome-west.slackworks.com",
  username: "poutine",
  password: "Kb43H_JB",
});

describe("SubsonicClient integration (real Navidrome)", () => {
  it("ping returns ok status", async () => {
    const result = await client.ping();
    expect(result.status).toBe("ok");
    expect(result.version).toBeDefined();
    console.log("Server version:", result.version, "type:", result.type, "serverVersion:", result.serverVersion);
  });

  it("getArtists returns artist list", async () => {
    const result = await client.getArtists();
    expect(Array.isArray(result)).toBe(true);
    console.log(`Found ${result.length} artist index entries`);

    // Flatten all artists and log count
    const allArtists = result.flatMap((idx) => idx.artist || []);
    console.log(`Total artists: ${allArtists.length}`);

    if (allArtists.length > 0) {
      const first = allArtists[0];
      console.log("First artist:", first.name, "id:", first.id, "mbid:", first.musicBrainzId || "none");
    }
  });

  it("getAlbumList2 returns albums", async () => {
    const result = await client.getAlbumList2({ type: "alphabeticalByName", size: 10 });
    expect(Array.isArray(result)).toBe(true);
    console.log(`Got ${result.length} albums from alphabetical listing`);

    for (const album of result.slice(0, 3)) {
      console.log(`  Album: "${album.name}" by ${album.artist} (${album.year || "?"}) mbid:${album.musicBrainzId || "none"}`);
    }
  });

  it("getAlbum returns album with tracks", async () => {
    // First get an album ID
    const albums = await client.getAlbumList2({ type: "alphabeticalByName", size: 1 });
    expect(albums.length).toBeGreaterThan(0);

    const album = await client.getAlbum(albums[0].id);
    expect(album.name).toBeDefined();
    expect(album.song).toBeDefined();
    console.log(`Album: "${album.name}" has ${album.song?.length || 0} tracks`);

    if (album.song && album.song.length > 0) {
      const track = album.song[0];
      console.log(`  Track 1: "${track.title}" duration:${track.duration}s format:${track.suffix} bitrate:${track.bitRate}kbps mbid:${track.musicBrainzId || "none"}`);
    }
  });

  it("getArtist returns artist with albums", async () => {
    const indexes = await client.getArtists();
    const allArtists = indexes.flatMap((idx) => idx.artist || []);
    expect(allArtists.length).toBeGreaterThan(0);

    const artist = await client.getArtist(allArtists[0].id);
    expect(artist.name).toBeDefined();
    console.log(`Artist: "${artist.name}" albums:${artist.albumCount || 0} mbid:${artist.musicBrainzId || "none"}`);
  });

  it("search3 returns results", async () => {
    const result = await client.search3("a", { artistCount: 5, albumCount: 5, songCount: 5 });
    console.log(`Search "a": ${result.artist?.length || 0} artists, ${result.album?.length || 0} albums, ${result.song?.length || 0} songs`);
  });

  it("getCoverArt returns image data", async () => {
    const albums = await client.getAlbumList2({ type: "alphabeticalByName", size: 1 });
    expect(albums.length).toBeGreaterThan(0);

    if (albums[0].coverArt) {
      const response = await client.getCoverArt(albums[0].coverArt, 100);
      expect(response.ok).toBe(true);
      const contentType = response.headers.get("content-type");
      console.log("Cover art content-type:", contentType);
      expect(contentType).toMatch(/^image\//);
      // Consume body to avoid leak
      await response.arrayBuffer();
    }
  });

  it("stream returns audio data", async () => {
    const albums = await client.getAlbumList2({ type: "alphabeticalByName", size: 1 });
    const album = await client.getAlbum(albums[0].id);
    expect(album.song?.length).toBeGreaterThan(0);

    const trackId = album.song![0].id;
    const response = await client.stream(trackId, { format: "mp3", maxBitRate: 128 });
    expect(response.ok).toBe(true);
    const contentType = response.headers.get("content-type");
    console.log("Stream content-type:", contentType);
    // Don't consume entire stream, just verify headers
    await response.body?.cancel();
  });
});
