import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";
import { syncPeer } from "../src/library/sync-peer.js";
import { mergeLibraries } from "../src/library/merge.js";
import type { Config } from "../src/config.js";

function tmpPath(suffix = "") {
  return path.join(
    os.tmpdir(),
    `poutine-sp-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`,
  );
}

function writeYaml(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, "utf8");
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("sync-peer", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let portB: number;
  let keyPathA: string;
  let keyPathB: string;
  let peersYamlA: string;
  let peersYamlB: string;

  beforeEach(async () => {
    keyPathA = tmpPath("key-a.pem");
    keyPathB = tmpPath("key-b.pem");
    peersYamlA = tmpPath("peers-a.yaml");
    peersYamlB = tmpPath("peers-b.yaml");

    const { publicKeyBase64: pubA } = loadOrCreatePrivateKey(keyPathA);
    const { publicKeyBase64: pubB } = loadOrCreatePrivateKey(keyPathB);

    // B trusts A (so A can fetch from B's federation endpoints)
    writeYaml(
      peersYamlB,
      [
        `instance_id: "poutine-b"`,
        `peers:`,
        `  - id: "poutine-a"`,
        `    url: "http://localhost"`,
        `    public_key: "ed25519:${pubA}"`,
      ].join("\n"),
    );

    // Build and start B first (so we get its port)
    const configB: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-b",
      poutinePrivateKeyPath: keyPathB,
      poutinePeersConfig: peersYamlB,
      poutineInstanceId: "poutine-b",
    };
    appB = await buildApp(configB);
    await appB.ready();
    await appB.listen({ port: 0, host: "127.0.0.1" });
    portB = (appB.server.address() as AddressInfo).port;

    // Now write A's peers.yaml with B's real URL
    writeYaml(
      peersYamlA,
      [
        `instance_id: "poutine-a"`,
        `peers:`,
        `  - id: "poutine-b"`,
        `    url: "http://127.0.0.1:${portB}"`,
        `    public_key: "ed25519:${pubB}"`,
      ].join("\n"),
    );

    const configA: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-a",
      poutinePrivateKeyPath: keyPathA,
      poutinePeersConfig: peersYamlA,
      poutineInstanceId: "poutine-a",
    };
    appA = await buildApp(configA);
    await appA.ready();

    // Seed B's instance_* tables with one artist/album/track so the export has data
    const db = appB.db;

    db.prepare(
      `INSERT OR IGNORE INTO instance_artists (id, instance_id, remote_id, name, album_count)
       VALUES ('local:art-1', 'local', 'art-1', 'Test Artist', 1)`,
    ).run();

    db.prepare(
      `INSERT OR IGNORE INTO instance_albums
       (id, instance_id, remote_id, name, artist_id, artist_name, track_count, cover_art_id)
       VALUES ('local:alb-1', 'local', 'alb-1', 'Test Album', 'local:art-1', 'Test Artist', 1, 'cover-001')`,
    ).run();

    db.prepare(
      `INSERT OR IGNORE INTO instance_tracks
       (id, instance_id, remote_id, album_id, title, artist_name, track_number, duration_ms, format, bitrate)
       VALUES ('local:trk-1', 'local', 'trk-1', 'local:alb-1', 'Test Track', 'Test Artist', 1, 240000, 'flac', 1000)`,
    ).run();

    // Run merge on B so unified tables are populated
    mergeLibraries(db);
  });

  afterEach(async () => {
    await appA.close();
    await appB.close();
    for (const f of [keyPathA, keyPathB, peersYamlA, peersYamlB]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("fetches B's export and populates A's instance_* tables with peer rows", async () => {
    const peerB = appA.peerRegistry.peers.get("poutine-b");
    expect(peerB).toBeDefined();

    const result = await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");

    expect(result.errors).toHaveLength(0);
    expect(result.artistCount).toBeGreaterThan(0);
    expect(result.albumCount).toBeGreaterThan(0);
    expect(result.trackCount).toBeGreaterThan(0);

    // Check A's DB has peer instance rows
    const artists = appA.db
      .prepare(
        "SELECT * FROM instance_artists WHERE instance_id = 'poutine-b'",
      )
      .all();
    expect(artists.length).toBeGreaterThan(0);

    const albums = appA.db
      .prepare(
        "SELECT * FROM instance_albums WHERE instance_id = 'poutine-b'",
      )
      .all();
    expect(albums.length).toBeGreaterThan(0);

    const tracks = appA.db
      .prepare(
        "SELECT * FROM instance_tracks WHERE instance_id = 'poutine-b'",
      )
      .all();
    expect(tracks.length).toBeGreaterThan(0);
  });

  it("after mergeLibraries, track_sources has source_kind=peer and peer_id=poutine-b", async () => {
    const peerB = appA.peerRegistry.peers.get("poutine-b");
    await syncPeer(appA.db, peerB!, appA.federatedFetch, "alice");

    mergeLibraries(appA.db);

    const peerSources = appA.db
      .prepare(
        `SELECT * FROM track_sources WHERE source_kind = 'peer' AND peer_id = 'poutine-b'`,
      )
      .all() as Array<{ source_kind: string; peer_id: string }>;

    expect(peerSources.length).toBeGreaterThan(0);
    expect(peerSources[0].source_kind).toBe("peer");
    expect(peerSources[0].peer_id).toBe("poutine-b");
  });
});
