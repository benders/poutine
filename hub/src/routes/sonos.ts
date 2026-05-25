import type { FastifyPluginAsync } from "fastify";
import {
  SonosControl,
  SONOS_MAX_SAMPLE_RATE_HZ,
  SONOS_MAX_BIT_DEPTH,
  chooseSonosCastFormat,
  type TrackMetadata,
} from "../services/sonos-control.js";
import type { SonosDiscoveryService } from "../services/sonos-discovery.js";
import type { SonosSettings } from "../services/sonos-settings.js";
import { buildStreamUrl } from "../services/cast-tokens.js";
import { requireAuth } from "../auth/middleware.js";
import { SubsonicClient } from "../adapters/subsonic.js";
import { getPreferredSource } from "../db/preferred-source.js";


/**
 * REST control surface for Sonos devices. Always mounted at /api/sonos —
 * routes 503 when the admin has Sonos disabled in `settings` (#184). The
 * frontend's SonosDriver calls these.
 *
 * Play flow: the client posts {trackId} → backend mints a signed cast token,
 * builds `${lan_url}/cast/stream/:trackId?token=…`, then issues
 * SetAVTransportURI + Play on the device.
 */
declare module "fastify" {
  interface FastifyInstance {
    sonosDiscovery: SonosDiscoveryService;
    sonosControl: SonosControl;
    sonosSettings: SonosSettings;
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

interface NextBody {
  /**
   * Track to pre-load for gapless auto-advance (#202). Null/omitted clears
   * the next-URI slot — used at end of queue, on sink switch, and after
   * Stop. The hub mints a token with TTL covering current+next durations
   * plus a 10-minute buffer so a long pause across a track boundary
   * doesn't expire the queued stream.
   */
  trackId: string | null;
  /**
   * Combined seconds the token must remain valid: roughly
   * `currentTrack.duration + nextTrack.duration`. The hub adds its own
   * buffer on top. Optional; if absent the default 1 h TTL is used.
   */
  ttlSec?: number;
}

interface SeekBody {
  position: number;
}

interface VolumeBody {
  level: number;
}

export const sonosRoutes: FastifyPluginAsync = async (app) => {
  // Cached `{samplingRate, bitDepth}` per Navidrome `remote_id` for the
  // hi-res FLAC guard. Naturally static (audio properties don't change at
  // runtime) and bounded by local library size. Lives on the plugin
  // closure so each app instance gets its own — important for tests, and
  // also drops on process restart for free. #199 will replace this with
  // a `track_sources` schema column.
  const hiResProbeCache = new Map<string, { sr: number; bd: number }>();
  const probeHiResFlac = async (
    remoteId: string,
    unifiedTrackId: string,
  ): Promise<{ sr: number; bd: number } | null> => {
    const cached = hiResProbeCache.get(remoteId);
    if (cached) return cached;
    try {
      const client = new SubsonicClient({
        url: app.config.navidromeUrl,
        username: app.config.navidromeUsername,
        password: app.config.navidromePassword,
      });
      const song = await client.getSong(remoteId);
      const result = { sr: song.samplingRate ?? 0, bd: song.bitDepth ?? 0 };
      hiResProbeCache.set(remoteId, result);
      return result;
    } catch (err) {
      // 16/44.1 is the overwhelming common case; Navidrome being
      // unreachable is a louder problem the stream itself will surface.
      app.log.warn(
        { err, trackId: unifiedTrackId },
        "Sonos: hi-res probe failed; proceeding with pass-through",
      );
      return null;
    }
  };

  /**
   * Resolve any of the trackId shapes the /play route accepts to a
   * unified_tracks UUID, then assemble the cast stream URL + DIDL metadata.
   * Shared by /play (current track) and /next (pre-loaded follow-up, #202).
   *
   * Returns a discriminated result so callers map cleanly to HTTP status.
   * Does NOT issue any SOAP — the caller decides whether this is a
   * SetAVTransportURI or SetNextAVTransportURI invocation.
   */
  type CastBuild =
    | {
        ok: true;
        unifiedTrackId: string;
        streamUri: string;
        meta: TrackMetadata;
        transcoded: boolean;
      }
    | { ok: false; status: number; error: string };

  const buildCast = async (
    rawTrackId: string,
    userId: string,
    dev: { supportedMimes?: Set<string> | null },
    opts: { position?: number; ttlSec?: number } = {},
  ): Promise<CastBuild> => {
    const lanUrl = app.sonosSettings.getLanUrl();
    if (!lanUrl) {
      return {
        ok: false,
        status: 500,
        error:
          "LAN URL is not configured — set it from Admin → Sonos so devices can fetch streams",
      };
    }

    // Resolve the incoming trackId to a unified_tracks UUID. See /play
    // handler comments for the accepted ID shapes; the same prefix-stripping
    // ambiguity guard applies here.
    const candidates =
      rawTrackId.startsWith("t") && rawTrackId.length > 1
        ? [rawTrackId, rawTrackId.slice(1)]
        : [rawTrackId];

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
      return { ok: false, status: 404, error: "Track not found" };
    }

    const trackRow = app.db
      .prepare(
        `SELECT ut.title, ut.duration_ms, ua.name AS artist_name,
                urg.name AS album_name, urg.image_url AS album_art,
                u.username
         FROM unified_tracks ut
         JOIN unified_artists ua ON ua.id = ut.artist_id
         LEFT JOIN unified_releases ur ON ur.id = ut.release_id
         LEFT JOIN unified_release_groups urg ON urg.id = ur.release_group_id
         CROSS JOIN users u
         WHERE ut.id = ? AND u.id = ?`,
      )
      .get(unifiedTrackId, userId) as
      | {
          title: string;
          duration_ms: number | null;
          artist_name: string;
          album_name: string | null;
          album_art: string | null;
          username: string;
        }
      | undefined;
    if (!trackRow) {
      return { ok: false, status: 404, error: "Track not found" };
    }

    const source = getPreferredSource(app.db, unifiedTrackId);
    let { mime, transcode } = chooseSonosCastFormat(
      source?.format,
      dev.supportedMimes,
    );

    if (
      !transcode &&
      source?.format?.toLowerCase() === "flac" &&
      source.instance_id === "local"
    ) {
      const probe = await probeHiResFlac(source.remote_id, unifiedTrackId);
      if (probe && (probe.sr > SONOS_MAX_SAMPLE_RATE_HZ || probe.bd > SONOS_MAX_BIT_DEPTH)) {
        app.log.info(
          { trackId: unifiedTrackId, samplingRate: probe.sr, bitDepth: probe.bd },
          "Sonos: hi-res FLAC exceeds S2 ceiling — forcing MP3 transcode",
        );
        mime = "audio/mpeg";
        transcode = true;
      }
    }

    const startAt =
      typeof opts.position === "number" && opts.position > 0
        ? Math.floor(opts.position)
        : 0;
    // `timeOffset` only works when Navidrome is transcoding — on raw
    // pass-through it is silently ignored and the file is served from
    // byte 0 (#204). For pass-through, the /play handler issues a SOAP
    // Seek after the URI loads instead.
    //
    // #218: Sonos devices fetch bytes directly from Hub's Subsonic
    // `/rest/stream.view` with the cast token as auth. No Player relay.
    const streamUri = buildStreamUrl({
      lanUrl,
      castSecret: app.castSecret,
      unifiedTrackId,
      username: trackRow.username,
      ttlSec: opts.ttlSec,
      ...(transcode ? { format: "mp3" } : {}),
      ...(transcode && startAt > 0 ? { timeOffsetSec: startAt } : {}),
      client: "poutine-sonos",
    });

    const meta: TrackMetadata = {
      trackId: unifiedTrackId,
      title: trackRow.title,
      artist: trackRow.artist_name,
      album: trackRow.album_name ?? "",
      albumArtUri: trackRow.album_art ?? null,
      durationSec: Math.max(0, Math.round((trackRow.duration_ms ?? 0) / 1000)),
      mimeType: mime,
    };

    return { ok: true, unifiedTrackId, streamUri, meta, transcoded: transcode };
  };

  // Reject every /api/sonos/* request when the admin has Sonos disabled
  // (#184). Runs before auth so unauthenticated probes also see 503 — the
  // SPA's capabilities probe is unauthenticated and reads this signal
  // indirectly via /api/capabilities, but a direct /api/sonos/devices hit
  // should also fail loud.
  app.addHook("preHandler", async (_req, reply) => {
    if (!app.sonosSettings.getEnabled()) {
      return reply.code(503).send({ error: "Sonos is disabled" });
    }
  });

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
      return { ...state, volume, volumeCap: app.sonosSettings.getVolumeCap() };
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

      // Pass-through (`format=` omitted) requires the byte content-type
      // to match the DIDL mime; mismatch sends Sonos to STOPPED.
      // Mid-track starts split by mode (#204): transcoded MP3 bakes
      // `timeOffset` into the cast URL (no Range — SOAP Seek past the
      // buffer drives STOPPED, see #182/#194), raw pass-through ignores
      // `timeOffset` and is seeked via SOAP `Seek` below.
      const cast = await buildCast(trackId, req.userId, dev, { position });
      if (!cast.ok) return reply.status(cast.status).send({ error: cast.error });
      const seekAfterPlay =
        !cast.transcoded && typeof position === "number" && position > 0
          ? Math.floor(position)
          : 0;

      try {
        // Volume preflight + URI load are independent SOAP calls, so run
        // them concurrently. Drop above-cap volume to the cap before audio
        // hits (preserve below-cap settings — user may have set it quieter).
        // Tolerate getVolume failures: better to play at an unknown level
        // than fail the cast outright.
        await Promise.all([
          (async () => {
            try {
              const cap = app.sonosSettings.getVolumeCap();
              const current = await app.sonosControl.getVolume(dev);
              if (current > cap) {
                await app.sonosControl.setVolume(dev, cap, cap);
              }
            } catch (err) {
              app.log.warn(
                { err, deviceId: dev.id },
                "Sonos: getVolume preflight failed; proceeding without cap check",
              );
            }
          })(),
          app.sonosControl.setAvTransportUri(dev, cast.streamUri, cast.meta),
        ]);
        if (autoplay) await app.sonosControl.play(dev);
        // Pass-through resume / mid-track sink switch: SOAP Seek to the
        // requested position after Play. Range-capable, so Sonos pulls a
        // fresh GET at the byte offset that maps to REL_TIME (#204).
        if (seekAfterPlay > 0) {
          try {
            await app.sonosControl.seek(dev, seekAfterPlay);
          } catch (err) {
            app.log.warn(
              { err, deviceId: dev.id, position: seekAfterPlay },
              "Sonos: post-play seek failed",
            );
          }
        }
        // `transcoded` lets the SPA pick the right seek path: SOAP Seek for
        // raw pass-through (Range-capable), SetAVTransportURI+timeOffset
        // re-issue for transcoded MP3 (no Range — see #182 / #204).
        return { ok: true, transcoded: cast.transcoded };
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }
    },
  );

  /**
   * Pre-load the next track for gapless auto-advance (#202). Null/omitted
   * trackId clears the slot — used at end of queue, on sink switch, and
   * after Stop. The SPA fires this after a successful /play and whenever
   * the queue's "next" mutates (skip, shuffle, repeat toggle).
   *
   * Token TTL is whatever the SPA passes (typically current+next durations);
   * `buildCast` mints accordingly. The caller is responsible for sizing this
   * to outlive the longest realistic pause across the track boundary.
   */
  app.post<{ Params: { id: string }; Body: NextBody }>(
    "/devices/:id/next",
    async (req, reply) => {
      const dev = app.sonosDiscovery.get(req.params.id);
      if (!dev) return reply.status(404).send({ error: "Device not found" });
      const { trackId, ttlSec } = req.body ?? ({} as NextBody);

      if (!trackId) {
        try {
          await app.sonosControl.setNextAvTransportUri(dev, "", null);
          return { ok: true, cleared: true };
        } catch (err) {
          return reply.status(502).send({ error: String(err) });
        }
      }

      const cast = await buildCast(trackId, req.userId, dev, { ttlSec });
      if (!cast.ok) return reply.status(cast.status).send({ error: cast.error });

      try {
        await app.sonosControl.setNextAvTransportUri(dev, cast.streamUri, cast.meta);
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
      // Request-shape check only. The real ceiling is the live
      // `sonos_volume_cap` setting (#184), enforced inside `setVolume`. A
      // POST of e.g. 80 succeeds and is silently clamped to the cap — do
      // NOT re-add a 400 here, the SPA's notion of the cap can lag a
      // server-side change.
      if (typeof level !== "number" || level < 0 || level > 100) {
        return reply.status(400).send({ error: "level must be 0..100" });
      }
      try {
        await app.sonosControl.setVolume(
          dev,
          level,
          app.sonosSettings.getVolumeCap(),
        );
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({ error: String(err) });
      }
    },
  );
};
