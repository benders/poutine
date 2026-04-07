import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { requireSubsonicAuth } from "../auth/subsonic-auth.js";
import {
  sendSubsonicOk,
  sendSubsonicError,
  encodeId,
  decodeId,
} from "./subsonic-response.js";
import { decodeCoverArtId } from "./stream.js";
import { SubsonicClient } from "../adapters/subsonic.js";

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
}

interface GenreRow {
  genre: string;
  albumCount: number;
  songCount: number;
}

interface TrackSourceRow {
  remote_id: string;
  format: string | null;
  bitrate: number | null;
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
  };
}

// ── Album shape builder ───────────────────────────────────────────────────────

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
    sendSubsonicOk(reply, q, {
      musicFolders: { musicFolder: [{ id: 1, name: "Music" }] },
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
      .prepare("SELECT id, name FROM unified_artists WHERE id = ?")
      .get(artistId) as { id: string; name: string } | undefined;

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

    sendSubsonicOk(reply, q, {
      artist: {
        id: encodeId("ar", artist.id),
        name: artist.name,
        albumCount: albums.length,
        album: albums.map(buildAlbum),
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

    let orderBy = "urg.created_at DESC";
    let where = "WHERE 1=1";
    const params: unknown[] = [];

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

    sendSubsonicOk(reply, q, {
      albumList2: { album: albums.map(buildAlbum) },
    });
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
              ut.duration_ms, ut.genre,
              ut.artist_id, ua.name AS artist_name,
              urg.id AS rg_id, urg.name AS rg_name,
              urg.year AS rg_year, urg.image_url AS rg_image_url,
              (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
              (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
              (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
               ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size
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

    sendSubsonicOk(reply, q, {
      album: {
        id: encodeId("al", rg.id),
        name: rg.name,
        artist: rg.artist_name,
        artistId: encodeId("ar", rg.artist_id),
        coverArt: rg.image_url ?? undefined,
        songCount: tracks.length,
        duration: totalDuration,
        year: rg.year ?? undefined,
        genre: rg.genre ?? undefined,
        song: tracks.map(buildSong),
      },
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
          ut.duration_ms, ut.genre,
          ut.artist_id, ua.name AS artist_name,
          urg.id AS rg_id, urg.name AS rg_name,
          urg.year AS rg_year, urg.image_url AS rg_image_url,
          (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
          (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
          (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size
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

    sendSubsonicOk(reply, q, { song: buildSong(row) });
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
    const like = `%${query}%`;

    const artists = app.db
      .prepare(
        `SELECT ua.id, ua.name, COUNT(urg.id) AS albumCount
        FROM unified_artists ua
        LEFT JOIN unified_release_groups urg ON urg.artist_id = ua.id
        WHERE ua.name_normalized LIKE ?
        GROUP BY ua.id
        ORDER BY ua.name_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(like, artistCount, artistOffset) as ArtistRow[];

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
        GROUP BY urg.id
        ORDER BY urg.name_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(like, albumCount, albumOffset) as ReleaseGroupRow[];

    const songs = app.db
      .prepare(
        `SELECT
          ut.id, ut.title, ut.track_number, ut.disc_number,
          ut.duration_ms, ut.genre,
          ut.artist_id, ua.name AS artist_name,
          urg.id AS rg_id, urg.name AS rg_name,
          urg.year AS rg_year, urg.image_url AS rg_image_url,
          (SELECT ts.format FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS format,
          (SELECT ts.bitrate FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS bitrate,
          (SELECT ts.size FROM track_sources ts WHERE ts.unified_track_id = ut.id
           ORDER BY COALESCE(ts.bitrate, 0) DESC LIMIT 1) AS size
        FROM unified_tracks ut
        JOIN unified_artists ua ON ua.id = ut.artist_id
        JOIN unified_releases ur ON ur.id = ut.release_id
        JOIN unified_release_groups urg ON urg.id = ur.release_group_id
        WHERE ut.title_normalized LIKE ?
        ORDER BY ut.title_normalized
        LIMIT ? OFFSET ?`,
      )
      .all(like, songCount, songOffset) as TrackRow[];

    sendSubsonicOk(reply, q, {
      searchResult3: {
        artist: artists.map((a) => ({
          id: encodeId("ar", a.id),
          name: a.name,
          albumCount: a.albumCount,
        })),
        album: albums.map(buildAlbum),
        song: songs.map(buildSong),
      },
    });
  });

  // ── getCoverArt ─────────────────────────────────────────────────────────────

  route("/getCoverArt", async (request, reply) => {
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
      sendSubsonicError(reply, 70, "Not found", q);
      return;
    }

    // TODO Phase 4: add peer art routing for non-local instances
    if (instanceId !== "local") {
      sendSubsonicError(reply, 70, "Not found", q);
      return;
    }

    const cacheKey = size ? `${id}:${size}` : id;

    // Check cache first
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

    // Cache miss — fetch from upstream Navidrome
    const client = new SubsonicClient({
      url: app.config.navidromeUrl,
      username: app.config.navidromeUsername,
      password: app.config.navidromePassword,
    });

    let response: Response;
    try {
      const sizeNum = size ? parseInt(size, 10) : undefined;
      response = await client.getCoverArt(coverArtId, sizeNum);
    } catch {
      sendSubsonicError(reply, 70, "Not found", q);
      return;
    }

    if (!response.body) {
      sendSubsonicError(reply, 70, "Not found", q);
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
    } catch {
      sendSubsonicError(reply, 70, "Song not found", q);
      return;
    }

    // TODO Phase 4: use selectBestSource() with local/peer routing
    const source = app.db
      .prepare(
        `SELECT ts.remote_id, ts.format, ts.bitrate
        FROM track_sources ts
        WHERE ts.unified_track_id = ?
        ORDER BY COALESCE(ts.bitrate, 0) DESC
        LIMIT 1`,
      )
      .get(trackId) as TrackSourceRow | undefined;

    if (!source) {
      sendSubsonicError(reply, 70, "Song not found", q);
      return;
    }

    const client = new SubsonicClient({
      url: app.config.navidromeUrl,
      username: app.config.navidromeUsername,
      password: app.config.navidromePassword,
    });

    let response: Response;
    try {
      const streamParams: { format?: string; maxBitRate?: number } = {};
      if (q.format) streamParams.format = q.format;
      if (q.maxBitRate) streamParams.maxBitRate = parseInt(q.maxBitRate, 10);
      response = await client.stream(source.remote_id, streamParams);
    } catch {
      sendSubsonicError(reply, 0, "Stream error", q);
      return;
    }

    if (!response.body) {
      sendSubsonicError(reply, 0, "Empty response from upstream", q);
      return;
    }

    const headers: Record<string, string> = {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers["content-length"] = contentLength;

    reply.raw.writeHead(response.status, headers);
    const nodeStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    );
    nodeStream.pipe(reply.raw);
  }

  route("/stream", handleStream);
  route("/download", handleStream); // alias — clients use interchangeably

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
