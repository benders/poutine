/**
 * sync-lastfm.test.ts
 * 
 * Functional tests for Last.fm integration during library sync.
 * These tests verify that:
 * 1. Last.fm is called when an artist has no cover art from Navidrome
 * 2. Artist images are correctly stored after Last.fm fetch
 * 3. Last.fm is NOT called when Navidrome already provides an image
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { syncInstance, type Instance } from "../src/library/sync.js";
import { SubsonicClient } from "../src/adapters/subsonic.js";
import { LastFmClient } from "../src/services/lastfm.js";
import { seedSyntheticInstances } from "../src/library/seed-instances.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Test Setup ──────────────────────────────────────────────────────────────

describe("Last.fm integration during sync", () => {
  let db: Database.Database;
  let fetchMock: ReturnType<typeof vi.fn>;
  let lastFmFetchMock: ReturnType<typeof vi.fn>;
  let lastFmClient: LastFmClient;

  beforeEach(() => {
    // Create in-memory database
    db = createDatabase(":memory:");

    // Create Last.fm client with test API key
    lastFmClient = new LastFmClient("test-lastfm-api-key");

    // Mock global fetch for both Subsonic and Last.fm API calls
    vi.spyOn(global, "fetch").mockImplementation(async (input: any) => {
      const urlString = typeof input === "string" ? input : input.url;
      
      // Return different mocks based on the URL
      if (urlString?.includes("ws.audioscrobbler.com")) {
        // Last.fm API call - use lastFmFetchMock
        return lastFmFetchMock(input);
      }
      // Subsonic API call - use fetchMock
      return fetchMock(input);
    });

    // Initialize mocks
    fetchMock = vi.fn();
    lastFmFetchMock = vi.fn();

    // Make salt deterministic for auth tests
    vi.spyOn(crypto, "randomBytes").mockReturnValue(
      Buffer.from("abcdef123456abcdef123456", "hex") as unknown as Buffer,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // ── Tests ─────────────────────────────────────────────────────────────────

  it("calls Last.fm when artist has no cover art from Navidrome", async () => {
    // Setup: Navidrome returns artist without coverArt
    const mockArtistsResponse = subsonicResponse({
      artists: {
        index: [
          {
            name: "R",
            artist: [
              { id: "ar-1", name: "Radiohead", artistCount: 10 },
            ],
          },
        ],
      },
    });

    const mockArtistDetail = subsonicResponse({
      artist: {
        id: "ar-1",
        name: "Radiohead",
        musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        albumCount: 10,
        // NO coverArt - this triggers Last.fm lookup
        album: [
          { id: "al-1", name: "OK Computer", artist: "Radiohead", songCount: 12 },
        ],
      },
    });

    const mockAlbumDetail = subsonicResponse({
      album: {
        id: "al-1",
        name: "OK Computer",
        artist: "Radiohead",
        song: [
          { id: "tr-1", title: "Paranoid Android", duration: 383 },
        ],
      },
    });

    // Mock Last.fm response with artist image
    const lastFmResponse = {
      artist: {
        name: "Radiohead",
        url: "https://last.fm/music/Radiohead",
        mbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        image: [
          { "#text": "https://last.fm/images/radiohead-small.jpg", size: "small" },
          { "#text": "https://last.fm/images/radiohead-medium.jpg", size: "medium" },
          { "#text": "https://last.fm/images/radiohead-large.jpg", size: "large" },
          { "#text": "https://last.fm/images/radiohead-extralarge.jpg", size: "extralarge" },
        ],
        stats: {
          listeners: "1234567",
          playcount: "98765432",
        },
      },
    };

    // Setup fetch mocks
    fetchMock
      .mockResolvedValueOnce(jsonResponse(mockArtistsResponse)) // getArtists
      .mockResolvedValueOnce(jsonResponse(mockArtistDetail))     // getArtist
      .mockResolvedValueOnce(jsonResponse(mockAlbumDetail));     // getAlbum

    lastFmFetchMock.mockResolvedValueOnce(jsonResponse(lastFmResponse));

    // Create synthetic instance row
    seedSyntheticInstances(db, {
      databasePath: ":memory:",
      navidromeUrl: "http://navidrome:4533",
      navidromeUsername: "test",
      navidromePassword: "test",
      poutineInstanceId: "test-instance",
      poutinePeersConfig: "{}",
      instanceConcurrency: 3,
    } as any, {
      instanceId: "test-instance",
      peers: new Map(),
      reload: () => {},
    } as any);

    // Create Subsonic client and instance
    const client = new SubsonicClient({
      url: "http://navidrome:4533",
      username: "test",
      password: "test",
    });

    const instance: Instance = {
      id: "local",
      name: "Local Navidrome",
      url: "http://navidrome:4533",
      adapterType: "subsonic",
      ownerId: "owner-1",
      status: "online",
      lastSeen: null,
      lastSyncedAt: null,
      trackCount: 0,
      serverVersion: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Run sync with Last.fm enabled
    const result = await syncInstance(db, instance, client, {
      concurrency: 1,
      lastFmClient,
    });

    // Assertions
    expect(result.artistCount).toBe(1);
    expect(result.albumCount).toBe(1);
    expect(result.trackCount).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify Last.fm was called
    expect(lastFmFetchMock).toHaveBeenCalledTimes(1);
    const lastFmCall = lastFmFetchMock.mock.calls[0][0] as string;
    expect(lastFmCall).toContain("ws.audioscrobbler.com");
    expect(lastFmCall).toContain("method=artist.getinfo");
    // When MusicBrainz ID is available, it's used for more accurate lookup
    expect(lastFmCall).toContain("mbid=a74b1b7f-71a5-4011-9441-d0b5e4122711");

    // Verify artist image was stored in database
    const artistRow = db.prepare(
      "SELECT id, name, image_url FROM instance_artists WHERE instance_id = ? AND remote_id = ?"
    ).get("local", "ar-1") as { id: string; name: string; image_url: string };

    expect(artistRow).toBeDefined();
    expect(artistRow.name).toBe("Radiohead");
    expect(artistRow.image_url).toBe("https://last.fm/images/radiohead-extralarge.jpg");
  });

  it("does NOT call Last.fm when Navidrome provides cover art", async () => {
    // Setup: Navidrome returns artist WITH coverArt
    const mockArtistsResponse = subsonicResponse({
      artists: {
        index: [
          {
            name: "R",
            artist: [
              { id: "ar-1", name: "Radiohead", artistCount: 10 },
            ],
          },
        ],
      },
    });

    const mockArtistDetail = subsonicResponse({
      artist: {
        id: "ar-1",
        name: "Radiohead",
        musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        albumCount: 10,
        coverArt: "navidrome-cover-art-123", // HAS coverArt - no Last.fm needed
        album: [
          { id: "al-1", name: "OK Computer", artist: "Radiohead", songCount: 12 },
        ],
      },
    });

    const mockAlbumDetail = subsonicResponse({
      album: {
        id: "al-1",
        name: "OK Computer",
        artist: "Radiohead",
        song: [
          { id: "tr-1", title: "Paranoid Android", duration: 383 },
        ],
      },
    });

    // Setup fetch mocks
    fetchMock
      .mockResolvedValueOnce(jsonResponse(mockArtistsResponse)) // getArtists
      .mockResolvedValueOnce(jsonResponse(mockArtistDetail))     // getArtist
      .mockResolvedValueOnce(jsonResponse(mockAlbumDetail));     // getAlbum

    // Create synthetic instance row
    seedSyntheticInstances(db, {
      databasePath: ":memory:",
      navidromeUrl: "http://navidrome:4533",
      navidromeUsername: "test",
      navidromePassword: "test",
      poutineInstanceId: "test-instance",
      poutinePeersConfig: "{}",
      instanceConcurrency: 3,
    } as any, {
      instanceId: "test-instance",
      peers: new Map(),
      reload: () => {},
    } as any);

    // Create Subsonic client and instance
    const client = new SubsonicClient({
      url: "http://navidrome:4533",
      username: "test",
      password: "test",
    });

    const instance: Instance = {
      id: "local",
      name: "Local Navidrome",
      url: "http://navidrome:4533",
      adapterType: "subsonic",
      ownerId: "owner-1",
      status: "online",
      lastSeen: null,
      lastSyncedAt: null,
      trackCount: 0,
      serverVersion: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Run sync with Last.fm enabled
    const result = await syncInstance(db, instance, client, {
      concurrency: 1,
      lastFmClient,
    });

    // Assertions
    expect(result.artistCount).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify Last.fm was NOT called (Navidrome already provided cover art)
    expect(lastFmFetchMock).not.toHaveBeenCalled();

    // Verify artist image was stored as encoded cover art ID
    const artistRow = db.prepare(
      "SELECT id, name, image_url FROM instance_artists WHERE instance_id = ? AND remote_id = ?"
    ).get("local", "ar-1") as { id: string; name: string; image_url: string };

    expect(artistRow).toBeDefined();
    expect(artistRow.image_url).toBe("navidrome-cover-art-123");
  });

  it("handles Last.fm API failure gracefully and continues sync", async () => {
    // Setup: Navidrome returns artist without coverArt
    const mockArtistsResponse = subsonicResponse({
      artists: {
        index: [
          {
            name: "U",
            artist: [
              { id: "ar-1", name: "Unknown Band", artistCount: 5 },
            ],
          },
        ],
      },
    });

    const mockArtistDetail = subsonicResponse({
      artist: {
        id: "ar-1",
        name: "Unknown Band",
        musicBrainzId: "unknown-mbid",
        albumCount: 5,
        // NO coverArt
        album: [
          { id: "al-1", name: "Debut Album", artist: "Unknown Band", songCount: 10 },
        ],
      },
    });

    const mockAlbumDetail = subsonicResponse({
      album: {
        id: "al-1",
        name: "Debut Album",
        artist: "Unknown Band",
        song: [
          { id: "tr-1", title: "Song One", duration: 240 },
        ],
      },
    });

    // Mock Last.fm API failure
    lastFmFetchMock.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    // Setup fetch mocks
    fetchMock
      .mockResolvedValueOnce(jsonResponse(mockArtistsResponse)) // getArtists
      .mockResolvedValueOnce(jsonResponse(mockArtistDetail))     // getArtist
      .mockResolvedValueOnce(jsonResponse(mockAlbumDetail));     // getAlbum

    // Create synthetic instance row
    seedSyntheticInstances(db, {
      databasePath: ":memory:",
      navidromeUrl: "http://navidrome:4533",
      navidromeUsername: "test",
      navidromePassword: "test",
      poutineInstanceId: "test-instance",
      poutinePeersConfig: "{}",
      instanceConcurrency: 3,
    } as any, {
      instanceId: "test-instance",
      peers: new Map(),
      reload: () => {},
    } as any);

    // Create Subsonic client and instance
    const client = new SubsonicClient({
      url: "http://navidrome:4533",
      username: "test",
      password: "test",
    });

    const instance: Instance = {
      id: "local",
      name: "Local Navidrome",
      url: "http://navidrome:4533",
      adapterType: "subsonic",
      ownerId: "owner-1",
      status: "online",
      lastSeen: null,
      lastSyncedAt: null,
      trackCount: 0,
      serverVersion: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Run sync with Last.fm enabled
    const result = await syncInstance(db, instance, client, {
      concurrency: 1,
      lastFmClient,
    });

    // Assertions - sync should complete successfully despite Last.fm failure
    expect(result.artistCount).toBe(1);
    expect(result.albumCount).toBe(1);
    expect(result.trackCount).toBe(1);
    expect(result.errors).toHaveLength(0); // No errors - Last.fm failure is handled gracefully

    // Verify Last.fm was called but failed
    expect(lastFmFetchMock).toHaveBeenCalledTimes(1);

    // Verify artist was stored WITHOUT image (Last.fm failed)
    const artistRow = db.prepare(
      "SELECT id, name, image_url FROM instance_artists WHERE instance_id = ? AND remote_id = ?"
    ).get("local", "ar-1") as { id: string; name: string; image_url: string };

    expect(artistRow).toBeDefined();
    expect(artistRow.name).toBe("Unknown Band");
    expect(artistRow.image_url).toBeNull(); // No image because Last.fm failed
  });

  it("uses MusicBrainz ID when available for Last.fm lookup", async () => {
    // Setup: Navidrome returns artist with MusicBrainz ID but no coverArt
    const mockArtistsResponse = subsonicResponse({
      artists: {
        index: [
          {
            name: "R",
            artist: [
              { id: "ar-1", name: "Radiohead", artistCount: 10 },
            ],
          },
        ],
      },
    });

    const mockArtistDetail = subsonicResponse({
      artist: {
        id: "ar-1",
        name: "Radiohead",
        musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        albumCount: 10,
        // NO coverArt
        album: [],
      },
    });

    // Mock Last.fm response
    const lastFmResponse = {
      artist: {
        name: "Radiohead",
        url: "https://last.fm/music/Radiohead",
        mbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        image: [
          { "#text": "https://last.fm/images/radiohead-large.jpg", size: "large" },
        ],
      },
    };

    // Setup fetch mocks
    fetchMock
      .mockResolvedValueOnce(jsonResponse(mockArtistsResponse)) // getArtists
      .mockResolvedValueOnce(jsonResponse(mockArtistDetail));    // getArtist

    lastFmFetchMock.mockResolvedValueOnce(jsonResponse(lastFmResponse));

    // Create synthetic instance row
    seedSyntheticInstances(db, {
      databasePath: ":memory:",
      navidromeUrl: "http://navidrome:4533",
      navidromeUsername: "test",
      navidromePassword: "test",
      poutineInstanceId: "test-instance",
      poutinePeersConfig: "{}",
      instanceConcurrency: 3,
    } as any, {
      instanceId: "test-instance",
      peers: new Map(),
      reload: () => {},
    } as any);

    // Create Subsonic client and instance
    const client = new SubsonicClient({
      url: "http://navidrome:4533",
      username: "test",
      password: "test",
    });

    const instance: Instance = {
      id: "local",
      name: "Local Navidrome",
      url: "http://navidrome:4533",
      adapterType: "subsonic",
      ownerId: "owner-1",
      status: "online",
      lastSeen: null,
      lastSyncedAt: null,
      trackCount: 0,
      serverVersion: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Run sync with Last.fm enabled
    await syncInstance(db, instance, client, {
      concurrency: 1,
      lastFmClient,
    });

    // Verify Last.fm was called with MusicBrainz ID
    expect(lastFmFetchMock).toHaveBeenCalledTimes(1);
    const lastFmCall = lastFmFetchMock.mock.calls[0][0] as string;
    expect(lastFmCall).toContain("mbid=a74b1b7f-71a5-4011-9441-d0b5e4122711");
    expect(lastFmCall).not.toContain("artist=Radiohead"); // Should use mbid, not artist name
  });
});
