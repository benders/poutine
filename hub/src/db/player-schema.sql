-- Poutine Player Database Schema (issue #215)
--
-- Owned exclusively by Player BE. Sits alongside hub.db; no ATTACH, no
-- cross-joins. Capability injection at entry point — Hub code holds zero
-- references to player.db, and Player code holds zero references to hub.db.
--
-- Phase 1 (#215) persisted the two values that are unambiguously
-- Player-private and have a "must survive restart" requirement:
--
--   - dlna_uuid        UDN broadcast by the DLNA MediaServer. Must be stable
--                       across restarts so renderers (notably Windows Media
--                       Player) don't re-add the server.
--   - cast_signing_key Random HMAC secret used to sign short-lived stream
--                       tokens for cast clients (Sonos etc).
--
-- Phase 3 (#217) moves Sonos + DLNA runtime settings into the same
-- key/value bag, with a one-shot migration from hub.db's `settings` table
-- on first boot:
--
--   - sonos_enabled       runtime Sonos toggle (#184)
--   - sonos_volume_cap    per-device volume ceiling (#184)
--   - lan_url             LAN-reachable base URL shared by Sonos+DLNA (#209)
--   - dlna_enabled        runtime DLNA MediaServer toggle (was env-only)
--   - dlna_friendly_name  display name advertised over SSDP (was env-only)
--
-- Device pairings + queue state may follow in later phases.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Generic key/value bag. Same shape as hub.db's `settings` table — terse,
-- typed-at-the-getter, easy to extend. Concrete keys (and any future typed
-- tables) live in services/player-settings.ts.
CREATE TABLE IF NOT EXISTS player_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
