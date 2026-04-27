import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  setPassword,
  verifyPassword,
  getStoredPassword,
} from "../src/auth/passwords.js";

const key = randomBytes(32);

describe("password storage", () => {
  it("encrypts a password to a non-plaintext blob", () => {
    const enc = setPassword("hunter2", key);
    expect(enc).toBeTruthy();
    expect(enc).not.toBe("hunter2");
  });

  it("verifies the correct password", () => {
    const enc = setPassword("hunter2", key);
    expect(verifyPassword(enc, "hunter2", key)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const enc = setPassword("hunter2", key);
    expect(verifyPassword(enc, "wrong", key)).toBe(false);
  });

  it("rejects empty stored value", () => {
    expect(verifyPassword("", "hunter2", key)).toBe(false);
  });

  it("rejects garbage stored value without throwing", () => {
    expect(verifyPassword("not-base64-ciphertext", "x", key)).toBe(false);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = setPassword("same", key);
    const b = setPassword("same", key);
    expect(a).not.toBe(b);
  });

  it("getStoredPassword recovers plaintext for u+t+s token computation", () => {
    const enc = setPassword("hunter2", key);
    expect(getStoredPassword(enc, key)).toBe("hunter2");
  });

  it("getStoredPassword returns null for empty/garbage", () => {
    expect(getStoredPassword("", key)).toBe(null);
    expect(getStoredPassword("garbage", key)).toBe(null);
  });
});
