import type { FastifyPluginAsync } from "fastify";
import {
  SonosControl,
  SONOS_VOLUME_CAP,
  chooseSonosCastFormat,
  type TrackMetadata,
} from "../services/sonos-control.js";
import type { SonosDiscoveryService } from "../services/sonos-discovery.js";
import { signCastToken } from "../services/cast-tokens.js";
import { requireAuth } from "../auth/middleware.js";
import { SubsonicClient } from "../adapters/subsonic.js";

/**
 * Sonos S2 firmware caps locally-streamed FLAC at 24-bit / 48 kHz. Material
 * above this (24/96, 24/192) is accepted at the AVTransport URI but silently
 * dropped to STOPPED when the device parses the FLAC header — see #199. Until
 * the full per-format capability table lands there, this route does a runtime
 * `getSong` probe and forces MP3 transcode when the local source exceeds these
 * limits. Peer-routed sources fall through (we don't probe peers).
 */
const SONOS_MAX_SAMPLE_RATE_HZ = 48_000;
const SONOS_MAX_BIT_DEPTH = 24;

/**
 * REST control surface for Sonos devices. Mounted at /api/sonos when
 * SONOS_ENABLED=true. The frontend's SonosDriver calls these.
 *
 * Play flow: the client posts {trackId} → backend mints a signed cast token,
 * builds `${POUTINE_LAN_URL}/cast/stream/:trackId?token=…`, then issues
 * SetAVTransportURI + Play on the device.
 */
declare module "fastify" {
  interface FastifyInstance {
    sonosDiscovery: SonosDiscoveryService;
    sonosControl: SonosControl;
  }
}

interface PlayBody {
  trackId: string;
  /** Optional start position in seconds. */
  position?: number;
  /**
   * When false, set the AVTransport URI + seek (if requested) but do NOT
   * issue Play. Lets the frontend load a track on a paused sink without
   * surprise auto-play when the user switches devices.
   * Default: true (backwards compatible).
   */
  autoplay?: boolean;
}

interface SeekBody {
  position: number;
}

interface VolumeBody {
  level: number;
}

export const sonosRoutes: FastifyPluginAsync = async (app) => {
  if (!app.config.sonosEnabled) return;

  // Every route under /api/sonos/* requires a logged-in user. The frontend
  // already sends the JWT via `Authorization: Bearer ...`; without this
  // gate, anyone on the LAN could enumerate Sonos rooms and blast audio.
  app.addHook("preHandler", requireAuth);

  app.get("/devices", async () => {
    return {
      devices: app.sonosDiscovery.list().map((d) => ({
        id: d.id,
        room: d.room,
        model: d.model,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/devices/:id/state", async (req, reply) => {
    const dev = app.sonosDiscovery.get(req.params.id);
    if (!dev) return reply.status(404).send({ error: "Device not found" });
    try {
      const state = await app.sonosControl.getState(dev);
      const volume = await app.sonosControl.getVolume(dev);
      return { ...state, volume, volumeCap: SONOS_VOLUME_CAP };
    } catch (err) {
      return reply.status(502).send({ error: String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: PlayBody }>(
    "/devices/:id/play",
    async (req, reply) => {
      const dev = app.sonosDiscovery.get(req.params.id);
      if (!dev) return reply.status(404).send({ error: "Device not found" });
      const { trackId, position, autoplay = true } = req.body ?? ({} as PlayBody);
      if (!trackId) return reply.status(400).send({ error: "trackId required" });
      if (!app.config.poutineLanUrl) {
        return reply.status(500).send({
          error:
            "POUTINE_LAN_URL is not configured — required for Sonos to fetch streams",
        });
      }

      // Resolve the incoming trackId to a unified_tracks UUID. cast.ts
      // /stream + the cast token both verify against unified_tracks.
      //
      // Accepted inputs:
      //   1. Subsonic song id from the SPA: "t<unified-uuid>" — the hub's
      //      /rest/* endpoints encode unified_tracks.id with a "t" prefix
      //      (see encodeId in subsonic-response.ts).
      //   2. Raw unified_tracks UUID — direct API callers / tests.
      //   3. Instance remote_id (e.g. Navidrome's 22-char hash) — older
      //      flows / debugging.
      // Real-world unified_tracks IDs are UUIDs (hex + dashes) and never
      // start with "t", so stripping the prefix is unambiguous in
      // production. Still, try both the raw value and the stripped form
      // so a test fixture or future ID scheme doesn't break the route.
      const candidates =
        trackId.startsWith("t") && trackId.length > 1
          ? [trackId, trackId.slice(1)]
          : [trackId];

      let unifiedTrackId: string | undefined;
      const unifiedQ = app.db.prepare(
        "SELECT id FROM unified_tracks WHERE id = ?",
      );
      for (const c of candidates) {
        const row = unifiedQ.get(c) as { id: string } | undefined;
        if (row) {
          unifiedTrackId = row.id;
          break;
        }
      }
      if (!unifiedTrackId) {
        const sourceQ = app.db.prepare(
          `SELECT ts.unified_track_id AS uid
           FROM instance_tracks it
           JOIN track_sources ts ON ts.instance_track_id = it.id
           WHERE it.remote_id = ?
           LIMIT 1`,
        );
        for (const c of candidates) {
          const row = sourceQ.get(c) as { uid: string } | undefined;
          if (row) {
            unifiedTrackId = row.uid;
            break;
          }
        }
      }
      if (!unifiedTrackId) {
        return reply.status(404).send({ error: "Track not found" });
      }

      const trackRow = app.db
        .prepare(
          `SELECT ut.id, ut.title, ut.duration_ms, ua.name AS artist_name,
                  urg.name AS album_name, urg.image_url AS album_art
           FROM unified_tracks ut
           JOIN unified_artists ua ON ua.id = ut.artist_id
           LEFT JOIN unified_releases ur ON ur.id = ut.release_id
           LEFT JOIN unified_release_groups urg ON urg.id = ur.release_group_id
           WHERE ut.id = ?`,
        )
        .get(unifiedTrackId) as
        | {
            id: string;
            title: string;
            duration_ms: number | null;
            artist_name: string;
            album_name: string | null;
            album_art: string | null;
          }
        | undefined;
      if (!trackRow) return reply.status(404).send({ error: "Track not found" });

      // Recover username from the JWT-authenticated user so we can encode
      // it in the cast token. Stream-tracking and federated peer routing
      // at /cast/stream time both want the originating user's identity.
      const user = app.db
        .prepare("SELECT username FROM users WHERE id = ?")
        .get(req.userId) as { username: string } | undefined;
      if (!user) {
        return reply.status(401).send({ error: "User not found" });
      }

      // Look up the preferred source's format so we can decide whether
      // Sonos can play the bytes verbatim or needs MP3 transcoding (#180).
      // Matches the source-selection query in stream-relay.ts.
      const sourceRow = app.db
        .prepare(
          `SELECT ts.format, ts.instance_id, it.remote_id
             FROM track_sources ts
             JOIN instance_tracks it ON it.id = ts.instance_track_id
            WHERE ts.unified_track_id = ? AND ts.preferred = 1
            LIMIT 1`,
        )
        .get(unifiedTrackId) as
        | { format: string | null; instance_id: string; remote_id: string }
        | undefined;
      const decision = chooseSonosCastFormat(
        sourceRow?.format ?? null,
        dev.supportedMimes ?? null,
      );
      let { mime, transcode } = decision;

      // Hi-res FLAC guard (#180 workaround for #199). When we're about to
      // pass FLAC through from the local Navidrome, ask Subsonic for the
      // file's samplingRate + bitDepth. If either exceeds the S2 ceiling,
      // downgrade to MP3 transcode. Skipped for peer sources (no Navidrome
      // available) and for non-FLAC formats (MP3/AAC/etc. have no rate cap
      // that Sonos cares about at our bitrates).
      if (
        !transcode &&
        sourceRow?.format?.toLowerCase() === "flac" &&
        sourceRow.instance_id === "local"
      ) {
        try {
          const client = new SubsonicClient({
            url: app.config.navidromeUrl,
            username: app.config.navidromeUsername,
            password: app.config.navidromePassword,
          });
          const song = await client.getSong(sourceRow.remote_id);
          const sr = song.samplingRate ?? 0;
          const bd = song.bitDepth ?? 0;
          if (sr > SONOS_MAX_SAMPLE_RATE_HZ || bd > SONOS_MAX_BIT_DEPTH) {
            app.log.info(
              { trackId: unifiedTrackId, samplingRate: sr, bitDepth: bd },
              "Sonos: hi-res FLAC exceeds S2 ceiling — forcing MP3 transcode",
            );
            mime = "audio/mpeg";
            transcode = true;
          }
        } catch (err) {
          // Probe failure: keep pass-through. 16/44.1 is the overwhelming
          // common case and Navidrome being unreachable is a louder problem
          // the stream itself will surface.
          app.log.warn(
            { err, trackId: unifiedTrackId },
            "Sonos: hi-res probe failed; proceeding with pass-through",
          );
        }
      }

      const token = signCastToken(app.castSecret, {
        trackId: unifiedTrackId,
        username: user.username,
      });
      const base = app.config.poutineLanUrl.replace(/\/+$/, "");
      // When transcoding, force MP3 so byte content-type matches the
      // audio/mpeg DIDL mime. When passing through, omit `format=` so
      // Navidrome streams source bytes and the DIDL declares the matching
      // mime — Sonos rejects a stream whose content-type doesn't match
      // what its AVTransport URI metadata declared.
      //
      // When the client asks to start mid-track, embed Subsonic's
      // `timeOffset` in the cast URL so the stream itself begins at that
      // position. Don't use SOAP `Seek` afterward — transcoded MP3 streams
      // have no Range support, so seeking past the buffer drives Sonos to
      // STOPPED and the SPA's poller misreads that as end-of-track (#182).
      // Same path handles mid-track sink switches (#194). The offset rides
      // on a query param the token doesn't cover, but the token still binds
      // trackId + user, so an attacker can't widen scope by adding params.
      const startAt =
        typeof position === "number" && position > 0
          ? Math.floor(position)
          : 0;
      const streamUri =
        `${base}/cast/stream/${encodeURIComponent(unifiedTrackId)}` +
        `?token=${encodeURIComponent(token)}` +
        (transcode ? `&format=mp3` : "") +
        (startAt > 0 ? `&timeOffset=${startAt}` : "");

      const meta: TrackMetadata = {
        trackId: unifiedTrackId,
        title: trackRow.title,
        artist: trackRow.artist_name,
        album: trackRow.album_name ?? "",
        albumArtUri: trackRow.album_art ?? null,
        durationSec: Math.max(0, Math.round((trackRow.duration_ms ?? 0) / 1000)),
        mimeType: mime,
      };

      try {
        // Safety clamp on cast start. If the device is currently above the
        // cap (e.g. left blasting from the Sonos app), drop it to the cap
        // BEFORE audio hits. Below-cap settings are preserved — the user
        // may have deliberately set the device quieter.
        // Tolerate getVolume failures: better to play at an unknown level
        // than fail the cast outright.
        try {
          const current = await app.sonosControl.getVolume(dev);
          if (current > SONOS_VOLUME_CAP) {
            await app.sonosControl.setVolume(dev, SONOS_VOLUME_CAP);
          }
        } catch (err) {
          app.log.warn(
            { err, deviceId: dev.id },
            "Sonos: getVolume preflight failed; proceeding without cap check",
          );
        }
        await app.sonosControl.setAvTransportUri(dev, streamUri, meta);
        // No SOAP Seek here — the stream URL above already starts at
        // `startAt`. See #182 / #194 above.
        if (autoplay) await app.sonosControl.play(dev);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }
    },
  );

  const simpleAction = (action: "pause" | "resume" | "stop") => {
    app.post<{ Params: { id: string } }>(
      `/devices/:id/${action}`,
      async (req, reply) => {
        const dev = app.sonosDiscovery.get(req.params.id);
        if (!dev) return reply.status(404).send({ error: "Device not found" });
        try {
          if (action === "pause") await app.sonosControl.pause(dev);
          else if (action === "resume") await app.sonosControl.play(dev);
          else await app.sonosControl.stop(dev);
          return { ok: true };
        } catch (err) {
          return reply.status(502).send({ error: String(err) });
        }
      },
    );
  };
  simpleAction("pause");
  simpleAction("resume");
  simpleAction("stop");

  app.post<{ Params: { id: string }; Body: SeekBody }>(
    "/devices/:id/seek",
    async (req, reply) => {
      const dev = app.sonosDiscovery.get(req.params.id);
      if (!dev) return reply.status(404).send({ error: "Device not found" });
      const { position } = req.body ?? ({} as SeekBody);
      if (typeof position !== "number" || position < 0) {
        return reply.status(400).send({ error: "position must be a non-negative number" });
      }
      try {
        await app.sonosControl.seek(dev, position);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: VolumeBody }>(
    "/devices/:id/volume",
    async (req, reply) => {
      const dev = app.sonosDiscovery.get(req.params.id);
      if (!dev) return reply.status(404).send({ error: "Device not found" });
      const { level } = req.body ?? ({} as VolumeBody);
      // Request-shape check only. The real ceiling is `SONOS_VOLUME_CAP`,
      // enforced inside `setVolume`. A POST of e.g. 80 succeeds and is
      // silently clamped to the cap — do NOT re-add a 400 here, the SPA's
      // notion of the cap can lag a server-side change.
      if (typeof level !== "number" || level < 0 || level > 100) {
        return reply.status(400).send({ error: "level must be 0..100" });
      }
      try {
        await app.sonosControl.setVolume(dev, level);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }
    },
  );
};
