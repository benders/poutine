import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { createDatabase } from "../src/db/client.js";

describe("instances.musicfolder_id migration (#123)", () => {
  it("adds musicfolder_id column and backfills values for pre-#123 DBs", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-mig-"));
    const path = join(dir, "old.db");

    // Build a pre-#123 DB by hand (without musicfolder_id column)
    const old = new Database(path);
    old.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_enc TEXT NOT NULL DEFAULT '',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        adapter_type TEXT NOT NULL DEFAULT 'subsonic',
        encrypted_credentials TEXT NOT NULL DEFAULT '{}',
        owner_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen TEXT,
        last_synced_at TEXT,
        track_count INTEGER NOT NULL DEFAULT 0,
        server_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO users (id, username, password_enc, is_admin)
        VALUES ('u1', 'admin', 'secret-key', 1);

      INSERT INTO instances (id, name, url, encrypted_credentials, owner_id, created_at)
        VALUES ('local', 'Local', 'http://localhost:4533', '{}', 'u1', '2024-01-01 00:00:00'),
               ('peer-1', 'Peer One', 'http://peer1:4533', '{}', 'u1', '2024-01-02 00:00:00'),
               ('peer-2', 'Peer Two', 'http://peer2:4533', '{}', 'u1', '2024-01-03 00:00:00');
    `);
    old.close();

    // Run migration by creating the database
    const db = createDatabase(path);

    // Verify column was added
    const cols = db
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("musicfolder_id")).toBe(true);

    // Verify values were backfilled (ordered by created_at)
    const rows = db
      .prepare("SELECT name, musicfolder_id FROM instances ORDER BY musicfolder_id")
      .all() as Array<{ name: string; musicfolder_id: number }>;

    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe("Local");
    expect(rows[0].musicfolder_id).toBe(1);
    expect(rows[1].name).toBe("Peer One");
    expect(rows[1].musicfolder_id).toBe(2);
    expect(rows[2].name).toBe("Peer Two");
    expect(rows[2].musicfolder_id).toBe(3);

    // Verify unique index was created
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_instances_musicfolder_id'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true });
  });

  it("is a no-op on a fresh DB built from current schema.sql", () => {
    const db = createDatabase(":memory:");
    const cols = db
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("musicfolder_id")).toBe(true);

    // Verify the index exists
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_instances_musicfolder_id'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);

    db.close();
  });

  it("handles empty instances table gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-mig-"));
    const path = join(dir, "empty.db");

    // Build a pre-#123 DB with empty instances table
    const old = new Database(path);
    old.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_enc TEXT NOT NULL DEFAULT '',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        adapter_type TEXT NOT NULL DEFAULT 'subsonic',
        encrypted_credentials TEXT NOT NULL DEFAULT '{}',
        owner_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'offline',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO users (id, username, password_enc, is_admin)
        VALUES ('u1', 'admin', 'secret-key', 1);
    `);
    old.close();

    // Run migration
    const db = createDatabase(path);

    // Verify column was added even with empty table
    const cols = db
      .prepare("PRAGMA table_info(instances)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("musicfolder_id")).toBe(true);

    // Verify table is still empty
    const count = db.prepare("SELECT COUNT(*) as count FROM instances").get() as { count: number };
    expect(count.count).toBe(0);

    db.close();
    rmSync(dir, { recursive: true });
  });
});
