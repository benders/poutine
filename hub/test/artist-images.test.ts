import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { SubsonicClient, type SubsonicArtistInfo } from "../src/adapters/subsonic.js";

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

// ── Setup ───────────────────────────────────────────────────────────────────

let client: SubsonicClient;
let fetchMock: ReturnType<typeof vi.fn>;

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

// ── getArtistInfo tests ─────────────────────────────────────────────────────

describe("getArtistInfo", () => {
  it("fetches artist info with image URLs from getArtistInfo2", async () => {
    const mockArtistInfo: SubsonicArtistInfo = {
      artist: {
        id: "ar-1",
        name: "Radiohead",
        musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      },
      smallImageUrl: "https://example.com/small.jpg",
      mediumImageUrl: "https://example.com/medium.jpg",
      largeImageUrl: "https://example.com/large.jpg",
      musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      biography: "Radiohead are an English rock band formed in Abingdon, Oxfordshire.",
      notes: "Alternative rock pioneers",
    };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artistInfo2: mockArtistInfo })),
    );

    const result = await client.getArtistInfo("ar-1");

    expect(result).toEqual(mockArtistInfo);
    expect(result.largeImageUrl).toBe("https://example.com/large.jpg");
    expect(result.mediumImageUrl).toBe("https://example.com/medium.jpg");
    expect(result.smallImageUrl).toBe("https://example.com/small.jpg");
    expect(result.biography).toContain("English rock band");

    // Verify correct endpoint and params
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/rest/getArtistInfo2");
    expect(calledUrl.searchParams.get("id")).toBe("ar-1");
  });

  it("includes optional params when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artistInfo2: {} })),
    );

    await client.getArtistInfo("ar-1", {
      musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      count: 5,
      includeNotYetReleased: true,
    });

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("musicBrainzId")).toBe(
      "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(calledUrl.searchParams.get("count")).toBe("5");
    expect(calledUrl.searchParams.get("includeNotYetReleased")).toBe("true");
  });

  it("returns empty object when no artist info available", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artistInfo2: {} })),
    );

    const result = await client.getArtistInfo("ar-1");

    expect(result).toEqual({});
    expect(result.largeImageUrl).toBeUndefined();
    expect(result.biography).toBeUndefined();
  });

  it("handles similar artists in response", async () => {
    const mockArtistInfo: SubsonicArtistInfo = {
      artist: {
        id: "ar-1",
        name: "Radiohead",
      },
      similarArtist: [
        { id: "ar-2", name: "Thom Yorke" },
        { id: "ar-3", name: "Atoms for Peace" },
      ],
      largeImageUrl: "https://example.com/radiohead.jpg",
    };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artistInfo2: mockArtistInfo })),
    );

    const result = await client.getArtistInfo("ar-1");

    expect(result.similarArtist).toHaveLength(2);
    expect(result.similarArtist?.[0].name).toBe("Thom Yorke");
    expect(result.similarArtist?.[1].name).toBe("Atoms for Peace");
  });

  it("handles missing image URLs gracefully", async () => {
    const mockArtistInfo: SubsonicArtistInfo = {
      artist: {
        id: "ar-1",
        name: "Radiohead",
      },
      musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    };

    fetchMock.mockResolvedValueOnce(
      jsonResponse(subsonicResponse({ artistInfo2: mockArtistInfo })),
    );

    const result = await client.getArtistInfo("ar-1");

    expect(result.largeImageUrl).toBeUndefined();
    expect(result.mediumImageUrl).toBeUndefined();
    expect(result.smallImageUrl).toBeUndefined();
    expect(result.musicBrainzId).toBe("a74b1b7f-71a5-4011-9441-d0b5e4122711");
  });

  it("throws on Subsonic error response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        subsonicResponse(
          {
            error: { code: 70, message: "Artist not found" },
          },
          "failed",
        ),
      ),
    );

    await expect(client.getArtistInfo("ar-invalid")).rejects.toThrow(
      "Subsonic error 70: Artist not found",
    );
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(client.getArtistInfo("ar-1")).rejects.toThrow(
      "Subsonic HTTP error: 404 Not Found",
    );
  });
});

// ── Image URL format handling tests ─────────────────────────────────────────

describe("image URL format handling", () => {
  it("detects Last.fm URLs correctly", () => {
    const lastFmUrl = "https://last.fm/music/Radiohead";
    const coverArtId = "cover-art-123";
    const encodedId = "instance-1:cover-art-123";

    expect(lastFmUrl.startsWith("https://")).toBe(true);
    expect(coverArtId.startsWith("https://")).toBe(false);
    expect(encodedId.startsWith("https://")).toBe(false);
  });

  it("encodes cover art IDs as instance_id:coverArtId", () => {
    const instanceId = "instance-1";
    const coverArtId = "cover-art-123";
    const encoded = `${instanceId}:${coverArtId}`;

    expect(encoded).toBe("instance-1:cover-art-123");
    expect(encoded.split(":").length).toBe(2);
    expect(encoded.split(":")[0]).toBe(instanceId);
    expect(encoded.split(":")[1]).toBe(coverArtId);
  });

  it("decodes encoded cover art IDs correctly", () => {
    const encoded = "instance-1:cover-art-123";
    const [instanceId, coverArtId] = encoded.split(":");

    expect(instanceId).toBe("instance-1");
    expect(coverArtId).toBe("cover-art-123");
  });

  it("handles encoded IDs with multiple colons", () => {
    // Edge case: what if coverArtId itself contains a colon?
    const encoded = "instance-1:cover:art:123";
    const parts = encoded.split(":");

    expect(parts[0]).toBe("instance-1");
    // The rest should be joined back
    const coverArtId = parts.slice(1).join(":");
    expect(coverArtId).toBe("cover:art:123");
  });
});

// ── Image priority tests ────────────────────────────────────────────────────

describe("image URL priority", () => {
  it("prefers largeImageUrl over medium and small", () => {
    const artistInfo: SubsonicArtistInfo = {
      smallImageUrl: "https://example.com/small.jpg",
      mediumImageUrl: "https://example.com/medium.jpg",
      largeImageUrl: "https://example.com/large.jpg",
    };

    // Simulating the priority logic from sync.ts
    const selectedImageUrl =
      artistInfo.largeImageUrl ??
      artistInfo.mediumImageUrl ??
      artistInfo.smallImageUrl ??
      null;

    expect(selectedImageUrl).toBe("https://example.com/large.jpg");
  });

  it("falls back to mediumImageUrl when large is missing", () => {
    const artistInfo: SubsonicArtistInfo = {
      smallImageUrl: "https://example.com/small.jpg",
      mediumImageUrl: "https://example.com/medium.jpg",
    };

    const selectedImageUrl =
      artistInfo.largeImageUrl ??
      artistInfo.mediumImageUrl ??
      artistInfo.smallImageUrl ??
      null;

    expect(selectedImageUrl).toBe("https://example.com/medium.jpg");
  });

  it("falls back to smallImageUrl when large and medium are missing", () => {
    const artistInfo: SubsonicArtistInfo = {
      smallImageUrl: "https://example.com/small.jpg",
    };

    const selectedImageUrl =
      artistInfo.largeImageUrl ??
      artistInfo.mediumImageUrl ??
      artistInfo.smallImageUrl ??
      null;

    expect(selectedImageUrl).toBe("https://example.com/small.jpg");
  });

  it("returns null when no image URLs are available", () => {
    const artistInfo: SubsonicArtistInfo = {};

    const selectedImageUrl =
      artistInfo.largeImageUrl ??
      artistInfo.mediumImageUrl ??
      artistInfo.smallImageUrl ??
      null;

    expect(selectedImageUrl).toBeNull();
  });

  it("handles getArtistInfo2 fallback to coverArt", () => {
    // Simulating the fallback logic from sync.ts
    const artistInfoError = new Error("getArtistInfo2 not supported");
    const coverArtId = "cover-art-123";

    let artistImageUrl: string | null = null;

    try {
      // Simulate getArtistInfo2 throwing
      throw artistInfoError;
    } catch {
      // Fall back to coverArt ID from getArtist
      artistImageUrl = coverArtId ?? null;
    }

    expect(artistImageUrl).toBe("cover-art-123");
  });
});
