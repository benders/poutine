// Test helper: seed an admin user and mint a JWT for /admin/* requests.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { setPassword } from "../../src/auth/passwords.js";
import { createAccessToken } from "../../src/auth/jwt.js";

export async function seedAdminUser(
  app: FastifyInstance,
  username = "admin-test",
): Promise<{ userId: string; token: string }> {
  const userId = randomUUID();
  const enc = setPassword("password-irrelevant", app.passwordKey);
  app.db
    .prepare(
      "INSERT OR IGNORE INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run(userId, username, enc);
  const token = await createAccessToken(userId, app.config);
  return { userId, token };
}
