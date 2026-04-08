import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let accessToken: string;
let instanceId: string;

// TODO Phase 5: this test exercises the legacy /api/instances flow that
// is removed in Phase 5. Skipped pending replacement with a Subsonic-flow
// e2e test.
describe.skip("E2E: Register → Add Instance → Sync → Browse Library", () => {
  beforeAll(async () => {
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "test-secret-for-e2e",
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("registers a user (first user = admin)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "admin", password: "testpassword123" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.user.isAdmin).toBe(true);
    accessToken = body.accessToken;
    expect(accessToken).toBeDefined();
    console.log("Registered admin user:", body.user.id);
  });

  it("adds the real Navidrome instance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: "Navidrome West",
        url: "https://navidrome-west.slackworks.com",
        username: "poutine",
        password: "Kb43H_JB",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    instanceId = body.id;
    console.log("Registered instance:", body.name, "id:", instanceId);
  });

  it("lists the registered instance", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/instances",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const instances = JSON.parse(res.body);
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe("Navidrome West");
  });

  it("syncs the instance library", async () => {
    // Import sync and merge functions directly since the route is a placeholder
    const { syncInstance } = await import("../src/library/sync.js");
    const { mergeLibraries } = await import("../src/library/merge.js");
    const { getInstanceCredentials, getInstance: getInst } = await import(
      "../src/federation/registry.js"
    );
    const { SubsonicClient } = await import("../src/adapters/subsonic.js");

    const instance = getInst(app.db, instanceId)!;
    const creds = getInstanceCredentials(
      app.db,
      instanceId,
      app.config.encryptionKey
    )!;

    const client = new SubsonicClient({
      url: instance.url,
      username: creds.username,
      password: creds.password,
    });

    console.log("Starting sync...");
    const result = await syncInstance(app.db, instance, client, {
      concurrency: 3,
    });
    console.log(
      `Sync complete: ${result.artistCount} artists, ${result.albumCount} albums, ${result.trackCount} tracks, ${result.errors.length} errors`
    );

    expect(result.artistCount).toBeGreaterThan(0);
    expect(result.albumCount).toBeGreaterThan(0);
    expect(result.trackCount).toBeGreaterThan(0);

    // Run the merge
    console.log("Running merge...");
    mergeLibraries(app.db);

    // Verify unified data was created
    const unifiedArtists = app.db
      .prepare("SELECT COUNT(*) as c FROM unified_artists")
      .get() as { c: number };
    const unifiedRGs = app.db
      .prepare("SELECT COUNT(*) as c FROM unified_release_groups")
      .get() as { c: number };
    const unifiedTracks = app.db
      .prepare("SELECT COUNT(*) as c FROM unified_tracks")
      .get() as { c: number };
    const trackSources = app.db
      .prepare("SELECT COUNT(*) as c FROM track_sources")
      .get() as { c: number };

    console.log(
      `Unified library: ${unifiedArtists.c} artists, ${unifiedRGs.c} release groups, ${unifiedTracks.c} tracks, ${trackSources.c} track sources`
    );

    expect(unifiedArtists.c).toBeGreaterThan(0);
    expect(unifiedRGs.c).toBeGreaterThan(0);
    expect(unifiedTracks.c).toBeGreaterThan(0);
    expect(trackSources.c).toBeGreaterThan(0);
  }, 120000); // 2 min timeout for sync

  it("queries unified artists via API", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/artists?limit=5",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const artists = JSON.parse(res.body);
    expect(artists.length).toBeGreaterThan(0);
    console.log(`API returned ${artists.length} artists:`);
    for (const a of artists) {
      console.log(`  ${a.name} (${a.trackCount} tracks, ${a.releaseGroupCount} release groups)`);
    }
  });

  it("queries unified release groups via API", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/release-groups?limit=5",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rgs = JSON.parse(res.body);
    expect(rgs.length).toBeGreaterThan(0);
    console.log(`API returned ${rgs.length} release groups:`);
    for (const rg of rgs) {
      console.log(`  "${rg.name}" by ${rg.artistName} (${rg.year || "?"})`);
    }
  });

  it("gets release group detail with tracks", async () => {
    // Get a release group ID first
    const listRes = await app.inject({
      method: "GET",
      url: "/api/library/release-groups?limit=1",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const rgs = JSON.parse(listRes.body);
    expect(rgs.length).toBeGreaterThan(0);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/library/release-groups/${rgs[0].id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = JSON.parse(detailRes.body);
    expect(detail.releases).toBeDefined();
    expect(detail.releases.length).toBeGreaterThan(0);

    const release = detail.releases[0];
    console.log(
      `Release group "${detail.name}" has ${detail.releases.length} release(s)`
    );
    console.log(
      `  Release "${release.name}": ${release.tracks.length} tracks`
    );
    if (release.tracks.length > 0) {
      const t = release.tracks[0];
      console.log(
        `    Track 1: "${t.title}" (${t.durationMs}ms) - ${t.sources.length} source(s)`
      );
      if (t.sources.length > 0) {
        console.log(
          `      Source: ${t.sources[0].instanceName} [${t.sources[0].format} ${t.sources[0].bitrate}kbps]`
        );
      }
    }
  });

  it("searches the unified library", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/search?q=a",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const results = JSON.parse(res.body);
    console.log(
      `Search "a": ${results.artists.length} artists, ${results.releaseGroups.length} release groups, ${results.tracks.length} tracks`
    );
  });

  it("queries tracks via API", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/library/tracks?limit=5",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const tracks = JSON.parse(res.body);
    expect(tracks.length).toBeGreaterThan(0);
    console.log(`API returned ${tracks.length} tracks:`);
    for (const t of tracks) {
      console.log(
        `  "${t.title}" by ${t.artistName} on "${t.releaseName}" (${t.durationMs}ms)`
      );
    }
  });
});
