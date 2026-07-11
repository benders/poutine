import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { createDatabase } from "../src/db/client.js";

describe("playlist_tracks unified_track_id FK migration (#242)", () => {
  it("drops the FK on a pre-#242 DB while preserving existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-mig-"));
    const path = join(dir, "old.db");

    // Build a pre-#242 DB by hand with the FK'd playlist_tracks shape.
    // Other tables are intentionally omitted — createDatabase() creates them
    // fresh via `CREATE TABLE IF NOT EXISTS` without touching these.
    const old = new Database(path);
    old.pragma("foreign_keys = OFF");
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_enc TEXT NOT NULL DEFAULT '',
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE playlists (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        comment TEXT,
        public INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE unified_tracks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_normalized TEXT NOT NULL,
        release_id TEXT,
        artist_id TEXT,
        musicbrainz_id TEXT,
        track_number INTEGER,
        disc_number INTEGER DEFAULT 1,
        duration_ms INTEGER,
        genre TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE playlist_tracks (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        unified_track_id TEXT NOT NULL REFERENCES unified_tracks(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (playlist_id, position)
      );

      INSERT INTO users (id, username, password_enc, is_admin) VALUES ('u1', 'admin', 'secret', 1);
      INSERT INTO playlists (id, owner_id, name) VALUES ('pl1', 'u1', 'My Playlist');
      INSERT INTO unified_tracks (id, title, title_normalized) VALUES ('t1', 'Paranoid Android', 'paranoid android');
      INSERT INTO playlist_tracks (playlist_id, position, unified_track_id) VALUES ('pl1', 0, 't1');
    `);
    old.close();

    // Confirm the pre-migration shape actually has the FK we're about to drop.
    const preFks = new Database(path).pragma("foreign_key_list(playlist_tracks)") as Array<{ table: string }>;
    expect(preFks.some((fk) => fk.table === "unified_tracks")).toBe(true);

    const db = createDatabase(path);

    const fks = db.pragma("foreign_key_list(playlist_tracks)") as Array<{ table: string; from: string }>;
    expect(fks.some((fk) => fk.table === "unified_tracks" && fk.from === "unified_track_id")).toBe(false);

    const rows = db.prepare("SELECT playlist_id, position, unified_track_id FROM playlist_tracks").all();
    expect(rows).toEqual([{ playlist_id: "pl1", position: 0, unified_track_id: "t1" }]);

    db.close();
    rmSync(dir, { recursive: true });
  });

  it("is a no-op on a fresh DB built from current schema.sql", () => {
    const db = createDatabase(":memory:");
    const fks = db.pragma("foreign_key_list(playlist_tracks)") as Array<{ table: string }>;
    expect(fks.some((fk) => fk.table === "unified_tracks")).toBe(false);
    db.close();
  });
});
