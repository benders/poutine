import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Drop tables removed in Phase 5 (server-side queue moved client-side).
 * Safe to call on fresh databases — DROP IF EXISTS is a no-op when absent.
 */
function dropLegacyTables(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS user_queue_state");
  db.exec("DROP TABLE IF EXISTS user_queue");
}

/**
 * Apply additive column migrations for existing databases.
 * SQLite supports ADD COLUMN idempotently via PRAGMA table_info check.
 */
function ensureColumns(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(track_sources)")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("source_kind")) {
    db.exec(
      "ALTER TABLE track_sources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local'",
    );
  }
  if (!names.has("peer_id")) {
    db.exec("ALTER TABLE track_sources ADD COLUMN peer_id TEXT");
  }

  const instanceCols = db
    .prepare("PRAGMA table_info(instances)")
    .all() as Array<{ name: string }>;
  const instanceColNames = new Set(instanceCols.map((c) => c.name));
  if (!instanceColNames.has("last_sync_ok")) {
    db.exec("ALTER TABLE instances ADD COLUMN last_sync_ok INTEGER");
  }
  if (!instanceColNames.has("last_sync_message")) {
    db.exec("ALTER TABLE instances ADD COLUMN last_sync_message TEXT");
  }
}

export function createDatabase(dbPath: string): Database.Database {
  // Ensure the directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode and foreign keys
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run schema
  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  // Execute each statement separately (better-sqlite3 exec handles multiple)
  db.exec(schema);

  // Drop tables removed in Phase 5
  dropLegacyTables(db);

  // Apply additive column migrations for existing DBs
  ensureColumns(db);

  return db;
}
