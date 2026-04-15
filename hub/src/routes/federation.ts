import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import { FEDERATION_API_VERSION } from "../version.js";

// ── Plugin options ────────────────────────────────────────────────────────────

interface FederationPluginOptions extends FastifyPluginOptions {
  requirePeerAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

/**
 * Federation v3: content routes (/library/export, /stream/:trackId, /art/:encodedId)
 * have been removed. Cross-hub content traffic now travels via /proxy/* (Phase 1).
 *
 * The Poutine-Api-Version header mechanism and the requirePeerAuth hook are kept
 * here so they are ready if any future federation surface is added. Ed25519
 * signing helpers (federation/signing.ts, federation/sign-request.ts,
 * federation/peer-auth.ts, federation/peers.ts) are still used by /proxy/*.
 */
export const federationRoutes: FastifyPluginAsync<FederationPluginOptions> =
  async (app, _opts) => {
    // Stamp every federation response with the current protocol version.
    app.addHook("onSend", async (_req, reply) => {
      reply.header("Poutine-Api-Version", String(FEDERATION_API_VERSION));
    });
  };
