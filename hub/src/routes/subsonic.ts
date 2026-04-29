import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import type { Peer } from "../federation/peers.js";
import { requireSubsonicAuth, requireSubsonicAuthBinary } from "../auth/subsonic-auth.js";
import {
  sendSubsonicOk,
  sendSubsonicError,
  sendBinaryError,
  encodeId,
  decodeId,
} from "./subsonic-response.js";
import { decodeCoverArtId } from "../library/cover-art.js";
import { normalizeName } from "../library/normalize.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { applyTranscodeRule, buildStreamParams } from "./stream-params.js";
import type { StreamTrackingService } from "../services/stream-tracking.js";

// Extend Fastify app type for stream tracking
declare module "fastify" {
  interface FastifyInstance {
    streamTracking: StreamTrackingService;
  }
}
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

function contentTypeForFormat(format: string | null | undefined): string {
  if (!format) return "audio/mpeg";
  return FORMAT_CONTENT_TYPE[format.toLowerCase()] ?? "audio/mpeg";
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
  image_url: string | null;
}

interface ReleaseGroupRow {
  id: string;
  name: string;
  artist_id: string;
  artist_name: string;
  year: number | null;
  genre: string | null;
  image_url: string | null;
  songCount: number;
}

interface TrackRow {
  id: string;
  title: string;
  track_number: number | null;
  disc_number: number | null;
  duration_ms: number | null;
  genre: string | null;
  artist_id: string;
  artist_name: string;
  rg_id: string;
  rg_name: string;
  rg_year: number | null;
  rg_image_url: string | null;
  format: string | null;
  bitrate: number | null;
  size: number | null;
  instance_name: string | null;
  musicbrainz_id: string | null;
}

interface GenreRow {
  genre: string;
  albumCount: number;
  songCount: number;
}

// ── Source selection subquery ─────────────────────────────────────────────────
// Returns the best source for a track (highest bitrate). Used for format,
// bitrate, size, and instance_name. Copy-pasted 3x in getAlbum, getSong,
// search3 — fine for now, could be a CTE/lateral join if query plans get heavy.
const BEST_SOURCE_SUBQUERY = `
  (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ?
   ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1)
`;

const BEST_SOURCE_INSTANCE_SUBQUERY = `
  (SELECT i.name FROM track_sources ts
   JOIN instances i ON i.id = ts.instance_id
   WHERE ts.unified_track_id = ?
   ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1)
`;

// ── Share ID helpers ──────────────────────────────────────────────────────────
// shareId is a raw `instance_*.remote_id` (typically a Navidrome 32-char hash).
// Collision across unrelated Navidromes is negligible, so the bare id is a
// usable cross-hub identifier — the receiving hub's search3 joins through
// instance_albums / instance_artists and resolves it to its own unified id.
// Prefer the 'local' source so that sharing an album from this hub's own
// library emits an id the owner's Navidrome holds.
function pickAlbumShareId(db: import("better-sqlite3").Database, rgId: string): string | null {
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

function pickArtistShareId(db: import("better-sqlite3").Database, artistId: string): string | null {
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

function buildSong(row: TrackRow) {
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
    discNumber: row.disc_number ?? undefined,
    sourceInstance: row.instance_name ?? undefined,
    musicBrainzId: row.musicbrainz_id ?? undefined,
  };
}

// ── Album shape builder ───────────────────────────────────────────────────────

// ── Star annotation helper (#104) ─────────────────────────────────────────────
// Post-fetch lookup that mutates already-built Subsonic objects with their
// `starred` ISO timestamp for the requesting user. Encoded ids of the form
// `<prefix><uuid>` are stripped to match `user_stars.target_id`.
function annotateStarred<T extends { id: string }>(
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
      const isoTs = ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
      (items[i] as T & { starred?: string }).starred = isoTs;
    }
  }
}

function buildAlbum(row: ReleaseGroupRow) {
  return {
    id: encodeId("al", row.id),
    name: row.name,
    artist: row.artist_name,
    artistId: encodeId("ar", row.artist_id),
    coverArt: row.image_url ?? undefined,
    songCount: row.songCount,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export const subsonicRoutes: FastifyPluginAsync = async (app) => {
  const preHandler = requireSubsonicAuth;

  /**
   * Register a handler for both GET and POST, with and without the .view suffix.
   * All Subsonic endpoints accept both methods and the optional .view suffix.
   */
  function route(path: string, handler: RouteHandlerMethod): void {
    app.get(path, { preHandler }, handler);
    app.get(`${path}.view`, { preHandler }, handler);
    app.post(path, { preHandler }, handler);
    app.post(`${path}.view`, { preHandler }, handler);
  }

  // ── ping ────────────────────────────────────────────────────────────────────

  route("/ping", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, {});
  });

  // ── getLicense ──────────────────────────────────────────────────────────────

  route("/getLicense", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, {
      license: { valid: true, email: "", licenseExpires: "" },
    });
  });

  // ── getMusicFolders ─────────────────────────────────────────────────────────

  route("/getMusicFolders", async (request, reply) => {
    const q = request.query as Record<string, string>;
    // Issue #123: each known instance (local + active peers) is exposed as a
    // MusicFolder so 3rd-party Subsonic clients can scope browsing per peer.
    const rows = app.db
      .prepare(
        `SELECT musicfolder_id AS id, name FROM instances
         WHERE musicfolder_id IS NOT NULL
         ORDER BY musicfolder_id`,
      )
      .all() as Array<{ id: number; name: string }>;
    sendSubsonicOk(reply, q, {
      musicFolders: { musicFolder: rows },
    });
  });

  // ── getGenres ───────────────────────────────────────────────────────────────

  route("/getGenres", async (request, reply) => {
    const q = request.query as Record<string, string>;

    const rows = app.db
      .prepare(
        `SELECT g.genre,
          (SELECT COUNT(*) FROM unified_release_groups WHERE genre = g.genre) AS albumCount,
          (SELECT COUNT(*) FROM unified_tracks WHERE genre = g.genre) AS songCount
        FROM (
          SELECT DISTINCT genre FROM unified_release_groups WHERE genre IS NOT NULL
          UNION
          SELECT DISTINCT genre FROM unified_tracks WHERE genre IS NOT NULL
        ) g
        ORDER BY g.genre`,
      )
      .all() as GenreRow[];

    sendSubsonicOk(reply, q, {
      genres: {
        genre: rows.map((r) => ({
          value: r.genre,
          songCount: r.songCount,
          albumCount: r.albumCount,
        })),
      },
    });
  });

  // ── getArtists ──────────────────────────────────────────────────────────────

  route("/getArtists", async (request, reply) => {
    const q = request.query as Record<string, string>;

    const artists = app.db
      .prepare(
        `SELECT ua.id, ua.name, ua.image_url,
          COUNT(urg.id) AS albumCount
        FROM unified_artists ua
        LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
        GROUP BY ua.id, ua.name
        ORDER BY ua.name_normalized`,
      )
      .all() as ArtistRow[];

    const indexMap = new Map<string, typeof artists>();
    for (const a of artists) {
      const firstChar = a.name.trim().toUpperCase()[0] ?? "#";
      const key = /[A-Z]/.test(firstChar) ? firstChar : "#";
      if (!indexMap.has(key)) indexMap.set(key, []);
      indexMap.get(key)!.push(a);
    }

    const index = [...indexMap.entries()]
      .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
      .map(([name, list]) => ({
        name,
        artist: list.map((a) => ({
          id: encodeId("ar", a.id),
          name: a.name,
          albumCount: a.albumCount,
          coverArt: a.image_url ?? undefined,
        })),
      }));

    sendSubsonicOk(reply, q, {
      artists: { ignoredArticles: "The An A", index },
    });
  });

  // ── getIndexes ──────────────────────────────────────────────────────────────

  route("/getIndexes", async (request, reply) => {
    const q = request.query as Record<string, string>;

    const artists = app.db
      .prepare(
        `SELECT ua.id, ua.name,
          COUNT(urg.id) AS albumCount
        FROM unified_artists ua
        LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
        GROUP BY ua.id, ua.name
        ORDER BY ua.name_normalized`,
      )
      .all() as ArtistRow[];

    const indexMap = new Map<string, typeof artists>();
    for (const a of artists) {
      const firstChar = a.name.trim().toUpperCase()[0] ?? "#";
      const key = /[A-Z]/.test(firstChar) ? firstChar : "#";
      if (!indexMap.has(key)) indexMap.set(key, []);
      indexMap.get(key)!.push(a);
    }

    const index = [...indexMap.entries()]
      .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
      .map(([name, list]) => ({
        name,
        artist: list.map((a) => ({
          id: encodeId("ar", a.id),
          name: a.name,
          albumCount: a.albumCount,
        })),
      }));

    sendSubsonicOk(reply, q, {
      indexes: {
        ignoredArticles: "The An A",
        lastModified: Date.now(),
        index,
      },
    });
  });

  // ── getArtist ───────────────────────────────────────────────────────────────

  route("/getArtist", async (request, reply) => {
    const q = request.query as Record<string, string>;

    let artistId: string;
    try {
      artistId = decodeId(q.id ?? "", "ar");
    } catch {
      sendSubsonicError(reply, 70, "Artist not found", q);
      return;
    }

    const artist = app.db
      .prepare("SELECT id, name, image_url FROM unified_artists WHERE id = ?")
      .get(artistId) as { id: string; name: string; image_url: string | null } | undefined;

    if (!artist) {
      sendSubsonicError(reply, 70, "Artist not found", q);
      return;
    }

    const albums = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url,
          COUNT(ut.id) AS songCount
        FROM unified_release_groups urg
        JOIN unified_artists ua ON ua.id = urg.artist_id
        LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
        LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
        WHERE urg.artist_id = ?
        GROUP BY urg.id
        ORDER BY urg.year DESC, urg.name_normalized`,
      )
      .all(artistId) as ReleaseGroupRow[];

    const shareId = pickArtistShareId(app.db, artist.id);

    const builtAlbums = albums.map(buildAlbum);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    const artistObj: {
      id: string;
      name: string;
      albumCount: number;
      coverArt?: string;
      shareId?: string;
      album: ReturnType<typeof buildAlbum>[];
      starred?: string;
    } = {
      id: encodeId("ar", artist.id),
      name: artist.name,
      albumCount: albums.length,
      coverArt: artist.image_url ?? undefined,
      shareId: shareId ?? undefined,
      album: builtAlbums,
    };
    annotateStarred(app.db, request.subsonicUser?.id, "artist", "ar", [artistObj]);
    sendSubsonicOk(reply, q, { artist: artistObj });
  });

// ── getArtistInfo2 ────────────────────────────────────────────────────────

  route("/getArtistInfo2", async (request, reply) => {
    const q = request.query as Record<string, string>;

    let artistId: string;
    try {
      artistId = decodeId(q.id ?? "", "ar");
    } catch {
      sendSubsonicError(reply, 70, "Artist not found", q);
      return;
    }

    const artistRow = app.db
      .prepare("SELECT id, name, musicbrainz_id, image_url FROM unified_artists WHERE id = ?")
      .get(artistId) as { id: string; name: string; musicbrainz_id: string | null; image_url: string | null } | undefined;

    if (!artistRow) {
      sendSubsonicError(reply, 70, "Artist not found", q);
      return;
    }

    // Get image URL from unified_artists (may be Last.fm URL or encoded cover art ID)
    let imageUrl: string | undefined;
    if (artistRow.image_url) {
      if (artistRow.image_url.startsWith("https://")) {
        // It's a Last.fm URL, return directly
        imageUrl = artistRow.image_url;
      } else {
        // It's an encoded cover art ID, return as-is for client to resolve
        imageUrl = artistRow.image_url;
      }
    }

    // If no image URL and Last.fm is enabled, try to fetch from Last.fm
    if (!imageUrl && app.lastFmClient?.isEnabled()) {
      try {
        const lastFmInfo = await app.lastFmClient.getArtistInfo(
          artistRow.name,
          artistRow.musicbrainz_id ?? undefined
        );

        if (lastFmInfo) {
          const bestImage = app.lastFmClient.getBestImage(lastFmInfo);
          if (bestImage) {
            // Cache the image URL in the database
            app.db
              .prepare("UPDATE unified_artists SET image_url = ? WHERE id = ?")
              .run(bestImage, artistId);
            imageUrl = bestImage;
            request.log.info(`Cached Last.fm image for artist ${artistRow.name}`);
          }
        }
      } catch (err) {
        request.log.warn(`Failed to fetch Last.fm info for artist ${artistRow.name}: ${err}`);
      }
    }

    sendSubsonicOk(reply, q, {
      artistInfo2: {
        artist: {
          id: encodeId("ar", artistRow.id),
          name: artistRow.name,
          musicBrainzId: artistRow.musicbrainz_id ?? undefined,
        },
        smallImageUrl: imageUrl,
        mediumImageUrl: imageUrl,
        largeImageUrl: imageUrl,
        musicBrainzId: artistRow.musicbrainz_id ?? undefined,
      },
    });
  });

  // ── getAlbumList2 ───────────────────────────────────────────────────────────

  route("/getAlbumList2", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const type = q.type ?? "newest";
    const size = Math.min(parseInt(q.size ?? "10", 10), 500);
    const offset = parseInt(q.offset ?? "0", 10);
    const fromYear = q.fromYear ? parseInt(q.fromYear, 10) : undefined;
    const toYear = q.toYear ? parseInt(q.toYear, 10) : undefined;
    const genre = q.genre;
    // Standard Subsonic param (issue #123). q.instanceId is an EOL alias
    // kept for in-tree callers mid-migration — slated for removal; do not
    // adopt in new code. See docs/opensubsonic.md.
    let instanceId: string | undefined = q.instanceId;
    if (!instanceId && q.musicFolderId) {
      const row = app.db
        .prepare("SELECT id FROM instances WHERE musicfolder_id = ?")
        .get(parseInt(q.musicFolderId, 10)) as { id: string } | undefined;
      // Unknown folder id → empty result, matching how Subsonic clients expect
      // an unrecognized scope to surface (no rows rather than an error).
      if (!row) {
        return sendSubsonicOk(reply, q, { albumList2: { album: [] } });
      }
      instanceId = row.id;
    }

    let orderBy = "urg.created_at DESC";
    let where = "WHERE 1=1";
    const params: unknown[] = [];

    // type=starred — restrict to albums starred by the requesting user. (#104)
    if (type === "starred") {
      where +=
        " AND EXISTS (SELECT 1 FROM user_stars us " +
        "WHERE us.user_id = ? AND us.kind = 'album' AND us.target_id = urg.id)";
      params.push(request.subsonicUser.id);
    }

    // EXISTS avoids row multiplication when an album has multiple sources.
    if (instanceId) {
      where +=
        " AND EXISTS (SELECT 1 FROM unified_releases ur2 " +
        "JOIN unified_release_sources urs ON urs.unified_release_id = ur2.id " +
        "JOIN instance_albums ia ON ia.id = urs.instance_album_id " +
        "WHERE ur2.release_group_id = urg.id AND ia.instance_id = ?)";
      params.push(instanceId);
    }

    switch (type) {
      case "alphabeticalByName":
        orderBy = "urg.name_normalized ASC";
        break;
      case "alphabeticalByArtist":
        orderBy = "ua.name_normalized ASC, urg.name_normalized ASC";
        break;
      case "byYear":
        if (fromYear !== undefined) {
          where += " AND urg.year >= ?";
          params.push(fromYear);
        }
        if (toYear !== undefined) {
          where += " AND urg.year <= ?";
          params.push(toYear);
        }
        orderBy =
          (fromYear ?? 0) <= (toYear ?? 9999)
            ? "urg.year ASC"
            : "urg.year DESC";
        break;
      case "byGenre":
        if (genre) {
          where += " AND urg.genre = ?";
          params.push(genre);
        }
        orderBy = "urg.name_normalized ASC";
        break;
      case "random":
        orderBy = "RANDOM()";
        break;
      case "starred":
        orderBy = "urg.name_normalized ASC";
        break;
      // frequent, recent, highest — fall back to newest (no play tracking yet)
      default:
        orderBy = "urg.created_at DESC";
        break;
    }

    params.push(size, offset);

    const albums = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url,
          COUNT(ut.id) AS songCount
        FROM unified_release_groups urg
        JOIN unified_artists ua ON ua.id = urg.artist_id
        LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
        LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
        ${where}
        GROUP BY urg.id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
      .all(...params) as ReleaseGroupRow[];

    const builtAlbums = albums.map(buildAlbum);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    sendSubsonicOk(reply, q, { albumList2: { album: builtAlbums } });
  });

  // ── getAlbum ────────────────────────────────────────────────────────────────

  route("/getAlbum", async (request, reply) => {
    const q = request.query as Record<string, string>;

    let rgId: string;
    try {
      rgId = decodeId(q.id ?? "", "al");
    } catch {
      sendSubsonicError(reply, 70, "Album not found", q);
      return;
    }

    const rg = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url
        FROM unified_release_groups urg
        JOIN unified_artists ua ON ua.id = urg.artist_id
        WHERE urg.id = ?`,
      )
      .get(rgId) as
      | {
          id: string;
          name: string;
          artist_id: string;
          artist_name: string;
          year: number | null;
          genre: string | null;
          image_url: string | null;
        }
      | undefined;

    if (!rg) {
      sendSubsonicError(reply, 70, "Album not found", q);
      return;
    }

    // Pick the release with the most tracks (fall back to first by id)
    const release = app.db
      .prepare(
        `SELECT id FROM unified_releases
        WHERE release_group_id = ?
        ORDER BY track_count DESC, id ASC
        LIMIT 1`,
      )
      .get(rgId) as { id: string } | undefined;

    const tracks: TrackRow[] = release
      ? (app.db
          .prepare(
            `SELECT
              ut.id, ut.title, ut.track_number, ut.disc_number,
              ut.duration_ms, ut.genre, ut.musicbrainz_id,
              ut.artist_id, ua.name AS artist_name,
              urg.id AS rg_id, urg.name AS rg_name,
              urg.year AS rg_year, urg.image_url AS rg_image_url,
              (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
              (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
              (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
              ${BEST_SOURCE_INSTANCE_SUBQUERY.replace('?', 'ut.id')} AS instance_name
            FROM unified_tracks ut
            JOIN unified_artists ua ON ua.id = ut.artist_id
            JOIN unified_releases ur ON ur.id = ut.release_id
            JOIN unified_release_groups urg ON urg.id = ur.release_group_id
            WHERE ut.release_id = ?
            ORDER BY ut.disc_number, ut.track_number, ut.id`,
          )
          .all(release.id) as TrackRow[])
      : [];

    const totalDuration = tracks.reduce(
      (sum, t) => sum + (t.duration_ms != null ? Math.round(t.duration_ms / 1000) : 0),
      0,
    );

    const shareId = pickAlbumShareId(app.db, rg.id);

    const builtSongs = tracks.map(buildSong);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", builtSongs);
    const albumObj: {
      id: string;
      name: string;
      artist: string;
      artistId: string;
      coverArt?: string;
      songCount: number;
      duration: number;
      year?: number;
      genre?: string;
      shareId?: string;
      song: ReturnType<typeof buildSong>[];
      starred?: string;
    } = {
      id: encodeId("al", rg.id),
      name: rg.name,
      artist: rg.artist_name,
      artistId: encodeId("ar", rg.artist_id),
      coverArt: rg.image_url ?? undefined,
      songCount: tracks.length,
      duration: totalDuration,
      year: rg.year ?? undefined,
      genre: rg.genre ?? undefined,
      shareId: shareId ?? undefined,
      song: builtSongs,
    };
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", [albumObj]);
    sendSubsonicOk(reply, q, {
      album: albumObj,
    });
  });

  // ── getSong ─────────────────────────────────────────────────────────────────

  route("/getSong", async (request, reply) => {
    const q = request.query as Record<string, string>;

    let trackId: string;
    try {
      trackId = decodeId(q.id ?? "", "t");
    } catch {
      sendSubsonicError(reply, 70, "Song not found", q);
      return;
    }

    const row = app.db
      .prepare(
        `SELECT
          ut.id, ut.title, ut.track_number, ut.disc_number,
          ut.duration_ms, ut.genre, ut.musicbrainz_id,
          ut.artist_id, ua.name AS artist_name,
          urg.id AS rg_id, urg.name AS rg_name,
          urg.year AS rg_year, urg.image_url AS rg_image_url,
          (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
          (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
          (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
          ${BEST_SOURCE_INSTANCE_SUBQUERY.replace('?', 'ut.id')} AS instance_name
        FROM unified_tracks ut
        JOIN unified_artists ua ON ua.id = ut.artist_id
        JOIN unified_releases ur ON ur.id = ut.release_id
        JOIN unified_release_groups urg ON urg.id = ur.release_group_id
        WHERE ut.id = ?`,
      )
      .get(trackId) as TrackRow | undefined;

    if (!row) {
      sendSubsonicError(reply, 70, "Song not found", q);
      return;
    }

    const built = buildSong(row);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", [built]);
    sendSubsonicOk(reply, q, { song: built });
  });

  // ── search3 ─────────────────────────────────────────────────────────────────

  route("/search3", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const query = q.query ?? "";
    const artistCount = parseInt(q.artistCount ?? "20", 10);
    const albumCount = parseInt(q.albumCount ?? "20", 10);
    const songCount = parseInt(q.songCount ?? "20", 10);
    const artistOffset = parseInt(q.artistOffset ?? "0", 10);
    const albumOffset = parseInt(q.albumOffset ?? "0", 10);
    const songOffset = parseInt(q.songOffset ?? "0", 10);
    const like = `%${normalizeName(query)}%`;

    // ID lookup: allow pasting an internal ID (optionally prefixed ar/al/t)
    // or a MusicBrainz ID into the search box. Strip known prefixes so the
    // bare UUID matches id/musicbrainz_id columns directly.
    const trimmed = query.trim();
    const artistIdCandidate = trimmed.startsWith("ar") ? trimmed.slice(2) : trimmed;
    const albumIdCandidate = trimmed.startsWith("al") ? trimmed.slice(2) : trimmed;
    const songIdCandidate = trimmed.startsWith("t") ? trimmed.slice(1) : trimmed;

    const artists = app.db
      .prepare(
        `SELECT ua.id, ua.name, COUNT(urg.id) AS albumCount
        FROM unified_artists ua
        LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
        WHERE ua.name_normalized LIKE ?
          OR ua.id = ? OR ua.id = ?
          OR ua.musicbrainz_id = ? OR ua.musicbrainz_id = ?
          OR EXISTS (
            SELECT 1 FROM unified_artist_sources uas
            JOIN instance_artists iar ON iar.id = uas.instance_artist_id
            WHERE uas.unified_artist_id = ua.id AND iar.remote_id = ?
          )
        GROUP BY ua.id
        ORDER BY ua.name_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(
        like,
        trimmed,
        artistIdCandidate,
        trimmed,
        artistIdCandidate,
        trimmed,
        artistCount,
        artistOffset,
      ) as ArtistRow[];

    const albums = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url,
          COUNT(ut.id) AS songCount
        FROM unified_release_groups urg
        JOIN unified_artists ua ON ua.id = urg.artist_id
        LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
        LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
        WHERE urg.name_normalized LIKE ?
          OR urg.id = ? OR urg.id = ?
          OR urg.musicbrainz_id = ? OR urg.musicbrainz_id = ?
          OR EXISTS (
            SELECT 1 FROM unified_release_sources urs
            JOIN unified_releases ur2 ON ur2.id = urs.unified_release_id
            JOIN instance_albums ial ON ial.id = urs.instance_album_id
            WHERE ur2.release_group_id = urg.id AND ial.remote_id = ?
          )
        GROUP BY urg.id
        ORDER BY urg.name_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(
        like,
        trimmed,
        albumIdCandidate,
        trimmed,
        albumIdCandidate,
        trimmed,
        albumCount,
        albumOffset,
      ) as ReleaseGroupRow[];

    const songs = app.db
      .prepare(
        `SELECT
          ut.id, ut.title, ut.track_number, ut.disc_number,
          ut.duration_ms, ut.genre, ut.musicbrainz_id,
          ut.artist_id, ua.name AS artist_name,
          urg.id AS rg_id, urg.name AS rg_name,
          urg.year AS rg_year, urg.image_url AS rg_image_url,
          (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
          (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
          (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
          ${BEST_SOURCE_INSTANCE_SUBQUERY.replace('?', 'ut.id')} AS instance_name
        FROM unified_tracks ut
        JOIN unified_artists ua ON ua.id = ut.artist_id
        JOIN unified_releases ur ON ur.id = ut.release_id
        JOIN unified_release_groups urg ON urg.id = ur.release_group_id
        WHERE ut.title_normalized LIKE ?
          OR ut.id = ? OR ut.id = ?
          OR ut.musicbrainz_id = ? OR ut.musicbrainz_id = ?
          OR EXISTS (
            SELECT 1 FROM track_sources ts2
            JOIN instance_tracks it ON it.id = ts2.instance_track_id
            WHERE ts2.unified_track_id = ut.id AND it.remote_id = ?
          )
        ORDER BY ut.title_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(
        like,
        trimmed,
        songIdCandidate,
        trimmed,
        songIdCandidate,
        trimmed,
        songCount,
        songOffset,
      ) as TrackRow[];

    const builtArtists = artists.map((a) => ({
      id: encodeId("ar", a.id),
      name: a.name,
      albumCount: a.albumCount,
    }));
    const builtAlbums = albums.map(buildAlbum);
    const builtSongs = songs.map(buildSong);
    annotateStarred(app.db, request.subsonicUser?.id, "artist", "ar", builtArtists);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", builtSongs);
    sendSubsonicOk(reply, q, {
      searchResult3: {
        artist: builtArtists,
        album: builtAlbums,
        song: builtSongs,
      },
    });
  });

  // ── getCoverArt ─────────────────────────────────────────────────────────────
  // Binary endpoint: uses requireSubsonicAuthBinary so auth failures return
  // real HTTP error codes instead of a 200+JSON Subsonic envelope.

  function binaryRoute(path: string, handler: RouteHandlerMethod): void {
    const binaryPreHandler = requireSubsonicAuthBinary;
    app.get(path, { preHandler: binaryPreHandler }, handler);
    app.get(`${path}.view`, { preHandler: binaryPreHandler }, handler);
    app.post(path, { preHandler: binaryPreHandler }, handler);
    app.post(`${path}.view`, { preHandler: binaryPreHandler }, handler);
  }

  binaryRoute("/getCoverArt", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const id = q.id ?? "";
    const size = q.size;

    let instanceId: string;
    let coverArtId: string;
    try {
      const decoded = decodeCoverArtId(id);
      instanceId = decoded.instanceId;
      coverArtId = decoded.coverArtId;
    } catch {
      sendBinaryError(reply, 400, "Invalid cover art ID");
      return;
    }

    const cacheKey = size ? `${id}:${size}` : id;

    // Check cache first (covers both local and peer art)
    const cached = app.artCache.get(cacheKey);
    if (cached) {
      const data = readFileSync(cached.filePath);
      reply.raw.writeHead(200, {
        "content-type": cached.contentType,
        "content-length": String(data.length),
        "cache-control": "public, max-age=2592000",
        "x-cache": "HIT",
      });
      reply.raw.end(data);
      return;
    }

    let response: Response;

    if (instanceId !== "local") {
      // Peer art routing via /proxy/rest/getCoverArt — Ed25519-signed request to the peer's proxy.
      // The signing path must include the /proxy prefix (as seen by the peer's Fastify router).
      const peer = app.peerRegistry.peers.get(instanceId);
      if (!peer) {
        sendBinaryError(reply, 404, "Peer not found");
        return;
      }
      try {
        const artParams = new URLSearchParams({ id: coverArtId });
        if (size) artParams.set("size", size);
        const signingPath = `/proxy/rest/getCoverArt?${artParams.toString()}`;
        // Substitute peer.proxyUrl as the base so the HTTP request goes to the correct host.
        const proxyPeer: Peer = { ...peer, url: peer.proxyUrl };
        response = await app.federatedFetch(
          proxyPeer,
          signingPath,
          { asUser: request.subsonicUser.username },
        );
      } catch {
        sendBinaryError(reply, 502, "Failed to fetch art from peer");
        return;
      }
    } else {
      // Local Navidrome art.
      // TODO(phase-5): route through /proxy/rest/getCoverArt (internal inject) once local
      // reads are uniformly proxied. SubsonicClient hits Navidrome directly for now.
      const client = new SubsonicClient({
        url: app.config.navidromeUrl,
        username: app.config.navidromeUsername,
        password: app.config.navidromePassword,
      });
      try {
        const sizeNum = size ? parseInt(size, 10) : undefined;
        response = await client.getCoverArt(coverArtId, sizeNum);
      } catch {
        sendBinaryError(reply, 502, "Failed to fetch art from Navidrome");
        return;
      }
    }

    if (!response.ok) {
      sendBinaryError(reply, response.status === 404 ? 404 : 502, "Art not found");
      return;
    }

    if (!response.body) {
      sendBinaryError(reply, 502, "Empty response from upstream");
      return;
    }

    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type") || "image/jpeg";

    app.artCache.put(cacheKey, buffer, contentType);

    reply.raw.writeHead(200, {
      "content-type": contentType,
      "content-length": String(buffer.length),
      "cache-control": "public, max-age=2592000",
      "x-cache": "MISS",
    });
    reply.raw.end(buffer);
  });

  // ── stream ──────────────────────────────────────────────────────────────────

async function handleStream(request: Parameters<RouteHandlerMethod>[0], reply: Parameters<RouteHandlerMethod>[1]) {
  const q = request.query as Record<string, string>;

let trackId: string;
try {
  trackId = decodeId(q.id ?? "", "t");
  request.log.info(`Stream request: decoded trackId = ${trackId}`);
} catch {
  request.log.warn(`Stream request: failed to decode track ID from ${q.id}`);
  sendBinaryError(reply, 400, "Invalid track ID");
  return;
}

  // Get track info for streaming
  const trackRow = app.db
    .prepare(
      `SELECT ut.id, ut.title, ut.artist_id, ua.name AS artist_name, ut.duration_ms
       FROM unified_tracks ut
       JOIN unified_artists ua ON ua.id = ut.artist_id
       WHERE ut.id = ?`,
    )
    .get(trackId) as { id: string; title: string; artist_name: string; duration_ms: number | null } | undefined;

  if (!trackRow) {
    request.log.warn(`Stream tracking: track ${trackId} not found in unified_tracks`);
  }

  // Defer stream tracking start until after source/transcode resolution
  // so we can record format/bitrate/source/transcode flags up front.
  let streamOpId: string | undefined;

  // Source selection happens at merge time (merge.ts sets preferred = 1).
  // At stream time we just look up THE source for this unified track.
  const best = app.db
    .prepare(
      `SELECT ts.instance_id, ts.format, ts.bitrate, it.remote_id
       FROM track_sources ts
       JOIN instance_tracks it ON it.id = ts.instance_track_id
       WHERE ts.unified_track_id = ? AND ts.preferred = 1
       LIMIT 1`,
    )
    .get(trackId) as
    | { instance_id: string; format: string | null; bitrate: number | null; remote_id: string }
    | undefined;

  if (!best) {
    sendBinaryError(reply, 404, "Track not found");
    return;
  }

  const streamParams = applyTranscodeRule(buildStreamParams(q), {
    format: best.format,
    bitrate: best.bitrate,
  });

  // Forward Range only for raw passthrough streams. If transcoding is in
  // play, byte offsets in the upstream response would not map to the
  // transcoded bytes the caller expects. (#97 — transcoded seek tracked
  // separately.)
  const cap = Number(streamParams.get("maxBitRate")) || Infinity;
  const srcBr = best.bitrate ?? Infinity;
  const isRaw =
    !streamParams.has("format") &&
    !streamParams.has("timeOffset") &&
    srcBr <= cap;
  const rangeHeader =
    isRaw && typeof request.headers.range === "string"
      ? request.headers.range
      : undefined;

  if (trackRow) {
    const transcoded = streamParams.has("format") || (Number.isFinite(cap) && srcBr > cap);
    streamOpId = app.streamTracking.start({
      kind: "subsonic",
      username: request.subsonicUser.username,
      trackId: trackRow.id,
      trackTitle: trackRow.title,
      artistName: trackRow.artist_name,
      clientName: q.c ?? null,
      clientVersion: q.v ?? null,
      sourceKind: best.instance_id === "local" ? "local" : "peer",
      sourcePeerId: best.instance_id === "local" ? null : best.instance_id,
      format: best.format,
      bitrate: best.bitrate,
      transcoded,
      maxBitrate: Number.isFinite(cap) ? cap : null,
    });
  }

  let response: Response;
  let bytesTransferred = 0;

  if (best.instance_id === "local") {
    const client = new SubsonicClient({
      url: app.config.navidromeUrl,
      username: app.config.navidromeUsername,
      password: app.config.navidromePassword,
    });
    try {
      const opts: { format?: string; maxBitRate?: number; timeOffset?: number; estimateContentLength?: boolean; range?: string } = {};
      const fmt = streamParams.get("format");
      const br = streamParams.get("maxBitRate");
      const to = streamParams.get("timeOffset");
      const ecl = streamParams.get("estimateContentLength");
      if (fmt) opts.format = fmt;
      if (br) opts.maxBitRate = parseInt(br, 10);
      if (to) opts.timeOffset = parseInt(to, 10);
      if (ecl === "true") opts.estimateContentLength = true;
      if (rangeHeader) opts.range = rangeHeader;
      response = await client.stream(best.remote_id, opts);
    } catch {
      if (streamOpId) app.streamTracking.finish(streamOpId, 0, "Stream error");
      sendBinaryError(reply, 502, "Stream error");
      return;
    }
  } else {
    const peer = app.peerRegistry.peers.get(best.instance_id);
    if (!peer) {
      if (streamOpId) app.streamTracking.finish(streamOpId, 0, "Peer not available");
      sendBinaryError(reply, 502, "Peer not available");
      return;
    }
    try {
      const qs = streamParams.toString();
      const path = `/federation/stream/${encodeURIComponent(best.remote_id)}${qs ? `?${qs}` : ""}`;
      response = await app.federatedFetch(
        peer,
        path,
        {
          asUser: request.subsonicUser.username,
          headers: rangeHeader ? { range: rangeHeader } : undefined,
        },
      );
    } catch {
      if (streamOpId) app.streamTracking.finish(streamOpId, 0, "Peer stream error");
      sendBinaryError(reply, 502, "Peer stream error");
      return;
    }
  }

  if (!response.body) {
    if (streamOpId) app.streamTracking.finish(streamOpId, 0, "Empty response from upstream");
    sendBinaryError(reply, 502, "Empty response from upstream");
    return;
  }

  const headers: Record<string, string> = {
    "content-type": response.headers.get("content-type") || "audio/mpeg",
  };
  const contentLength = response.headers.get("content-length");
  if (contentLength) headers["content-length"] = contentLength;
  const acceptRanges = response.headers.get("accept-ranges");
  if (acceptRanges) headers["accept-ranges"] = acceptRanges;
  const contentRange = response.headers.get("content-range");
  if (contentRange) headers["content-range"] = contentRange;

  reply.raw.writeHead(response.status, headers);
  const nodeStream = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
  
  // Track bytes transferred
  nodeStream.on("data", (chunk) => {
    bytesTransferred += chunk.length;
    if (streamOpId) app.streamTracking.updateBytes(streamOpId, bytesTransferred);
  });

  // Finish tracking when stream ends or errors
  nodeStream.on("end", () => {
    if (streamOpId) {
      app.streamTracking.finish(streamOpId, bytesTransferred, null);
    }
  });

  nodeStream.on("error", (err) => {
    if (streamOpId) {
      app.streamTracking.finish(streamOpId, bytesTransferred, err instanceof Error ? err.message : String(err));
    }
  });
  
  nodeStream.pipe(reply.raw);
}

  binaryRoute("/stream", handleStream);
  binaryRoute("/download", handleStream); // alias — clients use interchangeably

  // ── star / unstar / getStarred / getStarred2 (#104) ─────────────────────────
  //
  // Per-user favorites, stored in the `user_stars` table on this hub. Targets
  // are unified_*.id UUIDs; orphans (target gone after a sync) are dropped at
  // read time via JOIN. Stars are local to the hub the user logs into and are
  // not federated.

  type StarKind = "track" | "album" | "artist";

  function asArray(v: unknown): string[] {
    if (v == null) return [];
    return Array.isArray(v) ? (v as string[]) : [String(v)];
  }

  // Raw IDs are produced by `generateDeterministicId` (UUID v4 shape, all
  // lowercase hex). Anchoring the classifier on this shape rejects malformed
  // input (e.g. `id=tomato`) instead of silently inserting `omato` as a
  // track target. Bare-UUID forms (no prefix) on `albumId`/`artistId` are
  // also accepted, matching how some Subsonic clients send them.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function classifyStarId(encoded: string): { kind: StarKind; raw: string } | null {
    // Order matters: "ar"/"al" both start with "a"; "t" is a one-char prefix.
    let kind: StarKind | null = null;
    let raw = "";
    if (encoded.startsWith("al")) {
      kind = "album";
      raw = encoded.slice(2);
    } else if (encoded.startsWith("ar")) {
      kind = "artist";
      raw = encoded.slice(2);
    } else if (encoded.startsWith("t")) {
      kind = "track";
      raw = encoded.slice(1);
    }
    if (!kind || !UUID_RE.test(raw)) return null;
    return { kind, raw };
  }

  function unwrapKindId(encoded: string, prefix: string): string | null {
    // Accept either the prefixed form (`al<uuid>`/`ar<uuid>`) or a bare UUID
    // — the second is what some legacy clients send for `albumId`/`artistId`.
    const raw = encoded.startsWith(prefix) ? encoded.slice(prefix.length) : encoded;
    return UUID_RE.test(raw) ? raw : null;
  }

  function collectStarTargets(
    q: Record<string, string | string[] | undefined>,
  ): Array<{ kind: StarKind; raw: string }> {
    const out: Array<{ kind: StarKind; raw: string }> = [];
    for (const id of asArray(q.id)) {
      const c = classifyStarId(id);
      if (c) out.push(c);
    }
    for (const id of asArray(q.albumId)) {
      const raw = unwrapKindId(id, "al");
      if (raw) out.push({ kind: "album", raw });
    }
    for (const id of asArray(q.artistId)) {
      const raw = unwrapKindId(id, "ar");
      if (raw) out.push({ kind: "artist", raw });
    }
    return out;
  }

  // SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" UTC; Subsonic clients
  // expect ISO 8601 with 'T' separator and 'Z' suffix.
  function toIsoStarred(ts: string): string {
    return ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
  }

  route("/star", async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    const userId = request.subsonicUser.id;
    const targets = collectStarTargets(q);
    const stmt = app.db.prepare(
      "INSERT OR IGNORE INTO user_stars (user_id, kind, target_id) VALUES (?, ?, ?)",
    );
    const tx = app.db.transaction((rows: Array<{ kind: StarKind; raw: string }>) => {
      for (const r of rows) stmt.run(userId, r.kind, r.raw);
    });
    tx(targets);
    sendSubsonicOk(reply, q as Record<string, string>, {});
  });

  route("/unstar", async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>;
    const userId = request.subsonicUser.id;
    const targets = collectStarTargets(q);
    const stmt = app.db.prepare(
      "DELETE FROM user_stars WHERE user_id = ? AND kind = ? AND target_id = ?",
    );
    const tx = app.db.transaction((rows: Array<{ kind: StarKind; raw: string }>) => {
      for (const r of rows) stmt.run(userId, r.kind, r.raw);
    });
    tx(targets);
    sendSubsonicOk(reply, q as Record<string, string>, {});
  });

  function buildStarredEnvelope(userId: string) {
    const artists = app.db
      .prepare(
        `SELECT ua.id, ua.name, ua.image_url,
          COUNT(urg.id) AS albumCount,
          us.starred_at
        FROM user_stars us
        JOIN unified_artists ua ON ua.id = us.target_id
        LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
        WHERE us.user_id = ? AND us.kind = 'artist'
        GROUP BY ua.id, ua.name, ua.image_url, us.starred_at
        ORDER BY us.starred_at DESC`,
      )
      .all(userId) as Array<ArtistRow & { starred_at: string }>;

    const albums = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url,
          (SELECT COUNT(*) FROM unified_tracks ut
           JOIN unified_releases ur ON ur.id = ut.release_id
           WHERE ur.release_group_id = urg.id) AS songCount,
          us.starred_at
        FROM user_stars us
        JOIN unified_release_groups urg ON urg.id = us.target_id
        JOIN unified_artists ua ON ua.id = urg.artist_id
        WHERE us.user_id = ? AND us.kind = 'album'
        ORDER BY us.starred_at DESC`,
      )
      .all(userId) as Array<ReleaseGroupRow & { starred_at: string }>;

    const songs = app.db
      .prepare(
        `SELECT
          ut.id, ut.title, ut.track_number, ut.disc_number,
          ut.duration_ms, ut.genre, ut.musicbrainz_id,
          ut.artist_id, ua.name AS artist_name,
          urg.id AS rg_id, urg.name AS rg_name,
          urg.year AS rg_year, urg.image_url AS rg_image_url,
          (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
          (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
          (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size,
          (SELECT i.name FROM track_sources ts
           JOIN instances i ON i.id = ts.instance_id
           WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS instance_name,
          us.starred_at
        FROM user_stars us
        JOIN unified_tracks ut ON ut.id = us.target_id
        JOIN unified_artists ua ON ua.id = ut.artist_id
        JOIN unified_releases ur ON ur.id = ut.release_id
        JOIN unified_release_groups urg ON urg.id = ur.release_group_id
        WHERE us.user_id = ? AND us.kind = 'track'
        ORDER BY us.starred_at DESC`,
      )
      .all(userId) as Array<TrackRow & { starred_at: string }>;

    return {
      artist: artists.map((a) => ({
        id: encodeId("ar", a.id),
        name: a.name,
        albumCount: a.albumCount,
        coverArt: a.image_url ?? undefined,
        starred: toIsoStarred(a.starred_at),
      })),
      album: albums.map((a) => ({
        ...buildAlbum(a),
        starred: toIsoStarred(a.starred_at),
      })),
      song: songs.map((s) => ({
        ...buildSong(s),
        starred: toIsoStarred(s.starred_at),
      })),
    };
  }

  route("/getStarred2", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const env = buildStarredEnvelope(request.subsonicUser.id);
    sendSubsonicOk(reply, q, { starred2: env });
  });

  route("/getStarred", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const env = buildStarredEnvelope(request.subsonicUser.id);
    sendSubsonicOk(reply, q, { starred: env });
  });

  // ── Playlist stubs ──────────────────────────────────────────────────────────
  // TODO: implement fully once playlists table is populated (Phase 3+)

  route("/getPlaylists", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, { playlists: { playlist: [] } });
  });

  route("/getPlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 70, "Playlist not found", q);
  });

  route("/createPlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });

  route("/updatePlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });

  route("/deletePlaylist", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicError(reply, 0, "Generic error: not yet implemented", q);
  });

  // ── Scrobble stubs ──────────────────────────────────────────────────────────

  route("/scrobble", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, {});
  });

  route("/getNowPlaying", async (request, reply) => {
    const q = request.query as Record<string, string>;
    sendSubsonicOk(reply, q, { nowPlaying: { entry: [] } });
  });
};
