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

describe("StreamTrackingService", () => {
  let db: Database.Database;
  let service: StreamTrackingService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new Database(dbPath);
    
    // Create the stream_operations table
    db.exec(`
      CREATE TABLE stream_operations (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        bytes_transferred INTEGER
      )
    `);
    
    service = new StreamTrackingService(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe("start", () => {
    it("should create a new stream operation and track it as active", () => {
      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
      
      expect(id).toBeTruthy();
      expect(id).toHaveLength(36); // UUID format
      
      // Check database
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
      expect(row).toBeTruthy();
      expect((row as any).username).toBe("alice");
      expect((row as any).track_id).toBe("t:123");
      expect((row as any).track_title).toBe("Bohemian Rhapsody");
      expect((row as any).artist_name).toBe("Queen");
      expect((row as any).started_at).toBeTruthy();
      
      // Check active tracking
      const active = service.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id);
    });

    it("should handle multiple concurrent streams", () => {
      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
      const id3 = service.start("charlie", "t:3", "Song 3", "Artist 3");
      
      const active = service.getActive();
      
      expect(active).toHaveLength(3);
      const activeIds = active.map((a) => a.id);
      expect(activeIds).toContain(id1);
      expect(activeIds).toContain(id2);
      expect(activeIds).toContain(id3);
    });

    it("should return the active stream count", () => {
      service.start("alice", "t:1", "Song 1", "Artist 1");
      service.start("bob", "t:2", "Song 2", "Artist 2");
      
      expect(service.getActiveCount()).toBe(2);
    });
  });

  describe("finish", () => {
    it("should mark a stream as finished with duration and bytes", () => {
      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
      
      service.finish(id, 354000, 8500000); // 5:54 duration, ~8.5MB
      
      // Check database
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
      expect((row as any).finished_at).toBeTruthy();
      expect((row as any).duration_ms).toBe(354000);
      expect((row as any).bytes_transferred).toBe(8500000);
      
      // Check it's no longer active
      const active = service.getActive();
      expect(active).toHaveLength(0);
    });

    it("should handle streams finished without duration", () => {
      const id = service.start("alice", "t:123", "Song", "Artist");
      
      service.finish(id, null, 5000000);
      
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
      expect((row as any).duration_ms).toBeNull();
      expect((row as any).bytes_transferred).toBe(5000000);
    });

    it("should handle streams finished without bytes transferred", () => {
      const id = service.start("alice", "t:123", "Song", "Artist");
      
      service.finish(id, 180000, null);
      
      const row = db.prepare("SELECT * FROM stream_operations WHERE id = ?").get(id);
      expect((row as any).duration_ms).toBe(180000);
      expect((row as any).bytes_transferred).toBeNull();
    });

    it("should remove stream from active tracking on finish", () => {
      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
      
      service.finish(id1, 180000, 5000000);
      
      expect(service.getActiveCount()).toBe(1);
      
      const active = service.getActive();
      expect(active[0].id).toBe(id2);
    });
  });

  describe("getActive", () => {
    it("should return all currently active streams", () => {
      service.start("alice", "t:1", "Song 1", "Artist 1");
      service.start("bob", "t:2", "Song 2", "Artist 2");
      
      const active = service.getActive();
      
      expect(active).toHaveLength(2);
      expect(active[0].durationMs).toBeNull(); // Still playing
      expect(active[1].durationMs).toBeNull();
    });

    it("should not include finished streams", () => {
      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
      service.start("bob", "t:2", "Song 2", "Artist 2");
      
      service.finish(id1, 180000, 5000000);
      
      const active = service.getActive();
      
      expect(active).toHaveLength(1);
      expect(active[0].trackTitle).toBe("Song 2");
    });
  });

  describe("getRecent", () => {
    it("should return operations ordered by started_at descending", () => {
      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
      service.finish(id1, 180000, 5000000);
      
      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
      service.finish(id2, 240000, 7000000);
      
      const recent = service.getRecent(10);
      
      expect(recent).toHaveLength(2);
      expect(recent[0].id).toBe(id2); // Most recent first
      expect(recent[1].id).toBe(id1);
    });

    it("should respect the limit parameter", () => {
      // Create 5 streams
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = service.start(`user${i}`, `t:${i}`, `Song ${i}`, `Artist ${i}`);
        service.finish(id, 180000, 5000000);
        ids.push(id);
      }
      
      const recent = service.getRecent(3);
      
      expect(recent).toHaveLength(3);
    });

    it("should include all stream metadata", () => {
      const id = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
      service.finish(id, 354000, 8500000);
      
      const recent = service.getRecent(10);
      
      expect(recent[0]).toMatchObject({
        id,
        username: "alice",
        trackId: "t:123",
        trackTitle: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 354000,
        bytesTransferred: 8500000,
      });
      expect(recent[0].startedAt).toBeTruthy();
      expect(recent[0].finishedAt).toBeTruthy();
    });
  });

  describe("clearAll", () => {
    it("should delete all stream history and clear active tracking", () => {
      const id1 = service.start("alice", "t:1", "Song 1", "Artist 1");
      const id2 = service.start("bob", "t:2", "Song 2", "Artist 2");
      service.finish(id1, 180000, 5000000);
      
      service.clearAll();
      
      const recent = service.getRecent(100);
      expect(recent).toHaveLength(0);
      expect(service.getActiveCount()).toBe(0);
    });
  });

  describe("integration", () => {
    it("should track a complete stream lifecycle", () => {
      // Start stream
      const streamId = service.start("alice", "t:123", "Bohemian Rhapsody", "Queen");
      
      // Verify it's active
      expect(service.getActiveCount()).toBe(1);
      
      // Finish stream
      service.finish(streamId, 354000, 8500000);
      
      // Verify history
      const recent = service.getRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        id: streamId,
        username: "alice",
        trackTitle: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 354000,
        bytesTransferred: 8500000,
      });
      
      // Verify no longer active
      expect(service.getActiveCount()).toBe(0);
    });

    it("should handle multiple users streaming concurrently", () => {
      const streams: { id: string; user: string }[] = [];
      
      // Start 3 concurrent streams
      streams.push({ id: service.start("alice", "t:1", "Song A", "Artist A"), user: "alice" });
      streams.push({ id: service.start("bob", "t:2", "Song B", "Artist B"), user: "bob" });
      streams.push({ id: service.start("charlie", "t:3", "Song C", "Artist C"), user: "charlie" });
      
      expect(service.getActiveCount()).toBe(3);
      
      // Finish first stream
      service.finish(streams[0].id, 200000, 6000000);
      
      expect(service.getActiveCount()).toBe(2);
      
      // Finish remaining streams
      service.finish(streams[1].id, 180000, 5000000);
      service.finish(streams[2].id, 240000, 7000000);
      
      expect(service.getActiveCount()).toBe(0);
      
      // Verify all in history
      const recent = service.getRecent(10);
      expect(recent).toHaveLength(3);
      
      // Verify each stream's data
      const aliceStream = recent.find((s) => s.username === "alice");
      const bobStream = recent.find((s) => s.username === "bob");
      const charlieStream = recent.find((s) => s.username === "charlie");
      
      expect(aliceStream).toMatchObject({ trackTitle: "Song A", artistName: "Artist A" });
      expect(bobStream).toMatchObject({ trackTitle: "Song B", artistName: "Artist B" });
      expect(charlieStream).toMatchObject({ trackTitle: "Song C", artistName: "Artist C" });
    });

    it("should track stream with realistic audio data", () => {
      // Simulate a 3-minute 45-second FLAC track at ~900kbps
      const streamId = service.start("music_lover", "t:42", "Dark Side of the Moon", "Pink Floyd");
      
      // 3:45 = 225 seconds
      const durationMs = 225000;
      // ~900kbps * 225 seconds = ~25MB
      const bytesTransferred = 25300000;
      
      service.finish(streamId, durationMs, bytesTransferred);
      
      const recent = service.getRecent(10);
      expect(recent[0]).toMatchObject({
        trackTitle: "Dark Side of the Moon",
        artistName: "Pink Floyd",
        durationMs: 225000,
        bytesTransferred: 25300000,
      });
    });
  });
});
