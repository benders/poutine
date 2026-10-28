/**
 * Tests for NavidromeMonitor (issue #277).
 *
 * Covers the two halves the outage exposed:
 *   - passive observation of real Navidrome traffic (what a bare `catch {}`
 *     used to throw away), including the 4xx-vs-5xx split and the APM notice
 *     budget, and
 *   - the active probe that proves audio bytes actually flow, with its
 *     skip/ok/degraded decisions, candidate fallback and TTL cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import { NavidromeMonitor } from "../src/services/navidrome-monitor.js";
import type { SubsonicCallEvent, SubsonicClient } from "../src/adapters/subsonic.js";
import type { Telemetry } from "../src/services/telemetry.js";

function testTelemetry(): Telemetry & {
  noticeError: ReturnType<typeof vi.fn>;
  recordCustomEvent: ReturnType<typeof vi.fn>;
  recordMetric: ReturnType<typeof vi.fn>;
} {
  return {
    enabled: true,
    noticeError: vi.fn(),
    recordCustomEvent: vi.fn(),
    recordMetric: vi.fn(),
  };
}

function testLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface FakeClientOptions {
  ping?: () => Promise<unknown>;
  stream?: (id: string) => Promise<Response>;
}

function fakeClient(opts: FakeClientOptions = {}): SubsonicClient {
  return {
    ping: opts.ping ?? (async () => ({ status: "ok", version: "1.16.1" })),
    stream:
      opts.stream ??
      (async () => new Response(new Uint8Array([1, 2, 3]), { status: 206 })),
  } as unknown as SubsonicClient;
}

function event(overrides: Partial<SubsonicCallEvent> = {}): SubsonicCallEvent {
  return {
    path: "/rest/stream",
    kind: "binary",
    ok: false,
    status: 500,
    durationMs: 12,
    error: new Error("Subsonic HTTP error: 500 Internal Server Error"),
    ...overrides,
  };
}

/**
 * Minimal catalog rows for the probe's candidate query. Foreign keys are
 * switched off for the insert: the query only joins `track_sources` to
 * `instance_tracks`, and materializing the full instances → users →
 * unified_releases → unified_artists chain would test the schema, not the
 * monitor.
 */
function seedLocalTracks(db: Database.Database, remoteIds: string[]): void {
  db.pragma("foreign_keys = OFF");
  const insertTrack = db.prepare(
    `INSERT INTO instance_tracks (id, instance_id, remote_id, album_id, title, artist_name, format, size)
     VALUES (?, 'local', ?, 'al1', ?, 'Probe Artist', 'flac', ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO track_sources (id, unified_track_id, instance_id, instance_track_id, format, bitrate, size, preferred)
     VALUES (?, ?, 'local', ?, 'flac', 1000, ?, 1)`,
  );
  remoteIds.forEach((remoteId, i) => {
    const trackRowId = `local:${remoteId}`;
    insertTrack.run(trackRowId, remoteId, `Probe Track ${i}`, (i + 1) * 1000);
    insertSource.run(`ts-${remoteId}`, `ut-${remoteId}`, trackRowId, (i + 1) * 1000);
  });
  db.pragma("foreign_keys = ON");
}

describe("NavidromeMonitor (#277)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ── Passive observation ──────────────────────────────────────────────────

  describe("record()", () => {
    it("counts a 5xx stream failure and reports it to APM", () => {
      const telemetry = testTelemetry();
      const log = testLogger();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        telemetry,
        log,
      });

      monitor.record(event());

      const observed = monitor.observed();
      expect(observed.recentFailures).toBe(1);
      expect(observed.consecutiveStreamFailures).toBe(1);
      expect(observed.lastFailure?.path).toBe("/rest/stream");
      expect(observed.lastFailure?.status).toBe(500);
      expect(log.error).toHaveBeenCalledOnce();
      expect(telemetry.noticeError).toHaveBeenCalledOnce();
      expect(telemetry.recordCustomEvent).toHaveBeenCalledWith(
        "PoutineNavidromeError",
        expect.objectContaining({ path: "/rest/stream", status: 500 }),
      );
    });

    it("counts a transport failure (no HTTP status) as an upstream fault", () => {
      const telemetry = testTelemetry();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        telemetry,
        log: testLogger(),
      });

      monitor.record(event({ status: null, error: new Error("fetch failed") }));

      expect(monitor.observed().recentFailures).toBe(1);
      expect(telemetry.noticeError).toHaveBeenCalledOnce();
    });

    it("does NOT count a 4xx — one client asking for a stale id can't degrade the hub", () => {
      const telemetry = testTelemetry();
      const log = testLogger();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        telemetry,
        log,
      });

      monitor.record(event({ status: 404 }));

      const observed = monitor.observed();
      expect(observed.recentFailures).toBe(0);
      expect(observed.consecutiveStreamFailures).toBe(0);
      // Still visible to an operator, just not a degradation signal.
      expect(log.warn).toHaveBeenCalledOnce();
      expect(telemetry.noticeError).not.toHaveBeenCalled();
    });

    it("ignores the probe's own calls, so a probe success can't reset the counter", () => {
      const monitor = new NavidromeMonitor({ db, client: fakeClient(), log: testLogger() });

      monitor.record(event());
      monitor.record(event({ ok: true, status: 206, error: undefined, tag: "health-probe" }));
      monitor.record(event({ tag: "health-probe" }));

      const observed = monitor.observed();
      expect(observed.consecutiveStreamFailures).toBe(1);
      expect(observed.recentFailures).toBe(1);
    });

    it("treats a stream error envelope as neither a fault nor a success (#285)", () => {
      const log = testLogger();
      const telemetry = testTelemetry();
      const monitor = new NavidromeMonitor({ db, client: fakeClient(), log, telemetry });

      monitor.record(event());
      monitor.record(event({ status: 200, envelope: true }));

      const observed = monitor.observed();
      expect(observed.consecutiveStreamFailures).toBe(1);
      expect(observed.recentFailures).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringMatching(/error envelope/),
      );
      expect(telemetry.noticeError).toHaveBeenCalledOnce();
    });

    it("stays quiet about cover-art error envelopes", () => {
      const log = testLogger();
      const monitor = new NavidromeMonitor({ db, client: fakeClient(), log });

      monitor.record(event({ path: "/rest/getCoverArt", status: 200, envelope: true }));

      expect(log.warn).not.toHaveBeenCalled();
      expect(monitor.observed().lastFailure).toBeNull();
    });

    it("redacts URLs in lastFailure — it is served unauthenticated", () => {
      const monitor = new NavidromeMonitor({ db, client: fakeClient(), log: testLogger() });

      monitor.record(
        event({ status: null, error: new Error("request to http://navidrome:4533/rest/stream failed") }),
      );

      expect(monitor.observed().lastFailure?.message).toBe("request to <url> failed");
    });

    it("resets the consecutive stream counter on the next success", () => {
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
      });

      monitor.record(event());
      monitor.record(event());
      expect(monitor.observed().consecutiveStreamFailures).toBe(2);

      monitor.record(event({ ok: true, status: 206, error: undefined }));
      expect(monitor.observed().consecutiveStreamFailures).toBe(0);
      // The rolling window still remembers the faults happened.
      expect(monitor.observed().recentFailures).toBe(2);
    });

    it("caps APM errors per path per minute while keeping counters exact", () => {
      const telemetry = testTelemetry();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        telemetry,
        log: testLogger(),
      });

      for (let i = 0; i < 8; i++) monitor.record(event());

      expect(monitor.observed().recentFailures).toBe(8);
      expect(monitor.observed().consecutiveStreamFailures).toBe(8);
      expect(telemetry.noticeError).toHaveBeenCalledTimes(5);
    });
  });

  // ── Active probe ─────────────────────────────────────────────────────────

  describe("probe()", () => {
    it("reports ok when ping succeeds and the stream returns bytes", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.status).toBe("ok");
      expect(report.checks.hubDb.status).toBe("ok");
      expect(report.checks.navidromePing.status).toBe("ok");
      expect(report.checks.navidromeStream.status).toBe("ok");
      expect(report.cached).toBe(false);
    });

    it("skips the stream leg (staying ok) when the catalog has no local tracks", async () => {
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.status).toBe("ok");
      expect(report.checks.navidromeStream.status).toBe("skipped");
      expect(report.checks.navidromeStream.detail).toMatch(/no local tracks/);
    });

    it("degrades when Navidrome answers the stream with zero bytes", async () => {
      seedLocalTracks(db, ["nd-track-1", "nd-track-2", "nd-track-3"]);
      const telemetry = testTelemetry();
      const stream = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }));
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({ stream }),
        telemetry,
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.status).toBe("degraded");
      expect(report.checks.navidromeStream.status).toBe("failed");
      expect(report.checks.navidromeStream.detail).toMatch(/zero bytes/);
      // Every candidate is tried before the instance is called degraded.
      expect(stream).toHaveBeenCalledTimes(3);
      expect(telemetry.noticeError).toHaveBeenCalledOnce();
      expect(telemetry.recordCustomEvent).toHaveBeenCalledWith(
        "PoutineNavidromeHealth",
        expect.objectContaining({ status: "degraded" }),
      );
      expect(telemetry.recordMetric).toHaveBeenCalledWith(
        "Custom/Poutine/Navidrome/Degraded",
        1,
      );
    });

    it("stays ok when one bad track is followed by a good candidate (#222)", async () => {
      seedLocalTracks(db, ["bad-track", "good-track"]);
      const stream = vi.fn(async (id: string) =>
        id === "bad-track"
          ? new Response(null, { status: 200 })
          : new Response(new Uint8Array([9]), { status: 206 }),
      );
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({ stream }),
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.status).toBe("ok");
      expect(report.checks.navidromeStream.status).toBe("ok");
      expect(stream).toHaveBeenCalledTimes(2);
    });

    it("degrades on a ping failure and skips the stream leg", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const stream = vi.fn();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({
          ping: async () => {
            throw new Error("fetch failed");
          },
          stream: stream as unknown as (id: string) => Promise<Response>,
        }),
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.status).toBe("degraded");
      expect(report.checks.navidromePing.status).toBe("failed");
      expect(report.checks.navidromeStream.status).toBe("skipped");
      expect(stream).not.toHaveBeenCalled();
    });

    it("keeps internal URLs out of the (unauthenticated) response body", async () => {
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({
          ping: async () => {
            throw new Error(
              "request to http://navidrome:4533/rest/ping failed, reason: ECONNREFUSED",
            );
          },
        }),
        log: testLogger(),
      });

      const report = await monitor.probe();

      expect(report.checks.navidromePing.detail).not.toMatch(/navidrome:4533/);
      expect(report.checks.navidromePing.detail).toMatch(/<url>/);
    });

    it("serves a second call from the TTL cache, and `force` bypasses it", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const ping = vi.fn(async () => ({ status: "ok", version: "1.16.1" }));
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({ ping }),
        log: testLogger(),
        probeTtlMs: 60_000,
      });

      const first = await monitor.probe();
      const second = await monitor.probe();
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(ping).toHaveBeenCalledOnce();

      const forced = await monitor.probe({ force: true });
      expect(forced.cached).toBe(false);
      expect(ping).toHaveBeenCalledTimes(2);
    });

    it("reports live counters even on a cached report", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
        probeTtlMs: 60_000,
      });

      await monitor.probe();
      monitor.record(event());
      const cached = await monitor.probe();

      expect(cached.cached).toBe(true);
      expect(cached.observed.recentFailures).toBe(1);
    });

    it("degrades on observed real-traffic faults even when the probe passes", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
        streamFailureThreshold: 3,
      });

      monitor.record(event());
      monitor.record(event());
      let report = await monitor.probe({ force: true });
      expect(report.status).toBe("ok");

      monitor.record(event());
      report = await monitor.probe({ force: true });
      expect(report.status).toBe("degraded");
      // The synthetic probe itself is fine — the signal is real traffic.
      expect(report.checks.navidromeStream.status).toBe("ok");
      expect(report.observed.consecutiveStreamFailures).toBe(3);
    });

    it("re-evaluates status on a cached report from the live counters", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
        probeTtlMs: 60_000,
        streamFailureThreshold: 2,
      });

      expect((await monitor.probe()).status).toBe("ok");
      monitor.record(event());
      monitor.record(event());
      const cached = await monitor.probe();

      expect(cached.cached).toBe(true);
      expect(cached.status).toBe("degraded");
    });

    it("degrades when every candidate answers with a Subsonic error envelope (#285)", async () => {
      // Navidrome's 200 + `error code 70` for stale ids — e.g. every id after
      // a migration re-encodes them, before the hub re-syncs.
      seedLocalTracks(db, ["nd-track-1", "nd-track-2", "nd-track-3"]);
      const stream = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ "subsonic-response": { status: "failed", error: { code: 70 } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const monitor = new NavidromeMonitor({ db, client: fakeClient({ stream }), log: testLogger() });

      const report = await monitor.probe();

      expect(report.status).toBe("degraded");
      expect(report.checks.navidromeStream.detail).toMatch(/Subsonic error 70/);
      expect(stream).toHaveBeenCalledTimes(3);
    });

    it("asks for raw bytes and tags its stream calls for the observer", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const stream = vi.fn(
        async (_id: string, _opts?: unknown) =>
          new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
      );
      const monitor = new NavidromeMonitor({
        db,
        client: { ping: async () => ({}), stream } as unknown as SubsonicClient,
        log: testLogger(),
      });

      await monitor.probe();

      expect(stream).toHaveBeenCalledWith(
        "nd-track-1",
        expect.objectContaining({ format: "raw", observerTag: "health-probe" }),
      );
    });

    it("skips the stream leg when the probe is disabled by config", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const stream = vi.fn();
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({
          stream: stream as unknown as (id: string) => Promise<Response>,
        }),
        log: testLogger(),
        streamProbeEnabled: false,
      });

      const report = await monitor.probe();

      expect(report.status).toBe("ok");
      expect(report.checks.navidromeStream.status).toBe("skipped");
      expect(report.checks.navidromeStream.detail).toMatch(/disabled/);
      expect(stream).not.toHaveBeenCalled();
    });

    it("logs recovery and emits one transition per edge, not per probe", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const telemetry = testTelemetry();
      const log = testLogger();
      let healthy = false;
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({
          stream: async () =>
            healthy
              ? new Response(new Uint8Array([1]), { status: 206 })
              : new Response(new Uint8Array(0), { status: 200 }),
        }),
        telemetry,
        log,
      });

      await monitor.probe({ force: true });
      await monitor.probe({ force: true });
      expect(telemetry.recordCustomEvent).toHaveBeenCalledTimes(1);

      healthy = true;
      await monitor.probe({ force: true });
      expect(telemetry.recordCustomEvent).toHaveBeenCalledTimes(2);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ previousStatus: "degraded" }),
        "Navidrome health check recovered",
      );
      // The gauge is sampled on every probe regardless of transitions.
      expect(telemetry.recordMetric).toHaveBeenCalledTimes(3);
    });

    it("de-dupes concurrent probes into one Navidrome round trip", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const ping = vi.fn(async () => ({ status: "ok", version: "1.16.1" }));
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient({ ping }),
        log: testLogger(),
      });

      const [a, b, c] = await Promise.all([
        monitor.probe(),
        monitor.probe(),
        monitor.probe(),
      ]);

      expect(ping).toHaveBeenCalledOnce();
      expect([a.status, b.status, c.status]).toEqual(["ok", "ok", "ok"]);
    });

    it("lastReport() is null before the first probe and cached after", async () => {
      seedLocalTracks(db, ["nd-track-1"]);
      const monitor = new NavidromeMonitor({
        db,
        client: fakeClient(),
        log: testLogger(),
      });

      expect(monitor.lastReport()).toBeNull();
      await monitor.probe();
      expect(monitor.lastReport()?.cached).toBe(true);
      expect(monitor.lastReport()?.checks.navidromeStream.status).toBe("ok");
    });
  });
});
