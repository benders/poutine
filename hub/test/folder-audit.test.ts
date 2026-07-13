/**
 * Folder audit (#252): read-only detection of untagged-compilation damage.
 *
 * Seeds an in-memory DB with a folder split into sentinel albums (should
 * propose a regroup), a legit multi-album folder (informational, no
 * proposal), NULL-path tracks (counted in coverage, never crash), and a
 * disabled instance (excluded entirely). Asserts the report shape and that
 * the audit writes nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { runFolderAudit } from "../src/library/folder-audit.js";

let db: Database.Database;

function addUser(id: string): void {
  db.prepare(
    "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, '', 0)",
  ).run(id, id);
}

function addInstance(id: string, name: string, lifecycle: string): void {
  db.prepare(
    `INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, lifecycle)
     VALUES (?, ?, ?, '', 'owner', ?)`,
  ).run(id, name, `http://${id}.test`, lifecycle);
}

function addAlbum(
  instanceId: string,
  albumId: string,
  name: string,
  artistName: string,
  trackCount: number,
): void {
  db.prepare(
    `INSERT INTO instance_albums (id, instance_id, remote_id, name, artist_id, artist_name, track_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(albumId, instanceId, albumId, name, `${instanceId}:artist`, artistName, trackCount);
}

let trackSeq = 0;
function addTrack(
  instanceId: string,
  albumId: string,
  path: string | null,
): void {
  const id = `${instanceId}:t${trackSeq++}`;
  db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, instanceId, id, albumId, id, "Some Artist", path);
}

// Link an instance album to a unified release group so the audit can resolve
// unifiedReleaseGroupId for click-through.
function linkUnifiedReleaseGroup(instanceAlbumId: string, instanceId: string, rgId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO unified_artists (id, name, name_normalized) VALUES ('ua', 'A', 'a')",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO unified_release_groups (id, name, name_normalized, artist_id) VALUES (?, 'RG', 'rg', 'ua')",
  ).run(rgId);
  const releaseId = `rel-${rgId}`;
  db.prepare(
    "INSERT OR IGNORE INTO unified_releases (id, release_group_id, name) VALUES (?, ?, 'R')",
  ).run(releaseId, rgId);
  db.prepare(
    "INSERT INTO unified_release_sources (unified_release_id, instance_album_id, instance_id) VALUES (?, ?, ?)",
  ).run(releaseId, instanceAlbumId, instanceId);
}

describe("runFolderAudit (#252)", () => {
  beforeEach(() => {
    db = createDatabase(":memory:");
    trackSeq = 0;
    addUser("owner");

    addInstance("inst-a", "Hub A", "active");

    // Untagged-compilation damage: one folder, three sentinel-named albums by
    // different artists (empty, "[Unknown Album]", "unknown album").
    addAlbum("inst-a", "a-comp1", "", "Artist One", 2);
    addAlbum("inst-a", "a-comp2", "[Unknown Album]", "Artist Two", 3);
    addAlbum("inst-a", "a-comp3", "unknown album", "Artist Three", 1);
    addTrack("inst-a", "a-comp1", "Incoming/comp2020/01.mp3");
    addTrack("inst-a", "a-comp1", "Incoming/comp2020/02.mp3");
    addTrack("inst-a", "a-comp2", "Incoming/comp2020/03.mp3");
    addTrack("inst-a", "a-comp2", "Incoming/comp2020/04.mp3");
    addTrack("inst-a", "a-comp2", "Incoming/comp2020/05.mp3");
    addTrack("inst-a", "a-comp3", "Incoming/comp2020/06.mp3");
    // One sentinel album is merged, so its release group should resolve.
    linkUnifiedReleaseGroup("a-comp2", "inst-a", "rg-comp");

    // Legit multi-album folder: two real-named albums (e.g. a box set on disk).
    // Multi-album, but zero sentinels → informational, no proposal.
    addAlbum("inst-a", "a-disc1", "Box Set Disc 1", "The Band", 1);
    addAlbum("inst-a", "a-disc2", "Box Set Disc 2", "The Band", 1);
    addTrack("inst-a", "a-disc1", "The Band/Box Set/d1t1.mp3");
    addTrack("inst-a", "a-disc2", "The Band/Box Set/d2t1.mp3");

    // NULL-path track: counted in coverage, contributes to no folder.
    addAlbum("inst-a", "a-nopath", "Untracked", "Nobody", 1);
    addTrack("inst-a", "a-nopath", null);

    // Disabled instance with the same damage — must be excluded entirely.
    addInstance("inst-off", "Hub Off", "disabled");
    addAlbum("inst-off", "off-comp1", "[Unknown Album]", "X", 1);
    addAlbum("inst-off", "off-comp2", "unknown album", "Y", 1);
    addTrack("inst-off", "off-comp1", "Junk/mix/01.mp3");
    addTrack("inst-off", "off-comp2", "Junk/mix/02.mp3");
  });

  afterEach(() => {
    db.close();
  });

  it("proposes a regroup for a folder split into ≥2 sentinel albums", () => {
    const report = runFolderAudit(db);
    const comp = report.clusters.find(
      (c) => c.folder === "Incoming/comp2020" && c.instanceId === "inst-a",
    );
    expect(comp).toBeDefined();
    expect(comp!.albums).toHaveLength(3);
    expect(comp!.sentinelCount).toBe(3);
    expect(comp!.proposal).toEqual({
      kind: "group-into-compilation",
      albumCount: 3,
      trackCount: 6,
    });
    // Per-album track-in-folder counts and click-through id.
    const merged = comp!.albums.find((a) => a.instanceAlbumId === "a-comp2");
    expect(merged!.tracksInFolder).toBe(3);
    expect(merged!.unifiedReleaseGroupId).toBe("rg-comp");
    const unmerged = comp!.albums.find((a) => a.instanceAlbumId === "a-comp1");
    expect(unmerged!.unifiedReleaseGroupId).toBeNull();
  });

  it("reports a legit multi-album folder as informational (no proposal)", () => {
    const report = runFolderAudit(db);
    const boxset = report.clusters.find((c) => c.folder === "The Band/Box Set");
    expect(boxset).toBeDefined();
    expect(boxset!.albums).toHaveLength(2);
    expect(boxset!.sentinelCount).toBe(0);
    expect(boxset!.proposal).toBeNull();
  });

  it("counts NULL-path tracks in coverage without crashing", () => {
    const report = runFolderAudit(db);
    const cov = report.coverage.find((c) => c.instanceId === "inst-a");
    expect(cov).toBeDefined();
    // 6 comp + 2 box set + 1 null-path = 9 tracks; 8 carry a path.
    expect(cov!.trackCount).toBe(9);
    expect(cov!.tracksWithPath).toBe(8);
    expect(cov!.instanceName).toBe("Hub A");
  });

  it("excludes disabled instances from coverage and clusters", () => {
    const report = runFolderAudit(db);
    expect(report.coverage.some((c) => c.instanceId === "inst-off")).toBe(false);
    expect(report.clusters.some((c) => c.instanceId === "inst-off")).toBe(false);
  });

  it("makes no catalog changes (read-only)", () => {
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM instance_albums")
      .get() as { n: number };
    runFolderAudit(db);
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM instance_albums")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
