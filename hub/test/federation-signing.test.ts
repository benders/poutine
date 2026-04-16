import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  loadOrCreatePrivateKey,
  parsePeerPublicKey,
  canonicalSigningPayload,
  signRequest,
  verifyRequest,
  sha256Hex,
} from "../src/federation/signing.js";

function tmpKeyPath(suffix = "") {
  return path.join(os.tmpdir(), `poutine-test-key-${Date.now()}-${suffix}.pem`);
}

const samplePayload = () =>
  canonicalSigningPayload({
    method: "GET",
    path: "/proxy/rest/getArtists",
    bodyHash: "-",
    timestamp: String(Date.now()),
    instanceId: "poutine-test",
    userAssertion: "alice",
  });

describe("loadOrCreatePrivateKey", () => {
  it("creates a new key file when missing", () => {
    const keyPath = tmpKeyPath("create");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      expect(privateKey).toBeDefined();
      expect(typeof publicKeyBase64).toBe("string");
      expect(publicKeyBase64.length).toBeGreaterThan(0);
      expect(fs.existsSync(keyPath)).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("loads an existing key file and returns same public key base64", () => {
    const keyPath = tmpKeyPath("load");
    try {
      const first = loadOrCreatePrivateKey(keyPath);
      const second = loadOrCreatePrivateKey(keyPath);
      expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("created key file has restricted permissions (0600)", () => {
    const keyPath = tmpKeyPath("perms");
    try {
      loadOrCreatePrivateKey(keyPath);
      const stat = fs.statSync(keyPath);
      // Mode masked to permission bits
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });
});

describe("parsePeerPublicKey", () => {
  it("parses a key derived from loadOrCreatePrivateKey", () => {
    const keyPath = tmpKeyPath("parse");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const publicKey = parsePeerPublicKey(`ed25519:${publicKeyBase64}`);
      expect(publicKey).toBeDefined();

      // Verify a signature made with the loaded private key using the parsed public key
      const payload = samplePayload();
      const sig = signRequest(privateKey, payload);
      expect(verifyRequest(publicKey, payload, sig)).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("throws on wrong prefix", () => {
    expect(() => parsePeerPublicKey("rsa:abc")).toThrow(/ed25519:/);
  });

  it("throws on wrong key length", () => {
    const shortBase64 = Buffer.from("tooshort").toString("base64");
    expect(() => parsePeerPublicKey(`ed25519:${shortBase64}`)).toThrow(/length/);
  });
});

describe("sign / verify round-trip", () => {
  it("verifies a valid signature", () => {
    const keyPath = tmpKeyPath("roundtrip");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const publicKey = parsePeerPublicKey(`ed25519:${publicKeyBase64}`);
      const payload = samplePayload();
      const sig = signRequest(privateKey, payload);
      expect(verifyRequest(publicKey, payload, sig)).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("returns false when payload is tampered", () => {
    const keyPath = tmpKeyPath("tamper");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const publicKey = parsePeerPublicKey(`ed25519:${publicKeyBase64}`);
      const payload = samplePayload();
      const sig = signRequest(privateKey, payload);

      const tampered = Buffer.from(payload);
      tampered[0] ^= 0xff;

      expect(verifyRequest(publicKey, tampered, sig)).toBe(false);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("returns false when a different key is used to verify", () => {
    const keyPathA = tmpKeyPath("diff-a");
    const keyPathB = tmpKeyPath("diff-b");
    try {
      const { privateKey: privA } = loadOrCreatePrivateKey(keyPathA);
      const { publicKeyBase64: pubB64 } = loadOrCreatePrivateKey(keyPathB);
      const pubKeyB = parsePeerPublicKey(`ed25519:${pubB64}`);

      const payload = samplePayload();
      const sig = signRequest(privA, payload);

      expect(verifyRequest(pubKeyB, payload, sig)).toBe(false);
    } finally {
      if (fs.existsSync(keyPathA)) fs.unlinkSync(keyPathA);
      if (fs.existsSync(keyPathB)) fs.unlinkSync(keyPathB);
    }
  });

  it("returns false on garbage signature", () => {
    const keyPath = tmpKeyPath("garbage");
    try {
      const { publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const publicKey = parsePeerPublicKey(`ed25519:${publicKeyBase64}`);
      const payload = samplePayload();
      expect(verifyRequest(publicKey, payload, "not-a-valid-sig")).toBe(false);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });
});

describe("sha256Hex", () => {
  it("returns hex string for buffer input", () => {
    const result = sha256Hex(Buffer.from("hello"));
    expect(typeof result).toBe("string");
    expect(result).toHaveLength(64);
    // Known SHA-256 of "hello"
    expect(result).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("returns hex string for string input", () => {
    const result = sha256Hex("hello");
    expect(result).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
