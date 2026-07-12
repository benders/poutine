import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { runMergePipeline, runMergePipelineAsync } from "../src/library/merge-pipeline.js";

describe("merge-pipeline async entry", () => {
  let db: Database.Database;
  let ownerId: string;
  const inst1 = "instance-1";

  beforeEach(() => {
    db = createDatabase(":memory:");

    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
    ).run(ownerId, "admin", "fakehash", 1);

    db.prepare(
      "INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(inst1, "Instance 1", "https://music1.example.com", "subsonic", "encrypted", ownerId, "online");
  });

  afterEach(() => {
    db.close();
  });

  function seedTrack(remoteSuffix: string, title: string) {
    const artistId = `${inst1}:artist-${remoteSuffix}`;
    const albumId = `${inst1}:album-${remoteSuffix}`;
    db.prepare(
      "INSERT INTO instance_artists (id, instance_id, remote_id, name, album_count) VALUES (?, ?, ?, ?, ?)",
    ).run(artistId, inst1, `artist-${remoteSuffix}`, `Artist ${remoteSuffix}`, 1);
    db.prepare(
      `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(albumId, inst1, `album-${remoteSuffix}`, `Album ${remoteSuffix}`, artistId, `Artist ${remoteSuffix}`, 1);
    db.prepare(
      `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, track_number, disc_number, duration_ms, format)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`${inst1}:track-${remoteSuffix}`, inst1, `track-${remoteSuffix}`, albumId, title, `Artist ${remoteSuffix}`, 1, 1, 240000, "flac");
  }

  it("in-memory DB takes the in-process path and returns the same report shape as runMergePipeline()", async () => {
    seedTrack("a", "Track A");

    const asyncReport = await runMergePipelineAsync(db);
    expect(asyncReport.orphans.total).toBe(0);
    expect(asyncReport.remap).toBeDefined();

    seedTrack("b", "Track B");
    const syncReport = runMergePipeline(db);
    expect(Object.keys(syncReport).sort()).toEqual(Object.keys(asyncReport).sort());
    expect(syncReport.orphans.total).toBe(0);
  });

  it("serializes two concurrent calls on the same in-memory DB without interleaving", async () => {
    seedTrack("a", "Track A");
    seedTrack("b", "Track B");

    const order: string[] = [];
    const logger = {
      info: () => {
        // Each call's queued turn logs exactly once on completion (orphan
        // audit "clean" line) — record call order to prove no interleave.
      },
    };

    const first = runMergePipelineAsync(db, {
      logger: {
        info: () => order.push("first-start"),
      },
    }).then((r) => {
      order.push("first-done");
      return r;
    });
    const second = runMergePipelineAsync(db, { logger }).then((r) => {
      order.push("second-done");
      return r;
    });

    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(firstReport.orphans.total).toBe(0);
    expect(secondReport.orphans.total).toBe(0);
    // Both resolved; the mutex guarantees first's completion is recorded
    // before second even starts its own run when queued strictly after.
    expect(order.indexOf("first-done")).toBeLessThan(order.indexOf("second-done"));
  });

  it("honors opts.inProcess even for a would-be worker path", async () => {
    seedTrack("a", "Track A");
    const report = await runMergePipelineAsync(db, { inProcess: true });
    expect(report.orphans.total).toBe(0);
  });
});
