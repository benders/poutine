import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { Peer } from "../../federation/peers.js";
import { sendBinaryError, decodeId } from "../subsonic-response.js";
import { SubsonicClient } from "../../adapters/subsonic.js";
import type { SubsonicRouteContext, TrackRow } from "./types.js";

// ── /rest/download (#35) ──────────────────────────────────────────────────────
// Navidrome/Subsonic semantics: unlike /rest/stream, download returns the
// ORIGINAL media bytes — no transcoding, no maxBitRate — with a
// Content-Disposition: attachment header so browsers save instead of play.
//   id=t<uuid>  → single track, original file
//   id=al<uuid> → whole album as a ZIP (entries stored, not deflated — audio
//                 doesn't compress, and store keeps the response streaming)
// Peer-sourced tracks are proxied raw through /federation/stream, same
// source-selection as streaming (track_sources.preferred = 1).

interface PreferredSource {
  instance_id: string;
  format: string | null;
  bitrate: number | null;
  remote_id: string;
}

/** Common audio content-types → file extension, for sources with no format. */
const EXT_BY_MIME: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/** Strip path separators, Windows-forbidden characters, and control chars. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "untitled";
}

/** RFC 6266 Content-Disposition with an ASCII fallback + UTF-8 filename*. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^ -~]/g, "_").replace(/"/g, "'");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function extensionFor(format: string | null, contentType: string | null): string | null {
  if (format) return format;
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[mime] ?? null;
}

export function registerDownload(ctx: SubsonicRouteContext): void {
  const { app, queries, binaryRoute } = ctx;

  /** Fetch a track's original bytes from its preferred source — no transcode params. */
  async function fetchRawSource(
    source: PreferredSource,
    request: FastifyRequest,
  ): Promise<Response> {
    if (source.instance_id === "local") {
      const client = new SubsonicClient({
        url: app.config.navidromeUrl,
        username: app.config.navidromeUsername,
        password: app.config.navidromePassword,
      });
      return client.stream(source.remote_id);
    }
    const peer = app.peerRegistry.peers.get(source.instance_id);
    if (!peer) throw new Error(`Peer ${source.instance_id} not available`);
    const proxyPeer: Peer = peer;
    return app.federatedFetch(
      proxyPeer,
      `/federation/stream/${encodeURIComponent(source.remote_id)}`,
      { asUser: request.subsonicUser.username },
    );
  }

  async function handleTrackDownload(
    trackId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const track = queries.trackForSong.get(trackId) as TrackRow | undefined;
    const best = queries.preferredSourceForStream.get(trackId) as
      | PreferredSource
      | undefined;
    if (!track || !best) {
      sendBinaryError(reply, 404, "Track not found");
      return;
    }

    let response: Response;
    try {
      response = await fetchRawSource(best, request);
    } catch {
      sendBinaryError(reply, 502, "Download source unavailable");
      return;
    }
    if (!response.ok || !response.body) {
      sendBinaryError(reply, 502, "Download source unavailable");
      return;
    }

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const ext = extensionFor(best.format, contentType);
    const base = sanitizeFilename(`${track.artist_name} - ${track.title}`);
    const filename = ext ? `${base}.${ext}` : base;

    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-disposition": attachmentDisposition(filename),
    };
    const contentLength = response.headers.get("content-length");
    if (contentLength) headers["content-length"] = contentLength;

    reply.raw.writeHead(200, headers);
    Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    ).pipe(reply.raw);
  }

  async function handleAlbumDownload(
    rgId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const rg = queries.releaseGroupById.get(rgId) as
      | { id: string; name: string; artist_name: string }
      | undefined;
    if (!rg) {
      sendBinaryError(reply, 404, "Album not found");
      return;
    }

    const release = queries.bestReleaseForGroup.get(rgId) as
      | { id: string }
      | undefined;
    const tracks: TrackRow[] = release
      ? (queries.tracksForRelease.all(release.id) as TrackRow[])
      : [];
    if (tracks.length === 0) {
      sendBinaryError(reply, 404, "Album has no tracks");
      return;
    }

    const zipName = `${sanitizeFilename(`${rg.artist_name} - ${rg.name}`)}.zip`;
    reply.raw.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": attachmentDisposition(zipName),
    });

    const zip = new ZipFile();
    zip.outputStream.pipe(reply.raw);

    const multiDisc = tracks.some((t) => (t.disc_number ?? 1) > 1);
    const usedNames = new Set<string>();

    // Sequential on purpose: one upstream fetch open at a time, so a large
    // album never holds N connections to Navidrome/peers. yazl writes entries
    // in order, so each stream is fully consumed before the next fetch starts.
    for (const track of tracks) {
      if (reply.raw.destroyed) return; // client went away mid-zip

      const best = queries.preferredSourceForStream.get(track.id) as
        | PreferredSource
        | undefined;
      if (!best) {
        request.log.warn(`Album download: no source for track ${track.id}, skipping`);
        continue;
      }

      let response: Response;
      try {
        response = await fetchRawSource(best, request);
      } catch {
        request.log.warn(`Album download: fetch failed for track ${track.id}, skipping`);
        continue;
      }
      if (!response.ok || !response.body) {
        request.log.warn(`Album download: upstream ${response.status} for track ${track.id}, skipping`);
        continue;
      }

      const ext = extensionFor(best.format, response.headers.get("content-type"));
      const nn = String(track.track_number ?? 0).padStart(2, "0");
      const prefix = multiDisc ? `${track.disc_number ?? 1}-${nn}` : nn;
      let entryName = sanitizeFilename(`${prefix} - ${track.title}`);
      if (ext) entryName += `.${ext}`;
      // yazl throws on duplicate entry names — disambiguate defensively.
      while (usedNames.has(entryName)) entryName = `_${entryName}`;
      usedNames.add(entryName);

      const nodeStream = Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      );
      zip.addReadStream(nodeStream, entryName, { compress: false });

      // Wait for yazl to drain this entry before opening the next fetch.
      // If the client disconnects, the pipe stalls forever — bail on close.
      try {
        await new Promise<void>((resolve, reject) => {
          const onClose = () => {
            nodeStream.destroy();
            resolve();
          };
          reply.raw.once("close", onClose);
          nodeStream.once("end", () => {
            reply.raw.off("close", onClose);
            resolve();
          });
          nodeStream.once("error", (err) => {
            reply.raw.off("close", onClose);
            reject(err);
          });
        });
      } catch (err) {
        // Upstream died mid-entry: the ZIP is unsalvageable (bytes already
        // written) — kill the connection so the client sees a failure.
        request.log.warn(
          `Album download: stream error for track ${track.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        reply.raw.destroy();
        return;
      }
      if (reply.raw.destroyed) return;
    }

    zip.end();
  }

  binaryRoute("/download", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const id = q.id ?? "";

    if (id.startsWith("al")) {
      let rgId: string;
      try {
        rgId = decodeId(id, "al");
      } catch {
        sendBinaryError(reply, 400, "Invalid album ID");
        return;
      }
      await handleAlbumDownload(rgId, request, reply);
      return;
    }

    let trackId: string;
    try {
      trackId = decodeId(id, "t");
    } catch {
      sendBinaryError(reply, 400, "Invalid download ID");
      return;
    }
    await handleTrackDownload(trackId, request, reply);
  });
}
