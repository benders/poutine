import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) the Player database (`player.db`). Idempotent: applies
 * `player-schema.sql` on every boot, which is `CREATE TABLE IF NOT EXISTS`
 * only.
 *
 * Player BE owns this DB exclusively. Hub code must not import this module.
 * Capability injection happens in `server.ts` (Phase 1 wiring) — the player
 * settings module is the only consumer.
 *
 * See `docs/system-architecture.md` and issue #215.
 */
export function createPlayerDatabase(dbPath: string): Database.Database {
  // Allow :memory: for tests; otherwise ensure the parent directory exists.
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = resolve(__dirname, "player-schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return db;
}

/**
 * Default file path for `player.db` given the Hub database path. Lives in
 * the same data directory so a single volume backup captures both.
 *
 * Example: `./data/poutine.db` → `./data/player.db`.
 * `:memory:` passes through unchanged (tests).
 */
export function defaultPlayerDbPath(hubDbPath: string): string {
  if (hubDbPath === ":memory:") return ":memory:";
  return resolve(dirname(hubDbPath), "player.db");
}
