/**
 * health.ts — health and readiness endpoints (issues #178, #277).
 *
 * Three URLs, three different jobs. Keep them distinct; conflating them is
 * what made the Navidrome outage in #277 invisible:
 *
 * | Route               | HTTP status        | Probes                                     | Audience                        |
 * |---------------------|--------------------|--------------------------------------------|---------------------------------|
 * | `/api/health`       | always 200 (#178)  | Navidrome ping (~1 s budget)               | Peers (handshake), operators    |
 * | `/api/health/live`  | always 200         | nothing — process is serving requests      | k8s livenessProbe              |
 * | `/api/health/ready` | 200 ok / 503 bad   | hub DB + ping + real byte-range stream pull | Synthetics, k8s readinessProbe |
 *
 * `/api/health` must keep returning 200 even when Navidrome is down: the
 * federation handshake reads `apiVersion` / `appVersion` from a peer's
 * `/api/health`, and a peer whose Navidrome is briefly sick must still be
 * admittable (#178). That is exactly why it is useless as an LB probe, and why
 * `/api/health/ready` exists.
 *
 * Everything deep lives in `services/navidrome-monitor.ts`; this file only maps
 * a report onto a status code. All three routes are unauthenticated (an
 * orchestrator has no credentials), so no internal identifier or URL may appear
 * in a response body — the monitor redacts details for that reason.
 */

import type { FastifyInstance } from "fastify";
import { APP_VERSION, FEDERATION_API_VERSION } from "../version.js";
import { resolveGitSha } from "../services/git-sha.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Resolved once at startup: the build-time env var, else `git describe`
  // (issue #287). Doesn't change while the process runs.
  const gitSha = resolveGitSha();

  /**
   * Liveness. Answers from the event loop and touches nothing else: if this
   * 200s, the process is up and Fastify is routing. A dependency fault must
   * NOT fail this — under k8s that would restart the hub because Navidrome is
   * sick, killing every in-flight stream for no reason.
   */
  app.get("/api/health/live", async () => ({
    status: "ok",
    appVersion: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  /**
   * Readiness — the URL for Synthetic monitoring and orchestrator probes.
   * 200 when the hub can actually serve audio, 503 when it can't.
   *
   * The probe is TTL-cached in the monitor (default 30 s) and concurrent
   * callers share one run, so a tight polling cadence costs Navidrome nothing
   * extra. `cached: true` in the body says the result was reused; the
   * `observed` counters are always live.
   */
  app.get("/api/health/ready", async (_req, reply) => {
    const report = await app.navidromeMonitor.probe();
    const body = {
      status: report.status,
      appVersion: APP_VERSION,
      apiVersion: FEDERATION_API_VERSION,
      checks: report.checks,
      observed: report.observed,
      probedAt: report.probedAt,
      cached: report.cached,
    };
    // 503 + Retry-After is the conventional "not ready, come back" answer;
    // k8s and most LBs treat any non-2xx as down, synthetics alert on it.
    if (report.status !== "ok") {
      reply.status(503).header("retry-after", "30");
    }
    return body;
  });

  /**
   * Legacy/peer health (#178). Shape is a contract — peers parse it during the
   * handshake (`routes/federation.ts`) — so fields are only ever added.
   *
   * `navidromeStream` and `recentNavidromeFailures` (#277) report what the
   * monitor last observed; this route never triggers a probe itself, keeping
   * its cost at one Navidrome ping as before.
   */
  app.get("/api/health", async () => {
    let navidrome: "ok" | "unreachable" = "unreachable";
    try {
      // ~1s budget: Navidrome on the internal Docker network normally
      // responds in tens of ms. AbortSignal.timeout cancels the underlying
      // fetch so the request doesn't dangle past the response.
      await app.navidromeClient.ping({ signal: AbortSignal.timeout(1000) });
      navidrome = "ok";
    } catch (err) {
      app.log.warn({ err }, "Local Navidrome ping failed");
    }

    const lastReport = app.navidromeMonitor.lastReport();
    const observed = app.navidromeMonitor.observed();
    const navidromeStream = lastReport
      ? lastReport.checks.navidromeStream.status
      : "unknown";

    // Library-shrink guard (#297): the local catalog is being kept because
    // Navidrome's library shrank too far — usually an unmounted share.
    const held = app.db
      .prepare("SELECT 1 FROM instances WHERE id = 'local' AND shrink_held_at IS NOT NULL")
      .get();
    const library: "ok" | "held" = held ? "held" : "ok";

    // `status` rolls up the ping, whatever the deep probe last saw and the
    // shrink guard, so an operator keying on `body.status` (per #178) catches
    // each of them. HTTP status stays 200 regardless.
    const degraded =
      navidrome !== "ok" ||
      navidromeStream === "failed" ||
      lastReport?.status === "degraded" ||
      library === "held";

    return {
      status: degraded ? "degraded" : "ok",
      appVersion: APP_VERSION,
      apiVersion: FEDERATION_API_VERSION,
      gitSha,
      navidrome,
      navidromeStream,
      recentNavidromeFailures: observed.recentFailures,
      library,
    };
  });
}
