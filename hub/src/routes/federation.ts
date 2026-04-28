/**
 * Federation routes for peer-to-peer communication.
 * 
 * These routes are called by peer hubs to fetch resources on their behalf.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { createRequirePeerAuth } from "../federation/peer-auth.js";
import { buildStreamParams } from "./stream-params.js";

// ── HTTP agents for upstream requests ────────────────────────────────────────

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const federationRoutes: FastifyPluginAsync = async (app) => {
  const requirePeerAuth = createRequirePeerAuth({
    registry: app.peerRegistry,
    db: app.db,
  });

  // Stream audio from local Navidrome to peer
  app.get("/stream/:id", { preHandler: requirePeerAuth }, async (request, reply) => {
    const config = app.config;
    const { id: trackId } = request.params as { id: string };

    // Build the stream URL for local Navidrome
    const targetBase = config.navidromeUrl.replace(/\/+$/, "");
    const targetUrl = new URL(`${targetBase}/rest/stream`);
    
    // Add Subsonic auth params
    const salt = crypto.randomBytes(8).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(config.navidromePassword + salt)
      .digest("hex");
    
    targetUrl.searchParams.set("u", config.navidromeUsername);
    targetUrl.searchParams.set("t", token);
    targetUrl.searchParams.set("s", salt);
    targetUrl.searchParams.set("v", "1.16.1");
    targetUrl.searchParams.set("c", "poutine-federation");
    targetUrl.searchParams.set("id", trackId);
    
    // Forward Subsonic passthrough params (format, maxBitRate, timeOffset, …)
    // via a single shared helper so the local and peer paths agree.
    const q = request.query as Record<string, string>;
    for (const [key, val] of buildStreamParams(q)) {
      targetUrl.searchParams.set(key, val);
    }

    // Make the upstream request
    const isHttps = targetUrl.protocol === "https:";
    const agent = isHttps ? httpsAgent : httpAgent;

    // Forward Range from peer caller so the upstream can return 206 + bytes
    // (#97). Other headers stay out of the federation passthrough.
    const upstreamHeaders: Record<string, string> = {};
    const incomingRange = request.headers.range;
    if (typeof incomingRange === "string") {
      upstreamHeaders.range = incomingRange;
    }

    const upstreamResponse = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: "GET",
          headers: upstreamHeaders,
          agent,
        };

        const req = (isHttps ? https : http).request(options, resolve);
        req.on("error", reject);
        req.end();
      },
    );

    // Forward response
    const responseHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(upstreamResponse.headers)) {
      if (key.toLowerCase() !== "set-cookie" && val !== undefined) {
        responseHeaders[key.toLowerCase()] = Array.isArray(val)
          ? val.join(", ")
          : val;
      }
    }

    // ── Stream tracking (issue #121) ──────────────────────────────────────────
    // Record this peer-served stream as kind='proxy'. The track is identified
    // by the Navidrome remote_id we just looked up; resolve to unified track
    // metadata for display.
    let streamOpId: string | undefined;
    let bytesTransferred = 0;
    if (
      (upstreamResponse.statusCode ?? 0) >= 200 &&
      (upstreamResponse.statusCode ?? 0) < 300
    ) {
      const trackRow = app.db
        .prepare(
          `SELECT ut.id AS track_id, ut.title, ua.name AS artist_name,
                  ts.format, ts.bitrate
           FROM instance_tracks it
           JOIN track_sources ts ON ts.instance_track_id = it.id
           JOIN unified_tracks ut ON ut.id = ts.unified_track_id
           JOIN unified_artists ua ON ua.id = ut.artist_id
           WHERE it.instance_id = 'local' AND it.remote_id = ?
           LIMIT 1`,
        )
        .get(trackId) as
        | {
            track_id: string;
            title: string;
            artist_name: string;
            format: string | null;
            bitrate: number | null;
          }
        | undefined;
      if (trackRow) {
        // Honor the caller's transcode params so the activity row reflects
        // what was actually streamed, not the original source file.
        const reqFormat = q.format ? String(q.format) : null;
        const reqMaxBitrate = q.maxBitRate ? Number(q.maxBitRate) : NaN;
        const srcBr = trackRow.bitrate ?? 0;
        const capApplies = Number.isFinite(reqMaxBitrate) && srcBr > reqMaxBitrate;
        const transcoded = reqFormat !== null || capApplies;
        const effectiveFormat = reqFormat ?? trackRow.format;
        const effectiveBitrate = capApplies ? reqMaxBitrate : trackRow.bitrate;
        streamOpId = app.streamTracking.start({
          kind: "proxy",
          username: request.peer.userAssertion,
          trackId: trackRow.track_id,
          trackTitle: trackRow.title,
          artistName: trackRow.artist_name,
          peerId: request.peer.id,
          sourceKind: "local",
          format: effectiveFormat,
          bitrate: effectiveBitrate,
          transcoded,
          maxBitrate: Number.isFinite(reqMaxBitrate) ? reqMaxBitrate : null,
        });
      }
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

    if (streamOpId) {
      upstreamResponse.on("data", (chunk: Buffer) => {
        bytesTransferred += chunk.length;
        app.streamTracking.updateBytes(streamOpId!, bytesTransferred);
      });
    }

    try {
      await pipeline(upstreamResponse, raw);
      if (streamOpId) app.streamTracking.finish(streamOpId, bytesTransferred, null);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        app.log.error(err, "federation stream pipeline error");
      }
      if (streamOpId) {
        app.streamTracking.finish(
          streamOpId,
          bytesTransferred,
          nodeErr.code === "ERR_STREAM_PREMATURE_CLOSE" ? null : (nodeErr.message ?? "pipeline error"),
        );
      }
    }
  });
};
