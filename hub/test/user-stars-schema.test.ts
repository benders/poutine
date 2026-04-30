import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/client.js";

describe("user_stars schema (#104)", () => {
  it("creates the table on a fresh DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-stars-"));
    const db = createDatabase(join(dir, "stars.db"));
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user_stars'",
      )
      .get();
    expect(row).toBeDefined();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces (user_id, kind, target_id) primary key + kind CHECK", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-stars-"));
    const db = createDatabase(join(dir, "stars.db"));
    db.prepare(
      "INSERT INTO users (id, username, password_enc) VALUES (?, ?, '')",
    ).run("u1", "alice");

    db.prepare(
      "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    ).run("u1", "track", "t-uuid");
    // Duplicate fails on PK
    expect(() =>
      db
        .prepare(
          "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
        )
        .run("u1", "track", "t-uuid"),
    ).toThrow();
    // Bad kind fails CHECK
    expect(() =>
      db
        .prepare(
          "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
        )
        .run("u1", "bogus", "x"),
    ).toThrow();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cascades on user delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "poutine-stars-"));
    const db = createDatabase(join(dir, "stars.db"));
    db.prepare(
      "INSERT INTO users (id, username, password_enc) VALUES (?, ?, '')",
    ).run("u1", "alice");
    db.prepare(
      "INSERT INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    ).run("u1", "track", "t-uuid");

    db.prepare("DELETE FROM users WHERE id = ?").run("u1");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM user_stars")
      .get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
