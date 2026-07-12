import type { FastifyRequest, FastifyReply } from "fastify";
import { canonicalSigningPayload, sha256Hex, verifyRequest } from "./signing.js";
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
 *
 * Bumped to 5 with #147 (signed-invitation admission). v0.4.x peers cannot
 * be admitted to a v5 cluster — they lack the invitation provenance fields
 * and are removed by the v5 migration on first boot.
 */
export const MIN_FEDERATION_API_VERSION = 5;

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

    // "-" is the sentinel for "no body", matching what createFederationFetcher
    // signs when opts.body is undefined. POST routes that need their body
    // covered by the signature must register a content-type parser that lands
    // raw bytes on request.body as a Buffer (see federationRoutes).
    const bodyHash = Buffer.isBuffer(request.body) ? sha256Hex(request.body) : "-";

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

    // #244: peers that are locally disabled or tombstoned are refused inbound.
    // This gate covers /federation/*; /proxy/* has its own auth path with the
    // matching gate (proxy/auth.ts). Deliberately AFTER signature verification: only the
    // peer actually holding the key learns it has been disabled — an
    // unauthenticated probe naming a non-active instance id gets the same
    // 401s as any other unsigned request. Uniform 403 body — the caller must
    // not distinguish "disabled" from "tombstoned" from the response.
    if (peer.lifecycle !== "active") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    request.peer = { id: instanceId, userAssertion };
  };
}
