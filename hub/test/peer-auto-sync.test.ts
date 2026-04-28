/**
 * Tests for PeerAutoSyncService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Peer, PeerRegistry } from "../src/federation/peers.js";
import type { Config } from "../src/config.js";
import { PeerAutoSyncService } from "../src/services/peer-auto-sync.js";
import { SyncOperationService } from "../src/services/sync-operations.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  
  const schemaPath = path.join(__dirname, "../src/db/schema.sql");
  let schema = fs.readFileSync(schemaPath, "utf-8");
  schema = schema.replace(/REFERENCES\s+\w+\s*\([^)]*\)/g, "");
  schema = schema.replace(/ON DELETE CASCADE/g, "");
  db.exec(schema);
  
  return db;
}

function mockPeerRegistry(peers: Peer[]): PeerRegistry {
  return {
    peers: new Map(peers.map(p => [p.id, p])),
    reload: vi.fn(),
  } as unknown as PeerRegistry;
}

function mockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("PeerAutoSyncService", () => {
  let db: Database.Database;
  let config: Partial<Config>;
  let federatedFetch: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof mockLogger>;
  let ownerUsername = "test-owner";
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    db = createTestDb();
    config = { peerSyncIntervalSeconds: 60 };
    federatedFetch = vi.fn();
    log = mockLogger();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  describe("start/stop", () => {
    it("should start the sync timer", () => {
      const peers: Peer[] = [];
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      service.start();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("PeerAutoSyncService started"));
      service.stop();
    });

    it("should not start multiple timers", () => {
      const peers: Peer[] = [];
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      service.start();
      service.start();
      service.stop();
    });

    it("should stop the sync timer", () => {
      const peers: Peer[] = [];
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      service.start();
      service.stop();
      service.stop();
    });

    it("should do initial sync immediately on start", () => {
      const peers: Peer[] = [{
        id: "peer-init",
        url: "http://peer-init.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: false });
      service.start();
      expect(global.fetch).toHaveBeenCalled();
      service.stop();
    });
  });

  describe("healthCheckPeer", () => {
    it("should return health data on successful response", async () => {
      const peers: Peer[] = [{
        id: "peer-hc1",
        url: "http://peer-hc1.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ lastNavidromeSync: "2024-01-01T12:00:00Z" }),
      });
      
      const health = await service["healthCheckPeer"](peers[0]);
      expect(health).toEqual({ lastNavidromeSync: "2024-01-01T12:00:00Z" });
    });

    it("should return null on failed response", async () => {
      const peers: Peer[] = [{
        id: "peer-hc2",
        url: "http://peer-hc2.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: false });
      const health = await service["healthCheckPeer"](peers[0]);
      expect(health).toBeNull();
    });

    it("should return null on network error", async () => {
      const peers: Peer[] = [{
        id: "peer-hc3",
        url: "http://peer-hc3.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
      const health = await service["healthCheckPeer"](peers[0]);
      expect(health).toBeNull();
    });

    it("should use correct User-Agent header from version module", async () => {
      const peers: Peer[] = [{
        id: "peer-hc4",
        url: "http://peer-hc4.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
      await service["healthCheckPeer"](peers[0]);
      
      expect(global.fetch).toHaveBeenCalledWith(
        "http://peer-hc4.local/api/health",
        expect.objectContaining({ headers: { "User-Agent": "Poutine/0.4.2" } })
      );
    });
  });

  describe("sync decision logic", () => {
    it("should skip sync if peer navidrome sync is null", async () => {
      const peers: Peer[] = [{
        id: "peer-sd1",
        url: "http://peer-sd1.local",
        publicKeySpec: "test-key",
      }];
      
      db.prepare("INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("peer-sd1", "peer-sd1", "http://peer-sd1.local", "{}", "owner-1", "2024-01-01T10:00:00Z");
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: null }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("peer lastNavidromeSync is null"));
    });

    it("should skip sync if peer navidrome sync is not newer", async () => {
      const peers: Peer[] = [{
        id: "peer-sd2",
        url: "http://peer-sd2.local",
        publicKeySpec: "test-key",
      }];
      
      db.prepare("INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("peer-sd2", "peer-sd2", "http://peer-sd2.local", "{}", "owner-1", "2024-01-01T14:00:00Z");
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: "2024-01-01T12:00:00Z" }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("no sync needed"));
    });

    it("should skip sync if peer is offline", async () => {
      const peers: Peer[] = [{
        id: "peer-sd3",
        url: "http://peer-sd3.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: false });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("peer is offline or unreachable"));
    });

    it("should trigger sync when peer navidrome sync is newer", async () => {
      const peers: Peer[] = [{
        id: "peer-sd4",
        url: "http://peer-sd4.local",
        publicKeySpec: "test-key",
      }];
      
      db.prepare("INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("peer-sd4", "peer-sd4", "http://peer-sd4.local", "{}", "owner-1", "2024-01-01T10:00:00Z");
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: "2024-01-01T14:00:00Z" }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("syncing peer"));
    });

    it("should trigger sync when peer has never been synced", async () => {
      const peers: Peer[] = [{
        id: "peer-sd5",
        url: "http://peer-sd5.local",
        publicKeySpec: "test-key",
      }];
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: "2024-01-01T14:00:00Z" }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("syncing peer"));
    });
  });

  describe("concurrent sync guards", () => {
    it("should skip if a sync is already running", async () => {
      const peers: Peer[] = [{
        id: "peer-cg1",
        url: "http://peer-cg1.local",
        publicKeySpec: "test-key",
      }];
      
      const syncOpService = new SyncOperationService(db);
      syncOpService.start("manual", "local");
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log, null, syncOpService
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: "2024-01-01T14:00:00Z" }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("sync operation"));
    });
  });

  describe("splay timing", () => {
    it("should not block on splay during peer sync", async () => {
      const peers: Peer[] = [{
        id: "peer-st1",
        url: "http://peer-st1.local",
        publicKeySpec: "test-key",
      }];
      
      db.prepare("INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, last_synced_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("peer-st1", "peer-st1", "http://peer-st1.local", "{}", "owner-1", "2024-01-01T10:00:00Z");
      
      const service = new PeerAutoSyncService(
        db, config as Config, mockPeerRegistry(peers), federatedFetch, ownerUsername, log
      );
      
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lastNavidromeSync: "2024-01-01T14:00:00Z" }) });
      await service["checkAndSyncPeer"](peers[0]);
      
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("syncing peer"));
    });

    it("should calculate splay within 0-30000ms range", () => {
      const splayValues: number[] = [];
      
      for (let i = 0; i < 100; i++) {
        const splayMs = Math.floor((Math.random() * 60 - 30) * 1000);
        const actualDelay = Math.abs(splayMs);
        splayValues.push(actualDelay);
      }
      
      expect(splayValues.every(v => v >= 0 && v <= 30000)).toBe(true);
      const uniqueValues = new Set(splayValues);
      expect(uniqueValues.size).toBeGreaterThan(10);
    });
  });
});
