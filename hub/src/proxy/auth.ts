/**
 * Unified auth middleware for /proxy/* endpoints.
 *
 * Accepts any one of:
 *   1. Ed25519-signed request from a registered peer (reuses federation peer-auth)
 *   2. Valid JWT access token (Authorization header → cookie → `token` query param)
 *   3. Valid Subsonic credentials: u+p (plaintext or enc:<hex>) or u+t+s (token+salt)
 *
 * On success: sets request.proxyAuth and returns.
 * On failure: sends 401 and returns (Fastify reply is already sent).
 */

import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { FEDERATION_API_VERSION } from "../version.js";
import { canonicalSigningPayload, verifyRequest } from "../federation/signing.js";
import { verifyToken } from "../auth/jwt.js";
import { verifyPassword } from "../auth/passwords.js";
import type { PeerRegistry } from "../federation/peers.js";

export interface ProxyAuthInfo {
  kind: "peer" | "jwt" | "subsonic";
  /** For peer auth: the peer's instance ID */
  peerId?: string;
  /** For JWT/subsonic auth: the local user ID */
  userId?: string;
  username?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    proxyAuth: ProxyAuthInfo;
  }
}

/**
 * Extract a JWT from the request (Authorization header → cookie → `token` query param).
 */
function extractJwt(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  if (request.cookies?.access_token) return request.cookies.access_token;
  const q = request.query as Record<string, string>;
  if (q?.token) return q.token;
  return undefined;
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
    // ── 1. Ed25519 peer auth ──────────────────────────────────────────────────
    const instanceHeader = request.headers["x-poutine-instance"];
    const userHeader = request.headers["x-poutine-user"];
    const timestampHeader = request.headers["x-poutine-timestamp"];
    const signatureHeader = request.headers["x-poutine-signature"];

    if (instanceHeader && userHeader && timestampHeader && signatureHeader) {
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

      // Compute body hash from raw body if available, else "-"
      const rawBody = (request.body != null && Buffer.isBuffer(request.body))
        ? request.body
        : null;
      const bodyHash = rawBody
        ? crypto.createHash("sha256").update(rawBody).digest("hex")
        : "-";

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
      const versionCheckEnabled = process.env.POUTINE_DISABLE_VERSION_CHECK !== "true";
      if (versionCheckEnabled) {
        const apiVersionHeader = request.headers["poutine-api-version"];
        const rawVersion = Array.isArray(apiVersionHeader)
          ? apiVersionHeader[0]
          : apiVersionHeader;
        const peerApiVersion = rawVersion !== undefined ? parseInt(String(rawVersion), 10) : NaN;

        if (isNaN(peerApiVersion) || peerApiVersion < FEDERATION_API_VERSION) {
          const gotVersion = isNaN(peerApiVersion) ? "(none)" : String(peerApiVersion);
          reply.code(403).send({
            error: `Peer ${instanceId} apiVersion ${gotVersion} is below minimum required ${FEDERATION_API_VERSION}`,
          });
          return;
        }
      }

      request.proxyAuth = { kind: "peer", peerId: instanceId };
      return;
    }

    const app = request.server;
    const db = app.db;
    const q = request.query as Record<string, string>;

    // ── 2. JWT auth ───────────────────────────────────────────────────────────
    const jwt = extractJwt(request);
    if (jwt) {
      try {
        const { userId } = await verifyToken(jwt, app.config);
        const user = db
          .prepare("SELECT id, username FROM users WHERE id = ?")
          .get(userId) as { id: string; username: string } | undefined;

        if (user) {
          request.proxyAuth = { kind: "jwt", userId: user.id, username: user.username };
          return;
        }
      } catch {
        // invalid/expired JWT — fall through to Subsonic param auth
      }
    }

    // ── 3. Subsonic param auth (u+p or u+t+s) ────────────────────────────────
    const username = q.u;
    if (!username) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }

    const user = db
      .prepare("SELECT id, username, password_enc FROM users WHERE username = ?")
      .get(username) as { id: string; username: string; password_enc: string } | undefined;

    if (!user) {
      reply.code(401).send({ error: "Wrong username or password" });
      return;
    }

    let password = q.p;
    if (!password) {
      reply.code(401).send({ error: "Authentication required" });
      return;
    }

    if (password.startsWith("enc:")) {
      password = Buffer.from(password.slice(4), "hex").toString("utf8");
    }

    const valid = verifyPassword(user.password_enc, password, app.passwordKey);
    if (!valid) {
      reply.code(401).send({ error: "Wrong username or password" });
      return;
    }

    request.proxyAuth = { kind: "subsonic", userId: user.id, username: user.username };
  };
}
