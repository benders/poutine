import { encodeId } from "../subsonic-response.js";
import { sqliteToIso } from "../../util/time.js";
import type { TrackRow, ReleaseGroupRow } from "./types.js";

// ── Content-type helpers ──────────────────────────────────────────────────────

const FORMAT_CONTENT_TYPE: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  alac: "audio/mp4",
};

export function contentTypeForFormat(format: string | null | undefined): string {
  if (!format) return "audio/mpeg";
  return FORMAT_CONTENT_TYPE[format.toLowerCase()] ?? "audio/mpeg";
}

// #199: sampling_rate / bit_depth / channel_count from the best source row
// (same ORDER BY as the legacy format/bitrate/size triplet above). Inlined
// into every track-projecting SELECT — see comment above for why we haven't
// CTE'd this yet. Substitute `?` for the unified_tracks id expression.
const AUDIO_SOURCE_FIELDS_SUBQUERY = `
      (SELECT ts.sampling_rate FROM track_sources ts WHERE ts.unified_track_id = ?
       ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS sampling_rate,
      (SELECT ts.bit_depth FROM track_sources ts WHERE ts.unified_track_id = ?
       ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bit_depth,
      (SELECT ts.channel_count FROM track_sources ts WHERE ts.unified_track_id = ?
       ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS channel_count,`;
export function audioSourceFields(idExpr: string): string {
  return AUDIO_SOURCE_FIELDS_SUBQUERY.replace(/\?/g, idExpr);
}

// ── Share ID helpers ──────────────────────────────────────────────────────────
// shareId is a raw `instance_*.remote_id` (typically a Navidrome 32-char hash).
// Collision across unrelated Navidromes is negligible, so the bare id is a
// usable cross-hub identifier — the receiving hub's search3 joins through
// instance_albums / instance_artists and resolves it to its own unified id.
// Prefer the 'local' source so that sharing an album from this hub's own
// library emits an id the owner's Navidrome holds.
export function pickAlbumShareId(db: import("better-sqlite3").Database, rgId: string): string | null {
  const row = db
    .prepare(
      `SELECT ia.remote_id
       FROM unified_release_sources urs
       JOIN unified_releases ur ON ur.id = urs.unified_release_id
       JOIN instance_albums ia ON ia.id = urs.instance_album_id
       WHERE ur.release_group_id = ?
       ORDER BY (ia.instance_id = 'local') DESC, ia.instance_id, ia.remote_id
       LIMIT 1`,
    )
    .get(rgId) as { remote_id: string } | undefined;
  return row?.remote_id ?? null;
}

export function pickArtistShareId(db: import("better-sqlite3").Database, artistId: string): string | null {
  const row = db
    .prepare(
      `SELECT ia.remote_id
       FROM unified_artist_sources uas
       JOIN instance_artists ia ON ia.id = uas.instance_artist_id
       WHERE uas.unified_artist_id = ?
       ORDER BY (ia.instance_id = 'local') DESC, ia.instance_id, ia.remote_id
       LIMIT 1`,
    )
    .get(artistId) as { remote_id: string } | undefined;
  return row?.remote_id ?? null;
}

// ── Song shape builder ────────────────────────────────────────────────────────

export function buildSong(row: TrackRow) {
  return {
    id: encodeId("t", row.id),
    parent: encodeId("al", row.rg_id),
    title: row.title,
    album: row.rg_name,
    artist: row.artist_name,
    track: row.track_number ?? undefined,
    year: row.rg_year ?? undefined,
    genre: row.genre ?? undefined,
    coverArt: row.rg_image_url ?? undefined,
    duration: row.duration_ms != null ? Math.round(row.duration_ms / 1000) : undefined,
    bitRate: row.bitrate ?? undefined,
    contentType: contentTypeForFormat(row.format),
    suffix: row.format?.toLowerCase() ?? undefined,
    size: row.size ?? undefined,
    isDir: false,
    isVideo: false,
    type: "music",
    albumId: encodeId("al", row.rg_id),
    artistId: encodeId("ar", row.artist_id),
    albumArtist: row.rg_artist_name,
    albumArtistId: encodeId("ar", row.rg_artist_id),
    discNumber: row.disc_number ?? undefined,
    sourceInstance: row.instance_name ?? undefined,
    musicBrainzId: row.musicbrainz_id ?? undefined,
    // #199: OpenSubsonic hi-res fields. `bitDepth: 0` is Navidrome's signal
    // for lossy formats — preserved verbatim so the Sonos cast gate can
    // distinguish "lossy" from "missing metadata".
    samplingRate: row.sampling_rate ?? undefined,
    bitDepth: row.bit_depth ?? undefined,
    channelCount: row.channel_count ?? undefined,
  };
}

// ── Album shape builder ───────────────────────────────────────────────────────

// ── Star annotation helper (#104) ─────────────────────────────────────────────
// Post-fetch lookup that mutates already-built Subsonic objects with their
// `starred` ISO timestamp for the requesting user. Encoded ids of the form
// `<prefix><uuid>` are stripped to match `user_stars.target_id`.
export function annotateStarred<T extends { id: string }>(
  db: import("better-sqlite3").Database,
  userId: string | undefined,
  kind: "track" | "album" | "artist",
  prefix: string,
  items: T[],
): void {
  if (!userId || items.length === 0) return;
  const rawIds = items.map((it) =>
    it.id.startsWith(prefix) ? it.id.slice(prefix.length) : it.id,
  );
  const placeholders = rawIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT target_id, starred_at FROM user_stars
       WHERE user_id = ? AND kind = ? AND target_id IN (${placeholders})`,
    )
    .all(userId, kind, ...rawIds) as Array<{
      target_id: string;
      starred_at: string;
    }>;
  if (rows.length === 0) return;
  const map = new Map(rows.map((r) => [r.target_id, r.starred_at]));
  for (let i = 0; i < items.length; i++) {
    const ts = map.get(rawIds[i]);
    if (ts) {
      (items[i] as T & { starred?: string }).starred = sqliteToIso(ts);
    }
  }
}

// ── Play-count annotation helper (#197) ───────────────────────────────────────
// Mirrors annotateStarred: post-fetch lookup that mutates already-built Subsonic
// objects with the requesting user's `playCount` + `played` (last-played ISO).
// Per-user counts (Subsonic spec). Only set when the user has plays, matching
// how `starred` is omitted when absent. Encoded ids (`<prefix><uuid>`) are
// stripped to match the unified id stored in play_events.
export function annotatePlays<T extends { id: string }>(
  playEvents: import("../../services/play-events.js").PlayEventService,
  userId: string | undefined,
  kind: "track" | "album",
  prefix: string,
  items: T[],
): void {
  if (!userId || items.length === 0) return;
  const rawIds = items.map((it) =>
    it.id.startsWith(prefix) ? it.id.slice(prefix.length) : it.id,
  );
  const stats =
    kind === "track"
      ? playEvents.getTrackStats(userId, rawIds)
      : playEvents.getAlbumStats(userId, rawIds);
  if (stats.size === 0) return;
  for (let i = 0; i < items.length; i++) {
    const s = stats.get(rawIds[i]);
    if (s && s.playCount > 0) {
      const item = items[i] as T & { playCount?: number; played?: string };
      item.playCount = s.playCount;
      if (s.played) item.played = s.played;
    }
  }
}

export function buildAlbum(row: ReleaseGroupRow) {
  return {
    id: encodeId("al", row.id),
    name: row.name,
    artist: row.artist_name,
    artistId: encodeId("ar", row.artist_id),
    coverArt: row.image_url ?? undefined,
    songCount: row.songCount,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    // OpenSubsonic `created` (ISO 8601) — when the album first appeared
    // on this hub. Required for client "Recently Added" sorting (#148).
    created: row.created_at ? sqliteToIso(row.created_at) : undefined,
  };
}
