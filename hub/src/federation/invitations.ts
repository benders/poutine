// Federation invitations (issue #147, federation API v5).
//
// An invitation is a signed grant from an inviting hub to an invitee hub
// that authorizes the invitee to join the issuer's peer cluster. Invitations
// are signed with the inviter's Ed25519 federation key (the same key used
// for federation request signing) and carry the inviter's identity so a
// receiver can verify them without prior trust.
//
// The signed payload is **never gossiped** but it *is* stored alongside the
// resulting peer record (`instances.invitation_payload` etc.) and travels
// via gossip in Phase 3. Receivers verify the embedded signature against
// the named inviter's public key before trusting the gossiped entry.
//
// Wire format: base64-of-JSON of { payload, signature }.

import { randomUUID, type KeyObject } from "node:crypto";
import { signRequest, verifyRequest, parsePeerPublicKey } from "./signing.js";
import { FEDERATION_API_VERSION } from "../version.js";

export interface InvitationPayload {
  v: number;                   // federation api version (5 in this release)
  inviter_id: string;
  inviter_url: string;         // base URL, no trailing slash
  inviter_public_key: string;  // "ed25519:<base64>"
  invitee_url: string | null;  // null = open invite (any URL)
  nonce: string;               // UUID, single-use
  issued_at: string;           // ISO 8601
  expires_at: string;          // ISO 8601
}

export interface SignedInvitation {
  payload: InvitationPayload;
  signature: string;           // base64
}

/**
 * Canonical signing bytes for an invitation payload. Newline-joined fields
 * mirror the federation-request signing convention (canonicalSigningPayload)
 * for consistency. Order is fixed; do not reorder without bumping the
 * federation API version.
 */
export function canonicalInvitationPayload(p: InvitationPayload): Buffer {
  return Buffer.from(
    [
      `poutine-invitation/v${p.v}`,
      p.inviter_id,
      p.inviter_url,
      p.inviter_public_key,
      p.invitee_url ?? "",
      p.nonce,
      p.issued_at,
      p.expires_at,
    ].join("\n"),
    "utf8",
  );
}

export function createInvitation(opts: {
  privateKey: KeyObject;
  inviterId: string;
  inviterUrl: string;
  inviterPublicKey: string;
  inviteeUrl: string | null;
  expiresInSec?: number;       // default 7 days
}): SignedInvitation {
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() + (opts.expiresInSec ?? 7 * 24 * 60 * 60) * 1000,
  );
  const payload: InvitationPayload = {
    v: FEDERATION_API_VERSION,
    inviter_id: opts.inviterId,
    inviter_url: opts.inviterUrl.replace(/\/+$/, ""),
    inviter_public_key: opts.inviterPublicKey,
    invitee_url: opts.inviteeUrl ? opts.inviteeUrl.replace(/\/+$/, "") : null,
    nonce: randomUUID(),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  const signature = signRequest(opts.privateKey, canonicalInvitationPayload(payload));
  return { payload, signature };
}

export function encodeInvitation(signed: SignedInvitation): string {
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64");
}

export function decodeInvitation(text: string): SignedInvitation {
  const trimmed = text.trim();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(`Invitation is not valid base64-encoded JSON: ${String(err)}`);
  }
  if (!json || typeof json !== "object") {
    throw new Error("Invitation: expected an object");
  }
  const obj = json as { payload?: unknown; signature?: unknown };
  if (typeof obj.signature !== "string") {
    throw new Error("Invitation: missing or invalid signature");
  }
  const p = obj.payload as Partial<InvitationPayload> | undefined;
  if (
    !p ||
    typeof p.v !== "number" ||
    typeof p.inviter_id !== "string" ||
    typeof p.inviter_url !== "string" ||
    typeof p.inviter_public_key !== "string" ||
    (p.invitee_url !== null && typeof p.invitee_url !== "string") ||
    typeof p.nonce !== "string" ||
    typeof p.issued_at !== "string" ||
    typeof p.expires_at !== "string"
  ) {
    throw new Error("Invitation: payload missing required fields");
  }
  return { payload: p as InvitationPayload, signature: obj.signature };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify an invitation's signature against its embedded inviter_public_key.
 * Optionally checks expiry. Does not check single-use / replay — that's the
 * caller's responsibility (look up nonce in `invitations` table).
 */
export function verifyInvitationSignature(
  signed: SignedInvitation,
  opts?: { now?: Date },
): VerifyResult {
  let pubKey: KeyObject;
  try {
    pubKey = parsePeerPublicKey(signed.payload.inviter_public_key);
  } catch (err) {
    return { ok: false, error: `Invalid inviter_public_key: ${String(err)}` };
  }
  const ok = verifyRequest(
    pubKey,
    canonicalInvitationPayload(signed.payload),
    signed.signature,
  );
  if (!ok) return { ok: false, error: "Signature does not verify" };

  const now = opts?.now ?? new Date();
  if (new Date(signed.payload.expires_at).getTime() <= now.getTime()) {
    return { ok: false, error: "Invitation expired" };
  }
  return { ok: true };
}

/**
 * The invitee proves ownership of its claimed Ed25519 public key by signing
 * the invitation nonce with its private key. The inviter checks this during
 * the handshake to defend against a leaked invitation being redeemed by a
 * third party with a different keypair.
 */
export function signInviteeProof(
  privateKey: KeyObject,
  nonce: string,
): string {
  return signRequest(privateKey, Buffer.from(nonce, "utf8"));
}

export function verifyInviteeProof(
  publicKeySpec: string,
  nonce: string,
  signature: string,
): boolean {
  let pubKey: KeyObject;
  try {
    pubKey = parsePeerPublicKey(publicKeySpec);
  } catch {
    return false;
  }
  return verifyRequest(pubKey, Buffer.from(nonce, "utf8"), signature);
}
