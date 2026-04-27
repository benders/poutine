import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isAuthErrorCode, getArtists, SubsonicError } from "./subsonic";
import { setSubsonicCreds } from "./api";

// Subsonic auth-related error codes per OpenSubsonic spec. Codes 10/40/41/42/43/44
// must redirect to /login; code 50 (authz) and others must not.

describe("isAuthErrorCode", () => {
  it.each([10, 40, 41, 42, 43, 44])("treats code %i as auth-related", (code) => {
    expect(isAuthErrorCode(code)).toBe(true);
  });

  it.each([0, 20, 30, 50, 60, 70, 99])(
    "treats code %i as NOT auth-related",
    (code) => {
      expect(isAuthErrorCode(code)).toBe(false);
    },
  );

  it("rejects non-numeric inputs", () => {
    expect(isAuthErrorCode(undefined)).toBe(false);
    expect(isAuthErrorCode("40")).toBe(false);
    expect(isAuthErrorCode(null)).toBe(false);
  });
});

describe("subsonicFetch — redirect on auth error codes", () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    setSubsonicCreds({ username: "u", password: "p" });
    originalLocation = window.location;
    replaceSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, replace: replaceSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    setSubsonicCreds(null);
    vi.restoreAllMocks();
  });

  function mockSubsonicError(code: number) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          "subsonic-response": {
            status: "failed",
            error: { code, message: "x" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  it.each([40, 41, 42, 43, 44])(
    "redirects to /login on Subsonic error code %i",
    async (code) => {
      mockSubsonicError(code);
      await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
      expect(replaceSpy).toHaveBeenCalledWith("/login");
    },
  );

  it("redirects on code 10 (missing parameter — implies creds absent)", async () => {
    mockSubsonicError(10);
    await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
    expect(replaceSpy).toHaveBeenCalledWith("/login");
  });

  it("does NOT redirect on code 50 (authorization, not authentication)", async () => {
    mockSubsonicError(50);
    await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("does NOT redirect on a non-auth error (e.g. 70 not found)", async () => {
    mockSubsonicError(70);
    await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("redirects to /login when Subsonic creds are missing client-side (#111 upgrade path)", async () => {
    // Pre-#106 install: JWT survives in localStorage but
    // subsonicUser/subsonicPass were never written. authParams() returns
    // null and subsonicFetch must redirect rather than just throwing
    // SubsonicError(10) — otherwise the SPA shows "Subsonic error code 10"
    // and stays put.
    setSubsonicCreds(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledWith("/login");
  });

  it("does NOT redirect when already on /login (avoid redirect loop)", async () => {
    setSubsonicCreds(null);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, pathname: "/login", replace: replaceSpy },
    });
    await expect(getArtists()).rejects.toBeInstanceOf(SubsonicError);
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
