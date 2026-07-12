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
function logMigration(msg: string): void {
  console.log(`[DB Migration] ${msg}`);
}

/**
 * Migrate users.password_hash (Argon2id) → users.password_enc (AES-256-GCM).
 *
 * Argon2id was one-way; we now need reversible storage so the server can
 * answer Subsonic u+t+s (MD5 token+salt) auth. Old hashes cannot be converted
 * — admins must reset passwords post-upgrade. Owner reset happens
 * automatically via seedOwner() when POUTINE_OWNER_PASSWORD is set; other
 * users must be re-set via the admin UI.
 */
function migrateUserPasswords(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(users)")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  if (!names.has("password_enc")) {
    logMigration("Adding password_enc column to users table");
    db.exec(
      "ALTER TABLE users ADD COLUMN password_enc TEXT NOT NULL DEFAULT ''",
    );
  }
  if (names.has("password_hash")) {
    logMigration("Dropping password_hash column from users table");
    db.exec("ALTER TABLE users DROP COLUMN password_hash");
  }
}

function ensureColumns(db: Database.Database): void {
  const instanceCols = db
    .prepare("PRAGMA table_info(instances)")
    .all() as Array<{ name: string }>;
  const instanceColNames = new Set(instanceCols.map((c) => c.name));
  if (!instanceColNames.has("last_sync_ok")) {
    logMigration("Adding last_sync_ok column to instances table");
    db.exec("ALTER TABLE instances ADD COLUMN last_sync_ok INTEGER");
  }
  if (!instanceColNames.has("last_sync_message")) {
    logMigration("Adding last_sync_message column to instances table");
    db.exec("ALTER TABLE instances ADD COLUMN last_sync_message TEXT");
  }
  if (!instanceColNames.has("musicfolder_id")) {
    // Issue #123: surface peers as Subsonic MusicFolders. Backfill stable ints
    // ordered by created_at so existing rows get deterministic IDs on upgrade.
    // SQLite forbids ADD COLUMN ... UNIQUE; add the column, backfill, then
    // enforce uniqueness via an index.
    logMigration("Adding musicfolder_id column to instances table");
    db.exec("ALTER TABLE instances ADD COLUMN musicfolder_id INTEGER");
    logMigration("Backfilling musicfolder_id values");
    db.exec(`
      UPDATE instances SET musicfolder_id = sub.rn FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM instances
      ) AS sub WHERE instances.id = sub.id
    `);
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_musicfolder_id ON instances(musicfolder_id) WHERE musicfolder_id IS NOT NULL",
  );

  // Issue #147: peer federation fields. Hard-cut from peers.yaml — peers are
  // now DB-authoritative and admitted via signed invitations.
  for (const col of [
    "public_key",
    "invitation_payload",
    "invitation_signature",
    "inviter_id",
    "inviter_url",
    "inviter_public_key",
  ] as const) {
    if (!instanceColNames.has(col)) {
      logMigration(`Adding ${col} column to instances table`);
      db.exec(`ALTER TABLE instances ADD COLUMN ${col} TEXT`);
    }
  }

  // Drop legacy peer rows that pre-date federation v5. They have no
  // public_key (the column didn't exist) so they can't be authenticated; the
  // only honest move under the hard-cut decision is to remove them. Operators
  // re-invite peers under the new flow. CASCADE clears instance_* mirror rows.
  const legacyPeers = db
    .prepare(
      "SELECT id FROM instances WHERE id != 'local' AND public_key IS NULL",
    )
    .all() as Array<{ id: string }>;
  if (legacyPeers.length > 0) {
    logMigration(
      `Removing ${legacyPeers.length} legacy peer instance row(s) without federation v5 invitation provenance: ${legacyPeers.map((r) => r.id).join(", ")}. Re-invite peers via /admin/peers/invite.`,
    );
    const del = db.prepare("DELETE FROM instances WHERE id = ?");
    const tx = db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    tx(legacyPeers.map((r) => r.id));
  }

  const trackSourceCols = db
    .prepare("PRAGMA table_info(track_sources)")
    .all() as Array<{ name: string }>;
  const trackSourceColNames = new Set(trackSourceCols.map((c) => c.name));
  if (!trackSourceColNames.has("preferred")) {
    logMigration("Adding preferred column to track_sources table");
    db.exec(
      "ALTER TABLE track_sources ADD COLUMN preferred INTEGER NOT NULL DEFAULT 0",
    );
    // Backfill: pick a preferred source per unified track on existing DBs so
    // streaming keeps working before the next merge runs. Same rule merge.ts
    // applies after every sync.
    logMigration("Backfilling preferred values in track_sources table");
    db.exec(`
      UPDATE track_sources SET preferred = 1 WHERE id IN (
        SELECT id FROM (
          SELECT ts.id,
            ROW_NUMBER() OVER (
              PARTITION BY ts.unified_track_id
              ORDER BY
                CASE LOWER(COALESCE(ts.format, ''))
                  WHEN 'flac' THEN 100
                  WHEN 'wav'  THEN 90
                  WHEN 'alac' THEN 85
                  WHEN 'opus' THEN 70
                  WHEN 'aac'  THEN 60
                  WHEN 'mp3'  THEN 50
                  WHEN 'ogg'  THEN 45
                  ELSE 30
                END DESC,
                COALESCE(ts.bitrate, 0) DESC,
                CASE WHEN ts.instance_id = 'local' THEN 1 ELSE 0 END DESC,
                ts.id ASC
            ) AS rn
          FROM track_sources ts
        ) WHERE rn = 1
      );
    `);
  }

  // #199: hi-res metadata for Sonos cast-time capability gate. Three nullable
  // columns each on instance_tracks and track_sources; populated by the next
  // sync pass (no backfill — missing rows behave as pre-#199, i.e. silent
  // pass-through, which is what the gate falls back to when unknown).
  const instanceTrackCols = db
    .prepare("PRAGMA table_info(instance_tracks)")
    .all() as Array<{ name: string }>;
  const instanceTrackColNames = new Set(instanceTrackCols.map((c) => c.name));
  for (const col of ["sampling_rate", "bit_depth", "channel_count"] as const) {
    if (!instanceTrackColNames.has(col)) {
      logMigration(`Adding ${col} column to instance_tracks table`);
      db.exec(`ALTER TABLE instance_tracks ADD COLUMN ${col} INTEGER`);
    }
  }
  const trackSourceColsAfter = db
    .prepare("PRAGMA table_info(track_sources)")
    .all() as Array<{ name: string }>;
  const trackSourceColNamesAfter = new Set(trackSourceColsAfter.map((c) => c.name));
  for (const col of ["sampling_rate", "bit_depth", "channel_count"] as const) {
    if (!trackSourceColNamesAfter.has(col)) {
      logMigration(`Adding ${col} column to track_sources table`);
      db.exec(`ALTER TABLE track_sources ADD COLUMN ${col} INTEGER`);
    }
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
  logMigration("Migrating track_sources table to new schema");
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
      sampling_rate INTEGER,
      bit_depth INTEGER,
      channel_count INTEGER,
      preferred INTEGER NOT NULL DEFAULT 0,
      UNIQUE(unified_track_id, instance_track_id)
    );
    CREATE INDEX IF NOT EXISTS idx_track_sources_track ON track_sources(unified_track_id);
  `);
}

/**
 * Issue #121: rewrite stream_operations with new fields. Drop old table on
 * upgrade — activity history is ephemeral and not preserved.
 */
function migrateStreamOperations(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(stream_operations)")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (cols.length > 0 && !names.has("kind")) {
    logMigration("Migrating stream_operations table to new schema");
    db.exec("DROP TABLE IF EXISTS stream_operations");
    db.exec(`
      CREATE TABLE stream_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'subsonic',
        username TEXT NOT NULL,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        client_name TEXT,
        client_version TEXT,
        peer_id TEXT,
        source_kind TEXT,
        source_peer_id TEXT,
        format TEXT,
        bitrate INTEGER,
        transcoded INTEGER NOT NULL DEFAULT 0,
        max_bitrate INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        duration_ms INTEGER,
        bytes_transferred INTEGER,
        error TEXT
      );
    `);
  }
}

/**
 * Issue #242: additive column so mergeLibraries()/runMergePipeline() can
 * persist post-merge orphan-audit counts alongside the sync operation that
 * triggered them.
 */
function migrateSyncOperations(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(sync_operations)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "details")) {
    logMigration("Adding details column to sync_operations table");
    db.exec("ALTER TABLE sync_operations ADD COLUMN details TEXT");
  }
}

/**
 * Issue #242: drop the `unified_track_id` FK (+ implicit CASCADE) on
 * playlist_tracks. unified_tracks is cleared and rebuilt on every merge —
 * the FK meant a merge CASCADE-DELETEd every playlist row. playlist_tracks
 * now follows the same no-FK/orphans-dropped-at-read convention as
 * user_stars/play_events, with rows carried across merges by id-remap
 * instead of relying on referential integrity.
 */
function migratePlaylistTracks(db: Database.Database): void {
  const fks = db
    .prepare("PRAGMA foreign_key_list(playlist_tracks)")
    .all() as Array<{ table: string; from: string }>;
  const hasTrackFk = fks.some(
    (fk) => fk.table === "unified_tracks" && fk.from === "unified_track_id",
  );
  if (!hasTrackFk) return;

  logMigration("Dropping unified_track_id FK from playlist_tracks table");
  db.exec(`
    CREATE TABLE playlist_tracks_new (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      unified_track_id TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (playlist_id, position)
    );
    INSERT INTO playlist_tracks_new (playlist_id, position, unified_track_id, added_at)
      SELECT playlist_id, position, unified_track_id, added_at FROM playlist_tracks;
    DROP TABLE playlist_tracks;
    ALTER TABLE playlist_tracks_new RENAME TO playlist_tracks;
  `);
}

/**
 * Issue #244: peer lifecycle state (active/disabled/tombstoned), orthogonal
 * to the pre-existing liveness `status` column. Additive columns on
 * `instances` plus the new `peer_tombstones` table (idempotent CREATE, so
 * fresh DBs already carrying it from schema.sql are unaffected).
 */
function migrateInstancesLifecycle(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(instances)")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("lifecycle")) {
    logMigration("Adding lifecycle column to instances table");
    db.exec(
      "ALTER TABLE instances ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'",
    );
  }
  if (!names.has("lifecycle_changed_at")) {
    logMigration("Adding lifecycle_changed_at column to instances table");
    db.exec("ALTER TABLE instances ADD COLUMN lifecycle_changed_at TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_tombstones (
      instance_id TEXT PRIMARY KEY,
      removed_by TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      signature TEXT NOT NULL
    );
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

  // Migrate users.password_hash → password_enc (issue #106)
  migrateUserPasswords(db);

  // Apply additive column migrations for existing DBs
  ensureColumns(db);

  // Phase 5 data model cleanup: drop peer-import columns from track_sources
  migrateTrackSources(db);

  // Issue #121: rewrite stream_operations schema
  migrateStreamOperations(db);

  // Issue #242: add sync_operations.details for orphan-audit persistence
  migrateSyncOperations(db);

  // Issue #242: drop playlist_tracks' unified_track_id FK (CASCADE hazard)
  migratePlaylistTracks(db);

  // Issue #244: add instances.lifecycle/lifecycle_changed_at + peer_tombstones
  migrateInstancesLifecycle(db);

  return db;
}
