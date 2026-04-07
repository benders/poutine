import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyPassword } from "./passwords.js";
import { sendSubsonicError } from "../routes/subsonic-response.js";

declare module "fastify" {
  interface FastifyRequest {
    subsonicUser: { id: string; username: string; isAdmin: boolean };
  }
}

export async function requireSubsonicAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const app = request.server;
  const db = app.db;
  const query = request.query as Record<string, string>;

  const username = query.u;
  let password = query.p;

  // TODO: support t+s token auth once plaintext storage or challenge flow is designed

  if (!username || !password) {
    sendSubsonicError(reply, 10, "Required parameter missing", query);
    return;
  }

  // Decode enc:<HEX> prefix — Subsonic clients sometimes send hex-encoded passwords
  if (password.startsWith("enc:")) {
    const hex = password.slice(4);
    password = Buffer.from(hex, "hex").toString("utf8");
  }

  const user = db
    .prepare(
      "SELECT id, username, password_hash, is_admin FROM users WHERE username = ?",
    )
    .get(username) as
    | { id: string; username: string; password_hash: string; is_admin: number }
    | undefined;

  if (!user) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    sendSubsonicError(reply, 40, "Wrong username or password", query);
    return;
  }

  request.subsonicUser = {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
  };
}
