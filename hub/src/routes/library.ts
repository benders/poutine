import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../auth/middleware.js";

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/library/artists
  app.get<{
    Querystring: {
      search?: string;
      sort?: string;
      order?: string;
      limit?: string;
      offset?: string;
    };
  }>("/artists", { preHandler: requireAuth }, async (request, reply) => {
    const {
      search,
      sort = "name",
      order = "asc",
      limit: limitStr = "50",
      offset: offsetStr = "0",
    } = request.query;

    const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetStr, 10) || 0, 0);
    const sortOrder = order === "desc" ? "DESC" : "ASC";

    let where = "";
    const params: unknown[] = [];

    if (search) {
      where = "WHERE ua.name_normalized LIKE ?";
      params.push(`%${search.toLowerCase()}%`);
    }

    // Get total count
    const countRow = app.db
      .prepare(`SELECT COUNT(*) as total FROM unified_artists ua ${where}`)
      .get(...(params.length ? [params] : [])) as { total: number } | undefined;

    // Build the count query properly
    const countStmt = app.db.prepare(
      `SELECT COUNT(*) as total FROM unified_artists ua ${where}`,
    );
    const total = (countStmt.get(...params) as { total: number })?.total ?? 0;

    let orderBy: string;
    if (sort === "trackCount") {
      orderBy = `(SELECT COUNT(*) FROM unified_tracks ut WHERE ut.artist_id = ua.id) ${sortOrder}`;
    } else {
      orderBy = `ua.name_normalized ${sortOrder}`;
    }

    const rows = app.db
      .prepare(
        `SELECT ua.id, ua.name, ua.musicbrainz_id, ua.image_url,
                (SELECT COUNT(*) FROM unified_tracks ut WHERE ut.artist_id = ua.id) as track_count,
                (SELECT COUNT(DISTINCT urg.id) FROM unified_release_groups urg WHERE urg.artist_id = ua.id) as release_group_count
         FROM unified_artists ua
         ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    reply.header("X-Total-Count", String(total));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      musicbrainzId: r.musicbrainz_id,
      imageUrl: r.image_url,
      trackCount: r.track_count,
      releaseGroupCount: r.release_group_count,
    }));
  });

  // GET /api/library/artists/:id
  app.get<{ Params: { id: string } }>(
    "/artists/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const artist = app.db
        .prepare(
          `SELECT id, name, musicbrainz_id, image_url FROM unified_artists WHERE id = ?`,
        )
        .get(request.params.id) as Record<string, unknown> | undefined;

      if (!artist) {
        return reply.code(404).send({ error: "Artist not found" });
      }

      const releaseGroups = app.db
        .prepare(
          `SELECT id, name, musicbrainz_id, year, genre, image_url
           FROM unified_release_groups
           WHERE artist_id = ?
           ORDER BY year DESC, name ASC`,
        )
        .all(request.params.id) as Array<Record<string, unknown>>;

      return {
        id: artist.id,
        name: artist.name,
        musicbrainzId: artist.musicbrainz_id,
        imageUrl: artist.image_url,
        releaseGroups: releaseGroups.map((rg) => ({
          id: rg.id,
          name: rg.name,
          musicbrainzId: rg.musicbrainz_id,
          year: rg.year,
          genre: rg.genre,
          imageUrl: rg.image_url,
        })),
      };
    },
  );

  // GET /api/library/release-groups
  app.get<{
    Querystring: {
      artistId?: string;
      genre?: string;
      yearFrom?: string;
      yearTo?: string;
      search?: string;
      sort?: string;
      order?: string;
      limit?: string;
      offset?: string;
    };
  }>("/release-groups", { preHandler: requireAuth }, async (request, reply) => {
    const {
      artistId,
      genre,
      yearFrom,
      yearTo,
      search,
      sort = "name",
      order = "asc",
      limit: limitStr = "50",
      offset: offsetStr = "0",
    } = request.query;

    const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetStr, 10) || 0, 0);
    const sortOrder = order === "desc" ? "DESC" : "ASC";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (artistId) {
      conditions.push("rg.artist_id = ?");
      params.push(artistId);
    }
    if (genre) {
      conditions.push("rg.genre LIKE ?");
      params.push(`%${genre}%`);
    }
    if (yearFrom) {
      conditions.push("rg.year >= ?");
      params.push(parseInt(yearFrom, 10));
    }
    if (yearTo) {
      conditions.push("rg.year <= ?");
      params.push(parseInt(yearTo, 10));
    }
    if (search) {
      conditions.push("rg.name_normalized LIKE ?");
      params.push(`%${search.toLowerCase()}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total =
      (
        app.db
          .prepare(`SELECT COUNT(*) as total FROM unified_release_groups rg ${where}`)
          .get(...params) as { total: number }
      )?.total ?? 0;

    let orderBy: string;
    switch (sort) {
      case "year":
        orderBy = `rg.year ${sortOrder}`;
        break;
      case "recent":
        orderBy = `rg.created_at ${sortOrder}`;
        break;
      default:
        orderBy = `rg.name_normalized ${sortOrder}`;
    }

    const rows = app.db
      .prepare(
        `SELECT rg.id, rg.name, rg.musicbrainz_id, rg.year, rg.genre, rg.image_url,
                rg.artist_id,
                ua.name as artist_name
         FROM unified_release_groups rg
         JOIN unified_artists ua ON ua.id = rg.artist_id
         ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    reply.header("X-Total-Count", String(total));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      musicbrainzId: r.musicbrainz_id,
      year: r.year,
      genre: r.genre,
      imageUrl: r.image_url,
      artistId: r.artist_id,
      artistName: r.artist_name,
    }));
  });

  // GET /api/library/release-groups/:id
  app.get<{ Params: { id: string } }>(
    "/release-groups/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const rg = app.db
        .prepare(
          `SELECT rg.id, rg.name, rg.musicbrainz_id, rg.year, rg.genre, rg.image_url,
                  rg.artist_id, ua.name as artist_name
           FROM unified_release_groups rg
           JOIN unified_artists ua ON ua.id = rg.artist_id
           WHERE rg.id = ?`,
        )
        .get(request.params.id) as Record<string, unknown> | undefined;

      if (!rg) {
        return reply.code(404).send({ error: "Release group not found" });
      }

      // Get all releases for this release group
      const releases = app.db
        .prepare(
          `SELECT id, name, musicbrainz_id, edition, track_count
           FROM unified_releases
           WHERE release_group_id = ?
           ORDER BY name ASC`,
        )
        .all(request.params.id) as Array<Record<string, unknown>>;

      const releasesWithTracks = releases.map((rel) => {
        const tracks = app.db
          .prepare(
            `SELECT ut.id, ut.title, ut.musicbrainz_id, ut.track_number, ut.disc_number,
                    ut.duration_ms, ut.genre
             FROM unified_tracks ut
             WHERE ut.release_id = ?
             ORDER BY ut.disc_number ASC, ut.track_number ASC`,
          )
          .all(rel.id as string) as Array<Record<string, unknown>>;

        const tracksWithSources = tracks.map((t) => {
          const sources = app.db
            .prepare(
              `SELECT ts.instance_id, ts.remote_id, ts.format, ts.bitrate, ts.size,
                      i.name as instance_name, i.status as instance_status
               FROM track_sources ts
               JOIN instances i ON i.id = ts.instance_id
               WHERE ts.unified_track_id = ?`,
            )
            .all(t.id as string) as Array<Record<string, unknown>>;

          return {
            id: t.id,
            title: t.title,
            musicbrainzId: t.musicbrainz_id,
            trackNumber: t.track_number,
            discNumber: t.disc_number,
            durationMs: t.duration_ms,
            genre: t.genre,
            sources: sources.map((s) => ({
              instanceId: s.instance_id,
              instanceName: s.instance_name,
              instanceStatus: s.instance_status,
              remoteId: s.remote_id,
              format: s.format,
              bitrate: s.bitrate,
              size: s.size,
            })),
          };
        });

        return {
          id: rel.id,
          name: rel.name,
          musicbrainzId: rel.musicbrainz_id,
          edition: rel.edition,
          trackCount: rel.track_count,
          tracks: tracksWithSources,
        };
      });

      return {
        id: rg.id,
        name: rg.name,
        musicbrainzId: rg.musicbrainz_id,
        year: rg.year,
        genre: rg.genre,
        imageUrl: rg.image_url,
        artistId: rg.artist_id,
        artistName: rg.artist_name,
        releases: releasesWithTracks,
      };
    },
  );

  // GET /api/library/tracks
  app.get<{
    Querystring: {
      search?: string;
      releaseId?: string;
      artistId?: string;
      limit?: string;
      offset?: string;
    };
  }>("/tracks", { preHandler: requireAuth }, async (request, reply) => {
    const {
      search,
      releaseId,
      artistId,
      limit: limitStr = "50",
      offset: offsetStr = "0",
    } = request.query;

    const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetStr, 10) || 0, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) {
      conditions.push("ut.title_normalized LIKE ?");
      params.push(`%${search.toLowerCase()}%`);
    }
    if (releaseId) {
      conditions.push("ut.release_id = ?");
      params.push(releaseId);
    }
    if (artistId) {
      conditions.push("ut.artist_id = ?");
      params.push(artistId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total =
      (
        app.db
          .prepare(`SELECT COUNT(*) as total FROM unified_tracks ut ${where}`)
          .get(...params) as { total: number }
      )?.total ?? 0;

    const rows = app.db
      .prepare(
        `SELECT ut.id, ut.title, ut.musicbrainz_id, ut.track_number, ut.disc_number,
                ut.duration_ms, ut.genre,
                ua.name as artist_name, ua.id as artist_id,
                ur.name as release_name, ur.id as release_id
         FROM unified_tracks ut
         JOIN unified_artists ua ON ua.id = ut.artist_id
         JOIN unified_releases ur ON ur.id = ut.release_id
         ${where}
         ORDER BY ut.title_normalized ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    reply.header("X-Total-Count", String(total));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      musicbrainzId: r.musicbrainz_id,
      trackNumber: r.track_number,
      discNumber: r.disc_number,
      durationMs: r.duration_ms,
      genre: r.genre,
      artistId: r.artist_id,
      artistName: r.artist_name,
      releaseId: r.release_id,
      releaseName: r.release_name,
    }));
  });

  // GET /api/library/search
  app.get<{ Querystring: { q?: string } }>(
    "/search",
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = request.query.q;
      if (!q) {
        return { artists: [], releaseGroups: [], tracks: [] };
      }

      const searchTerm = `%${q.toLowerCase()}%`;

      const artists = app.db
        .prepare(
          `SELECT id, name, musicbrainz_id, image_url
           FROM unified_artists
           WHERE name_normalized LIKE ?
           LIMIT 10`,
        )
        .all(searchTerm) as Array<Record<string, unknown>>;

      const releaseGroups = app.db
        .prepare(
          `SELECT rg.id, rg.name, rg.musicbrainz_id, rg.year, rg.genre, rg.image_url,
                  ua.name as artist_name, ua.id as artist_id
           FROM unified_release_groups rg
           JOIN unified_artists ua ON ua.id = rg.artist_id
           WHERE rg.name_normalized LIKE ?
           LIMIT 10`,
        )
        .all(searchTerm) as Array<Record<string, unknown>>;

      const tracks = app.db
        .prepare(
          `SELECT ut.id, ut.title, ut.track_number, ut.duration_ms,
                  ua.name as artist_name, ua.id as artist_id,
                  ur.name as release_name
           FROM unified_tracks ut
           JOIN unified_artists ua ON ua.id = ut.artist_id
           JOIN unified_releases ur ON ur.id = ut.release_id
           WHERE ut.title_normalized LIKE ?
           LIMIT 10`,
        )
        .all(searchTerm) as Array<Record<string, unknown>>;

      return {
        artists: artists.map((a) => ({
          id: a.id,
          name: a.name,
          musicbrainzId: a.musicbrainz_id,
          imageUrl: a.image_url,
        })),
        releaseGroups: releaseGroups.map((rg) => ({
          id: rg.id,
          name: rg.name,
          musicbrainzId: rg.musicbrainz_id,
          year: rg.year,
          genre: rg.genre,
          imageUrl: rg.image_url,
          artistId: rg.artist_id,
          artistName: rg.artist_name,
        })),
        tracks: tracks.map((t) => ({
          id: t.id,
          title: t.title,
          trackNumber: t.track_number,
          durationMs: t.duration_ms,
          artistId: t.artist_id,
          artistName: t.artist_name,
          releaseName: t.release_name,
        })),
      };
    },
  );
};
