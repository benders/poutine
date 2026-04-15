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

/**
 * Phase 5 data model cleanup: drop peer-import columns from track_sources.
 *
 * source_kind, peer_id, and remote_id are removed — routing now keys by
 * instance_id directly, and remote_id is fetched from instance_tracks via JOIN.
 * track_sources is a derived/rebuilt table (mergeLibraries clears and repopulates
 * it on every sync) so dropping and recreating loses no durable data.
 */
function migrateTrackSources(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(track_sources)")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("source_kind") && !names.has("peer_id") && !names.has("remote_id")) {
    return; // already on new schema
  }
  db.exec(`
    DROP TABLE IF EXISTS track_sources;
    CREATE TABLE track_sources (
      id TEXT PRIMARY KEY,
      unified_track_id TEXT NOT NULL REFERENCES unified_tracks(id) ON DELETE CASCADE,
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      instance_track_id TEXT NOT NULL REFERENCES instance_tracks(id) ON DELETE CASCADE,
      format TEXT,
      bitrate INTEGER,
      size INTEGER,
      UNIQUE(unified_track_id, instance_track_id)
    );
    CREATE INDEX IF NOT EXISTS idx_track_sources_track ON track_sources(unified_track_id);
  `);
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

  // Phase 5 data model cleanup: drop peer-import columns from track_sources
  migrateTrackSources(db);

  return db;
}
