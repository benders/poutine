/**
 * Local user invitations (issue #272).
 *
 * An invite is a signed, expiring, single-use grant that lets a person create
 * their own account on this hub — the user-facing mirror of the federation
 * invitation flow in `federation/invitations.ts`.
 *
 * Two deliberate differences from the peer flow:
 *
 * 1. **HMAC-SHA-256, not Ed25519.** A peer invitation is verified by a *different*
 *    hub with no prior trust, which is what the asymmetric signature buys. A user
 *    invite is issued and redeemed by the same hub, so a symmetric key is
 *    sufficient — and the federation private key must not be spent on it: that
 *    key is cluster trust (admission and eviction), an entirely different blast
 *    radius. Same reasoning that keeps `castSecret` separate from
 *    `internalAuthSecret` (docs/authentication.md).
 * 2. **The DB row is authoritative.** The signature only proves the token was
 *    minted here and hasn't been tampered with, letting the public redeem route
 *    reject junk before touching the DB. Single-use, expiry, and revocation are
 *    all enforced by the atomic consume in `consumeUserInvite`.
 *
 * The token is never persisted — only `sha256(token)` — so a stolen DB copy
 * yields no redeemable invites.
 */

import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Database } from "better-sqlite3";

const KEY_SETTING = "user_invite_key";

/** 48 h. Shorter than the peer default (7 d) — invites travel over chat. */
export const DEFAULT_INVITE_TTL_SEC = 48 * 60 * 60;
export const MAX_INVITE_TTL_SEC = 30 * 24 * 60 * 60;

export const USER_INVITE_VERSION = 1;

export interface UserInvitePayload {
  v: number;
  nonce: string; // UUID, single-use
  issued_at: string; // ISO 8601
  expires_at: string; // ISO 8601
  suggested_username: string | null;
  is_admin: boolean;
}

export interface SignedUserInvite {
  payload: UserInvitePayload;
  signature: string; // base64
}

/**
 * HMAC key for user invites, generated on first use and persisted in
 * `settings`. Mirrors `ensureJwtSecret`. Rotating it (deleting the row)
 * invalidates every outstanding invite, which is the intended escape hatch.
 */
export function ensureUserInviteKey(db: Database): Buffer {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY_SETTING) as { value: string } | undefined;
  if (existing) return Buffer.from(existing.value, "hex");

  const key = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    KEY_SETTING,
    key,
  );
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY_SETTING) as { value: string };
  return Buffer.from(row.value, "hex");
}

/**
 * Canonical signing bytes. Newline-joined, fixed order — mirrors
 * `canonicalInvitationPayload`. Do not reorder without bumping
 * USER_INVITE_VERSION.
 */
export function canonicalUserInvitePayload(p: UserInvitePayload): Buffer {
  return Buffer.from(
    [
      `poutine-user-invite/v${p.v}`,
      p.nonce,
      p.issued_at,
      p.expires_at,
      p.suggested_username ?? "",
      p.is_admin ? "1" : "0",
    ].join("\n"),
    "utf8",
  );
}

function sign(key: Buffer, payload: UserInvitePayload): string {
  return createHmac("sha256", key)
    .update(canonicalUserInvitePayload(payload))
    .digest("base64");
}

export function createUserInvite(opts: {
  key: Buffer;
  expiresInSec?: number;
  suggestedUsername?: string | null;
  isAdmin?: boolean;
}): SignedUserInvite {
  const ttl = Math.min(
    Math.max(opts.expiresInSec ?? DEFAULT_INVITE_TTL_SEC, 60),
    MAX_INVITE_TTL_SEC,
  );
  const issuedAt = new Date();
  const payload: UserInvitePayload = {
    v: USER_INVITE_VERSION,
    nonce: randomUUID(),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
    suggested_username: opts.suggestedUsername || null,
    is_admin: opts.isAdmin === true,
  };
  return { payload, signature: sign(opts.key, payload) };
}

/** Wire format: base64url of JSON — URL-fragment safe, no escaping needed. */
export function encodeUserInvite(signed: SignedUserInvite): string {
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
}

export function decodeUserInvite(text: string): SignedUserInvite {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(text.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invite token is not valid base64url-encoded JSON");
  }
  if (!json || typeof json !== "object") {
    throw new Error("Invite token: expected an object");
  }
  const obj = json as { payload?: unknown; signature?: unknown };
  if (typeof obj.signature !== "string") {
    throw new Error("Invite token: missing or invalid signature");
  }
  const p = obj.payload as Partial<UserInvitePayload> | undefined;
  if (
    !p ||
    typeof p.v !== "number" ||
    typeof p.nonce !== "string" ||
    typeof p.issued_at !== "string" ||
    typeof p.expires_at !== "string" ||
    (p.suggested_username !== null && typeof p.suggested_username !== "string") ||
    typeof p.is_admin !== "boolean"
  ) {
    throw new Error("Invite token: payload missing required fields");
  }
  return { payload: p as UserInvitePayload, signature: obj.signature };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Signature + version + expiry check. Says nothing about single-use — that is
 * `consumeUserInvite`'s job, and only it may be trusted for admission.
 */
export function verifyUserInvite(
  key: Buffer,
  signed: SignedUserInvite,
  opts?: { now?: Date },
): VerifyResult {
  if (signed.payload.v !== USER_INVITE_VERSION) {
    return { ok: false, error: "Unsupported invite version" };
  }
  const expected = Buffer.from(sign(key, signed.payload), "base64");
  const actual = Buffer.from(signed.signature, "base64");
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { ok: false, error: "Signature does not verify" };
  }
  const now = opts?.now ?? new Date();
  if (new Date(signed.payload.expires_at).getTime() <= now.getTime()) {
    return { ok: false, error: "Invite expired" };
  }
  return { ok: true };
}

/**
 * SQLite's `datetime('now')` renders `2026-09-03 15:04:05`, which sorts BELOW
 * a JS `toISOString()` value on the same instant (space < 'T'), so comparing
 * the two silently treats every invite as unexpired. Compare against the ISO
 * rendering instead, and write timestamps in the same shape.
 */
const SQL_NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export type InviteState = "pending" | "consumed" | "expired" | "revoked";

export interface UserInviteRow {
  id: string;
  suggested_username: string | null;
  is_admin: number;
  note: string | null;
  created_by: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_id: string | null;
  revoked_at: string | null;
}

export function inviteState(row: UserInviteRow, now = new Date()): InviteState {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "consumed";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** Persist a freshly issued invite. Returns the row id. */
export function recordUserInvite(
  db: Database,
  opts: {
    signed: SignedUserInvite;
    token: string;
    createdBy: string;
    note?: string | null;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO user_invitations
       (id, token_hash, payload, signature, suggested_username, is_admin, note,
        created_by, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashInviteToken(opts.token),
    JSON.stringify(opts.signed.payload),
    opts.signed.signature,
    opts.signed.payload.suggested_username,
    opts.signed.payload.is_admin ? 1 : 0,
    opts.note ?? null,
    opts.createdBy,
    opts.signed.payload.issued_at,
    opts.signed.payload.expires_at,
  );
  return id;
}

export function findUserInviteByToken(
  db: Database,
  token: string,
): UserInviteRow | undefined {
  return db
    .prepare("SELECT * FROM user_invitations WHERE token_hash = ?")
    .get(hashInviteToken(token)) as UserInviteRow | undefined;
}

/**
 * Atomically claim the invite. Single statement — a SELECT-then-UPDATE loses
 * the race between two simultaneous redemptions of the same link (the #156
 * TOCTOU trap, peer-invitation edition). Returns undefined when the invite is
 * unknown, already consumed, revoked, or expired; the caller must not admit
 * anyone in that case.
 */
export function consumeUserInvite(
  db: Database,
  token: string,
  consumedById: string,
): UserInviteRow | undefined {
  return db
    .prepare(
      `UPDATE user_invitations
          SET consumed_at = ${SQL_NOW_ISO}, consumed_by_id = ?
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${SQL_NOW_ISO}
      RETURNING *`,
    )
    .get(consumedById, hashInviteToken(token)) as UserInviteRow | undefined;
}

/**
 * Revoke an outstanding invite. Consumed invites are left alone — revoking one
 * would misreport history (the account already exists; delete the user instead).
 */
export function revokeUserInvite(db: Database, id: string): boolean {
  const res = db
    .prepare(
      `UPDATE user_invitations
          SET revoked_at = ${SQL_NOW_ISO}
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(id);
  return res.changes > 0;
}
