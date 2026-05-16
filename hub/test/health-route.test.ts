/**
 * Tests for GET /api/health (issue #178).
 *
 * The endpoint reflects local Navidrome reachability. It returns HTTP 200
 * in both cases so the federation handshake (which reads `apiVersion` /
 * `appVersion` from a peer's `/api/health`) keeps working when a peer's
 * Navidrome is briefly down. Operators key on `body.status` instead.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";

describe("GET /api/health (issue #178)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("reports navidrome=unreachable / status=degraded when local Navidrome is down", async () => {
    const config: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "health-test-down",
      // 127.0.0.1:1 reliably refuses connections — nothing listens there.
      navidromeUrl: "http://127.0.0.1:1",
      navidromeUsername: "x",
      navidromePassword: "x",
    };
    app = await buildApp(config);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.navidrome).toBe("unreachable");
    expect(body.status).toBe("degraded");
    expect(body).toHaveProperty("appVersion");
    expect(body).toHaveProperty("apiVersion");
  });

  it("reports navidrome=ok / status=ok when local Navidrome ping succeeds", async () => {
    // Minimal fake Navidrome that answers /rest/ping with a Subsonic OK
    // envelope. We don't care about query params; the hub just needs a 200
    // JSON response with status:"ok".
    const naviServer = http.createServer((req, res) => {
      if (req.url && req.url.startsWith("/rest/ping")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            "subsonic-response": {
              status: "ok",
              version: "1.16.1",
              type: "navidrome",
              serverVersion: "0.52.0",
              openSubsonic: true,
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      naviServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const naviPort = (naviServer.address() as AddressInfo).port;

    try {
      const config: Partial<Config> = {
        databasePath: ":memory:",
        jwtSecret: "health-test-up",
        navidromeUrl: `http://127.0.0.1:${naviPort}`,
        navidromeUsername: "x",
        navidromePassword: "x",
      };
      app = await buildApp(config);
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.navidrome).toBe("ok");
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("appVersion");
      expect(body).toHaveProperty("apiVersion");
    } finally {
      await new Promise<void>((resolve) => naviServer.close(() => resolve()));
    }
  });
});
