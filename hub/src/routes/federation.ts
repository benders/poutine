/**
 * Federation routes for peer-to-peer communication.
 * 
 * These routes are called by peer hubs to fetch resources on their behalf.
 */

import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

// ── HTTP agents for upstream requests ────────────────────────────────────────

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

export const federationRoutes: FastifyPluginAsync = async (app) => {
  const config = app.config;

  // Stream audio from local Navidrome to peer
  app.get("/stream/:id", async (request, reply) => {
    const trackId = request.params.id as string;
    
    // Build the stream URL for local Navidrome
    const targetBase = config.navidromeUrl.replace(/\/+$/, "");
    const targetUrl = new URL(`${targetBase}/rest/stream`);
    
    // Add Subsonic auth params
    const salt = crypto.randomBytes(8).toString("hex");
    const token = crypto
      .createHash("md5")
      .update(config.navidromePassword + salt)
      .digest("hex");
    
    targetUrl.searchParams.set("u", config.navidromeUsername);
    targetUrl.searchParams.set("t", token);
    targetUrl.searchParams.set("s", salt);
    targetUrl.searchParams.set("v", "1.16.1");
    targetUrl.searchParams.set("c", "poutine-federation");
    targetUrl.searchParams.set("id", trackId);
    
    // Forward any format params from the request
    const q = request.query as Record<string, string>;
    if (q.format) targetUrl.searchParams.set("format", q.format);
    if (q.maxBitRate) targetUrl.searchParams.set("maxBitRate", q.maxBitRate);

    // Make the upstream request
    const isHttps = targetUrl.protocol === "https:";
    const agent = isHttps ? httpsAgent : httpAgent;

    const upstreamResponse = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: "GET",
          agent,
        };

        const req = (isHttps ? https : http).request(options, resolve);
        req.on("error", reject);
        req.end();
      },
    );

    // Forward response
    const responseHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(upstreamResponse.headers)) {
      if (key.toLowerCase() !== "set-cookie" && val !== undefined) {
        responseHeaders[key.toLowerCase()] = Array.isArray(val)
          ? val.join(", ")
          : val;
      }
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

    try {
      await pipeline(upstreamResponse, raw);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        app.log.error(err, "federation stream pipeline error");
      }
    }
  });
};
