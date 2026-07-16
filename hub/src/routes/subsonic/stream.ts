import type { RouteHandlerMethod } from "fastify";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Peer } from "../../federation/peers.js";
import { sendBinaryError, decodeId } from "../subsonic-response.js";
import { decodeCoverArtId } from "../../library/cover-art.js";
import { isAllowedExternalArtUrl } from "../external-art.js";
import { SubsonicClient } from "../../adapters/subsonic.js";
import { applyTranscodeRule, buildStreamParams } from "../stream-params.js";
import { effectiveArtSize } from "./art-size.js";
import { resizeImage } from "../../services/art-resize.js";
import type { SubsonicRouteContext } from "./types.js";

export function registerStream(ctx: SubsonicRouteContext): void {
  const { app, queries, binaryRoute } = ctx;

  // ── getCoverArt ─────────────────────────────────────────────────────────────
  // Binary endpoint: uses requireSubsonicAuthBinary so auth failures return
  // real HTTP error codes instead of a 200+JSON Subsonic envelope.

  binaryRoute("/getCoverArt", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const id = q.id ?? "";
    const effSize = effectiveArtSize(q.size);

    // Raw external URL `id` (e.g. 3rd-party Subsonic clients echoing back the
    // `coverArt` value we returned for an artist image). Skip decodeCoverArtId
    // — the embedded `https:` colon would mis-parse as an instance prefix —
    // and route through the external-fetch branch below.
    let instanceId: string;
    let coverArtId: string;
    if (id.startsWith("http://") || id.startsWith("https://")) {
      instanceId = "local";
      coverArtId = id;
    } else {
      try {
        const decoded = decodeCoverArtId(id);
        instanceId = decoded.instanceId;
        coverArtId = decoded.coverArtId;
      } catch {
        sendBinaryError(reply, 400, "Invalid cover art ID");
        return;
      }
    }

    const cacheKey = `${id}:${effSize}`;

    // Check cache first (covers both local and peer art). Skip a hit if the
    // cached entry is not a real image — old Navidrome "missing cover" XML
    // envelopes may have been cached before the upstream-validation fix.
    const cached = app.artCache.get(cacheKey);
    if (cached && cached.contentType.startsWith("image/") && cached.data.length > 0) {
      reply.raw.writeHead(200, {
        "content-type": cached.contentType,
        "content-length": String(cached.data.length),
        "cache-control": "public, max-age=2592000",
        "x-cache": "HIT",
      });
      reply.raw.end(cached.data);
      return;
    }
    if (cached) {
      // Poisoned entry — drop it and re-fetch.
      app.artCache.delete(cacheKey);
    }

    let response: Response;
    const isExternal = coverArtId.startsWith("http://") || coverArtId.startsWith("https://");

    // External URL (e.g. fanart.tv album cover stored when Navidrome had none).
    // The decoded coverArtId is the full https:// URL — fetch it directly
    // instead of routing through Navidrome or a peer proxy. Restricted to a
    // fanart.tv hostname allowlist; peer-supplied URLs to other hosts are
    // rejected to prevent SSRF.
    if (isExternal) {
      if (!isAllowedExternalArtUrl(coverArtId)) {
        sendBinaryError(reply, 400, "Disallowed external art URL");
        return;
      }
      try {
        response = await fetch(coverArtId);
      } catch {
        sendBinaryError(reply, 502, "Failed to fetch external art");
        return;
      }
    } else if (instanceId !== "local") {
      // Peer art routing via /proxy/rest/getCoverArt — Ed25519-signed request to the peer's proxy.
      // The signing path must include the /proxy prefix (as seen by the peer's Fastify router).
      const peer = app.peerRegistry.peers.get(instanceId);
      if (!peer) {
        sendBinaryError(reply, 404, "Peer not found");
        return;
      }
      try {
        const artParams = new URLSearchParams({ id: coverArtId, size: String(effSize) });
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
        response = await client.getCoverArt(coverArtId, effSize);
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
    let buffer = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type") || "image/jpeg";

    // Navidrome answers a missing cover with HTTP 200 + a Subsonic XML/JSON
    // error envelope (Content-Type: text/xml or application/json), not an
    // image. Don't cache or serve those — let the client treat it as 404 so
    // a future re-sync can supply a real cover (e.g. via fanart.tv).
    if (buffer.length === 0 || !contentType.startsWith("image/")) {
      sendBinaryError(reply, 404, "Art not found");
      return;
    }

    // External art (fanart.tv/Last.fm) ignores `size` entirely — downsample
    // it hub-side to the requested dimension. Local/peer art is already
    // resized upstream by Navidrome.
    if (isExternal) {
      const resized = await resizeImage(buffer, contentType, effSize);
      buffer = Buffer.from(resized.data);
    }

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
  const trackRow = queries.trackForStream.get(trackId) as
    | { id: string; title: string; artist_name: string; duration_ms: number | null; rg_id: string }
    | undefined;

  if (!trackRow) {
    request.log.warn(`Stream tracking: track ${trackId} not found in unified_tracks`);
  }

  // Defer stream tracking start until after source/transcode resolution
  // so we can record format/bitrate/source/transcode flags up front.
  let streamOpId: string | undefined;

  // Source selection happens at merge time (merge.ts sets preferred = 1).
  // At stream time we just look up THE source for this unified track.
  const best = queries.preferredSourceForStream.get(trackId) as
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
    // Cast-token-authed stream → tag activity with the appropriate kind
    // (#218). `dlna=1` flag set by buildStreamUrl for DLNA renderers; cast
    // token without the flag is from a Sonos device.
    const streamKind: "subsonic" | "cast" | "dlna" = q.castToken
      ? q.dlna === "1"
        ? "dlna"
        : "cast"
      : "subsonic";
    streamOpId = app.streamTracking.start({
      kind: streamKind,
      username: request.subsonicUser.username,
      trackId: trackRow.id,
      trackTitle: trackRow.title,
      artistName: trackRow.artist_name,
      albumId: trackRow.rg_id,
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
  // `dlna=1` flag (set by `buildStreamUrl` for DLNA renderers, #218):
  // strict renderers (WMP, Xbox) require `transferMode.dlna.org` +
  // `contentFeatures.dlna.org` on the byte response, and tolerate a
  // forced `accept-ranges: bytes` even when upstream omits it.
  const isDlna = q.dlna === "1";
  const acceptRanges =
    response.headers.get("accept-ranges") || (isDlna ? "bytes" : null);
  if (acceptRanges) headers["accept-ranges"] = acceptRanges;
  if (isDlna) {
    const reqHeaders = request.headers as Record<string, string | undefined>;
    headers["transferMode.dlna.org"] =
      reqHeaders["transfermode.dlna.org"] ?? "Streaming";
    headers["contentFeatures.dlna.org"] =
      "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000";
  }
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

  // pipeline() (unlike bare .pipe()) propagates a client disconnect back to
  // the source: the upstream fetch is cancelled instead of drained to
  // completion into a dead socket. With bare .pipe() an aborted request never
  // fired end/error — the activity entry stayed "active" forever and recorded
  // the full file size no matter how little the client took (#263 review).
  // A premature close is normal listener behavior (skip, seek, page close),
  // not an error worth flagging in the activity feed.
  try {
    await pipeline(nodeStream, reply.raw);
    if (streamOpId) app.streamTracking.finish(streamOpId, bytesTransferred, null);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (streamOpId) {
      app.streamTracking.finish(
        streamOpId,
        bytesTransferred,
        nodeErr.code === "ERR_STREAM_PREMATURE_CLOSE"
          ? null
          : (nodeErr.message ?? "stream error"),
      );
    }
  }
}

  binaryRoute("/stream", handleStream);
  // /download is no longer a stream alias — it returns original bytes with a
  // Content-Disposition header (and album ZIPs). See download.ts (#35).
}
