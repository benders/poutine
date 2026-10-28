/**
 * Tests for resolveGitSha (issue #287) — the `gitSha` field of /api/health.
 */

import { describe, it, expect } from "vitest";
import { resolveGitSha } from "../src/services/git-sha.js";

const SHA = "8cdde80ffb68e858738b67a5451a97ebe58c6837";

describe("resolveGitSha (issue #287)", () => {
  it("prefers the POUTINE_GIT_SHA build-time env var over git", () => {
    const git = () => {
      throw new Error("git must not run when the env var is set");
    };
    expect(resolveGitSha({ POUTINE_GIT_SHA: `${SHA}-dirty\n` }, git)).toBe(
      `${SHA}-dirty`,
    );
  });

  it("falls back to git when the env var is unset or empty", () => {
    expect(resolveGitSha({}, () => `${SHA}\n`)).toBe(SHA);
    expect(resolveGitSha({ POUTINE_GIT_SHA: "" }, () => SHA)).toBe(SHA);
  });

  it("returns null when git is unavailable", () => {
    const git = () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    expect(resolveGitSha({}, git)).toBeNull();
  });

  it("resolves this checkout's commit with the real git", () => {
    expect(resolveGitSha({})).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
  });
});
