/**
 * preHandler that rejects requests carrying any HTTP proxy / forwarding
 * header. Used to gate endpoints intended for true LAN clients only
 * (Sonos, DLNA control points) when the hub is also exposed through a
 * public tunnel like Cloudflare Tunnel, Caddy, nginx, Tailscale Funnel,
 * etc.
 *
 * Rationale: a public tunnel typically terminates on the same host as the
 * hub and forwards traffic to localhost. From the hub's perspective those
 * requests look identical to a LAN client — same port, often loopback
 * source IP. The discriminator is that every reasonable forward proxy
 * sets one or more of the headers below; a real LAN client doesn't set
 * any of them.
 *
 * Conservative deny: if even one of these headers is present, the request
 * is rejected. Operators who run a transparent reverse proxy on the LAN
 * itself will need to strip these headers there or leave `DLNA_ENABLED=
 * false`. Matches the project's stance on TLS — operator owns public
 * exposure; the hub doesn't second-guess the deployment.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** Headers whose presence proves the request hopped through a proxy. */
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
] as const;

/** Returns the first proxy header found on `headers`, or null. */
export function detectProxyHeader(
  headers: Record<string, unknown>,
): string | null {
  for (const name of PROXY_HEADERS) {
    if (headers[name] !== undefined) return name;
  }
  return null;
}

export async function requireLan(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const found = detectProxyHeader(
    request.headers as Record<string, unknown>,
  );
  if (found !== null) {
    request.log.warn(
      { proxyHeader: found, url: request.url },
      "Rejected non-LAN request to LAN-only endpoint",
    );
    // Explicit `return reply` makes the halt unambiguous. Fastify also
    // stops the lifecycle when a reply is sent in a preHandler, but our
    // sibling preHandlers (e.g. requireAuth) use this form too — match.
    return reply.status(403).send({ error: "LAN-only endpoint" });
  }
}
