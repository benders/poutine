import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { SubsonicClient } from "../adapters/subsonic.js";
import { decodeCoverArtId } from "../library/cover-art.js";
import { FEDERATION_API_VERSION } from "../version.js";

// ── Plugin options ────────────────────────────────────────────────────────────

interface FederationPluginOptions extends FastifyPluginOptions {
  requirePeerAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface ArtistExportRow {
  id: string;
  name: string;
  musicbrainz_id: string | null;
  image_url: string | null;
}

interface ReleaseGroupExportRow {
  id: string;
  name: string;
  artist_id: string;
  musicbrainz_id: string | null;
  year: number | null;
  genre: string | null;
  cover_art_id: string | null; // raw cover art id from instance_albums (no peer prefix)
}

interface ReleaseExportRow {
  id: string;
  release_group_id: string;
  name: string;
  musicbrainz_id: string | null;
  edition: string | null;
  track_count: number;
}

interface TrackExportRow {
  id: string;
  release_id: string;
  artist_id: string;
  title: string;
  musicbrainz_id: string | null;
  track_number: number | null;
  disc_number: number | null;
  duration_ms: number | null;
  genre: string | null;
}

interface SourceExportRow {
  track_id: string;
  remote_id: string;
  format: string | null;
  bitrate: number | null;
  size: number | null;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const federationRoutes: FastifyPluginAsync<FederationPluginOptions> =
  async (app, opts) => {
    const preHandler = opts.requirePeerAuth;

    // Stamp every federation response with the current protocol version.
    app.addHook("onSend", async (_req, reply) => {
      reply.header("Poutine-Api-Version", String(FEDERATION_API_VERSION));
    });

    // ── GET /library/export ───────────────────────────────────────────────────

    app.get<{
      Querystring: { since?: string; limit?: string; offset?: string };
    }>("/library/export", { preHandler }, async (request, reply) => {
      // TODO: use `since` for incremental sync once updated_at tracking is solid
      const limit = Math.min(
        parseInt(request.query.limit ?? "500", 10),
        2000,
      );
      const offset = parseInt(request.query.offset ?? "0", 10);

      // Paginate over locally-sourced unified_tracks only.
      // Peer-imported tracks are never re-exported to prevent fan-out loops.
      const total = (
        app.db.prepare(
          `SELECT COUNT(DISTINCT ut.id) AS n
           FROM unified_tracks ut
           JOIN track_sources ts ON ts.unified_track_id = ut.id
           WHERE ts.source_kind = 'local'`,
        ).get() as { n: number }
      ).n;

      const tracks = app.db
        .prepare(
          `SELECT DISTINCT ut.id, ut.release_id, ut.artist_id, ut.title, ut.musicbrainz_id,
            ut.track_number, ut.disc_number, ut.duration_ms, ut.genre
          FROM unified_tracks ut
          JOIN track_sources ts ON ts.unified_track_id = ut.id
          WHERE ts.source_kind = 'local'
          ORDER BY ut.id
          LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as TrackExportRow[];

      if (tracks.length === 0) {
        return reply.send({
          instanceId: app.peerRegistry.instanceId,
          apiVersion: FEDERATION_API_VERSION,
          page: { limit, offset, total },
          artists: [],
          releaseGroups: [],
          releases: [],
          tracks: [],
        });
      }

      // Collect referenced IDs
      const trackIds = tracks.map((t) => t.id);
      const releaseIds = [...new Set(tracks.map((t) => t.release_id))];
      const artistIdsFromTracks = [...new Set(tracks.map((t) => t.artist_id))];

      const placeholders = (n: number) =>
        Array.from({ length: n }, () => "?").join(",");

      // Get releases referenced by these tracks
      const releases = app.db
        .prepare(
          `SELECT id, release_group_id, name, musicbrainz_id, edition, track_count
          FROM unified_releases
          WHERE id IN (${placeholders(releaseIds.length)})`,
        )
        .all(...releaseIds) as ReleaseExportRow[];

      const rgIds = [...new Set(releases.map((r) => r.release_group_id))];

      // Get release groups
      // Fetch raw cover_art_id from a local instance_album rather than the
      // encoded image_url, to avoid double-encoding when peers re-import this data.
      const releaseGroups = rgIds.length
        ? (app.db
            .prepare(
              `SELECT urg.id, urg.name, urg.artist_id, urg.musicbrainz_id, urg.year, urg.genre,
                (SELECT ia.cover_art_id
                 FROM unified_releases ur
                 JOIN unified_release_sources urs ON urs.unified_release_id = ur.id
                 JOIN instance_albums ia ON ia.id = urs.instance_album_id
                 WHERE ur.release_group_id = urg.id AND ia.instance_id = 'local'
                 LIMIT 1) AS cover_art_id
              FROM unified_release_groups urg
              WHERE urg.id IN (${placeholders(rgIds.length)})`,
            )
            .all(...rgIds) as ReleaseGroupExportRow[])
        : [];

      const artistIdsFromRGs = releaseGroups.map((rg) => rg.artist_id);
      const allArtistIds = [
        ...new Set([...artistIdsFromTracks, ...artistIdsFromRGs]),
      ];

      // Get artists
      const artists = allArtistIds.length
        ? (app.db
            .prepare(
              `SELECT id, name, musicbrainz_id, image_url
              FROM unified_artists
              WHERE id IN (${placeholders(allArtistIds.length)})`,
            )
            .all(...allArtistIds) as ArtistExportRow[])
        : [];

      // Only export local sources — peer-imported sources are never re-exported
      // to prevent fan-out loops where A→B→C sources end up back on A.
      const sources = trackIds.length
        ? (app.db
            .prepare(
              `SELECT ts.unified_track_id AS track_id, ts.remote_id,
                ts.format, ts.bitrate, ts.size
              FROM track_sources ts
              WHERE ts.source_kind = 'local'
                AND ts.unified_track_id IN (${placeholders(trackIds.length)})`,
            )
            .all(...trackIds) as SourceExportRow[])
        : [];

      // Group sources by track_id
      const sourcesByTrack = new Map<string, SourceExportRow[]>();
      for (const s of sources) {
        if (!sourcesByTrack.has(s.track_id)) sourcesByTrack.set(s.track_id, []);
        sourcesByTrack.get(s.track_id)!.push(s);
      }

      return reply.send({
        instanceId: app.peerRegistry.instanceId,
        apiVersion: FEDERATION_API_VERSION,
        page: { limit, offset, total },
        artists: artists.map((a) => ({
          id: a.id,
          name: a.name,
          musicbrainzId: a.musicbrainz_id,
          imageUrl: a.image_url,
        })),
        releaseGroups: releaseGroups.map((rg) => ({
          id: rg.id,
          name: rg.name,
          artistId: rg.artist_id,
          musicbrainzId: rg.musicbrainz_id,
          year: rg.year,
          genre: rg.genre,
          coverArtId: rg.cover_art_id, // raw id; importing peers encode as peerId:coverArtId
        })),
        releases: releases.map((r) => ({
          id: r.id,
          releaseGroupId: r.release_group_id,
          name: r.name,
          musicbrainzId: r.musicbrainz_id,
          edition: r.edition,
          trackCount: r.track_count,
        })),
        tracks: tracks.map((t) => ({
          id: t.id,
          releaseId: t.release_id,
          artistId: t.artist_id,
          title: t.title,
          musicbrainzId: t.musicbrainz_id,
          trackNumber: t.track_number,
          discNumber: t.disc_number,
          durationMs: t.duration_ms,
          genre: t.genre,
          sources: (sourcesByTrack.get(t.id) ?? []).map((s) => ({
            remoteId: s.remote_id,
            format: s.format,
            bitrate: s.bitrate,
            size: s.size,
          })),
        })),
      });
    });

    // ── GET /stream/:trackId ──────────────────────────────────────────────────

    app.get<{ Params: { trackId: string } }>(
      "/stream/:trackId",
      { preHandler },
      async (request, reply) => {
        const { trackId } = request.params;

        // Federation uses raw unified_track IDs (no "t" prefix)
        const source = app.db
          .prepare(
            `SELECT ts.remote_id, ts.format, ts.bitrate
            FROM track_sources ts
            WHERE ts.unified_track_id = ?
            ORDER BY COALESCE(ts.bitrate, 0) DESC
            LIMIT 1`,
          )
          .get(trackId) as
          | { remote_id: string; format: string | null; bitrate: number | null }
          | undefined;

        if (!source) {
          return reply.code(404).send({ error: "Track not found" });
        }

        const client = new SubsonicClient({
          url: app.config.navidromeUrl,
          username: app.config.navidromeUsername,
          password: app.config.navidromePassword,
        });

        let response: Response;
        try {
          response = await client.stream(source.remote_id);
        } catch {
          return reply.code(502).send({ error: "Upstream stream error" });
        }

        if (!response.body) {
          return reply.code(502).send({ error: "Empty upstream response" });
        }

        const headers: Record<string, string> = {
          "content-type":
            response.headers.get("content-type") || "audio/mpeg",
        };
        const contentLength = response.headers.get("content-length");
        if (contentLength) headers["content-length"] = contentLength;

        reply.raw.writeHead(response.status, headers);
        const nodeStream = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        );
        nodeStream.pipe(reply.raw);
        return reply;
      },
    );

    // ── GET /art/:encodedId ───────────────────────────────────────────────────

    app.get<{
      Params: { encodedId: string };
      Querystring: { size?: string };
    }>("/art/:encodedId", { preHandler }, async (request, reply) => {
      const { encodedId } = request.params;
      const { size } = request.query;

      let instanceId: string;
      let coverArtId: string;
      try {
        const decoded = decodeCoverArtId(encodedId);
        instanceId = decoded.instanceId;
        coverArtId = decoded.coverArtId;
      } catch {
        return reply.code(404).send({ error: "Invalid cover art ID" });
      }

      if (instanceId !== "local") {
        return reply
          .code(404)
          .send({ error: "Only local cover art is served via federation" });
      }

      const cacheKey = size ? `${encodedId}:${size}` : encodedId;

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
        return reply;
      }

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
        return reply.code(502).send({ error: "Failed to fetch cover art" });
      }

      if (!response.body) {
        return reply.code(502).send({ error: "Empty upstream response" });
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
      return reply;
    });
  };
