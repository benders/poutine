import type { FastifyPluginAsync } from "fastify";
import { SonosControl, type TrackMetadata } from "../services/sonos-control.js";
import type { SonosDiscoveryService } from "../services/sonos-discovery.js";
import { signCastToken } from "../services/cast-tokens.js";
import { requireAuth } from "../auth/middleware.js";

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
      return { ...state, volume };
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

      const trackRow = app.db
        .prepare(
          `SELECT ut.id, ut.title, ut.duration_ms, ua.name AS artist_name,
                  urg.name AS album_name, urg.image_url AS album_art
           FROM unified_tracks ut
           JOIN unified_artists ua ON ua.id = ut.artist_id
           LEFT JOIN unified_release_groups urg ON urg.id = ut.rg_id
           WHERE ut.id = ?`,
        )
        .get(trackId) as
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

      const token = signCastToken(app.castSecret, {
        trackId,
        username: user.username,
      });
      const base = app.config.poutineLanUrl.replace(/\/+$/, "");
      const streamUri = `${base}/cast/stream/${encodeURIComponent(trackId)}?token=${encodeURIComponent(token)}`;

      const meta: TrackMetadata = {
        trackId,
        title: trackRow.title,
        artist: trackRow.artist_name,
        album: trackRow.album_name ?? "",
        albumArtUri: trackRow.album_art ?? null,
        durationSec: Math.max(0, Math.round((trackRow.duration_ms ?? 0) / 1000)),
        mimeType: "audio/mpeg",
      };

      try {
        await app.sonosControl.setAvTransportUri(dev, streamUri, meta);
        if (typeof position === "number" && position > 0) {
          await app.sonosControl.seek(dev, position);
        }
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
