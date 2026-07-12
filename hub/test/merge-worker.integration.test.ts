import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { runMergePipelineAsync } from "../src/library/merge-pipeline.js";

/**
 * #242 Phase 3: proves the merge pipeline runs on a worker's own connection
 * against a file-backed DB, so the main thread's event loop keeps serving
 * reads (and stays responsive) for the whole duration of a merge large
 * enough to take real wall-clock time.
 */
describe("merge-worker integration", () => {
  let dir: string;
  let db: Database.Database | null = null;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    db = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const TRACK_COUNT = 15000;

  function seedFixture(database: Database.Database, ownerId: string) {
    const inst1 = "instance-1";
    database.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(inst1, "Instance 1", "https://music1.example.com", "subsonic", "encrypted", ownerId, "online");

    const insertArtist = database.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    );
    const insertAlbum = database.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTrack = database.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const seed = database.transaction(() => {
      const artistCount = 200;
      const albumsPerArtist = 10;
      let trackTotal = 0;
      for (let a = 0; a < artistCount; a++) {
        const artistId = `${inst1}:artist-${a}`;
        insertArtist.run(artistId, inst1, `artist-${a}`, `Artist ${a}`, albumsPerArtist);
        for (let al = 0; al < albumsPerArtist; al++) {
          const albumId = `${inst1}:album-${a}-${al}`;
          const tracksPerAlbum = Math.min(
            Math.ceil((TRACK_COUNT - trackTotal) / ((artistCount - a) * albumsPerArtist - al)),
            15,
          );
          insertAlbum.run(albumId, inst1, `album-${a}-${al}`, `Album ${a}-${al}`, artistId, `Artist ${a}`, tracksPerAlbum);
          for (let t = 0; t < tracksPerAlbum && trackTotal < TRACK_COUNT; t++) {
            insertTrack.run(
              `${inst1}:track-${a}-${al}-${t}`,
              inst1,
              `track-${a}-${al}-${t}`,
              albumId,
              `Track ${a}-${al}-${t}`,
              `Artist ${a}`,
              t + 1,
              1,
              200000,
              "flac",
            );
            trackTotal++;
          }
        }
      }
    });
    seed();
  }

  it("keeps the main connection responsive while a large merge runs on the worker", async () => {
    dir = mkdtempSync(join(tmpdir(), "poutine-merge-worker-"));
    const dbPath = join(dir, "hub.db");
    db = createDatabase(dbPath);

    const ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);
    seedFixture(db, ownerId);

    expect(db.name).not.toBe(":memory:");
    expect(db.name).not.toBe("");

    let readCompletedAt: number | null = null;
    let mergeResolvedAt: number | null = null;
    let maxTickLatencyMs = 0;

    const mergePromise = runMergePipelineAsync(db, {
      logger: { warn: () => {}, info: () => {} },
    }).then((report) => {
      mergeResolvedAt = Date.now();
      return report;
    });

    // While the merge is in flight, hammer the main connection with reads
    // and measure event-loop tick latency. If the pipeline were still
    // running synchronously on the main thread, neither the read nor the
    // timers below would get a chance to run until the merge finished.
    const probeUntil = Date.now() + 5000;
    while (readCompletedAt === null && Date.now() < probeUntil) {
      const tickStart = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      const tickLatency = Date.now() - tickStart;
      if (tickLatency > maxTickLatencyMs) maxTickLatencyMs = tickLatency;

      const row = db.prepare("SELECT COUNT(*) AS n FROM instance_tracks").get() as { n: number };
      expect(row.n).toBe(TRACK_COUNT);
      readCompletedAt = Date.now();
    }

    expect(readCompletedAt).not.toBeNull();
    // A read completed well before the merge resolved, proving the main
    // connection wasn't blocked for the merge's duration.
    expect(mergeResolvedAt).toBeNull();
    expect(maxTickLatencyMs).toBeLessThan(100);

    const report = await mergePromise;
    expect(report.orphans.total).toBe(0);

    const unifiedCount = (
      db.prepare("SELECT COUNT(*) AS n FROM unified_tracks").get() as { n: number }
    ).n;
    expect(unifiedCount).toBe(TRACK_COUNT);
  }, 30000);
});
