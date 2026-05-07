import { describe, it, expect } from "vitest";
import { sqliteToIso } from "../src/util/time.js";

describe("sqliteToIso", () => {
  it("converts SQLite datetime('now') output to ISO 8601 with T and Z", () => {
    expect(sqliteToIso("2026-04-30 12:34:56")).toBe("2026-04-30T12:34:56Z");
  });

  it("passes through values that already contain a T separator", () => {
    expect(sqliteToIso("2026-04-30T12:34:56Z")).toBe("2026-04-30T12:34:56Z");
  });

  it("passes through fractional ISO strings unchanged", () => {
    expect(sqliteToIso("2026-04-30T12:34:56.789Z")).toBe("2026-04-30T12:34:56.789Z");
  });
});
