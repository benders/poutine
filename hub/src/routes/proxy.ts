/**
 * /proxy/* route tree — peer-only, read-only window onto local Navidrome.
 *
 * Auth: Ed25519 peer signature only (proxy/auth.ts). No local-user auth.
 * Surface: GET on PROXY_ALLOWED_ENDPOINTS under /proxy/rest/, nothing else.
 *   Method, path and body are checked in onRequest — before auth and before
 *   any body parsing — so a refused request never reaches Navidrome.
 * Streaming: response is piped directly — no buffering.
 * Concurrency: node:http agent with keepAlive + unlimited sockets.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { PeerRegistry } from "../federation/peers.js";
import { createRequireProxyAuth } from "../proxy/auth.js";
import { FEDERATION_API_VERSION } from "../version.js";

// ── Surface allowlist ─────────────────────────────────────────────────────────

/**
 * The only Subsonic endpoints reachable through /proxy/rest/. Every forwarded
 * request carries the Navidrome ADMIN credentials, so this list is the whole
 * of what a peer can do to the local Navidrome: keep it read-only and keep it
 * to what peers actually call.
 *
 *   getArtists, getArtist, getAlbum — peer library sync (library/sync-instance.ts)
 *   getScanStatus                   — peer auto-sync poll (services/auto-sync.ts)
 *   getCoverArt                     — peer cover art (routes/subsonic/stream.ts)
 *
 * Unchanged since federation API v5 (the floor), so every supported peer
 * stays inside it. Peer audio is /federation/stream/:id, never the proxy.
 * Adding an endpoint: it must be a read, and a peer call site must need it.
 */
export const PROXY_ALLOWED_ENDPOINTS: readonly string[] = [
  "getArtists",
  "getArtist",
  "getAlbum",
  "getScanStatus",
  "getCoverArt",
];

const PROXY_REST_PREFIX = "/proxy/rest/";
const VIEW_SUFFIX = ".view";
const allowedEndpoints = new Set(PROXY_ALLOWED_ENDPOINTS);

/**
 * Map a raw request URL to the Navidrome path it may be forwarded to, or
 * null. Exact string match on the undecoded path: no normalisation, so
 * encoded separators, dot segments, doubled slashes and trailing slashes all
 * miss. The optional Subsonic `.view` suffix is accepted and dropped.
 */
export function resolveProxyTarget(
  rawUrl: string,
): { upstreamPath: string; search: string } | null {
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  if (!path.startsWith(PROXY_REST_PREFIX)) return null;
  let endpoint = path.slice(PROXY_REST_PREFIX.length);
  if (endpoint.endsWith(VIEW_SUFFIX)) {
    endpoint = endpoint.slice(0, -VIEW_SUFFIX.length);
  }
  if (!allowedEndpoints.has(endpoint)) return null;
  return {
    upstreamPath: `/rest/${endpoint}`,
    search: q === -1 ? "" : rawUrl.slice(q + 1),
  };
}

/** True if the request declares a body (either framing). */
function declaresBody(request: FastifyRequest): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const len = request.headers["content-length"];
  return len !== undefined && len !== "0";
}

/**
 * onRequest gate: method, path, body. Runs before auth and before Fastify
 * parses anything, with fixed responses that say nothing about the caller.
 */
async function enforceProxySurface(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.method !== "GET") {
    reply.code(405).header("allow", "GET").send({ error: "Method not allowed" });
    return;
  }
  if (!resolveProxyTarget(request.url)) {
    reply.code(404).send({ error: "Not found" });
    return;
  }
  if (declaresBody(request)) {
    reply.code(400).send({ error: "Request body not allowed" });
    return;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Request headers forwarded from the client to Navidrome. */
const ALLOWED_REQUEST_HEADERS = new Set([
  "range",
  "accept",
  // accept-encoding is intentionally excluded: the proxy does not transcode, so
  // we never forward compression negotiation to Navidrome. If Navidrome replied
  // with gzip the content-encoding header would be stripped by the response
  // allowlist, leaving the caller with compressed bytes and no hint to decompress.
  "if-none-match",
  "if-modified-since",
  "cache-control",
  // No content-type / content-length: /proxy/* never forwards a body.
]);

/** Response headers from Navidrome that must NOT be forwarded to the caller. */
const BLOCKED_RESPONSE_HEADERS = new Set([
  // Navidrome's own session cookies must not reach the caller — they would be
  // set under the hub's domain and have no meaning outside Navidrome itself.
  "set-cookie",
]);

// ── HTTP agents — keepAlive + unlimited sockets for ≥12 concurrent streams ───

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 32,
});

// ── Plugin ────────────────────────────────────────────────────────────────────

interface ProxyRoutesOptions {
  registry: PeerRegistry;
}

export const proxyRoutes: FastifyPluginAsync<ProxyRoutesOptions> = async (
  app,
  opts,
) => {
  const requireProxyAuth = createRequireProxyAuth({ registry: opts.registry });

  // Every method and path lands here so the refusals are explicit (405 / 404 /
  // 400) rather than left to the router; only allowlisted GETs get past
  // enforceProxySurface.
  app.all(
    "/*",
    { onRequest: enforceProxySurface, preHandler: requireProxyAuth },
    async (request, reply) => {
      const config = app.config;

      // request.url inside a prefixed plugin keeps the /proxy prefix. The
      // upstream path is rebuilt from the matched allowlist entry — caller
      // path text is never copied into the Navidrome URL. Re-checked here so
      // the handler cannot forward anything if the hook is ever detached.
      const target = resolveProxyTarget(request.url);
      if (!target || request.method !== "GET") {
        return reply.code(404).send({ error: "Not found" });
      }

      const targetBase = config.navidromeUrl.replace(/\/+$/, "");
      const targetUrl = new URL(`${targetBase}${target.upstreamPath}`);
      targetUrl.search = target.search;

      // Strip any Subsonic auth params the caller sent before injecting the
      // proxy's own credentials: Navidrome must authenticate the request with
      // the injected u+t+s and nothing else. u/t/s are overwritten by set()
      // below; p and jwt must be explicitly removed.
      for (const param of ["u", "p", "t", "s", "jwt"]) {
        targetUrl.searchParams.delete(param);
      }

      // Inject Navidrome credentials via Subsonic token auth (u+t+s).
      // Fresh salt per request so credentials can't be replayed.
      const salt = crypto.randomBytes(8).toString("hex");
      const token = crypto
        .createHash("md5")
        .update(config.navidromePassword + salt)
        .digest("hex");

      targetUrl.searchParams.set("u", config.navidromeUsername);
      targetUrl.searchParams.set("t", token);
      targetUrl.searchParams.set("s", salt);
      targetUrl.searchParams.set("v", "1.16.1");
      // The proxy overwrites the caller's `c` and drops its User-Agent, so this
      // client name is the player identity that PEERS' syncs see in local
      // Navidrome. Its reportRealPath is provisioned at runtime by the
      // navidrome-native service (services/navidrome-native.ts).
      targetUrl.searchParams.set("c", "poutine-proxy");

      // ── Collect allowed request headers ────────────────────────────────────
      const forwardHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(request.headers)) {
        if (ALLOWED_REQUEST_HEADERS.has(key.toLowerCase()) && val !== undefined) {
          forwardHeaders[key.toLowerCase()] = Array.isArray(val)
            ? val.join(", ")
            : val;
        }
      }

      // ── Make the upstream request (always a bodyless GET) ──────────────────
      const isHttps = targetUrl.protocol === "https:";
      const agent = isHttps ? httpsAgent : httpAgent;

      const upstreamResponse = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          const options: http.RequestOptions = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: "GET",
            headers: forwardHeaders,
            agent,
          };

          const req = (isHttps ? https : http).request(options, resolve);
          req.on("error", reject);
          req.end();
        },
      );

      // ── Forward response status + headers (minus blocked) + stream body ────
      const responseHeaders: Record<string, string> = {};
      for (const [key, val] of Object.entries(upstreamResponse.headers)) {
        if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase()) && val !== undefined) {
          responseHeaders[key.toLowerCase()] = Array.isArray(val)
            ? val.join(", ")
            : val;
        }
      }

      responseHeaders["poutine-api-version"] = String(FEDERATION_API_VERSION);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

      try {
        await pipeline(upstreamResponse, raw);
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          app.log.error(err, "proxy pipeline error");
        }
      }
    },
  );
};
