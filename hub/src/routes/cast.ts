import type { FastifyPluginAsync } from "fastify";
import { verifyCastToken } from "../services/cast-tokens.js";
import { relayTrackStream } from "../services/stream-relay.js";

/**
 * Token-authenticated streaming endpoint for casting devices (Sonos etc.)
 * that can't compute Subsonic auth.
 *
 * GET /cast/stream/:trackId?token=<hmac>.<exp>
 *
 * Always mounted; rejects when Sonos is disabled in `settings` (#184). The
 * token binds to the trackId and has a short TTL — see
 * services/cast-tokens.ts.
 */
declare module "fastify" {
  interface FastifyInstance {
    castSecret: Buffer;
  }
}

export const castRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { trackId: string }; Querystring: Record<string, string> }>(
    "/stream/:trackId",
    async (request, reply) => {
      if (!app.sonosSettings.getEnabled()) {
        reply.status(503).send({ error: "Sonos is disabled" });
        return;
      }
      const { trackId } = request.params;
      const token = request.query.token;
      if (!token) {
        reply.status(401).send({ error: "Missing token" });
        return;
      }
      const verified = verifyCastToken(app.castSecret, trackId, token);
      if (!verified) {
        reply.status(403).send({ error: "Invalid or expired token" });
        return;
      }

      await relayTrackStream(app, request, reply, {
        trackId,
        kind: "cast",
        username: verified.username,
        clientName: "sonos",
      });
    },
  );
};
