import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createInvitation,
  encodeInvitation,
  decodeInvitation,
  verifyInvitationSignature,
  signInviteeProof,
  verifyInviteeProof,
} from "../src/federation/invitations.js";
import { loadOrCreatePrivateKey } from "../src/federation/signing.js";

function tmpKey(suffix = "") {
  return path.join(os.tmpdir(), `poutine-inv-${Date.now()}-${suffix}.pem`);
}

describe("invitations", () => {
  it("round-trips through encode/decode preserving payload + signature", () => {
    const keyPath = tmpKey("a");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const signed = createInvitation({
        privateKey,
        inviterId: "alice",
        inviterUrl: "https://alice.example",
        inviterPublicKey: `ed25519:${publicKeyBase64}`,
        inviteeUrl: "https://bob.example",
      });
      const wire = encodeInvitation(signed);
      const decoded = decodeInvitation(wire);
      expect(decoded.payload).toEqual(signed.payload);
      expect(decoded.signature).toBe(signed.signature);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("verifyInvitationSignature accepts a freshly issued invitation", () => {
    const keyPath = tmpKey("b");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const signed = createInvitation({
        privateKey,
        inviterId: "alice",
        inviterUrl: "https://alice.example",
        inviterPublicKey: `ed25519:${publicKeyBase64}`,
        inviteeUrl: null,
      });
      const result = verifyInvitationSignature(signed);
      expect(result.ok).toBe(true);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const keyPath = tmpKey("c");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const signed = createInvitation({
        privateKey,
        inviterId: "alice",
        inviterUrl: "https://alice.example",
        inviterPublicKey: `ed25519:${publicKeyBase64}`,
        inviteeUrl: "https://bob.example",
      });
      const tampered = {
        ...signed,
        payload: { ...signed.payload, inviter_url: "https://evil.example" },
      };
      const result = verifyInvitationSignature(tampered);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Signature/);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("rejects an expired invitation", () => {
    const keyPath = tmpKey("d");
    try {
      const { privateKey, publicKeyBase64 } = loadOrCreatePrivateKey(keyPath);
      const signed = createInvitation({
        privateKey,
        inviterId: "alice",
        inviterUrl: "https://alice.example",
        inviterPublicKey: `ed25519:${publicKeyBase64}`,
        inviteeUrl: null,
        expiresInSec: 60,
      });
      // 10 minutes in the future
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const result = verifyInvitationSignature(signed, { now: future });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/expired/);
    } finally {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    }
  });

  it("decodeInvitation throws on malformed input", () => {
    expect(() => decodeInvitation("not-base64!!!")).toThrow();
    // valid base64 but not JSON
    const garbage = Buffer.from("plain text", "utf8").toString("base64");
    expect(() => decodeInvitation(garbage)).toThrow();
  });

  it("invitee proof: verifies own signature, rejects wrong key", () => {
    const inviteeKey = tmpKey("e1");
    const otherKey = tmpKey("e2");
    try {
      const { privateKey: pkInvitee, publicKeyBase64: pubInvitee } =
        loadOrCreatePrivateKey(inviteeKey);
      const { publicKeyBase64: pubOther } = loadOrCreatePrivateKey(otherKey);

      const nonce = "abc-123";
      const proof = signInviteeProof(pkInvitee, nonce);

      expect(verifyInviteeProof(`ed25519:${pubInvitee}`, nonce, proof)).toBe(true);
      expect(verifyInviteeProof(`ed25519:${pubOther}`, nonce, proof)).toBe(false);
      expect(verifyInviteeProof(`ed25519:${pubInvitee}`, "wrong-nonce", proof)).toBe(false);
    } finally {
      if (fs.existsSync(inviteeKey)) fs.unlinkSync(inviteeKey);
      if (fs.existsSync(otherKey)) fs.unlinkSync(otherKey);
    }
  });
});
