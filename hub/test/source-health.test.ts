import { describe, it, expect } from "vitest";
import { SourceHealth } from "../src/services/source-health.js";

describe("SourceHealth (#241)", () => {
  function clocked(ttl = 1000) {
    let t = 0;
    const health = new SourceHealth({ suspectTtlMs: ttl, now: () => t });
    return { health, advance: (ms: number) => { t += ms; } };
  }

  it("marks a failed source suspect until the TTL lapses", () => {
    const { health, advance } = clocked(1000);
    expect(health.isSuspect("peer-a")).toBe(false);
    health.recordFailure("peer-a");
    expect(health.isSuspect("peer-a")).toBe(true);
    advance(999);
    expect(health.isSuspect("peer-a")).toBe(true);
    advance(1);
    expect(health.isSuspect("peer-a")).toBe(false);
  });

  it("clears on success", () => {
    const { health } = clocked();
    health.recordFailure("local");
    health.recordSuccess("local");
    expect(health.isSuspect("local")).toBe(false);
  });

  it("orders healthy candidates first, keeping rank order within each group", () => {
    const { health } = clocked();
    health.recordFailure("a");
    health.recordFailure("c");
    const ranked = ["a", "b", "c", "d"].map((instance_id) => ({ instance_id }));
    expect(health.order(ranked).map((s) => s.instance_id)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps every candidate when all are suspect", () => {
    const { health } = clocked();
    health.recordFailure("a");
    health.recordFailure("b");
    const ranked = [{ instance_id: "a" }, { instance_id: "b" }];
    expect(health.order(ranked).map((s) => s.instance_id)).toEqual(["a", "b"]);
  });
});
