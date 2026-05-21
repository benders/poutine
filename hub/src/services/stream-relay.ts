/**
 * Shared streaming pipeline for non-Subsonic endpoints (`/cast/stream` and
 * `/dlna/stream`). Selects the preferred source (local Navidrome vs peer
 * federation), applies the transcode rule, opens the upstream response,
 * forwards response headers + body, and bookkeeps `stream_operations`.
 *
 * Callers supply the differentiators: attribution `username`, the
 * `kind`/`clientName` tags used in tracking, and any extra response headers
 * to merge in (DLNA's `transferMode.dlna.org` / `contentFeatures.dlna.org`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { SubsonicClient } from "../adapters/subsonic.js";
import { getPreferredSource } from "../db/preferred-source.js";
import {
  applyTranscodeRule,
  buildStreamParams,
} from "../routes/stream-params.js";
import type { StreamKind } from "./stream-tracking.js";

export interface StreamRelayOptions {
  trackId: string;
  /** Stream-tracking kind tag (`cast`, `dlna`, …). */
  kind: StreamKind;
  /** Attribution user. Also used as `asUser` for peer fetches. */
  username: string;
  /** Stream-tracking `clientName`. */
  clientName: string;
  /** Extra response headers merged into the proxied reply. */
  extraResponseHeaders?: Record<string, string>;
  /**
   * If set, treated as a default for `accept-ranges` when upstream omits it.
   * DLNA wants `bytes` baked in; cast only forwards what upstream provided.
   */
  defaultAcceptRanges?: string;
}

export interface StreamRelayMissReason {
  status: number;
  error: string;
}

/**
 * Drive a track stream onto `reply`. Returns void on success (response
 * already written). On miss (track unknown, no source, peer offline, …)
 * the function sends the error reply itself and returns.
 */
export async function relayTrackStream(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: StreamRelayOptions,
): Promise<void> {
  const { trackId } = opts;

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

  if (!trackRow) {
    reply.status(404).send({ error: "Track not found" });
    return;
  }

  const best = getPreferredSource(app.db, trackId);

  if (!best) {
    // Track exists in the unified library but has no preferred source —
    // operationally this is "the source instance is offline / unmerged",
    // not "object missing." 503 distinguishes for ops triage.
    reply.status(503).send({ error: "No source available for track" });
    return;
  }

  const query = request.query as Record<string, string>;
  const streamParams = applyTranscodeRule(buildStreamParams(query), {
    format: best.format,
    bitrate: best.bitrate,
  });
  const cap = Number(streamParams.get("maxBitRate")) || Infinity;
  const srcBr = best.bitrate ?? Infinity;
  const transcoded =
    streamParams.has("format") || (Number.isFinite(cap) && srcBr > cap);

  const streamOpId = app.streamTracking.start({
    kind: opts.kind,
    username: opts.username,
    trackId: trackRow.id,
    trackTitle: trackRow.title,
    artistName: trackRow.artist_name,
    clientName: opts.clientName,
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
      const subOpts: {
        format?: string;
        maxBitRate?: number;
        timeOffset?: number;
        range?: string;
      } = {};
      const fmt = streamParams.get("format");
      const br = streamParams.get("maxBitRate");
      const to = streamParams.get("timeOffset");
      if (fmt) subOpts.format = fmt;
      if (br) subOpts.maxBitRate = parseInt(br, 10);
      if (to) subOpts.timeOffset = parseInt(to, 10);
      if (typeof request.headers.range === "string" && !transcoded) {
        subOpts.range = request.headers.range;
      }
      response = await client.stream(best.remote_id, subOpts);
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
        asUser: opts.username,
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
  const acceptRanges =
    response.headers.get("accept-ranges") || opts.defaultAcceptRanges;
  if (acceptRanges) headers["accept-ranges"] = acceptRanges;
  const contentRange = response.headers.get("content-range");
  if (contentRange) headers["content-range"] = contentRange;
  if (opts.extraResponseHeaders) {
    for (const [k, v] of Object.entries(opts.extraResponseHeaders)) {
      headers[k] = v;
    }
  }

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
}
