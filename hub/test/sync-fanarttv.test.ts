/**
 * Functional tests for fanart.tv integration during library sync (#131).
 *
 *  1. Artists with an MBID get their image from fanart.tv (preferred over Navidrome's).
 *  2. Albums with a release-group MBID and no Navidrome cover get one from fanart.tv.
 *  3. fanart.tv is not consulted for artists without an MBID.
 *  4. fanart.tv failure falls back to Navidrome's image.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { syncLocal } from "../src/library/sync-local.js";
import type { Config } from "../src/config.js";
import { FanartTvClient } from "../src/services/fanarttv.js";
import { seedSyntheticInstances } from "../src/library/seed-instances.js";

function subsonicResponse(payload: Record<string, unknown>) {
  return {
    "subsonic-response": {
      status: "ok",
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

const TEST_BASE_URL = "http://fanarttv.test/v3.2";

function seedAndConfig(db: Database.Database) {
  seedSyntheticInstances(
    db,
    {
      databasePath: ":memory:",
      navidromeUrl: "http://navidrome:4533",
      navidromeUsername: "test",
      navidromePassword: "test",
      poutineInstanceId: "test-instance",
      poutinePeersConfig: "{}",
      instanceConcurrency: 3,
    } as unknown as Config,
    {
      instanceId: "test-instance",
      peers: new Map(),
      reload: () => {},
    } as unknown as Parameters<typeof seedSyntheticInstances>[2],
  );

  return {
    databasePath: ":memory:",
    navidromeUrl: "http://navidrome:4533",
    navidromeUsername: "test",
    navidromePassword: "test",
    poutineInstanceId: "test-instance",
    poutinePeersConfig: "{}",
    instanceConcurrency: 1,
  } as unknown as Config;
}

describe("fanart.tv integration during sync", () => {
  let db: Database.Database;
  let subsonicMock: ReturnType<typeof vi.fn>;
  let fanartMock: ReturnType<typeof vi.fn>;
  let client: FanartTvClient;

  beforeEach(() => {
    db = createDatabase(":memory:");
    client = new FanartTvClient({ projectKey: "PROJ", baseUrl: TEST_BASE_URL });

    subsonicMock = vi.fn();
    fanartMock = vi.fn();

    vi.spyOn(global, "fetch").mockImplementation(async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith(TEST_BASE_URL)) return fanartMock(url);
      return subsonicMock(url);
    });

    vi.spyOn(crypto, "randomBytes").mockReturnValue(
      Buffer.from("abcdef123456abcdef123456", "hex") as unknown as Buffer,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("uses fanart.tv as primary source for artists with an MBID", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [
                {
                  name: "R",
                  artist: [{ id: "ar-1", name: "Radiohead" }],
                },
              ],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Radiohead",
              musicBrainzId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
              coverArt: "navidrome-cover-art-123",
              album: [],
            },
          }),
        ),
      );

    fanartMock.mockResolvedValueOnce(
      jsonResponse({
        artistthumb: [{ id: "1", url: "https://fanart.tv/radiohead-thumb.jpg" }],
        artistbackground: [{ id: "2", url: "https://fanart.tv/radiohead-bg.jpg" }],
      }),
    );

    const config = seedAndConfig(db);
    await syncLocal(db, config, null, client);

    expect(fanartMock).toHaveBeenCalledTimes(1);
    const fanartUrl = new URL(fanartMock.mock.calls[0][0] as string);
    expect(fanartUrl.pathname).toBe(
      "/v3.2/music/a74b1b7f-71a5-4011-9441-d0b5e4122711",
    );
    expect(fanartUrl.searchParams.get("api_key")).toBe("PROJ");

    const row = db
      .prepare(
        "SELECT image_url FROM instance_artists WHERE instance_id = ? AND remote_id = ?",
      )
      .get("local", "ar-1") as { image_url: string };
    expect(row.image_url).toBe("https://fanart.tv/radiohead-thumb.jpg");
  });

  it("falls back to Navidrome cover when fanart.tv has no image for the MBID", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [{ name: "R", artist: [{ id: "ar-1", name: "Radiohead" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Radiohead",
              musicBrainzId: "rg-mbid",
              coverArt: "navidrome-cover-art-123",
              album: [],
            },
          }),
        ),
      );

    fanartMock.mockResolvedValueOnce(new Response("Not found", { status: 404 }));

    const config = seedAndConfig(db);
    await syncLocal(db, config, null, client);

    const row = db
      .prepare(
        "SELECT image_url FROM instance_artists WHERE instance_id = ? AND remote_id = ?",
      )
      .get("local", "ar-1") as { image_url: string };
    expect(row.image_url).toBe("navidrome-cover-art-123");
  });

  it("does NOT call fanart.tv for artists without an MBID", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [{ name: "U", artist: [{ id: "ar-1", name: "Unknown" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Unknown",
              coverArt: "nd-cover",
              album: [],
            },
          }),
        ),
      );

    const config = seedAndConfig(db);
    await syncLocal(db, config, null, client);

    expect(fanartMock).not.toHaveBeenCalled();
    const row = db
      .prepare("SELECT image_url FROM instance_artists WHERE remote_id = ?")
      .get("ar-1") as { image_url: string };
    expect(row.image_url).toBe("nd-cover");
  });

  it("uses fanart.tv album cover when album has release-group MBID and no Navidrome cover", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [{ name: "R", artist: [{ id: "ar-1", name: "Radiohead" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Radiohead",
              album: [{ id: "al-1", name: "OK Computer" }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            album: {
              id: "al-1",
              name: "OK Computer",
              releaseGroupMbid: "rg-okc",
              // No coverArt — triggers fanart.tv lookup.
              song: [],
            },
          }),
        ),
      );

    fanartMock.mockResolvedValueOnce(
      jsonResponse({
        albums: [
          {
            mbid_id: "rg-okc",
            albumcover: [{ id: "9", url: "https://fanart.tv/okc.jpg" }],
          },
        ],
      }),
    );

    const config = seedAndConfig(db);
    await syncLocal(db, config, null, client);

    const fanartCalls = fanartMock.mock.calls.map((c) => c[0] as string);
    const albumCall = fanartCalls.find((u) => u.includes("/albums/rg-okc"));
    expect(albumCall).toBeDefined();

    const row = db
      .prepare(
        "SELECT cover_art_id FROM instance_albums WHERE instance_id = ? AND remote_id = ?",
      )
      .get("local", "al-1") as { cover_art_id: string };
    expect(row.cover_art_id).toBe("https://fanart.tv/okc.jpg");
  });

  it("does NOT call fanart.tv for an album when Navidrome already provides a cover", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [{ name: "R", artist: [{ id: "ar-1", name: "Radiohead" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Radiohead",
              album: [{ id: "al-1", name: "OK Computer" }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            album: {
              id: "al-1",
              name: "OK Computer",
              releaseGroupMbid: "rg-okc",
              coverArt: "nd-cover-okc",
              song: [],
            },
          }),
        ),
      );

    const config = seedAndConfig(db);
    await syncLocal(db, config, null, client);

    const albumCalls = fanartMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes("/albums/"));
    expect(albumCalls).toHaveLength(0);

    const row = db
      .prepare(
        "SELECT cover_art_id FROM instance_albums WHERE remote_id = ?",
      )
      .get("al-1") as { cover_art_id: string };
    expect(row.cover_art_id).toBe("nd-cover-okc");
  });

  it("handles fanart.tv API failure gracefully", async () => {
    subsonicMock
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artists: {
              index: [{ name: "R", artist: [{ id: "ar-1", name: "Radiohead" }] }],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subsonicResponse({
            artist: {
              id: "ar-1",
              name: "Radiohead",
              musicBrainzId: "mbid-x",
              coverArt: "nd-cover",
              album: [],
            },
          }),
        ),
      );

    fanartMock.mockRejectedValueOnce(new Error("network"));

    const config = seedAndConfig(db);
    const result = await syncLocal(db, config, null, client);

    expect(result.errors).toHaveLength(0);
    const row = db
      .prepare("SELECT image_url FROM instance_artists WHERE remote_id = ?")
      .get("ar-1") as { image_url: string };
    expect(row.image_url).toBe("nd-cover");
  });
});
