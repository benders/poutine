import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
    isAdmin: boolean;
  }
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const app = request.server;
  const config = app.config;
  const db = app.db;

  let token: string | undefined;

  // Try Authorization header first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fall back to cookie
  if (!token && request.cookies?.access_token) {
    token = request.cookies.access_token;
  }

  // Fall back to query param (for <audio>/<img> elements that can't set headers)
  if (!token) {
    const query = request.query as Record<string, string>;
    if (query?.token) {
      token = query.token;
    }
  }

  if (!token) {
    reply.code(401).send({ error: "Authentication required" });
    return;
  }

  try {
    const { userId } = await verifyToken(token, config);

    // Look up user to get admin status
    const user = db
      .prepare("SELECT id, is_admin FROM users WHERE id = ?")
      .get(userId) as { id: string; is_admin: number } | undefined;

    if (!user) {
      reply.code(401).send({ error: "User not found" });
      return;
    }

    request.userId = user.id;
    request.isAdmin = user.is_admin === 1;
  } catch {
    reply.code(401).send({ error: "Invalid or expired token" });
  }
}

// All users have admin permission — alias to requireAuth
export const requireAdmin = requireAuth;
