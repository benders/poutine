import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { SyncOperationService } from "../src/services/sync-operations.js";

function tmpDbPath() {
  return path.join(
    os.tmpdir(),
    `poutine-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("SyncOperationService", () => {
  let db: Database.Database;
  let service: SyncOperationService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new Database(dbPath);
    
    // Create the sync_operations table
    db.exec(`
      CREATE TABLE sync_operations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        artist_count INTEGER,
        album_count INTEGER,
        track_count INTEGER,
        errors TEXT
      )
    `);
    
    service = new SyncOperationService(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe("start", () => {
    it("should create a new manual sync operation", () => {
      const id = service.start("manual", "local");
      
      expect(id).toBeTruthy();
      expect(id).toHaveLength(36); // UUID format
      
      const row = db.prepare("SELECT * FROM sync_operations WHERE id = ?").get(id);
      expect(row).toBeTruthy();
      expect((row as any).type).toBe("manual");
      expect((row as any).scope).toBe("local");
      expect((row as any).status).toBe("running");
      expect((row as any).started_at).toBeTruthy();
    });

    it("should create a new auto sync operation for a peer", () => {
      const id = service.start("auto", "peer", "peer-123");
      
      expect(id).toBeTruthy();
      
      const row = db.prepare("SELECT * FROM sync_operations WHERE id = ?").get(id);
      expect((row as any).type).toBe("auto");
      expect((row as any).scope).toBe("peer");
      expect((row as any).scope_id).toBe("peer-123");
    });
  });

  describe("complete", () => {
    it("should mark an operation as complete with results", () => {
      const id = service.start("manual", "local");
      
      service.complete(id, 100, 50, 500, []);
      
      const row = db.prepare("SELECT * FROM sync_operations WHERE id = ?").get(id);
      expect((row as any).status).toBe("complete");
      expect((row as any).artist_count).toBe(100);
      expect((row as any).album_count).toBe(50);
      expect((row as any).track_count).toBe(500);
      expect((row as any).finished_at).toBeTruthy();
      expect((row as any).duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("should record errors on completion", () => {
      const id = service.start("manual", "local");
      const errors = ["Error 1", "Error 2"];
      
      service.complete(id, 100, 50, 500, errors);
      
      const row = db.prepare("SELECT errors FROM sync_operations WHERE id = ?").get(id);
      const parsedErrors = JSON.parse((row as any).errors);
      expect(parsedErrors).toEqual(errors);
    });
  });

  describe("fail", () => {
    it("should mark an operation as failed", () => {
      const id = service.start("manual", "local");
      
      service.fail(id, ["Sync failed due to network error"]);
      
      const row = db.prepare("SELECT * FROM sync_operations WHERE id = ?").get(id);
      expect((row as any).status).toBe("failed");
      expect((row as any).finished_at).toBeTruthy();
      expect((row as any).duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("should record multiple errors on failure", () => {
      const id = service.start("manual", "local");
      const errors = ["Timeout after 30s", "Peer unreachable"];
      
      service.fail(id, errors);
      
      const row = db.prepare("SELECT errors FROM sync_operations WHERE id = ?").get(id);
      const parsedErrors = JSON.parse((row as any).errors);
      expect(parsedErrors).toEqual(errors);
    });
  });

  describe("getRecent", () => {
    it("should return operations ordered by started_at descending", () => {
      const id1 = service.start("manual", "local");
      service.complete(id1, 10, 5, 50, []);
      
      // Wait to ensure different timestamps
      const wait = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) {} };
      wait(1100);
      
      const id2 = service.start("manual", "local");
      service.complete(id2, 20, 10, 100, []);
      
      const recent = service.getRecent(10);
      
      expect(recent).toHaveLength(2);
      // Most recent should be first
      expect(recent[0].id).toBe(id2);
      expect(recent[1].id).toBe(id1);
    });

    it("should respect the limit parameter", () => {
      // Create 5 operations
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = service.start("manual", "local");
        service.complete(id, i * 10, i * 5, i * 50, []);
        ids.push(id);
      }
      
      const recent = service.getRecent(3);
      
      expect(recent).toHaveLength(3);
    });

    it("should parse errors from JSON", () => {
      const id = service.start("manual", "local");
      service.complete(id, 10, 5, 50, ["Error 1"]);
      
      const recent = service.getRecent(10);
      
      expect(recent[0].errors).toEqual(["Error 1"]);
    });
  });

  describe("getRunning", () => {
    it("should return only running operations", () => {
      const id1 = service.start("manual", "local");
      const id2 = service.start("auto", "peer", "peer-1");
      const id3 = service.start("manual", "local");
      service.complete(id1, 10, 5, 50, []);
      
      const running = service.getRunning();
      
      expect(running).toHaveLength(2);
      const runningIds = running.map((r) => r.id);
      expect(runningIds).toContain(id2);
      expect(runningIds).toContain(id3);
    });

    it("should return empty array when no operations are running", () => {
      const id = service.start("manual", "local");
      service.complete(id, 10, 5, 50, []);
      
      const running = service.getRunning();
      
      expect(running).toHaveLength(0);
    });
  });

  describe("clearAll", () => {
    it("should delete all sync operations", () => {
      const id1 = service.start("manual", "local");
      const id2 = service.start("auto", "peer", "peer-1");
      service.complete(id1, 10, 5, 50, []);
      service.fail(id2, ["Error"]);
      
      service.clearAll();
      
      const recent = service.getRecent(100);
      expect(recent).toHaveLength(0);
    });
  });

  describe("integration", () => {
    it("should track a complete sync workflow", () => {
      // Start manual sync
      const syncId = service.start("manual", "local");
      
      // Simulate some work...
      service.complete(syncId, 250, 75, 1200, []);
      
      // Verify the operation
      const recent = service.getRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        id: syncId,
        type: "manual",
        scope: "local",
        status: "complete",
        artistCount: 250,
        albumCount: 75,
        trackCount: 1200,
        errors: [],
      });
      expect(recent[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(recent[0].finishedAt).toBeTruthy();
    });

    it("should track multiple concurrent sync operations", () => {
      const localSyncId = service.start("manual", "local");
      const peerSyncId = service.start("auto", "peer", "peer-1");
      
      // Complete local sync
      service.complete(localSyncId, 100, 50, 500, []);
      
      // Peer sync fails
      service.fail(peerSyncId, ["Connection timeout"]);
      
      const recent = service.getRecent(10);
      
      expect(recent).toHaveLength(2);
      const localOp = recent.find((r) => r.id === localSyncId);
      const peerOp = recent.find((r) => r.id === peerSyncId);
      
      expect(localOp).toMatchObject({
        status: "complete",
        artistCount: 100,
        errors: [],
      });
      
      expect(peerOp).toMatchObject({
        status: "failed",
        errors: ["Connection timeout"],
      });
    });
  });
});
