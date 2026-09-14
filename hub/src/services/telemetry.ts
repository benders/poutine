/**
 * telemetry.ts — optional New Relic bridge (issue #277, extends #3).
 *
 * #3 wired the APM agent at the process level (`hub/docker-entrypoint.sh`)
 * with zero app code. That buys transactions, traces and VM metrics, but it
 * cannot report a failure the hub *handles* — a Navidrome 500 swallowed into
 * a generic 502 looks like a successful request to the agent. This module is
 * the narrow app-level seam for those: `noticeError`, custom events, custom
 * metrics.
 *
 * Rules it follows:
 *
 * - **Same gate as the entrypoint.** The agent is only loaded when
 *   `NEW_RELIC_LICENSE_KEY` is set, so this bridge activates on exactly that
 *   condition. No key → every call here is a no-op and the `newrelic` module
 *   is never imported (importing it would *start* an agent).
 * - **Never throws, never blocks.** Telemetry is a side channel; a broken or
 *   absent agent must not affect a request. Every call is wrapped.
 * - **Import stays bare.** `import("newrelic")` resolves from this file's
 *   directory (`hub/dist/services/` → `hub/node_modules/newrelic`), unlike
 *   the entrypoint's `-r` flag which resolves from the cwd (`/app`) and
 *   therefore needs a path specifier. Don't "fix" one to match the other.
 */

export interface TelemetryAttributes {
  [key: string]: string | number | boolean;
}

export interface Telemetry {
  /** True when the New Relic agent API was resolved and calls reach it. */
  readonly enabled: boolean;
  /** Report a handled error the agent would otherwise never see. */
  noticeError(error: Error, attributes?: TelemetryAttributes): void;
  /** Record a custom event (NRQL: `FROM <eventType>`). */
  recordCustomEvent(eventType: string, attributes: TelemetryAttributes): void;
  /** Record a custom metric (NRQL: `FROM Metric SELECT … WHERE …`). */
  recordMetric(name: string, value: number): void;
}

/** Event type for Navidrome health-state transitions (see navidrome-monitor.ts). */
export const NAVIDROME_HEALTH_EVENT = "PoutineNavidromeHealth";
/** Event type for individual Navidrome call failures. */
export const NAVIDROME_ERROR_EVENT = "PoutineNavidromeError";

const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  noticeError: () => {},
  recordCustomEvent: () => {},
  recordMetric: () => {},
};

/** Shape of the bits of the New Relic API this module uses. */
interface NewRelicApi {
  noticeError?: (error: Error, attributes?: Record<string, unknown>) => void;
  recordCustomEvent?: (
    eventType: string,
    attributes: Record<string, unknown>,
  ) => void;
  recordMetric?: (name: string, value: number) => void;
}

export interface TelemetryLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
}

/**
 * Resolve the telemetry sink once, at boot.
 *
 * Returns the no-op sink when `NEW_RELIC_LICENSE_KEY` is unset (dev, tests,
 * and every deployment that didn't opt in) or when the agent module can't be
 * loaded. Callers hold the returned object and call it synchronously — no
 * per-call dynamic import on a hot path.
 */
export async function initTelemetry(
  log: TelemetryLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Telemetry> {
  if (!env.NEW_RELIC_LICENSE_KEY) {
    log.debug(
      "telemetry: NEW_RELIC_LICENSE_KEY unset — app-level telemetry disabled (no-op sink)",
    );
    return NOOP_TELEMETRY;
  }

  let api: NewRelicApi;
  try {
    // The agent is normally already initialized by the entrypoint's
    // `-r newrelic` preload; this import returns that same API singleton.
    const mod = (await import("newrelic")) as { default?: NewRelicApi } & NewRelicApi;
    api = mod.default ?? mod;
  } catch (err) {
    log.warn(
      `telemetry: NEW_RELIC_LICENSE_KEY is set but the newrelic module failed to load (${String(err)}); app-level telemetry disabled`,
    );
    return NOOP_TELEMETRY;
  }

  if (typeof api.noticeError !== "function") {
    log.warn(
      "telemetry: newrelic module loaded but exposes no noticeError() — app-level telemetry disabled",
    );
    return NOOP_TELEMETRY;
  }

  log.info("telemetry: New Relic app-level telemetry enabled (#277)");

  return {
    enabled: true,
    noticeError(error, attributes) {
      try {
        api.noticeError?.(error, attributes);
      } catch {
        // A telemetry failure must never surface to the caller.
      }
    },
    recordCustomEvent(eventType, attributes) {
      try {
        api.recordCustomEvent?.(eventType, attributes);
      } catch {
        // ditto
      }
    },
    recordMetric(name, value) {
      try {
        api.recordMetric?.(name, value);
      } catch {
        // ditto
      }
    },
  };
}

/** The shared no-op sink — use in tests and wherever telemetry is optional. */
export function noopTelemetry(): Telemetry {
  return NOOP_TELEMETRY;
}
