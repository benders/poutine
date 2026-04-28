/**
 * /proxy/* route tree — transparent HTTP proxy to local Navidrome.
 *
 * Auth: Ed25519 peer signature, JWT access token, or Subsonic u+p credentials.
 * Streaming: response is piped directly — no buffering.
 * Concurrency: node:http agent with keepAlive + unlimited sockets.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import type { PeerRegistry } from "../federation/peers.js";
import { createRequireProxyAuth } from "../proxy/auth.js";
import { FEDERATION_API_VERSION } from "../version.js";

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
  "content-type",
  "content-length",
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

  // Match any method + any path under /proxy/*
  app.all("/*", { preHandler: requireProxyAuth }, async (request, reply) => {
    const config = app.config;

    // In Fastify, request.url inside a prefixed plugin retains the full URL including
    // the plugin prefix. Strip the /proxy prefix before forwarding to Navidrome.
    const PROXY_PREFIX = "/proxy";
    const suffix = request.url.startsWith(PROXY_PREFIX)
      ? request.url.slice(PROXY_PREFIX.length) || "/"
      : request.url; // e.g. "/rest/stream?id=..."

    // Build the target URL: Navidrome base + suffix
    const targetBase = config.navidromeUrl.replace(/\/+$/, "");
    const targetUrl = new URL(`${targetBase}${suffix}`);

    // Strip any Subsonic auth params from the incoming request before injecting
    // the proxy's own credentials. If the caller used u+p auth, the `p` param
    // would remain in the URL and confuse Navidrome's auth (it would see both
    // plaintext `p` and token `t+s` and fail). u/t/s are overwritten by set()
    // below but p must be explicitly removed.
    for (const param of ["u", "p", "t", "s"]) {
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
    targetUrl.searchParams.set("c", "poutine-proxy");

    // ── Collect allowed request headers ──────────────────────────────────────
    const forwardHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(request.headers)) {
      if (ALLOWED_REQUEST_HEADERS.has(key.toLowerCase()) && val !== undefined) {
        forwardHeaders[key.toLowerCase()] = Array.isArray(val)
          ? val.join(", ")
          : val;
      }
    }

    // ── Determine if there's a body to forward ────────────────────────────────
    const methodHasBody =
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "DELETE";

    // ── Make the upstream request ─────────────────────────────────────────────
    const isHttps = targetUrl.protocol === "https:";
    const agent = isHttps ? httpsAgent : httpAgent;

    const upstreamResponse = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: request.method,
          headers: forwardHeaders,
          agent,
        };

        const req = (isHttps ? https : http).request(options, resolve);
        req.on("error", reject);

        if (methodHasBody) {
          // Fastify has already consumed and parsed the body if content-type
          // was application/json. For raw bytes (audio/image POSTs) it's a
          // Buffer on request.body. For others, pipe the raw stream.
          const rawBody = request.body;
          if (Buffer.isBuffer(rawBody)) {
            req.end(rawBody);
          } else if (typeof rawBody === "string") {
            req.end(rawBody);
          } else if (rawBody != null) {
            req.end(JSON.stringify(rawBody));
          } else {
            // No parsed body — stream the raw request
            request.raw.pipe(req);
          }
        } else {
          req.end();
        }
      },
    );

    // ── Forward response status + headers (minus blocked) + stream body ─────────
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
  });
};
