-- Poutine Hub Database Schema
-- SQLite with WAL mode for concurrent reads

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Authentication & Users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                -- UUID
  username TEXT NOT NULL UNIQUE,
  password_enc TEXT NOT NULL DEFAULT '', -- AES-256-GCM(plaintext) ‖ tag, base64
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Federation: Instance Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,                -- UUID, or 'local' for self
  name TEXT NOT NULL,                 -- Human-readable label
  url TEXT NOT NULL UNIQUE,           -- Base URL of the Navidrome instance
  adapter_type TEXT NOT NULL DEFAULT 'subsonic',
  encrypted_credentials TEXT NOT NULL, -- AES-256-GCM encrypted JSON {username, password}
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'offline', -- online | offline | degraded
  last_seen TEXT,
  last_synced_at TEXT,
  last_sync_ok INTEGER,
  last_sync_message TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  server_version TEXT,
  -- Stable small integer for the Subsonic getMusicFolders / musicFolderId
  -- contract. Subsonic clients require integer folder IDs but instances are
  -- keyed on UUID. Assigned monotonically on insert; never reused.
  -- Uniqueness enforced via partial index below to match the on-upgrade
  -- migration shape (SQLite forbids ADD COLUMN ... UNIQUE).
  musicfolder_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_musicfolder_id
  ON instances(musicfolder_id) WHERE musicfolder_id IS NOT NULL;

-- ============================================================
-- Raw Instance Data (per-instance mirror)
-- ============================================================

CREATE TABLE IF NOT EXISTS instance_artists (
  id TEXT PRIMARY KEY,                -- composite: instanceId:remoteId
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,            -- Artist ID on the remote instance
  name TEXT NOT NULL,
  musicbrainz_id TEXT,                -- Artist MBID if available
  album_count INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  UNIQUE(instance_id, remote_id)
);

CREATE TABLE IF NOT EXISTS instance_albums (
  id TEXT PRIMARY KEY,                -- composite: instanceId:remoteId
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,            -- Album ID on the remote instance
  name TEXT NOT NULL,
  artist_id TEXT NOT NULL,            -- References instance_artists(id)
  artist_name TEXT NOT NULL,
  year INTEGER,
  genre TEXT,
  musicbrainz_id TEXT,                -- Release MBID
  release_group_mbid TEXT,            -- Release Group MBID
  track_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  cover_art_id TEXT,                  -- Remote cover art ID
  created_at TEXT,
  UNIQUE(instance_id, remote_id)
);

CREATE TABLE IF NOT EXISTS instance_tracks (
  id TEXT PRIMARY KEY,                -- composite: instanceId:remoteId
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,            -- Track ID on the remote instance
  album_id TEXT NOT NULL,             -- References instance_albums(id)
  title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  duration_ms INTEGER,
  bitrate INTEGER,                    -- kbps
  format TEXT,                        -- flac, mp3, aac, opus, etc.
  size INTEGER,                       -- bytes
  musicbrainz_id TEXT,                -- Recording MBID
  year INTEGER,
  genre TEXT,
  UNIQUE(instance_id, remote_id)
);

-- ============================================================
-- Unified / Merged Library
-- ============================================================

CREATE TABLE IF NOT EXISTS unified_artists (
  id TEXT PRIMARY KEY,                -- UUID
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,      -- Lowercased, stripped for matching
  musicbrainz_id TEXT UNIQUE,         -- Artist MBID (unique when present)
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unified_artists_normalized ON unified_artists(name_normalized);
CREATE INDEX IF NOT EXISTS idx_unified_artists_mbid ON unified_artists(musicbrainz_id);

CREATE TABLE IF NOT EXISTS unified_artist_sources (
  unified_artist_id TEXT NOT NULL REFERENCES unified_artists(id) ON DELETE CASCADE,
  instance_artist_id TEXT NOT NULL REFERENCES instance_artists(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  PRIMARY KEY (unified_artist_id, instance_artist_id)
);

CREATE TABLE IF NOT EXISTS unified_release_groups (
  id TEXT PRIMARY KEY,                -- UUID
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES unified_artists(id),
  musicbrainz_id TEXT UNIQUE,         -- Release Group MBID
  year INTEGER,
  genre TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unified_rg_artist ON unified_release_groups(artist_id);
CREATE INDEX IF NOT EXISTS idx_unified_rg_mbid ON unified_release_groups(musicbrainz_id);
CREATE INDEX IF NOT EXISTS idx_unified_rg_normalized ON unified_release_groups(name_normalized);

CREATE TABLE IF NOT EXISTS unified_releases (
  id TEXT PRIMARY KEY,                -- UUID
  release_group_id TEXT NOT NULL REFERENCES unified_release_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  musicbrainz_id TEXT UNIQUE,         -- Release MBID
  edition TEXT,                       -- "Deluxe", "Japan", "Remaster", etc.
  track_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unified_releases_rg ON unified_releases(release_group_id);

CREATE TABLE IF NOT EXISTS unified_release_sources (
  unified_release_id TEXT NOT NULL REFERENCES unified_releases(id) ON DELETE CASCADE,
  instance_album_id TEXT NOT NULL REFERENCES instance_albums(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  PRIMARY KEY (unified_release_id, instance_album_id)
);

CREATE TABLE IF NOT EXISTS unified_tracks (
  id TEXT PRIMARY KEY,                -- UUID
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES unified_releases(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES unified_artists(id),
  musicbrainz_id TEXT,                -- Recording MBID (not unique - same recording can appear on multiple releases)
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  duration_ms INTEGER,
  genre TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unified_tracks_release ON unified_tracks(release_id);
CREATE INDEX IF NOT EXISTS idx_unified_tracks_artist ON unified_tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_unified_tracks_mbid ON unified_tracks(musicbrainz_id);

CREATE TABLE IF NOT EXISTS track_sources (
  id TEXT PRIMARY KEY,                -- UUID
  unified_track_id TEXT NOT NULL REFERENCES unified_tracks(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  instance_track_id TEXT NOT NULL REFERENCES instance_tracks(id) ON DELETE CASCADE,
  format TEXT,
  bitrate INTEGER,
  size INTEGER,
  preferred INTEGER NOT NULL DEFAULT 0,
  UNIQUE(unified_track_id, instance_track_id)
);

CREATE INDEX IF NOT EXISTS idx_track_sources_track ON track_sources(unified_track_id);

-- ============================================================
-- Settings (key-value store)
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- Playlists
-- ============================================================

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,                -- UUID
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  comment TEXT,
  public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  unified_track_id TEXT NOT NULL REFERENCES unified_tracks(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, position)
);

-- ============================================================
-- Per-User Stars (issue #104)
-- ============================================================
-- Per-user starred tracks/albums/artists. Targets are unified_*.id UUIDs.
-- No FK to unified_* — target rows can be transiently absent during sync;
-- orphans are pruned at read time via JOIN. Stars are local to the hub the
-- user logs into; not federated.

CREATE TABLE IF NOT EXISTS user_stars (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('track','album','artist')),
  target_id  TEXT NOT NULL,
  starred_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_user_stars_lookup
  ON user_stars(user_id, kind, starred_at DESC);

-- ============================================================
-- Art Cache Metadata
-- ============================================================

CREATE TABLE IF NOT EXISTS art_cache (
  id TEXT PRIMARY KEY,              -- cache key: encodedCoverArtId or encodedCoverArtId:size
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,            -- file size in bytes
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Activity Tracking: Sync Operations
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_operations (
  id TEXT PRIMARY KEY,              -- UUID
  type TEXT NOT NULL,               -- 'manual' | 'auto'
  scope TEXT NOT NULL,              -- 'local' | 'peer'
  scope_id TEXT,                    -- peer id when scope = 'peer'
  status TEXT NOT NULL,             -- 'running' | 'complete' | 'failed'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,              -- milliseconds
  artist_count INTEGER DEFAULT 0,
  album_count INTEGER DEFAULT 0,
  track_count INTEGER DEFAULT 0,
  errors TEXT                       -- JSON array of error strings
);

-- ============================================================
-- Activity Tracking: Stream Operations
-- ============================================================

CREATE TABLE IF NOT EXISTS stream_operations (
  id TEXT PRIMARY KEY,              -- UUID
  kind TEXT NOT NULL DEFAULT 'subsonic',  -- 'subsonic' | 'proxy'
  username TEXT NOT NULL,           -- Subsonic username (or remote user for proxy)
  track_id TEXT NOT NULL,           -- unified_tracks.id
  track_title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  client_name TEXT,                 -- Subsonic c= param
  client_version TEXT,              -- Subsonic v= param
  peer_id TEXT,                     -- non-null when kind='proxy'
  source_kind TEXT,                 -- 'local' | 'peer'
  source_peer_id TEXT,              -- when source_kind='peer'
  format TEXT,                      -- source format
  bitrate INTEGER,                  -- source bitrate
  transcoded INTEGER NOT NULL DEFAULT 0,
  max_bitrate INTEGER,              -- requested max bitrate when transcoded
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,              -- playback duration in milliseconds
  bytes_transferred INTEGER,        -- bytes streamed
  error TEXT
);
