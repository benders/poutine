import { describe, it, expect } from "vitest";
import {
  signCastToken,
  verifyCastToken,
  deriveCastSecret,
} from "../src/services/cast-tokens.js";

const SECRET = Buffer.from("a".repeat(32));

describe("cast tokens", () => {
  it("round-trips a valid token and recovers the username", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", username: "alice" });
    const result = verifyCastToken(SECRET, "track-1", token);
    expect(result).toEqual({ username: "alice" });
  });

  it("rejects token for a different track id", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", username: "alice" });
    expect(verifyCastToken(SECRET, "track-2", token)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", username: "alice" });
    const tampered = "AAAA" + token.slice(4);
    expect(verifyCastToken(SECRET, "track-1", tampered)).toBeNull();
  });

  it("rejects username tampering — swapped username invalidates signature", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", username: "alice" });
    // Replace the encoded username segment with one for "bob" — sig won't match.
    const aliceEnc = Buffer.from("alice", "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const bobEnc = Buffer.from("bob", "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const tampered = token.replace(aliceEnc, bobEnc);
    expect(verifyCastToken(SECRET, "track-1", tampered)).toBeNull();
  });

  it("rejects expired token", () => {
    const token = signCastToken(SECRET, {
      trackId: "track-1",
      username: "alice",
      ttlSec: -10,
    });
    expect(verifyCastToken(SECRET, "track-1", token)).toBeNull();
  });

  it("rejects token signed with a different secret", () => {
    const token = signCastToken(SECRET, { trackId: "track-1", username: "alice" });
    expect(
      verifyCastToken(Buffer.from("b".repeat(32)), "track-1", token),
    ).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyCastToken(SECRET, "track-1", "")).toBeNull();
    expect(verifyCastToken(SECRET, "track-1", "two.parts")).toBeNull();
    expect(verifyCastToken(SECRET, "track-1", "sig.notanumber.user")).toBeNull();
  });

  it("preserves usernames with special characters and unicode", () => {
    const token = signCastToken(SECRET, {
      trackId: "track-1",
      username: "nic.benders+test@example.com 日本語",
    });
    expect(verifyCastToken(SECRET, "track-1", token)).toEqual({
      username: "nic.benders+test@example.com 日本語",
    });
  });

  it("deriveCastSecret returns a 32-byte buffer deterministically", () => {
    const k = Buffer.from("priv-key-bytes");
    const a = deriveCastSecret(k);
    const b = deriveCastSecret(k);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });
});
