import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import crypto from "node:crypto";
import { SubsonicClient } from "../src/adapters/subsonic.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Wrap a Subsonic payload in the standard JSON envelope. */
function subsonicResponse(payload: Record<string, unknown>, status = "ok") {
  return {
    "subsonic-response": {
      status,
      version: "1.16.1",
      type: "navidrome",
      serverVersion: "0.53.3",
      openSubsonic: true,
      ...payload,
    },
  };
}

/** Create a mock Response that returns the given JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Create a mock Response that returns binary data. */
function binaryResponse(data: string, contentType: string): Response {
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

let client: SubsonicClient;
let fetchMock: Mock;

beforeEach(() => {
  client = new SubsonicClient({
    url: "https://music.example.com",
    username: "testuser",
    password: "testpass",
  });

  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  // Make salt deterministic for auth tests
  vi.spyOn(crypto, "randomBytes").mockReturnValue(
    Buffer.from("abcdef123456abcdef123456", "hex") as unknown as Buffer,
  );
});

// ── Auth parameter tests ────────────────────────────────────────────────────

describe("auth parameters", () => {
  it("includes correct auth params in every request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({})),
    );

    await client.ping();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);

    expect(calledUrl.searchParams.get("u")).toBe("testuser");
    expect(calledUrl.searchParams.get("v")).toBe("1.16.1");
    expect(calledUrl.searchParams.get("c")).toBe("poutine");
    expect(calledUrl.searchParams.get("f")).toBe("json");
    expect(calledUrl.searchParams.get("s")).toBe("abcdef123456abcdef123456");

    // Verify the token is md5(password + salt)
    const expectedToken = crypto
      .createHash("md5")
      .update("testpass" + "abcdef123456abcdef123456")
      .digest("hex");
    expect(calledUrl.searchParams.get("t")).toBe(expectedToken);
  });

  it("constructs the correct base URL path", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({})),
    );

    await client.ping();

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.origin).toBe("https://music.example.com");
    expect(calledUrl.pathname).toBe("/rest/ping");
  });

  it("strips trailing slash from base URL", async () => {
    const clientTrailingSlash = new SubsonicClient({
      url: "https://music.example.com/",
      username: "testuser",
      password: "testpass",
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({})),
    );

    await clientTrailingSlash.ping();

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/ping");
  });
});

// ── ping ────────────────────────────────────────────────────────────────────

describe("ping", () => {
  it("returns parsed ping response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          type: "navidrome",
          serverVersion: "0.53.3",
          openSubsonic: true,
        }),
      ),
    );

    const result = await client.ping();

    expect(result).toEqual({
      status: "ok",
      version: "1.16.1",
      type: "navidrome",
      serverVersion: "0.53.3",
      openSubsonic: true,
    });
  });
});

// ── getArtists ──────────────────────────────────────────────────────────────

describe("getArtists", () => {
  it("returns array of artist indexes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          artists: {
            index: [
              {
                name: "R",
                artist: [
                  {
                    id: "ar-1",
                    name: "Radiohead",
                    albumCount: 9,
                    musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
                  },
                ],
              },
              {
                name: "T",
                artist: [
                  { id: "ar-2", name: "Thom Yorke", albumCount: 3 },
                ],
              },
            ],
          },
        }),
      ),
    );

    const result = await client.getArtists();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("R");
    expect(result[0].artist[0].name).toBe("Radiohead");
    expect(result[0].artist[0].musicBrainzId).toBe(
      "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(result[1].artist[0].name).toBe("Thom Yorke");
  });

  it("returns empty array when no artists exist", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artists: {} })),
    );

    const result = await client.getArtists();
    expect(result).toEqual([]);
  });
});

// ── getArtist ───────────────────────────────────────────────────────────────

describe("getArtist", () => {
  it("returns artist with albums", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          artist: {
            id: "ar-1",
            name: "Radiohead",
            musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
            albumCount: 2,
            album: [
              {
                id: "al-1",
                name: "OK Computer",
                year: 1997,
                songCount: 12,
                musicBrainzId: "b1392450-e666-3926-a536-22c65f834433",
              },
              {
                id: "al-2",
                name: "Kid A",
                year: 2000,
                songCount: 10,
              },
            ],
          },
        }),
      ),
    );

    const result = await client.getArtist("ar-1");

    expect(result.name).toBe("Radiohead");
    expect(result.musicBrainzId).toBe(
      "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(result.album).toHaveLength(2);
    expect(result.album![0].name).toBe("OK Computer");
    expect(result.album![0].musicBrainzId).toBe(
      "b1392450-e666-3926-a536-22c65f834433",
    );

    // Verify correct query param
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/getArtist");
    expect(calledUrl.searchParams.get("id")).toBe("ar-1");
  });
});

// ── getAlbumList2 ───────────────────────────────────────────────────────────

describe("getAlbumList2", () => {
  it("returns album list with pagination params", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          albumList2: {
            album: [
              { id: "al-1", name: "OK Computer", year: 1997 },
              { id: "al-2", name: "Kid A", year: 2000 },
            ],
          },
        }),
      ),
    );

    const result = await client.getAlbumList2({
      type: "newest",
      size: 10,
      offset: 20,
    });

    expect(result).toHaveLength(2);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("type")).toBe("newest");
    expect(calledUrl.searchParams.get("size")).toBe("10");
    expect(calledUrl.searchParams.get("offset")).toBe("20");
  });

  it("returns empty array when no albums", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ albumList2: {} })),
    );

    const result = await client.getAlbumList2({ type: "newest" });
    expect(result).toEqual([]);
  });
});

// ── getAlbum ────────────────────────────────────────────────────────────────

describe("getAlbum", () => {
  it("returns album with songs including detailed fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          album: {
            id: "al-1",
            name: "OK Computer",
            artist: "Radiohead",
            artistId: "ar-1",
            year: 1997,
            songCount: 2,
            duration: 600,
            musicBrainzId: "b1392450-e666-3926-a536-22c65f834433",
            song: [
              {
                id: "tr-1",
                title: "Airbag",
                artist: "Radiohead",
                album: "OK Computer",
                track: 1,
                discNumber: 1,
                duration: 284,
                bitRate: 320,
                size: 11380000,
                suffix: "mp3",
                contentType: "audio/mpeg",
                mediaType: "song",
                musicBrainzId: "f1b6e6b8-0c01-4572-a0b8-d7e863aaa123",
                path: "Radiohead/OK Computer/01 - Airbag.mp3",
              },
              {
                id: "tr-2",
                title: "Paranoid Android",
                track: 2,
                discNumber: 1,
                duration: 383,
                bitRate: 974,
                size: 28080000,
                suffix: "flac",
                contentType: "audio/flac",
                mediaType: "song",
              },
            ],
          },
        }),
      ),
    );

    const result = await client.getAlbum("al-1");

    expect(result.name).toBe("OK Computer");
    expect(result.musicBrainzId).toBe(
      "b1392450-e666-3926-a536-22c65f834433",
    );
    expect(result.song).toHaveLength(2);

    const song1 = result.song![0];
    expect(song1.title).toBe("Airbag");
    expect(song1.track).toBe(1);
    expect(song1.discNumber).toBe(1);
    expect(song1.duration).toBe(284);
    expect(song1.bitRate).toBe(320);
    expect(song1.size).toBe(11380000);
    expect(song1.suffix).toBe("mp3");
    expect(song1.mediaType).toBe("song");
    expect(song1.musicBrainzId).toBe(
      "f1b6e6b8-0c01-4572-a0b8-d7e863aaa123",
    );

    const song2 = result.song![1];
    expect(song2.suffix).toBe("flac");
    expect(song2.bitRate).toBe(974);
  });
});

// ── search3 ─────────────────────────────────────────────────────────────────

describe("search3", () => {
  it("returns search results grouped by type", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          searchResult3: {
            artist: [{ id: "ar-1", name: "Radiohead" }],
            album: [{ id: "al-1", name: "OK Computer" }],
            song: [{ id: "tr-1", title: "Creep" }],
          },
        }),
      ),
    );

    const result = await client.search3("radiohead", {
      artistCount: 5,
      albumCount: 10,
      songCount: 20,
    });

    expect(result.artist).toHaveLength(1);
    expect(result.album).toHaveLength(1);
    expect(result.song).toHaveLength(1);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/search3");
    expect(calledUrl.searchParams.get("query")).toBe("radiohead");
    expect(calledUrl.searchParams.get("artistCount")).toBe("5");
    expect(calledUrl.searchParams.get("albumCount")).toBe("10");
    expect(calledUrl.searchParams.get("songCount")).toBe("20");
  });

  it("works without optional params", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          searchResult3: {
            artist: [],
            album: [],
            song: [],
          },
        }),
      ),
    );

    const result = await client.search3("test");

    expect(result.artist).toEqual([]);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has("artistCount")).toBe(false);
  });
});

// ── stream ──────────────────────────────────────────────────────────────────

describe("stream", () => {
  it("returns raw Response without consuming body", async () => {
    const mockResponse = binaryResponse("audio-data", "audio/opus");
    fetchMock.mockResolvedValueOnce(mockResponse);

    const result = await client.stream("tr-1", {
      format: "opus",
      maxBitRate: 128,
    });

    expect(result).toBe(mockResponse);
    // Body should not be consumed
    expect(result.bodyUsed).toBe(false);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/stream");
    expect(calledUrl.searchParams.get("id")).toBe("tr-1");
    expect(calledUrl.searchParams.get("format")).toBe("opus");
    expect(calledUrl.searchParams.get("maxBitRate")).toBe("128");
  });

  it("passes timeOffset when specified", async () => {
    fetchMock.mockResolvedValueOnce(
      binaryResponse("audio-data", "audio/mpeg"),
    );

    await client.stream("tr-1", { timeOffset: 30 });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("timeOffset")).toBe("30");
  });
});

// ── getCoverArt ─────────────────────────────────────────────────────────────

describe("getCoverArt", () => {
  it("returns raw Response for cover art", async () => {
    const mockResponse = binaryResponse("image-data", "image/jpeg");
    fetchMock.mockResolvedValueOnce(mockResponse);

    const result = await client.getCoverArt("al-1", 300);

    expect(result).toBe(mockResponse);
    expect(result.bodyUsed).toBe(false);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/getCoverArt");
    expect(calledUrl.searchParams.get("id")).toBe("al-1");
    expect(calledUrl.searchParams.get("size")).toBe("300");
  });

  it("works without size parameter", async () => {
    fetchMock.mockResolvedValueOnce(
      binaryResponse("image-data", "image/jpeg"),
    );

    await client.getCoverArt("al-1");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.has("size")).toBe(false);
  });
});

// ── getAlbumInfo ────────────────────────────────────────────────────────────

describe("getAlbumInfo", () => {
  it("returns album info with MBIDs and metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse({
          albumInfo: {
            notes: "OK Computer is the third studio album by Radiohead.",
            musicBrainzId: "b1392450-e666-3926-a536-22c65f834433",
            lastFmUrl: "https://www.last.fm/music/Radiohead/OK+Computer",
            smallImageUrl: "https://example.com/small.jpg",
            mediumImageUrl: "https://example.com/medium.jpg",
            largeImageUrl: "https://example.com/large.jpg",
          },
        }),
      ),
    );

    const result = await client.getAlbumInfo("al-1");

    expect(result.notes).toContain("OK Computer");
    expect(result.musicBrainzId).toBe(
      "b1392450-e666-3926-a536-22c65f834433",
    );
    expect(result.lastFmUrl).toBe(
      "https://www.last.fm/music/Radiohead/OK+Computer",
    );
    expect(result.largeImageUrl).toBe("https://example.com/large.jpg");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/getAlbumInfo2");
    expect(calledUrl.searchParams.get("id")).toBe("al-1");
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws on Subsonic error response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse(
          {
            error: { code: 40, message: "Wrong username or password" },
          },
          "failed",
        ),
      ),
    );

    await expect(client.ping()).rejects.toThrow(
      "Subsonic error 40: Wrong username or password",
    );
  });

  it("throws on HTTP error status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(client.ping()).rejects.toThrow("Subsonic HTTP error: 404 Not Found");
  });

  it("throws on missing subsonic-response envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ unexpected: "format" }),
    );

    await expect(client.ping()).rejects.toThrow(
      "Invalid Subsonic response: missing subsonic-response envelope",
    );
  });

  it("throws on HTTP error for raw requests (stream)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(client.stream("tr-1")).rejects.toThrow(
      "Subsonic HTTP error: 500 Internal Server Error",
    );
  });
});
