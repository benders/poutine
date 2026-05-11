import { describe, it, expect } from "vitest";
import {
  signCastToken,
  verifyCastToken,
  deriveCastSecret,
} from "../src/services/cast-tokens.js";

const SECRET = Buffer.from("a".repeat(32));

describe("cast tokens", () => {
  it("round-trips a valid token", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", userId: "cast" });
    expect(verifyCastToken(SECRET, "track-1", token)?.userId).toBe("cast");
  });

  it("rejects token for a different track id", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", userId: "cast" });
    expect(verifyCastToken(SECRET, "track-2", token)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", userId: "cast" });
    const tampered = "AAAA" + token.slice(4);
    expect(verifyCastToken(SECRET, "track-1", tampered)).toBeNull();
  });

  it("rejects expired token", () => {
    const token = signCastToken(SECRET, {
      trackId: "track-1",
      userId: "cast",
      ttlSec: -10,
    });
    expect(verifyCastToken(SECRET, "track-1", token)).toBeNull();
  });

  it("rejects token signed with a different secret", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", userId: "cast" });
    expect(
      verifyCastToken(Buffer.from("b".repeat(32)), "track-1", token),
    ).toBeNull();
  });

  it("deriveCastSecret returns a 32-byte buffer deterministically", () => {
    const k = Buffer.from("priv-key-bytes");
    const a = deriveCastSecret(k);
    const b = deriveCastSecret(k);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });
});
