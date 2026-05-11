import type { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import { SubsonicClient } from "../adapters/subsonic.js";
import { applyTranscodeRule, buildStreamParams } from "./stream-params.js";
import { verifyCastToken } from "../services/cast-tokens.js";

/**
 * Token-authenticated streaming endpoint for casting devices (Sonos etc.)
 * that can't compute Subsonic auth.
 *
 * GET /cast/stream/:trackId?token=<hmac>.<exp>
 *
 * Mounted only when SONOS_ENABLED=true. The token binds to the trackId and
 * has a short TTL — see services/cast-tokens.ts.
 */
declare module "fastify" {
  interface FastifyInstance {
    castSecret: Buffer;
  }
}

export const castRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { trackId: string }; Querystring: Record<string, string> }>(
    "/stream/:trackId",
    async (request, reply) => {
      const { trackId } = request.params;
      const token = request.query.token;
      if (!token) {
        reply.status(401).send({ error: "Missing token" });
        return;
      }
      const verified = verifyCastToken(app.castSecret, trackId, token);
      if (!verified) {
        reply.status(403).send({ error: "Invalid or expired token" });
        return;
      }

      const trackRow = app.db
        .prepare(
          `SELECT ut.id, ut.title, ua.name AS artist_name
           FROM unified_tracks ut
           JOIN unified_artists ua ON ua.id = ut.artist_id
           WHERE ut.id = ?`,
        )
        .get(trackId) as
        | { id: string; title: string; artist_name: string }
        | undefined;

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

      if (!best || !trackRow) {
        reply.status(404).send({ error: "Track not found" });
        return;
      }

      const streamParams = applyTranscodeRule(buildStreamParams(request.query), {
        format: best.format,
        bitrate: best.bitrate,
      });

      const cap = Number(streamParams.get("maxBitRate")) || Infinity;
      const srcBr = best.bitrate ?? Infinity;
      const transcoded =
        streamParams.has("format") || (Number.isFinite(cap) && srcBr > cap);

      const streamOpId = app.streamTracking.start({
        kind: "cast",
        username: verified.userId,
        trackId: trackRow.id,
        trackTitle: trackRow.title,
        artistName: trackRow.artist_name,
        clientName: "sonos",
        clientVersion: null,
        sourceKind: best.instance_id === "local" ? "local" : "peer",
        sourcePeerId: best.instance_id === "local" ? null : best.instance_id,
        format: best.format,
        bitrate: best.bitrate,
        transcoded,
        maxBitrate: Number.isFinite(cap) ? cap : null,
      });

      let response: Response;
      try {
        if (best.instance_id === "local") {
          const client = new SubsonicClient({
            url: app.config.navidromeUrl,
            username: app.config.navidromeUsername,
            password: app.config.navidromePassword,
          });
          const opts: {
            format?: string;
            maxBitRate?: number;
            timeOffset?: number;
            range?: string;
          } = {};
          const fmt = streamParams.get("format");
          const br = streamParams.get("maxBitRate");
          const to = streamParams.get("timeOffset");
          if (fmt) opts.format = fmt;
          if (br) opts.maxBitRate = parseInt(br, 10);
          if (to) opts.timeOffset = parseInt(to, 10);
          if (typeof request.headers.range === "string" && !transcoded) {
            opts.range = request.headers.range;
          }
          response = await client.stream(best.remote_id, opts);
        } else {
          const peer = app.peerRegistry.peers.get(best.instance_id);
          if (!peer) {
            app.streamTracking.finish(streamOpId, 0, "Peer not available");
            reply.status(502).send({ error: "Peer not available" });
            return;
          }
          const qs = streamParams.toString();
          const path = `/federation/stream/${encodeURIComponent(best.remote_id)}${qs ? `?${qs}` : ""}`;
          response = await app.federatedFetch(peer, path, {
            asUser: verified.userId,
            headers:
              typeof request.headers.range === "string" && !transcoded
                ? { range: request.headers.range }
                : undefined,
          });
        }
      } catch (err) {
        app.streamTracking.finish(streamOpId, 0, `Stream error: ${String(err)}`);
        reply.status(502).send({ error: "Stream error" });
        return;
      }

      if (!response.body) {
        app.streamTracking.finish(streamOpId, 0, "Empty response from upstream");
        reply.status(502).send({ error: "Empty response from upstream" });
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

      let bytesTransferred = 0;
      nodeStream.on("data", (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        app.streamTracking.updateBytes(streamOpId, bytesTransferred);
      });
      nodeStream.on("end", () => {
        app.streamTracking.finish(streamOpId, bytesTransferred, null);
      });
      nodeStream.on("error", (err) => {
        app.streamTracking.finish(
          streamOpId,
          bytesTransferred,
          err instanceof Error ? err.message : String(err),
        );
      });
      nodeStream.pipe(reply.raw);
    },
  );
};
