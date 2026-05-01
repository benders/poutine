/**
 * Unit tests for FanartTvClient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FanartTvClient } from "../src/services/fanarttv.js";

describe("FanartTvClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses default base URL and bundles project key in query string", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ artistthumb: [] }), { status: 200 }),
    );

    const client = new FanartTvClient({ projectKey: "PROJ" });
    await client.getArtist("mbid-1");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      "https://webservice.fanart.tv/v3.2/music/mbid-1",
    );
    expect(url.searchParams.get("api_key")).toBe("PROJ");
    expect(url.searchParams.has("client_key")).toBe(false);
  });

  it("respects baseUrl override and adds personal client_key when present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const client = new FanartTvClient({
      projectKey: "PROJ",
      personalKey: "PERSONAL",
      baseUrl: "http://localhost:1234/v3.2/",
    });
    await client.getArtist("mbid-1");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin).toBe("http://localhost:1234");
    expect(url.pathname).toBe("/v3.2/music/mbid-1");
    expect(url.searchParams.get("api_key")).toBe("PROJ");
    expect(url.searchParams.get("client_key")).toBe("PERSONAL");
  });

  it("returns null on 404 (no artwork on file)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    const client = new FanartTvClient({ projectKey: "PROJ" });
    expect(await client.getArtist("missing")).toBeNull();
  });

  it("returns null on non-OK responses without throwing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const client = new FanartTvClient({ projectKey: "PROJ" });
    expect(await client.getArtist("mbid-1")).toBeNull();
  });

  it("returns null on network error without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("DNS"));
    const client = new FanartTvClient({ projectKey: "PROJ" });
    expect(await client.getArtist("mbid-1")).toBeNull();
  });

  it("bestArtistImage prefers thumb, then background", () => {
    expect(
      FanartTvClient.bestArtistImage({
        artistthumb: [{ id: "1", url: "thumb.jpg" }],
        artistbackground: [{ id: "2", url: "bg.jpg" }],
      }),
    ).toBe("thumb.jpg");

    expect(
      FanartTvClient.bestArtistImage({
        artistbackground: [{ id: "2", url: "bg.jpg" }],
      }),
    ).toBe("bg.jpg");

    expect(FanartTvClient.bestArtistImage({})).toBeNull();
    expect(FanartTvClient.bestArtistImage(null)).toBeNull();
  });

  it("bestArtistImage prefers higher-liked entries", () => {
    expect(
      FanartTvClient.bestArtistImage({
        artistthumb: [
          { id: "1", url: "low.jpg", likes: "1" },
          { id: "2", url: "high.jpg", likes: "9" },
        ],
      }),
    ).toBe("high.jpg");
  });

  it("bestAlbumCover looks up the album by release-group MBID", () => {
    const resp = {
      albums: {
        "rg-1": { albumcover: [{ id: "100", url: "cover.jpg" }] },
      },
    };
    expect(FanartTvClient.bestAlbumCover(resp, "rg-1")).toBe("cover.jpg");
    expect(FanartTvClient.bestAlbumCover(resp, "rg-other")).toBeNull();
    expect(FanartTvClient.bestAlbumCover(null, "rg-1")).toBeNull();
  });

  it("getAlbum hits the /music/albums/{mbid} path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const client = new FanartTvClient({ projectKey: "PROJ" });
    await client.getAlbum("rg-mbid-1");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v3.2/music/albums/rg-mbid-1");
  });

  it("isEnabled requires a non-empty project key", () => {
    expect(new FanartTvClient({ projectKey: "" }).isEnabled()).toBe(false);
    expect(new FanartTvClient({ projectKey: "x" }).isEnabled()).toBe(true);
  });
});
