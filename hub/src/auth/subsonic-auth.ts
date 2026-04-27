import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword, getStoredPassword } from "./passwords.js";
import { sendSubsonicError, sendBinaryError } from "../routes/subsonic-response.js";

declare module "fastify" {
  interface FastifyRequest {
    subsonicUser: { id: string; username: string; isAdmin: boolean };
  }
}

interface SubsonicCreds {
  hasAny: boolean;
  username?: string;
  password?: string;   // decoded plaintext (u+p path)
  token?: string;      // md5 hex (u+t+s path)
  salt?: string;
}

function readSubsonicCreds(query: Record<string, string>): SubsonicCreds {
  const username = query.u;
  if (!username) return { hasAny: false };

  if (query.t && query.s) {
    return {
      hasAny: true,
      username,
      token: query.t.toLowerCase(),
      salt: query.s,
    };
  }

  if (query.p) {
    let password = query.p;
    if (password.startsWith("enc:")) {
      password = Buffer.from(password.slice(4), "hex").toString("utf8");
    }
    return { hasAny: true, username, password };
  }

  return { hasAny: false, username };
}

function verifySubsonicCreds(
  creds: SubsonicCreds,
  passwordEnc: string,
  passwordKey: Buffer,
): boolean {
  if (creds.password !== undefined) {
    return verifyPassword(passwordEnc, creds.password, passwordKey);
  }
  if (creds.token && creds.salt) {
    const stored = getStoredPassword(passwordEnc, passwordKey);
    if (stored === null) return false;
    const expected = crypto
      .createHash("md5")
      .update(stored + creds.salt)
      .digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(creds.token, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

function lookupAndVerify(
  request: FastifyRequest,
  creds: SubsonicCreds,
):
  | { id: string; username: string; isAdmin: boolean }
  | null {
  const app = request.server;
  const user = app.db
    .prepare(
      "SELECT id, username, password_enc, is_admin FROM users WHERE username = ?",
    )
    .get(creds.username!) as
    | { id: string; username: string; password_enc: string; is_admin: number }
    | undefined;

  if (!user || !verifySubsonicCreds(creds, user?.password_enc ?? "", app.passwordKey)) {
    return null;
  }
  return { id: user.id, username: user.username, isAdmin: user.is_admin === 1 };
}

export async function requireSubsonicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as Record<string, string>;
  const creds = readSubsonicCreds(query);

  if (!creds.hasAny) {
    sendSubsonicError(reply, 10, "Required parameter missing", query);
    return;
  }

  const auth = lookupAndVerify(request, creds);
  if (!auth) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }
  request.subsonicUser = auth;
}

/**
 * Same as requireSubsonicAuth but uses HTTP error status codes instead of
 * Subsonic envelopes. Use this for binary endpoints (getCoverArt, stream)
 * where a 200+JSON body would be interpreted as corrupt image/audio data.
 */
export async function requireSubsonicAuthBinary(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as Record<string, string>;
  const creds = readSubsonicCreds(query);

  if (!creds.hasAny) {
    sendBinaryError(reply, 401, "Authentication required");
    return;
  }

  const auth = lookupAndVerify(request, creds);
  if (!auth) {
    sendBinaryError(reply, 401, "Wrong username or password");
    return;
  }
  request.subsonicUser = auth;
}
