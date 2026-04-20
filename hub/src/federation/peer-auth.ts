import type { FastifyRequest, FastifyReply } from "fastify";
import { canonicalSigningPayload, verifyRequest } from "./signing.js";
import type { PeerRegistry } from "./peers.js";

declare module "fastify" {
  interface FastifyRequest {
    peer: { id: string; userAssertion: string };
  }
}

/**
 * Minimum accepted federation API version.
 * Peers advertising an apiVersion below this floor will be rejected.
 * May be disabled via POUTINE_DISABLE_VERSION_CHECK=true for testing/migration.
 */
const MIN_FEDERATION_API_VERSION = 3;

export function createRequirePeerAuth(deps: {
  registry: PeerRegistry;
  db: { prepare(sql: string): { run(instanceId: string, serverVersion: string): void } };
  maxSkewMs?: number;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const maxSkewMs = deps.maxSkewMs ?? 5 * 60 * 1000;
  const versionCheckEnabled = process.env.POUTINE_DISABLE_VERSION_CHECK !== "true";
  const upsertServerVersion = deps.db.prepare(
    "UPDATE instances SET server_version = ? WHERE id = ?",
  );

  return async function requirePeerAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const instanceHeader = request.headers["x-poutine-instance"];
    const userHeader = request.headers["x-poutine-user"];
    const timestampHeader = request.headers["x-poutine-timestamp"];
    const signatureHeader = request.headers["x-poutine-signature"];
    const apiVersionHeader = request.headers["poutine-api-version"];

    if (!instanceHeader || !userHeader || !timestampHeader || !signatureHeader) {
      reply.code(401).send({ error: "Missing required federation headers" });
      return;
    }

    const instanceId = Array.isArray(instanceHeader) ? instanceHeader[0] : instanceHeader;
    const userAssertion = Array.isArray(userHeader) ? userHeader[0] : userHeader;
    const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    const peer = deps.registry.peers.get(instanceId);
    if (!peer) {
      reply.code(401).send({ error: `Unknown peer: ${instanceId}` });
      return;
    }

    // ── Phase 3: version enforcement ─────────────────────────────────────────
    if (versionCheckEnabled) {
      const rawVersion = Array.isArray(apiVersionHeader)
        ? apiVersionHeader[0]
        : apiVersionHeader;
      const peerApiVersion = rawVersion !== undefined ? parseInt(String(rawVersion), 10) : NaN;

      if (isNaN(peerApiVersion) || peerApiVersion < MIN_FEDERATION_API_VERSION) {
        const gotVersion = isNaN(peerApiVersion) ? "(none)" : String(peerApiVersion);
        reply.code(403).send({
          error: `Peer ${instanceId} apiVersion ${gotVersion} is below minimum required ${MIN_FEDERATION_API_VERSION}`,
        });
        return;
      }

      // Store the peer's reported version in the instances table for display.
      upsertServerVersion.run(String(peerApiVersion), instanceId);
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
      reply.code(401).send({ error: "Request timestamp out of acceptable range" });
      return;
    }

    // Phase 3: all /federation/* endpoints are GET, so body hash is always "-".
    // TODO: when POST endpoints are added, raw body parsing will be needed to
    // compute sha256(body) here. Until then this simplification is safe.
    const bodyHash = "-";

    const payload = canonicalSigningPayload({
      method: request.method,
      path: request.url,
      bodyHash,
      timestamp,
      instanceId,
      userAssertion,
    });

    if (!verifyRequest(peer.publicKey, payload, signature)) {
      reply.code(401).send({ error: "Invalid signature" });
      return;
    }

    request.peer = { id: instanceId, userAssertion };
  };
}
