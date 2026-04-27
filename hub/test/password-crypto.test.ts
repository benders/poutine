import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  encryptPassword,
  decryptPassword,
  loadOrCreatePasswordKey,
  constantTimeEqual,
} from "../src/auth/password-crypto.js";

function tempPath(name = "key"): string {
  const dir = mkdtempSync(join(tmpdir(), "poutine-pwkey-"));
  return join(dir, name);
}

describe("password-crypto", () => {
  it("round-trips arbitrary UTF-8", () => {
    const key = randomBytes(32);
    for (const pt of ["", "hunter2", "🎵 unicode", "a".repeat(1024)]) {
      const enc = encryptPassword(pt, key);
      expect(decryptPassword(enc, key)).toBe(pt);
    }
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const key = randomBytes(32);
    const a = encryptPassword("same", key);
    const b = encryptPassword("same", key);
    expect(a).not.toBe(b);
    expect(decryptPassword(a, key)).toBe(decryptPassword(b, key));
  });

  it("rejects tampered ciphertext", () => {
    const key = randomBytes(32);
    const enc = encryptPassword("hunter2", key);
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a bit in the auth tag
    const tampered = buf.toString("base64");
    expect(() => decryptPassword(tampered, key)).toThrow();
  });

  it("rejects ciphertext encrypted with a different key", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const enc = encryptPassword("hunter2", k1);
    expect(() => decryptPassword(enc, k2)).toThrow();
  });

  it("loadOrCreatePasswordKey creates a new 32-byte key with mode 0600", () => {
    const path = tempPath();
    expect(existsSync(path)).toBe(false);
    const key = loadOrCreatePasswordKey(path);
    expect(key.length).toBe(32);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(path);
  });

  it("loadOrCreatePasswordKey is stable across calls", () => {
    const path = tempPath();
    const a = loadOrCreatePasswordKey(path);
    const b = loadOrCreatePasswordKey(path);
    expect(b.equals(a)).toBe(true);
    rmSync(path);
  });

  it("loadOrCreatePasswordKey rejects malformed key files", () => {
    const path = tempPath();
    require("node:fs").writeFileSync(path, "not-base64-of-32-bytes");
    expect(() => loadOrCreatePasswordKey(path)).toThrow(/expected 32/);
    rmSync(path);
  });

  it("constantTimeEqual matches strict equality semantics", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("password key file", () => {
  it("written value matches what's read back", () => {
    const path = tempPath();
    const key = loadOrCreatePasswordKey(path);
    const onDisk = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    expect(onDisk.equals(key)).toBe(true);
    rmSync(path);
  });
});
