/**
 * Tests for the optional New Relic bridge (issue #277).
 *
 * The contract that matters: with no license key the `newrelic` module is
 * never imported and every call is a no-op (so dev, tests and opt-out
 * deployments carry zero agent code), and when the bridge IS live a throwing
 * agent can never surface an error into a request path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { initTelemetry, noopTelemetry } from "../src/services/telemetry.js";

const agent = vi.hoisted(() => ({
  noticeError: vi.fn(),
  recordCustomEvent: vi.fn(),
  recordMetric: vi.fn(),
}));

// Stubbed so the real agent never boots during the suite.
vi.mock("newrelic", () => ({ default: agent }));

function testLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

describe("initTelemetry (#277)", () => {
  beforeEach(() => {
    agent.noticeError.mockReset();
    agent.recordCustomEvent.mockReset();
    agent.recordMetric.mockReset();
  });

  it("returns a no-op sink when NEW_RELIC_LICENSE_KEY is unset", async () => {
    const log = testLogger();
    const telemetry = await initTelemetry(log, {});

    expect(telemetry.enabled).toBe(false);
    telemetry.noticeError(new Error("boom"), { a: 1 });
    telemetry.recordCustomEvent("X", { a: 1 });
    telemetry.recordMetric("m", 1);

    expect(agent.noticeError).not.toHaveBeenCalled();
    expect(agent.recordCustomEvent).not.toHaveBeenCalled();
    expect(agent.recordMetric).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("forwards to the agent when the license key is set", async () => {
    const telemetry = await initTelemetry(testLogger(), {
      NEW_RELIC_LICENSE_KEY: "fake-key",
    });

    expect(telemetry.enabled).toBe(true);

    const err = new Error("navidrome exploded");
    telemetry.noticeError(err, { navidromePath: "/rest/stream" });
    telemetry.recordCustomEvent("PoutineNavidromeHealth", { status: "degraded" });
    telemetry.recordMetric("Custom/Poutine/Navidrome/Degraded", 1);

    expect(agent.noticeError).toHaveBeenCalledWith(err, {
      navidromePath: "/rest/stream",
    });
    expect(agent.recordCustomEvent).toHaveBeenCalledWith(
      "PoutineNavidromeHealth",
      { status: "degraded" },
    );
    expect(agent.recordMetric).toHaveBeenCalledWith(
      "Custom/Poutine/Navidrome/Degraded",
      1,
    );
  });

  it("swallows errors thrown by the agent", async () => {
    agent.noticeError.mockImplementation(() => {
      throw new Error("agent is broken");
    });
    agent.recordCustomEvent.mockImplementation(() => {
      throw new Error("agent is broken");
    });
    agent.recordMetric.mockImplementation(() => {
      throw new Error("agent is broken");
    });

    const telemetry = await initTelemetry(testLogger(), {
      NEW_RELIC_LICENSE_KEY: "fake-key",
    });

    expect(() => telemetry.noticeError(new Error("x"))).not.toThrow();
    expect(() => telemetry.recordCustomEvent("X", {})).not.toThrow();
    expect(() => telemetry.recordMetric("m", 1)).not.toThrow();
  });

  it("noopTelemetry() is inert and reports disabled", () => {
    const telemetry = noopTelemetry();
    expect(telemetry.enabled).toBe(false);
    expect(() => telemetry.noticeError(new Error("x"))).not.toThrow();
  });
});
