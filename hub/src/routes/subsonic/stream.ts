import type { RouteHandlerMethod } from "fastify";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Peer } from "../../federation/peers.js";
import { sendBinaryError, decodeId } from "../subsonic-response.js";
import { decodeCoverArtId } from "../../library/cover-art.js";
import { isAllowedExternalArtUrl } from "../external-art.js";
import { SubsonicClient, SubsonicHttpError } from "../../adapters/subsonic.js";
import { applyTranscodeRule, buildStreamParams } from "../stream-params.js";
import { describeEnvelopeError, readEnvelopeError } from "../../adapters/upstream-envelope.js";
import { effectiveArtSize } from "./art-size.js";
import { resizeImage } from "../../services/art-resize.js";
import type { SubsonicRouteContext } from "./types.js";

/** One `track_sources` candidate for a stream (see `rankedSourcesForStream`). */
interface StreamSource {
  id: string;
  instance_id: string;
  format: string | null;
  bitrate: number | null;
  remote_id: string;
}

/** A candidate with the request resolved against it (transcode rule, Range). */
interface SourcePlan {
  source: StreamSource;
  streamParams: URLSearchParams;
  /** Caller's maxBitRate cap, Infinity when uncapped. */
  cap: number;
  /** Source bitrate, Infinity when unknown. */
  srcBr: number;
  rangeHeader: string | undefined;
}

interface SourceFailure {
  /** What the client gets if this is the reported failure. */
  status: 404 | 502;
  message: string;
  /** `stream_operations.error`. */
  reason: string;
  /** True for reachability faults (transport, timeout, 5xx) — feeds SourceHealth. */
  instanceFault: boolean;
}

/**
 * Resolve the caller's params against one source. Per source because the
 * transcode rule and the raw-passthrough decision depend on the source's own
 * format/bitrate — a failover must not inherit the previous source's plan.
 * Both paths go through buildStreamParams (#77/#91).
 */
function planSource(
  source: StreamSource,
  q: Record<string, string>,
  range: string | string[] | undefined,
): SourcePlan {
  const streamParams = applyTranscodeRule(buildStreamParams(q), {
    format: source.format,
    bitrate: source.bitrate,
  });

  // Forward Range only for raw passthrough streams. If transcoding is in
  // play, byte offsets in the upstream response would not map to the
  // transcoded bytes the caller expects. (#97 — transcoded seek tracked
  // separately.)
  const cap = Number(streamParams.get("maxBitRate")) || Infinity;
  const srcBr = source.bitrate ?? Infinity;
  const isRaw =
    !streamParams.has("format") &&
    !streamParams.has("timeOffset") &&
    srcBr <= cap;
  const rangeHeader = isRaw && typeof range === "string" ? range : undefined;
  return { source, streamParams, cap, srcBr, rangeHeader };
}

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

  /**
   * One attempt against one source. Resolves to the upstream response ready to
   * pipe (2xx/206, or a 416 answering the caller's Range), or to a failure
   * that `handleStream` may fail over from — nothing has been written to the
   * client either way.
   */
  async function fetchFromSource(
    request: Parameters<RouteHandlerMethod>[0],
    trackId: string,
    plan: SourcePlan,
  ): Promise<
    | { ok: true; response: Response & { body: ReadableStream } }
    | { ok: false; failure: SourceFailure }
  > {
    const { source, streamParams, rangeHeader } = plan;
    const fail = (failure: SourceFailure) => ({ ok: false as const, failure });

    // A source that hasn't answered with headers in time counts as down; the
    // timer is cleared once headers arrive so it never cuts a slow body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), app.sourceHealth.connectTimeoutMs);
    timer.unref();

    let response: Response;
    try {
      if (source.instance_id === "local") {
        const client = new SubsonicClient({
          url: app.config.navidromeUrl,
          username: app.config.navidromeUsername,
          password: app.config.navidromePassword,
        });
        try {
          const opts: { format?: string; maxBitRate?: number; timeOffset?: number; estimateContentLength?: boolean; range?: string; signal?: AbortSignal } = {
            signal: controller.signal,
          };
          const fmt = streamParams.get("format");
          const br = streamParams.get("maxBitRate");
          const to = streamParams.get("timeOffset");
          const ecl = streamParams.get("estimateContentLength");
          if (fmt) opts.format = fmt;
          if (br) opts.maxBitRate = parseInt(br, 10);
          if (to) opts.timeOffset = parseInt(to, 10);
          if (ecl === "true") opts.estimateContentLength = true;
          if (rangeHeader) opts.range = rangeHeader;
          response = await client.stream(source.remote_id, opts);
        } catch (err) {
          // Log the upstream detail. Swallowing it here is what made the #277
          // outage invisible: Navidrome 500s on every stream while /rest/ping
          // stays green, and the hub reported only a generic 502. The adapter's
          // observer (NavidromeMonitor) has already counted the fault and
          // reported it to APM — this line is the local breadcrumb.
          request.log.error(
            { err, navidromeTrackId: source.remote_id, trackId },
            "Navidrome stream request failed",
          );
          // A 4xx is about this request, not Navidrome's health (#277).
          const status = err instanceof SubsonicHttpError ? err.status : null;
          const requestLevel = status !== null && status < 500;
          return fail({
            status: status === 404 ? 404 : 502,
            message: "Stream error",
            reason: "Stream error",
            instanceFault: !requestLevel,
          });
        }
      } else {
        const peer = app.peerRegistry.peers.get(source.instance_id);
        if (!peer || peer.lifecycle !== "active") {
          return fail({ status: 502, message: "Peer not available", reason: "Peer not available", instanceFault: false });
        }
        try {
          const qs = streamParams.toString();
          const path = `/federation/stream/${encodeURIComponent(source.remote_id)}${qs ? `?${qs}` : ""}`;
          response = await app.federatedFetch(
            peer,
            path,
            {
              asUser: request.subsonicUser.username,
              headers: rangeHeader ? { range: rangeHeader } : undefined,
              signal: controller.signal,
            },
          );
        } catch (err) {
          // Peer-side detail stays local (never echoed to the caller, #156), but
          // it must be logged — a peer that stops serving bytes is as silent a
          // failure as a sick local Navidrome was in #277.
          request.log.error(
            { err, peerId: source.instance_id, trackId },
            "Peer stream request failed",
          );
          return fail({ status: 502, message: "Peer stream error", reason: "Peer stream error", instanceFault: true });
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (!response.body) {
      request.log.error(
        { trackId, sourceInstance: source.instance_id, upstreamStatus: response.status },
        "Upstream stream response had no body",
      );
      return fail({
        status: 502,
        message: "Empty response from upstream",
        reason: "Empty response from upstream",
        instanceFault: true,
      });
    }

    // A peer's /federation/stream answers a stale remote_id with a real 404
    // (#285). Only peer responses reach here non-2xx — SubsonicClient throws.
    // 416 is a legitimate answer to the caller's Range and passes through.
    if (!response.ok && response.status !== 416) {
      await response.body.cancel().catch(() => {});
      return fail({
        status: response.status === 404 ? 404 : 502,
        message: response.status === 404 ? "Track not found at source" : "Stream error",
        reason: `Source returned HTTP ${response.status}`,
        instanceFault: response.status >= 500,
      });
    }

    // Navidrome reports a failed stream (stale remote_id, file gone) as HTTP 200
    // + a Subsonic error envelope. A peer's /federation/stream relays the same
    // envelope when it predates #285. Never pipe that to the client as audio.
    const envelopeError = await readEnvelopeError(response);
    if (envelopeError) {
      request.log.warn(
        { trackId, instanceId: source.instance_id, remoteId: source.remote_id, code: envelopeError.code },
        "Stream source returned a Subsonic error envelope",
      );
      return fail({
        status: envelopeError.httpStatus,
        message: envelopeError.httpStatus === 404 ? "Track not found at source" : "Stream error",
        reason: describeEnvelopeError(envelopeError),
        // An envelope is an answer from a live upstream, never a reachability fault.
        instanceFault: false,
      });
    }

    return { ok: true, response: response as Response & { body: ReadableStream } };
  }

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

  // Merge picks the preferred source; at stream time we walk every source in
  // rank order and fail over while no response headers have been sent (#241).
  // Sources that failed recently (SourceHealth) are tried last, not skipped.
  const ranked = queries.rankedSourcesForStream.all(trackId) as StreamSource[];
  if (ranked.length === 0) {
    sendBinaryError(reply, 404, "Track not found");
    return;
  }
  const candidates = app.sourceHealth.order(ranked);

  // Deferred until the winning source is known so the activity row records
  // the source, format and transcode flags actually used (#241).
  const startTracking = (plan: SourcePlan): string | undefined => {
    if (!trackRow) return undefined;
    const { source, streamParams, cap, srcBr } = plan;
    const transcoded = streamParams.has("format") || (Number.isFinite(cap) && srcBr > cap);
    // Cast-token-authed stream → tag activity with the appropriate kind
    // (#218). `dlna=1` flag set by buildStreamUrl for DLNA renderers; cast
    // token without the flag is from a Sonos device.
    const streamKind: "subsonic" | "cast" | "dlna" = q.castToken
      ? q.dlna === "1"
        ? "dlna"
        : "cast"
      : "subsonic";
    return app.streamTracking.start({
      kind: streamKind,
      username: request.subsonicUser.username,
      trackId: trackRow.id,
      trackTitle: trackRow.title,
      artistName: trackRow.artist_name,
      albumId: trackRow.rg_id,
      clientName: q.c ?? null,
      clientVersion: q.v ?? null,
      sourceKind: source.instance_id === "local" ? "local" : "peer",
      sourcePeerId: source.instance_id === "local" ? null : source.instance_id,
      format: source.format,
      bitrate: source.bitrate,
      transcoded,
      maxBitrate: Number.isFinite(cap) ? cap : null,
    });
  };

  let winner: { plan: SourcePlan; response: Response & { body: ReadableStream } } | undefined;
  let lastFailure: { plan: SourcePlan; failure: SourceFailure } | undefined;
  let worstFailure: typeof lastFailure;

  for (const [i, source] of candidates.entries()) {
    if (reply.raw.destroyed) return; // client gave up while we were failing over

    const plan = planSource(source, q, request.headers.range);
    const result = await fetchFromSource(request, trackId, plan);
    if (result.ok) {
      app.sourceHealth.recordSuccess(source.instance_id);
      winner = { plan, response: result.response };
      if (i > 0) {
        request.log.warn(
          { trackId, instanceId: source.instance_id, attempt: i + 1 },
          "Stream failed over to a non-preferred source",
        );
      }
      break;
    }

    if (result.failure.instanceFault) app.sourceHealth.recordFailure(source.instance_id);
    lastFailure = { plan, failure: result.failure };
    // A 5xx-class failure outranks "not found" when choosing what to report.
    if (!worstFailure || result.failure.status >= worstFailure.failure.status) {
      worstFailure = lastFailure;
    }
    if (i < candidates.length - 1) {
      request.log.warn(
        { trackId, instanceId: source.instance_id, reason: result.failure.reason },
        "Stream source failed; trying next source",
      );
    }
  }

  if (!winner) {
    // Every source failed. Record one activity row for the last attempt and
    // answer 404 only if every source said "not found"; any reachability
    // fault makes it a 502. Upstream text is never echoed (#156).
    const report = (worstFailure ?? lastFailure)!;
    const opId = startTracking(report.plan);
    if (opId) app.streamTracking.finish(opId, 0, report.failure.reason);
    sendBinaryError(reply, report.failure.status, report.failure.message);
    return;
  }

  const { plan: { source: best }, response } = winner;
  const streamOpId = startTracking(winner.plan);
  let bytesTransferred = 0;

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
    const premature = nodeErr.code === "ERR_STREAM_PREMATURE_CLOSE";
    if (streamOpId) {
      app.streamTracking.finish(
        streamOpId,
        bytesTransferred,
        premature ? null : (nodeErr.message ?? "stream error"),
      );
    }
    if (!premature) {
      // A genuine mid-transfer failure: bytes started flowing and then
      // stopped. The adapter observer can't see this (it only watches the
      // response headers), so report it here (#277).
      request.log.error(
        {
          err,
          trackId,
          sourceInstance: best.instance_id,
          bytesTransferred,
        },
        "Stream aborted mid-transfer",
      );
      app.telemetry.noticeError(
        nodeErr instanceof Error ? nodeErr : new Error(String(err)),
        {
          streamSource: best.instance_id,
          bytesTransferred,
          errCode: nodeErr.code ?? "unknown",
        },
      );
    }
  }
}

  binaryRoute("/stream", handleStream);
  // /download is no longer a stream alias — it returns original bytes with a
  // Content-Disposition header (and album ZIPs). See download.ts (#35).
}
