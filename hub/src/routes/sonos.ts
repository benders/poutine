import type { FastifyPluginAsync } from "fastify";
import {
  SonosControl,
  chooseSonosCastFormat,
  type TrackMetadata,
} from "../services/sonos-control.js";
import type { SonosDiscoveryService } from "../services/sonos-discovery.js";
import type { SonosSettings } from "../services/sonos-settings.js";
import { buildStreamUrl } from "../services/cast-tokens.js";
import { requireAuth } from "../auth/middleware.js";
import type { HubSubsonicCaller } from "../services/hub-subsonic-caller.js";
import { shouldForceMp3 } from "../services/sonos-capabilities.js";


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
    /**
     * #220: in-process Hub Subsonic caller for sonos route. All
     * track-metadata + source-info reads go through this HTTP-shaped
     * surface — no `SubsonicClient` adapter import, no direct `app.db`
     * access. Wired in `server.ts`.
     */
    hubSubsonicSonos: HubSubsonicCaller;
  }
}

/**
 * Minimal Subsonic `song` shape this route consumes. The Hub `/rest/getSong`
 * response has many more fields; we only narrow the ones we use.
 */
interface SubsonicSongInfo {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  coverArt?: string;
  suffix?: string;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
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
  // #199: hi-res FLAC silently STOPs on Sonos when the FLAC header exceeds
  // firmware ceilings (S2: 24/48/2-ch, S1: 16/48/2-ch). protocolInfo doesn't
  // surface these — gate at cast time using model + Subsonic `getSong`'s
  // samplingRate / bitDepth / channelCount, force MP3 when any exceed the
  // ceiling. Pure logic lives in `services/sonos-capabilities.ts`.

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
    username: string,
    dev: { model?: string; supportedMimes?: Set<string> | null },
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

    // #220: Resolve track via Hub Subsonic `getSong` — no direct `app.db`
    // access. The route accepts either `t<uuid>` (Subsonic id, what the SPA
    // sends) or a bare `<uuid>` (historical). Bare ids get the `t` prefix
    // added so `getSong` sees a well-formed Subsonic id.
    //
    // Bare Navidrome `remote_id` resolution was removed — the SPA has
    // always sent the unified Subsonic id; the remote_id fallback was dead
    // defensive code.
    // Build candidate Subsonic IDs to probe via `getSong`. The SPA sends
    // `t<uuid>` (Subsonic-encoded), so that's the primary form; the bare
    // `<uuid>` fallback covers historical callers + tests. Dedupe.
    const seen = new Set<string>();
    const candidates: string[] = [];
    const push = (s: string): void => {
      if (!seen.has(s)) {
        seen.add(s);
        candidates.push(s);
      }
    };
    if (rawTrackId.startsWith("t")) push(rawTrackId);
    push(`t${rawTrackId}`);

    let song: SubsonicSongInfo | undefined;
    let unifiedTrackId: string | undefined;
    for (const candidate of candidates) {
      try {
        const body = await app.hubSubsonicSonos.call(
          "/rest/getSong",
          { id: candidate },
          // #224: auth as the calling SPA user via the in-process trusted-
          // header path. Eliminates the POUTINE_OWNER credential dependency
          // on the cast hot-path (silent 404 when owner u+p didn't match a
          // real hub user — see docs/pitfalls.md "Sonos cast").
          { asUser: username },
        );
        const sr = body["subsonic-response"];
        if (sr.status === "ok" && sr.song) {
          song = sr.song as SubsonicSongInfo;
          // Strip the `t` prefix to recover the unified UUID — used in
          // the cast token + stream URL.
          unifiedTrackId = song.id.startsWith("t") ? song.id.slice(1) : song.id;
          break;
        }
      } catch (err) {
        app.log.debug(
          { err, candidate, rawTrackId },
          "Sonos: getSong probe failed for candidate id, trying next",
        );
      }
    }

    if (!song || !unifiedTrackId) {
      return { ok: false, status: 404, error: "Track not found" };
    }

    const mimeChoice = chooseSonosCastFormat(song.suffix ?? null, dev.supportedMimes);
    // #199: even when MIME pass-through is fine, force MP3 when the source
    // exceeds the target Sonos line's firmware ceiling. OR'd with the MIME-
    // mismatch transcode flag — either signal lands us in the MP3 path.
    const forceMp3 = shouldForceMp3(
      dev.model,
      song.samplingRate,
      song.bitDepth,
      song.channelCount,
    );
    const transcode = mimeChoice.transcode || forceMp3;
    const mime = transcode ? "audio/mpeg" : mimeChoice.mime;
    app.log.info(
      {
        trackId: unifiedTrackId,
        model: dev.model,
        suffix: song.suffix,
        samplingRate: song.samplingRate,
        bitDepth: song.bitDepth,
        channelCount: song.channelCount,
        mimeMismatch: mimeChoice.transcode,
        hiresGate: forceMp3,
        transcode,
      },
      "sonos cast format decision",
    );

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
      username,
      ttlSec: opts.ttlSec,
      ...(transcode ? { format: "mp3" } : {}),
      ...(transcode && startAt > 0 ? { timeOffsetSec: startAt } : {}),
      client: "poutine-sonos",
    });

    // Hub Subsonic returns `coverArt` as either a full external URL
    // (federated `image_url`) or a Subsonic id that maps to
    // `/rest/getCoverArt`. Sonos DIDL needs an absolute URL — pass full
    // URLs through, wrap bare ids with the LAN-reachable Hub endpoint.
    let albumArtUri: string | null = null;
    if (song.coverArt) {
      albumArtUri = /^https?:\/\//i.test(song.coverArt)
        ? song.coverArt
        : `${lanUrl}/rest/getCoverArt.view?id=${encodeURIComponent(song.coverArt)}`;
    }

    const meta: TrackMetadata = {
      trackId: unifiedTrackId,
      title: song.title,
      artist: song.artist,
      album: song.album ?? "",
      albumArtUri,
      durationSec: Math.max(0, Math.round(song.duration ?? 0)),
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
      const cast = await buildCast(trackId, req.username, dev, { position });
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

      const cast = await buildCast(trackId, req.username, dev, { ttlSec });
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
