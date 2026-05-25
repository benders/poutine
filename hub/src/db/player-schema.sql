-- Poutine Player Database Schema (issue #215)
--
-- Owned exclusively by Player BE. Sits alongside hub.db; no ATTACH, no
-- cross-joins. Capability injection at entry point — Hub code holds zero
-- references to player.db, and Player code holds zero references to hub.db.
--
-- Phase 1 (#215) persists only the two values that are unambiguously
-- Player-private and have a "must survive restart" requirement:
--
--   - dlna_uuid        UDN broadcast by the DLNA MediaServer. Must be stable
--                       across restarts so renderers (notably Windows Media
--                       Player) don't re-add the server.
--   - cast_signing_key Random HMAC secret used to sign short-lived stream
--                       tokens for cast clients (Sonos etc).
--
-- Further player settings (lan_url, sonos/dlna enabled, friendly name,
-- device pairings, queue state) move in Phase 3 (#217).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Generic key/value bag. Same shape as hub.db's `settings` table — terse,
-- typed-at-the-getter, easy to extend. Concrete keys (and any future typed
-- tables) live in services/player-settings.ts.
CREATE TABLE IF NOT EXISTS player_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
