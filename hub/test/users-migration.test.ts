import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/client.js";

describe("users.password_hash → password_enc migration (#106)", () => {
  it("rewrites a pre-#106 schema: drops password_hash, adds password_enc=''", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-mig-"));
    const path = join(dir, "old.db");

    // Build a pre-#106 DB by hand so we exercise the migration path.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, username, password_hash, is_admin)
        VALUES ('u1', 'alice', '$argon2id$stale-hash', 1);
    `);
    old.close();

    const db = createDatabase(path);
    const cols = db
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    expect(names.has("password_enc")).toBe(true);
    expect(names.has("password_hash")).toBe(false);

    const row = db
      .prepare("SELECT username, password_enc, is_admin FROM users WHERE id = 'u1'")
      .get() as { username: string; password_enc: string; is_admin: number };
    expect(row.username).toBe("alice");
    expect(row.password_enc).toBe("");
    expect(row.is_admin).toBe(1);

    db.close();
    rmSync(dir, { recursive: true });
  });

  it("is a no-op on a fresh DB built from current schema.sql", () => {
    const db = createDatabase(":memory:");
    const cols = db
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("password_enc")).toBe(true);
    expect(names.has("password_hash")).toBe(false);
    db.close();
  });
});
