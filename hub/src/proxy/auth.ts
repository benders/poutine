/**
 * Auth middleware for /proxy/* endpoints — peers only.
 *
 * Accepts exactly one kind of caller: an Ed25519-signed request from a
 * registered, active peer at or above the federation API floor. There is no
 * local-user path (no JWT, no Subsonic credentials): /proxy/* forwards with
 * the Navidrome admin credentials, and local users reach the library through
 * /rest/* instead.
 *
 * /proxy/* requests never carry a body (routes/proxy.ts rejects them before
 * this runs), so the signed body hash is always "-".
 *
 * On success: sets request.proxyAuth and returns.
 * On failure: sends 401 / 403 and returns (Fastify reply is already sent).
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { canonicalSigningPayload, verifyRequest } from "../federation/signing.js";
import { MIN_FEDERATION_API_VERSION } from "../federation/peer-auth.js";
import type { PeerRegistry } from "../federation/peers.js";

export interface ProxyAuthInfo {
  kind: "peer";
  /** The calling peer's instance ID */
  peerId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    proxyAuth: ProxyAuthInfo;
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createRequireProxyAuth(deps: {
  registry: PeerRegistry;
  maxSkewMs?: number;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const maxSkewMs = deps.maxSkewMs ?? 5 * 60 * 1000;

  return async function requireProxyAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const instanceId = single(request.headers["x-poutine-instance"]);
    const userAssertion = single(request.headers["x-poutine-user"]);
    const timestamp = single(request.headers["x-poutine-timestamp"]);
    const signature = single(request.headers["x-poutine-signature"]);

    // No fallback: a request without the full set of signing headers is
    // unauthenticated, whatever other credentials it carries.
    if (!instanceId || !userAssertion || !timestamp || !signature) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }

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

    const payload = canonicalSigningPayload({
      method: request.method,
      path: request.url,
      bodyHash: "-",
      timestamp,
      instanceId,
      userAssertion,
    });

    if (!verifyRequest(peer.publicKey, payload, signature)) {
      reply.code(401).send({ error: "Invalid signature" });
      return;
    }

    // Enforce the minimum federation API version — the FLOOR, not the
    // current version. Comparing against FEDERATION_API_VERSION here would
    // cut older-but-supported peers off from /proxy/* on every protocol
    // bump (a v6 peer must keep syncing from a v7 hub while the floor
    // stays 5). Mirrors MIN_FEDERATION_API_VERSION in federation/peer-auth.ts.
    const versionCheckEnabled = process.env.POUTINE_DISABLE_VERSION_CHECK !== "true";
    if (versionCheckEnabled) {
      const rawVersion = single(request.headers["poutine-api-version"]);
      const peerApiVersion = rawVersion !== undefined ? parseInt(String(rawVersion), 10) : NaN;

      if (isNaN(peerApiVersion) || peerApiVersion < MIN_FEDERATION_API_VERSION) {
        const gotVersion = isNaN(peerApiVersion) ? "(none)" : String(peerApiVersion);
        reply.code(403).send({
          error: `Peer ${instanceId} apiVersion ${gotVersion} is below minimum required ${MIN_FEDERATION_API_VERSION}`,
        });
        return;
      }
    }

    // #244: locally disabled/tombstoned peers are refused here too — the
    // matching gate for /federation/* lives in federation/peer-auth.ts.
    // Deliberately AFTER signature verification (only the key holder
    // learns it is non-active) with the same uniform 403 body, so the
    // caller cannot distinguish "disabled" from "tombstoned".
    if (peer.lifecycle !== "active") {
      reply.code(403).send({ error: "forbidden" });
      return;
    }

    request.proxyAuth = { kind: "peer", peerId: instanceId };
  };
}
