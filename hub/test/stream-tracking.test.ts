import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { StreamTrackingService } from "../src/services/stream-tracking.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `poutine-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeStart(overrides: Partial<Parameters<StreamTrackingService["start"]>[0]> = {}) {
  return {
    kind: "subsonic" as const,
    username: "alice",
    trackId: "t:123",
    trackTitle: "Bohemian Rhapsody",
    artistName: "Queen",
    ...overrides,
  };
}

describe("StreamTrackingService", () => {
  let db: Database.Database;
  let service: StreamTrackingService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE stream_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'subsonic',
        username TEXT NOT NULL,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        client_name TEXT,
        client_version TEXT,
        peer_id TEXT,
        source_kind TEXT,
        source_peer_id TEXT,
        format TEXT,
        bitrate INTEGER,
        transcoded INTEGER NOT NULL DEFAULT 0,
        max_bitrate INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        duration_ms INTEGER,
        bytes_transferred INTEGER,
        error TEXT
      )
    `);
    service = new StreamTrackingService(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  describe("start", () => {
    it("creates an active row with new fields", () => {
      const id = service.start(makeStart({
        clientName: "DSub",
        clientVersion: "5.5.4",
        sourceKind: "local",
        format: "flac",
        bitrate: 900,
        transcoded: false,
      }));

      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id) as any;
      expect(row.kind).toBe("subsonic");
      expect(row.client_name).toBe("DSub");
      expect(row.client_version).toBe("5.5.4");
      expect(row.source_kind).toBe("local");
      expect(row.format).toBe("flac");
      expect(row.bitrate).toBe(900);
      expect(row.transcoded).toBe(0);

      const active = service.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id);
      expect(active[0].clientName).toBe("DSub");
    });

    it("supports proxy kind with peer id", () => {
      const id = service.start(makeStart({
        kind: "proxy",
        peerId: "peerA",
        username: "remoteUser",
        sourceKind: "local",
      }));
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id) as any;
      expect(row.kind).toBe("proxy");
      expect(row.peer_id).toBe("peerA");
    });
  });

  describe("finish", () => {
    it("records bytes and clears active", () => {
      const id = service.start(makeStart());
      service.finish(id, 8_500_000, null);

      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id) as any;
      expect(row.finished_at).toBeTruthy();
      expect(row.bytes_transferred).toBe(8_500_000);
      expect(service.getActiveCount()).toBe(0);
    });

    it("records error on failure", () => {
      const id = service.start(makeStart());
      service.finish(id, 0, "Stream error");
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id) as any;
      expect(row.error).toBe("Stream error");
    });
  });

  describe("updateBytes / getActive", () => {
    it("updates in-memory bytes and exposes via getActive", () => {
      const id = service.start(makeStart());
      service.updateBytes(id, 12345);
      const active = service.getActive();
      expect(active[0].bytesTransferred).toBe(12345);
    });
  });

  describe("getRecent", () => {
    it("returns most recent first", async () => {
      const id1 = service.start(makeStart({ trackId: "t:1", trackTitle: "Song 1" }));
      service.finish(id1, 1000, null);
      await new Promise((r) => setTimeout(r, 1100));
      const id2 = service.start(makeStart({ trackId: "t:2", trackTitle: "Song 2" }));
      service.finish(id2, 2000, null);

      const recent = service.getRecent(10);
      expect(recent[0].id).toBe(id2);
      expect(recent[1].id).toBe(id1);
    });
  });

  describe("pruneToCount / setMaxRows", () => {
    it("prunes finished rows beyond max", async () => {
      service.setMaxRows(3);
      for (let i = 0; i < 5; i++) {
        const id = service.start(makeStart({ trackId: `t:${i}` }));
        service.finish(id, 1000, null);
      }
      const recent = service.getRecent(100);
      expect(recent.length).toBe(3);
    });
  });

  describe("clearAll", () => {
    it("clears history + active", () => {
      const id1 = service.start(makeStart({ trackId: "t:1" }));
      service.start(makeStart({ trackId: "t:2" }));
      service.finish(id1, 1000, null);
      service.clearAll();
      expect(service.getRecent(100)).toHaveLength(0);
      expect(service.getActiveCount()).toBe(0);
    });
  });
});
