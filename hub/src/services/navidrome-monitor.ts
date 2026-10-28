/**
 * navidrome-monitor.ts — Navidrome fault detection and reporting (issue #277).
 *
 * Two failure modes motivated this service, both seen in production:
 *
 *   1. Navidrome answered `/rest/ping` normally while every `/rest/stream`
 *      request failed. `/api/health` (ping only, always HTTP 200 by #178)
 *      reported the hub healthy and APM showed nothing, because
 *      `routes/subsonic/stream.ts` caught the adapter's error and returned a
 *      generic 502 without logging it or reporting it anywhere.
 *   2. Nothing a Synthetic monitor or k8s probe could key on: no URL whose
 *      HTTP status reflects whether audio actually works.
 *
 * So this service does two things:
 *
 *   - **Passive:** it is the `SubsonicClient` call observer (see
 *     `adapters/subsonic.ts#setSubsonicObserver`). Every local Navidrome
 *     failure gets a structured log line and — for upstream faults (5xx or a
 *     transport error) — a New Relic `noticeError` with the operation, HTTP
 *     status and duration attached. It keeps rolling counters so real-traffic
 *     faults show up in readiness even when a synthetic probe happens to pass.
 *   - **Active:** `probe()` exercises the audio path end to end against the
 *     local Navidrome — hub DB read, Subsonic ping, then a byte-range pull of
 *     a real local track off `/rest/stream`, asserting bytes actually arrive.
 *     Results are TTL-cached so a 10 s Synthetic cadence doesn't turn into a
 *     10 s Navidrome cadence.
 *
 * The *only* consumer that decides HTTP status from this is `routes/health.ts`
 * (`/api/health/ready` → 503 when degraded). `/api/health` keeps its #178
 * contract: always 200, consumers key on `body.status`.
 */

import type Database from "better-sqlite3";
import type { SubsonicCallEvent, SubsonicClient } from "../adapters/subsonic.js";
import {
  NAVIDROME_ERROR_EVENT,
  NAVIDROME_HEALTH_EVENT,
  noopTelemetry,
  type Telemetry,
} from "./telemetry.js";
import { readEnvelopeError } from "../adapters/upstream-envelope.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/** How long a probe result is reused before Navidrome is touched again. */
const DEFAULT_PROBE_TTL_MS = 30_000;
/** Whole-probe budget for the byte-range stream pull. */
const DEFAULT_STREAM_TIMEOUT_MS = 5_000;
/** Budget for the Subsonic ping leg. */
const DEFAULT_PING_TIMEOUT_MS = 2_000;
/** Consecutive real-traffic stream faults that flip readiness on their own. */
const DEFAULT_STREAM_FAILURE_THRESHOLD = 5;
/** Watchdog cadence — probes Navidrome so APM alerts without a synthetic. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
/** Rolling window for the `recentFailures` counter. */
const FAILURE_WINDOW_MS = 5 * 60_000;
/** Hard cap on retained failure timestamps (bounded memory under a storm). */
const FAILURE_WINDOW_MAX = 500;
/** Upstream-fault errors reported to APM per path per minute. */
const NOTICE_BUDGET_PER_MIN = 5;
/** How many candidate tracks the stream probe will try before giving up. */
const PROBE_CANDIDATES = 3;
/** Byte range requested from Navidrome. Small: we only need proof of bytes. */
const PROBE_RANGE = "bytes=0-65535";
/** `SubsonicCallEvent.tag` on the probe's own stream calls — see `record()`. */
const PROBE_TAG = "health-probe";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Cap on detail strings echoed in the (unauthenticated) health body. */
const MAX_DETAIL_LEN = 160;

/**
 * Shape an error for the public health body: no URLs (the Navidrome base URL
 * and credentials-adjacent internals stay in the logs, cf. the #139 rule that
 * internal error text never leaves the hub), length-capped.
 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/https?:\/\/\S+/gi, "<url>").slice(0, MAX_DETAIL_LEN);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "failed" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  /** Human-readable reason — present on `failed`, and on `skipped`. */
  detail?: string;
  durationMs?: number;
}

export interface FailureInfo {
  path: string;
  status: number | null;
  message: string;
  at: string;
}

export interface ObservedFailures {
  /** Upstream faults (5xx / transport) seen in the last 5 minutes. */
  recentFailures: number;
  /** Consecutive `/rest/stream` upstream faults with no success between. */
  consecutiveStreamFailures: number;
  lastFailure: FailureInfo | null;
  lastSuccessAt: string | null;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checks: {
    hubDb: CheckResult;
    navidromePing: CheckResult;
    navidromeStream: CheckResult;
  };
  observed: ObservedFailures;
  /** When the underlying probe ran (may predate this response — see `cached`). */
  probedAt: string;
  /** True when this report was served from the TTL cache. */
  cached: boolean;
}

export interface NavidromeMonitorOptions {
  db: Database.Database;
  client: SubsonicClient;
  log: MonitorLogger;
  telemetry?: Telemetry;
  probeTtlMs?: number;
  pingTimeoutMs?: number;
  streamTimeoutMs?: number;
  streamFailureThreshold?: number;
  watchdogIntervalMs?: number;
  /** When false, the stream leg reports `skipped` and Navidrome isn't touched. */
  streamProbeEnabled?: boolean;
}

export interface MonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

interface ProbeCandidate {
  remoteId: string;
  format: string | null;
  size: number | null;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class NavidromeMonitor {
  private readonly db: Database.Database;
  private readonly client: SubsonicClient;
  private readonly log: MonitorLogger;
  private readonly telemetry: Telemetry;
  private readonly probeTtlMs: number;
  private readonly pingTimeoutMs: number;
  private readonly streamTimeoutMs: number;
  private readonly streamFailureThreshold: number;
  private readonly watchdogIntervalMs: number;
  private readonly streamProbeEnabled: boolean;

  /** Timestamps of upstream faults, trimmed to FAILURE_WINDOW_MS on read. */
  private failureTimes: number[] = [];
  private consecutiveStreamFailures = 0;
  private lastFailure: FailureInfo | null = null;
  private lastSuccessAt: number | null = null;
  /** APM notice budget per path: [windowStartedAt, noticesSent]. */
  private noticeBudget = new Map<string, [number, number]>();

  private cached: HealthReport | null = null;
  private cachedAt = 0;
  /** De-dupes concurrent probes (synthetic + watchdog + k8s arriving together). */
  private inFlight: Promise<HealthReport> | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastReportedStatus: "ok" | "degraded" | null = null;

  constructor(opts: NavidromeMonitorOptions) {
    this.db = opts.db;
    this.client = opts.client;
    this.log = opts.log;
    this.telemetry = opts.telemetry ?? noopTelemetry();
    this.probeTtlMs = opts.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.streamTimeoutMs = opts.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    this.streamFailureThreshold =
      opts.streamFailureThreshold ?? DEFAULT_STREAM_FAILURE_THRESHOLD;
    this.watchdogIntervalMs =
      opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.streamProbeEnabled = opts.streamProbeEnabled ?? true;
  }

  // ── Passive observation ───────────────────────────────────────────────────

  /**
   * Observer sink for `SubsonicClient`. Hot path: called for every local
   * Navidrome call, so it stays allocation-light on success.
   */
  record(event: SubsonicCallEvent): void {
    // The probe reports its own verdict through `checks`. Counting its calls
    // here too would let a probe success on the smallest file reset the
    // consecutive counter every interval while real traffic keeps failing.
    if (event.tag === PROBE_TAG) return;

    if (event.envelope) {
      // 200 + Subsonic error envelope (#285). The code isn't known here (the
      // caller reads the body), and the usual cause is one stale id, so it
      // neither counts as an upstream fault nor resets the stream counter.
      // A library-wide failure (every id stale, files unreadable) is the
      // stream probe's job — it does check the code. Cover art misses take
      // this path all the time: log streams only.
      if (this.isStreamPath(event.path)) {
        this.log.warn(
          { navidromePath: event.path, durationMs: event.durationMs },
          "Navidrome answered a stream with a Subsonic error envelope",
        );
      }
      return;
    }

    if (event.ok) {
      this.lastSuccessAt = Date.now();
      if (this.isStreamPath(event.path)) this.consecutiveStreamFailures = 0;
      return;
    }

    const message = event.error?.message ?? "unknown error";
    const upstreamFault = event.status === null || event.status >= 500;
    this.lastFailure = {
      path: event.path,
      status: event.status,
      // Served by the unauthenticated /api/health/ready — same redaction as
      // the check details. Logs and APM below keep the full text.
      message: describeError(message),
      at: new Date().toISOString(),
    };

    if (!upstreamFault) {
      // 4xx: usually a request-level problem (unknown id, bad params), not a
      // sick Navidrome. Visible in logs, excluded from the degradation signal
      // so a third-party client asking for a stale id can't take the hub out
      // of service.
      this.log.warn(
        {
          navidromePath: event.path,
          navidromeStatus: event.status,
          durationMs: event.durationMs,
          err: message,
        },
        "Navidrome call rejected (client-level)",
      );
      return;
    }

    this.failureTimes.push(Date.now());
    if (this.failureTimes.length > FAILURE_WINDOW_MAX) {
      this.failureTimes.splice(0, this.failureTimes.length - FAILURE_WINDOW_MAX);
    }
    if (this.isStreamPath(event.path)) this.consecutiveStreamFailures += 1;

    this.log.error(
      {
        navidromePath: event.path,
        navidromeStatus: event.status,
        navidromeKind: event.kind,
        durationMs: event.durationMs,
        consecutiveStreamFailures: this.consecutiveStreamFailures,
        err: message,
      },
      "Navidrome call failed (upstream fault)",
    );

    if (!this.spendNoticeBudget(event.path)) return;

    const err = event.error ?? new Error(message);
    this.telemetry.noticeError(err, {
      navidromePath: event.path,
      navidromeStatus: event.status ?? -1,
      navidromeKind: event.kind,
      durationMs: event.durationMs,
      consecutiveStreamFailures: this.consecutiveStreamFailures,
    });
    this.telemetry.recordCustomEvent(NAVIDROME_ERROR_EVENT, {
      path: event.path,
      kind: event.kind,
      status: event.status ?? -1,
      durationMs: event.durationMs,
      message,
    });
  }

  private isStreamPath(path: string): boolean {
    return path === "/rest/stream" || path === "/rest/download";
  }

  /**
   * Rate-limit APM errors per path. A sick Navidrome can fail hundreds of
   * calls a minute; the counters stay exact but the error channel doesn't get
   * flooded (and the agent's own harvest limit doesn't get spent on one fault).
   */
  private spendNoticeBudget(path: string): boolean {
    const now = Date.now();
    const entry = this.noticeBudget.get(path);
    if (!entry || now - entry[0] > 60_000) {
      this.noticeBudget.set(path, [now, 1]);
      return true;
    }
    if (entry[1] >= NOTICE_BUDGET_PER_MIN) return false;
    entry[1] += 1;
    return true;
  }

  /** Rolling counters, no Navidrome traffic. */
  observed(): ObservedFailures {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    this.failureTimes = this.failureTimes.filter((t) => t >= cutoff);
    return {
      recentFailures: this.failureTimes.length,
      consecutiveStreamFailures: this.consecutiveStreamFailures,
      lastFailure: this.lastFailure,
      lastSuccessAt: this.lastSuccessAt
        ? new Date(this.lastSuccessAt).toISOString()
        : null,
    };
  }

  /** Last probe result without probing — null until the first probe runs. */
  lastReport(): HealthReport | null {
    return this.cached ? { ...this.cached, cached: true } : null;
  }

  // ── Active probe ─────────────────────────────────────────────────────────

  /**
   * Run (or reuse) the deep check. Concurrent callers share one probe, and a
   * result younger than `probeTtlMs` is served from cache with `cached: true`.
   */
  async probe(options?: { force?: boolean }): Promise<HealthReport> {
    if (!options?.force && this.cached && Date.now() - this.cachedAt < this.probeTtlMs) {
      // Counters are live even on a cached probe, and so is the status they
      // feed: real-traffic faults that started after the probe ran degrade
      // readiness now, not at the next probe.
      const observed = this.observed();
      return {
        ...this.cached,
        status: this.rollup(this.cached.checks, observed),
        observed,
        cached: true,
      };
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.runProbe()
      .then((report) => {
        this.cached = report;
        this.cachedAt = Date.now();
        this.reportTransition(report);
        return report;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async runProbe(): Promise<HealthReport> {
    const hubDb = this.checkHubDb();
    const navidromePing = await this.checkPing();
    // Skip the stream leg when Navidrome isn't answering at all — it would
    // only restate the ping failure at five times the timeout cost.
    const navidromeStream =
      navidromePing.status === "ok"
        ? await this.checkStream()
        : { status: "skipped" as CheckStatus, detail: "navidrome ping failed" };

    const checks = { hubDb, navidromePing, navidromeStream };
    const observed = this.observed();
    return {
      status: this.rollup(checks, observed),
      checks,
      observed,
      probedAt: new Date().toISOString(),
      cached: false,
    };
  }

  /** Any failed check, or enough consecutive real-traffic stream faults. */
  private rollup(
    checks: HealthReport["checks"],
    observed: ObservedFailures,
  ): HealthReport["status"] {
    const failed =
      checks.hubDb.status === "failed" ||
      checks.navidromePing.status === "failed" ||
      checks.navidromeStream.status === "failed" ||
      observed.consecutiveStreamFailures >= this.streamFailureThreshold;
    return failed ? "degraded" : "ok";
  }

  private checkHubDb(): CheckResult {
    const started = Date.now();
    try {
      this.db.prepare("SELECT 1").get();
      return { status: "ok", durationMs: Date.now() - started };
    } catch (err) {
      return {
        status: "failed",
        detail: describeError(err),
        durationMs: Date.now() - started,
      };
    }
  }

  private async checkPing(): Promise<CheckResult> {
    const started = Date.now();
    try {
      await this.client.ping({
        signal: AbortSignal.timeout(this.pingTimeoutMs),
      });
      return { status: "ok", durationMs: Date.now() - started };
    } catch (err) {
      return {
        status: "failed",
        detail: describeError(err),
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Pull the head of a real local track off Navidrome's `/rest/stream`.
   *
   * Several candidates are tried before declaring a fault: a single file can
   * be individually unplayable (#222 — import-time problems break playback for
   * one track), and one bad file must not mark the whole instance degraded.
   * Conversely a fault that hits every candidate is exactly the outage this
   * endpoint exists to catch.
   */
  private async checkStream(): Promise<CheckResult> {
    if (!this.streamProbeEnabled) {
      return { status: "skipped", detail: "stream probe disabled" };
    }

    const started = Date.now();
    let candidates: ProbeCandidate[];
    try {
      candidates = this.probeCandidates();
    } catch (err) {
      // Catalog tables missing or unreadable — the hub DB check owns that
      // signal; don't double-report it as a streaming fault.
      return {
        status: "skipped",
        detail: `candidate lookup failed: ${describeError(err)}`,
        durationMs: Date.now() - started,
      };
    }

    if (candidates.length === 0) {
      // Fresh instance, or a library that hasn't synced yet. Legitimately
      // ready — there is nothing to stream.
      return {
        status: "skipped",
        detail: "no local tracks in the catalog",
        durationMs: Date.now() - started,
      };
    }

    const failures: string[] = [];
    for (const candidate of candidates) {
      const detail = await this.pullHead(candidate);
      if (detail === null) {
        return { status: "ok", durationMs: Date.now() - started };
      }
      // Candidate ids are logged, never returned: `/api/health/ready` is
      // unauthenticated, so its body stays free of internal identifiers.
      this.log.warn(
        { navidromeTrackId: candidate.remoteId, format: candidate.format, err: detail },
        "Navidrome stream probe failed for candidate track",
      );
      failures.push(detail);
    }

    return {
      status: "failed",
      detail: `${failures.length} candidate track(s) failed — ${failures.join("; ")}`,
      durationMs: Date.now() - started,
    };
  }

  /** @returns null on success, else a failure detail string. */
  private async pullHead(candidate: ProbeCandidate): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.streamTimeoutMs);
    try {
      // `format=raw`: passthrough even when the player record has a
      // transcoding default, so a broken transcoder isn't mistaken for a
      // broken library and vice versa. Range keeps the transfer to the head
      // of the file whatever its size.
      const res = await this.client.stream(candidate.remoteId, {
        format: "raw",
        range: PROBE_RANGE,
        signal: controller.signal,
        observerTag: PROBE_TAG,
      });

      // Navidrome reports a failed stream (stale id, unreadable file) as 200 +
      // a Subsonic error envelope — bytes, but not audio (#285).
      const envelopeError = await readEnvelopeError(res);
      if (envelopeError) {
        return `HTTP ${res.status} with Subsonic error ${envelopeError.code ?? "unknown"}`;
      }
      if (!res.body) return `HTTP ${res.status} with no body`;

      const reader = res.body.getReader();
      try {
        // Proof of bytes: Navidrome has returned a 200 with an empty body
        // when its underlying file handling is broken, which is precisely the
        // state that looks healthy to a ping.
        const { value, done } = await reader.read();
        if (done || !value || value.length === 0) {
          return `HTTP ${res.status} but zero bytes`;
        }
        return null;
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (err) {
      return describeError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cheapest-to-stream local tracks, deterministic across probes so the TTL
   * cache and the candidate set stay stable. `preferred = 1` means this is a
   * row `/rest/stream` would really serve (see `preferredSourceForStream`).
   */
  private probeCandidates(): ProbeCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT it.remote_id AS remoteId, ts.format AS format, ts.size AS size
           FROM track_sources ts
           JOIN instance_tracks it ON it.id = ts.instance_track_id
          WHERE ts.instance_id = 'local'
            AND ts.preferred = 1
            AND it.remote_id IS NOT NULL
          ORDER BY (ts.size IS NULL), ts.size, it.remote_id
          LIMIT ?`,
      )
      .all(PROBE_CANDIDATES) as ProbeCandidate[];
    return rows;
  }

  // ── Watchdog ─────────────────────────────────────────────────────────────

  /**
   * Probe on a timer so APM sees the state without a Synthetic monitor
   * configured. Unref'd (#156 rule: every long-lived timer unrefs) so it
   * never holds the process open.
   *
   * Started from the `isMain` entrypoint in `server.ts`, not `buildApp` — the
   * test harness builds apps against no live Navidrome and must not make
   * network calls on a timer.
   */
  start(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      void this.probe({ force: true }).catch((err: unknown) => {
        this.log.warn({ err: String(err) }, "Navidrome health watchdog failed");
      });
    }, this.watchdogIntervalMs);
    this.watchdog.unref();
    // Prime the cache immediately so the first readiness call is instant and
    // APM gets a state sample at boot.
    void this.probe({ force: true }).catch(() => {});
  }

  stop(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Log + report ok↔degraded edges. Transitions (not every sample) are what
   * an alert policy wants, and they keep the custom-event volume at roughly
   * one per incident.
   */
  private reportTransition(report: HealthReport): void {
    this.telemetry.recordMetric(
      "Custom/Poutine/Navidrome/Degraded",
      report.status === "degraded" ? 1 : 0,
    );

    if (report.status === this.lastReportedStatus) return;
    const previous = this.lastReportedStatus;
    this.lastReportedStatus = report.status;

    const context = {
      previousStatus: previous ?? "unknown",
      navidromePing: report.checks.navidromePing.status,
      navidromeStream: report.checks.navidromeStream.status,
      streamDetail: report.checks.navidromeStream.detail ?? "",
      hubDb: report.checks.hubDb.status,
      recentFailures: report.observed.recentFailures,
      consecutiveStreamFailures: report.observed.consecutiveStreamFailures,
    };

    if (report.status === "degraded") {
      this.log.error(context, "Navidrome health check DEGRADED — audio may be unavailable");
      this.telemetry.noticeError(
        new Error(
          `Navidrome health degraded (ping=${report.checks.navidromePing.status}, ` +
            `stream=${report.checks.navidromeStream.status}): ` +
            `${report.checks.navidromeStream.detail ?? report.checks.navidromePing.detail ?? "see checks"}`,
        ),
        context,
      );
    } else if (previous !== null) {
      this.log.info(context, "Navidrome health check recovered");
    }

    this.telemetry.recordCustomEvent(NAVIDROME_HEALTH_EVENT, {
      status: report.status,
      ...context,
    });
  }
}
