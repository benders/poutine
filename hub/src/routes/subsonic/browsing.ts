import { sendSubsonicOk, sendSubsonicError, encodeId, decodeId } from "../subsonic-response.js";
import { sqliteToIso } from "../../util/time.js";
import type { ArtistRow, GenreRow, ReleaseGroupRow, TrackRow, SubsonicRouteContext } from "./types.js";
import {
  pickAlbumShareId,
  pickArtistShareId,
  buildSong,
  annotateStarred,
  annotatePlays,
  buildAlbum,
} from "./builders.js";

export function registerBrowsing(ctx: SubsonicRouteContext): void {
  const { app, queries, route } = ctx;

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

  // ── getUser ─────────────────────────────────────────────────────────────────

  route("/getUser", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const auth = request.subsonicUser!;
    const requested = (q.username || "").trim();
    // Subsonic spec: non-admins may only fetch their own record.
    if (requested && requested !== auth.username && !auth.isAdmin) {
      sendSubsonicError(reply, 50, "User is not authorized for the given operation.", q);
      return;
    }
    const targetName = requested || auth.username;
    const row = queries.userByUsername.get(targetName) as
      | { username: string; is_admin: number }
      | undefined;
    if (!row) {
      sendSubsonicError(reply, 70, "User not found.", q);
      return;
    }
    const isAdmin = row.is_admin === 1;
    sendSubsonicOk(reply, q, {
      user: {
        username: row.username,
        email: "",
        scrobblingEnabled: true,
        adminRole: isAdmin,
        settingsRole: isAdmin,
        downloadRole: true,
        uploadRole: false,
        playlistRole: true,
        coverArtRole: true,
        commentRole: false,
        podcastRole: false,
        streamRole: true,
        jukeboxRole: false,
        shareRole: false,
        videoConversionRole: false,
      },
    });
  });

  // ── getMusicFolders ─────────────────────────────────────────────────────────

  route("/getMusicFolders", async (request, reply) => {
    const q = request.query as Record<string, string>;
    // Issue #123: each known instance (local + active peers) is exposed as a
    // MusicFolder so 3rd-party Subsonic clients can scope browsing per peer.
    const rows = queries.musicFolders.all() as Array<{ id: number; name: string }>;
    sendSubsonicOk(reply, q, {
      musicFolders: { musicFolder: rows },
    });
  });

  // ── getGenres ───────────────────────────────────────────────────────────────

  route("/getGenres", async (request, reply) => {
    const q = request.query as Record<string, string>;

    const rows = queries.genres.all() as GenreRow[];

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

    // INNER JOIN drops artists with no release group of their own.
    // Featured-only / track-credit-only artists otherwise appear in client
    // lists with zero albums and no playable content, because the artist
    // detail view filters albums by `urg.artist_id`. Their tracks remain
    // reachable via the album they appear on.
    const artists = queries.artistsWithAlbumCount.all() as ArtistRow[];

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

    // INNER JOIN: see /getArtists above for the rationale.
    const artists = queries.artistIndexRows.all() as ArtistRow[];

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

    const artist = queries.artistById.get(artistId) as
      | { id: string; name: string; image_url: string | null }
      | undefined;

    if (!artist) {
      sendSubsonicError(reply, 70, "Artist not found", q);
      return;
    }

    const albums = queries.albumsForArtist.all(artistId) as ReleaseGroupRow[];

    const shareId = pickArtistShareId(app.db, artist.id);

    const builtAlbums = albums.map(buildAlbum);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "album", "al", builtAlbums);
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

    const artistRow = queries.artistInfoById.get(artistId) as
      | { id: string; name: string; musicbrainz_id: string | null; image_url: string | null }
      | undefined;

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
            queries.updateArtistImageUrl.run(bestImage, artistId);
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
      const row = queries.instanceByMusicFolderId.get(
        parseInt(q.musicFolderId, 10),
      ) as { id: string } | undefined;
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

    // #197: type=frequent / type=recent rank by the requesting user's play
    // history. A LEFT JOIN onto per-release-group aggregates lets us order by
    // play count / last-played and (for these two types) exclude never-played
    // albums — matching how Subsonic clients expect "frequent"/"recent". The
    // join's `?` (user id) is the first bound param, so it's prepended below.
    const usePlayJoin = type === "frequent" || type === "recent";
    const playJoin = usePlayJoin
      ? `LEFT JOIN (
           SELECT ur2.release_group_id AS rg,
                  COUNT(*) AS play_count,
                  MAX(pe.played_at) AS last_played
           FROM play_events pe
           JOIN unified_tracks ut2 ON ut2.id = pe.unified_track_id
           JOIN unified_releases ur2 ON ur2.id = ut2.release_id
           WHERE pe.user_id = ?
           GROUP BY ur2.release_group_id
         ) pc ON pc.rg = urg.id`
      : "";
    const joinParams: unknown[] = usePlayJoin ? [request.subsonicUser.id] : [];
    // Reuse the playJoin's aggregate for playCount/played instead of a second
    // pass via getAlbumStats (#197). Functionally dependent on urg.id (one pc
    // row per release group), so safe under GROUP BY urg.id.
    const playCols = usePlayJoin ? ", pc.play_count, pc.last_played" : "";

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
      case "frequent":
        // Most-played first; restrict to albums the user has actually played.
        // urg.id breaks ties so LIMIT/OFFSET paging is stable across windows.
        where += " AND pc.play_count IS NOT NULL";
        orderBy = "pc.play_count DESC, pc.last_played DESC, urg.id";
        break;
      case "recent":
        // Most-recently-played first; played albums only. SQLite sorts NULLs
        // last under DESC, but the WHERE already excludes the never-played.
        // urg.id breaks ties so LIMIT/OFFSET paging is stable across windows.
        where += " AND pc.play_count IS NOT NULL";
        orderBy = "pc.last_played DESC, urg.id";
        break;
      // highest (ratings) — not tracked; fall back to newest.
      default:
        orderBy = "urg.created_at DESC";
        break;
    }

    params.push(size, offset);

    const albums = app.db
      .prepare(
        `SELECT urg.id, urg.name, urg.artist_id, ua.name AS artist_name,
          urg.year, urg.genre, urg.image_url, urg.created_at,
          COUNT(ut.id) AS songCount${playCols}
        FROM unified_release_groups urg
        JOIN unified_artists ua ON ua.id = urg.artist_id
        ${playJoin}
        LEFT JOIN unified_releases ur ON ur.release_group_id = urg.id
        LEFT JOIN unified_tracks ut ON ut.release_id = ur.id
        ${where}
        GROUP BY urg.id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
      .all(...joinParams, ...params) as ReleaseGroupRow[];

    const builtAlbums = albums.map(buildAlbum);
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", builtAlbums);
    if (usePlayJoin) {
      // frequent/recent: the playJoin already computed each album's play
      // aggregate for this page — reuse it instead of re-querying getAlbumStats
      // (#197). Same per-user, source-agnostic count, same ISO conversion.
      for (let i = 0; i < albums.length; i++) {
        const count = albums[i].play_count;
        if (count != null && count > 0) {
          const a = builtAlbums[i] as (typeof builtAlbums)[number] & {
            playCount?: number;
            played?: string;
          };
          a.playCount = count;
          if (albums[i].last_played) a.played = sqliteToIso(albums[i].last_played!);
        }
      }
    } else {
      annotatePlays(app.playEvents, request.subsonicUser?.id, "album", "al", builtAlbums);
    }
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

    const rg = queries.releaseGroupById.get(rgId) as
      | {
          id: string;
          name: string;
          artist_id: string;
          artist_name: string;
          year: number | null;
          genre: string | null;
          image_url: string | null;
          created_at: string | null;
        }
      | undefined;

    if (!rg) {
      sendSubsonicError(reply, 70, "Album not found", q);
      return;
    }

    // Pick the release with the most tracks (fall back to first by id)
    const release = queries.bestReleaseForGroup.get(rgId) as { id: string } | undefined;

    const tracks: TrackRow[] = release
      ? (queries.tracksForRelease.all(release.id) as TrackRow[])
      : [];

    const totalDuration = tracks.reduce(
      (sum, t) => sum + (t.duration_ms != null ? Math.round(t.duration_ms / 1000) : 0),
      0,
    );

    const shareId = pickAlbumShareId(app.db, rg.id);

    const builtSongs = tracks.map(buildSong);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", builtSongs);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "track", "t", builtSongs);
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
      created?: string;
      playCount?: number;
      played?: string;
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
      created: rg.created_at ? sqliteToIso(rg.created_at) : undefined,
    };
    annotateStarred(app.db, request.subsonicUser?.id, "album", "al", [albumObj]);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "album", "al", [albumObj]);
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

    const row = queries.trackForSong.get(trackId) as TrackRow | undefined;

    if (!row) {
      sendSubsonicError(reply, 70, "Song not found", q);
      return;
    }

    const built = buildSong(row);
    annotateStarred(app.db, request.subsonicUser?.id, "track", "t", [built]);
    annotatePlays(app.playEvents, request.subsonicUser?.id, "track", "t", [built]);
    sendSubsonicOk(reply, q, { song: built });
  });
}
