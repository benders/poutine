import type { FastifyRequest, FastifyReply } from "fastify";
import { canonicalSigningPayload, verifyRequest } from "./signing.js";
import type { PeerRegistry } from "./peers.js";

declare module "fastify" {
  interface FastifyRequest {
    peer: { id: string; userAssertion: string };
  }
}

export function createRequirePeerAuth(deps: {
  registry: PeerRegistry;
  maxSkewMs?: number;
  poutineSkipVersionCheck?: boolean;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const maxSkewMs = deps.maxSkewMs ?? 5 * 60 * 1000;

  return async function requirePeerAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const instanceHeader = request.headers["x-poutine-instance"];
    const userHeader = request.headers["x-poutine-user"];
    const timestampHeader = request.headers["x-poutine-timestamp"];
    const signatureHeader = request.headers["x-poutine-signature"];

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

    // Enforce minimum federation API version
    const MINIMUM_API_VERSION = 3;
    const skipCheck = deps.poutineSkipVersionCheck ?? false;
    if (!skipCheck) {
      const versionHeader = request.headers["poutine-api-version"];
      const peerVersion = versionHeader
        ? parseInt(Array.isArray(versionHeader) ? versionHeader[0] : versionHeader, 10)
        : undefined;

      // Reject peers that omit the header or declare a version below the floor.
      if (peerVersion === undefined || peerVersion < MINIMUM_API_VERSION) {
        reply.code(403).send({
          error: `Peer API version ${peerVersion ?? "unspecified"} is below minimum required ${MINIMUM_API_VERSION}`,
        });
        return;
      }
    }

    request.peer = { id: instanceId, userAssertion };
  };
}
