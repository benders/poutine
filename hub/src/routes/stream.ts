import type { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import { requireAuth } from "../auth/middleware.js";
import { decrypt } from "../auth/encryption.js";
import { SubsonicClient } from "../adapters/subsonic.js";

// ── Cover art ID helpers ─────────────────────────────────────────────────────

export function encodeCoverArtId(
  instanceId: string,
  coverArtId: string,
): string {
  return `${instanceId}:${coverArtId}`;
}

export function decodeCoverArtId(
  encoded: string,
): { instanceId: string; coverArtId: string } {
  const colonIdx = encoded.indexOf(":");
  if (colonIdx === -1) {
    throw new Error("Invalid cover art ID format");
  }
  return {
    instanceId: encoded.slice(0, colonIdx),
    coverArtId: encoded.slice(colonIdx + 1),
  };
}

// ── Source selection ──────────────────────────────────────────────────────────

interface TrackSourceRow {
  source_id: string;
  remote_id: string;
  format: string | null;
  bitrate: number | null;
  instance_id: string;
  instance_url: string;
  instance_status: string;
  encrypted_credentials: string;
}

const FORMAT_QUALITY: Record<string, number> = {
  flac: 100,
  wav: 90,
  alac: 85,
  opus: 70,
  aac: 60,
  mp3: 50,
  ogg: 45,
};

export function selectBestSource(
  sources: TrackSourceRow[],
  requestedFormat?: string,
): TrackSourceRow | null {
  // Filter to online instances
  const online = sources.filter((s) => s.instance_status === "online");
  if (online.length === 0) return null;

  // Score each source
  let best = online[0];
  let bestScore = scoreSource(best, requestedFormat);

  for (let i = 1; i < online.length; i++) {
    const score = scoreSource(online[i], requestedFormat);
    if (score > bestScore) {
      best = online[i];
      bestScore = score;
    }
  }

  return best;
}

function scoreSource(
  source: TrackSourceRow,
  requestedFormat?: string,
): number {
  let score = 0;

  // Prefer matching format (avoids transcoding)
  if (
    requestedFormat &&
    source.format &&
    source.format.toLowerCase() === requestedFormat.toLowerCase()
  ) {
    score += 200;
  }

  // Prefer higher quality format
  const formatScore =
    FORMAT_QUALITY[source.format?.toLowerCase() ?? ""] ?? 30;
  score += formatScore;

  // Prefer higher bitrate
  score += (source.bitrate ?? 0) / 10;

  return score;
}

// ── Create SubsonicClient from instance data ─────────────────────────────────

function createClientForInstance(
  source: { instance_url: string; encrypted_credentials: string },
  encryptionKey: string,
): SubsonicClient {
  const credentials = JSON.parse(
    decrypt(source.encrypted_credentials, encryptionKey),
  ) as { username: string; password: string };

  return new SubsonicClient({
    url: source.instance_url,
    username: credentials.username,
    password: credentials.password,
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────

export const streamRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/stream/:trackId - Stream audio for a unified track
  app.get<{
    Params: { trackId: string };
    Querystring: { format?: string; maxBitRate?: string };
  }>("/stream/:trackId", { preHandler: requireAuth }, async (request, reply) => {
    const { trackId } = request.params;
    const { format, maxBitRate } = request.query;

    // Look up all track_sources for this unified track, joined with instances
    const sources = app.db
      .prepare(
        `SELECT
          ts.id AS source_id,
          ts.remote_id,
          ts.format,
          ts.bitrate,
          i.id AS instance_id,
          i.url AS instance_url,
          i.status AS instance_status,
          i.encrypted_credentials
        FROM track_sources ts
        JOIN instances i ON ts.instance_id = i.id
        WHERE ts.unified_track_id = ?`,
      )
      .all(trackId) as TrackSourceRow[];

    if (sources.length === 0) {
      return reply.code(404).send({ error: "Track not found" });
    }

    const best = selectBestSource(sources, format);
    if (!best) {
      return reply
        .code(503)
        .send({ error: "No online instances available for this track" });
    }

    // Create SubsonicClient and stream
    let client: SubsonicClient;
    try {
      client = createClientForInstance(best, app.config.encryptionKey);
    } catch {
      return reply.code(500).send({ error: "Failed to connect to instance" });
    }

    let response: Response;
    try {
      const streamParams: { format?: string; maxBitRate?: number } = {};
      if (format) streamParams.format = format;
      if (maxBitRate) streamParams.maxBitRate = parseInt(maxBitRate, 10);

      response = await client.stream(best.remote_id, streamParams);
    } catch {
      return reply.code(502).send({ error: "Upstream instance error" });
    }

    if (!response.body) {
      return reply.code(502).send({ error: "Empty response from upstream" });
    }

    // Pipe the response to the client
    const headers: Record<string, string> = {
      "content-type":
        response.headers.get("content-type") || "audio/mpeg",
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      headers["content-length"] = contentLength;
    }

    reply.raw.writeHead(response.status, headers);
    const nodeStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    );
    nodeStream.pipe(reply.raw);
    return reply;
  });

  // GET /api/art/:id - Proxy cover art
  app.get<{
    Params: { id: string };
    Querystring: { size?: string };
  }>("/art/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params;
    const { size } = request.query;

    let instanceId: string;
    let coverArtId: string;
    try {
      const decoded = decodeCoverArtId(id);
      instanceId = decoded.instanceId;
      coverArtId = decoded.coverArtId;
    } catch {
      return reply.code(400).send({ error: "Invalid cover art ID format" });
    }

    // Get instance info
    const instance = app.db
      .prepare(
        `SELECT id, url, status, encrypted_credentials
        FROM instances WHERE id = ?`,
      )
      .get(instanceId) as
      | {
          id: string;
          url: string;
          status: string;
          encrypted_credentials: string;
        }
      | undefined;

    if (!instance) {
      return reply.code(404).send({ error: "Instance not found" });
    }

    let client: SubsonicClient;
    try {
      client = createClientForInstance(
        {
          instance_url: instance.url,
          encrypted_credentials: instance.encrypted_credentials,
        },
        app.config.encryptionKey,
      );
    } catch {
      return reply.code(500).send({ error: "Failed to connect to instance" });
    }

    let response: Response;
    try {
      const sizeNum = size ? parseInt(size, 10) : undefined;
      response = await client.getCoverArt(coverArtId, sizeNum);
    } catch {
      return reply.code(502).send({ error: "Failed to fetch cover art" });
    }

    if (!response.body) {
      return reply.code(502).send({ error: "Empty response from upstream" });
    }

    const headers: Record<string, string> = {
      "content-type":
        response.headers.get("content-type") || "image/jpeg",
      "cache-control": "public, max-age=2592000", // 30 days
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      headers["content-length"] = contentLength;
    }

    reply.raw.writeHead(response.status, headers);
    const nodeStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    );
    nodeStream.pipe(reply.raw);
    return reply;
  });
};
