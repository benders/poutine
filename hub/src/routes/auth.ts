import type { FastifyPluginAsync } from "fastify";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { createAccessToken, createRefreshToken, verifyToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/auth/register
  app.post<{
    Body: { username: string; password: string };
  }>("/register", async (request, reply) => {
    const { username, password } = request.body;

    if (!username || !password) {
      return reply.code(400).send({ error: "Username and password are required" });
    }

    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }

    // Check if username already exists
    const existing = app.db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username);

    if (existing) {
      return reply.code(409).send({ error: "Username already taken" });
    }

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();

    // First user becomes admin
    const userCount = app.db
      .prepare("SELECT COUNT(*) as count FROM users")
      .get() as { count: number };
    const isAdmin = userCount.count === 0 ? 1 : 0;

    app.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)"
      )
      .run(id, username, passwordHash, isAdmin);

    const accessToken = await createAccessToken(id, app.config);
    const refreshToken = await createRefreshToken(id, app.config);

    return reply.code(201).send({
      user: { id, username, isAdmin: isAdmin === 1 },
      accessToken,
      refreshToken,
    });
  });

  // POST /api/auth/login
  app.post<{
    Body: { username: string; password: string };
  }>("/login", async (request, reply) => {
    const { username, password } = request.body;

    if (!username || !password) {
      return reply.code(400).send({ error: "Username and password are required" });
    }

    const user = app.db
      .prepare("SELECT id, username, password_hash, is_admin FROM users WHERE username = ?")
      .get(username) as
      | { id: string; username: string; password_hash: string; is_admin: number }
      | undefined;

    if (!user) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const accessToken = await createAccessToken(user.id, app.config);
    const refreshToken = await createRefreshToken(user.id, app.config);

    return reply.send({
      user: { id: user.id, username: user.username, isAdmin: user.is_admin === 1 },
      accessToken,
      refreshToken,
    });
  });

  // POST /api/auth/refresh
  app.post<{
    Body: { refreshToken: string };
  }>("/refresh", async (request, reply) => {
    const { refreshToken } = request.body;

    if (!refreshToken) {
      return reply.code(400).send({ error: "Refresh token is required" });
    }

    try {
      const { userId } = await verifyToken(refreshToken, app.config);
      const accessToken = await createAccessToken(userId, app.config);
      return reply.send({ accessToken });
    } catch {
      return reply.code(401).send({ error: "Invalid or expired refresh token" });
    }
  });

  // GET /api/auth/me
  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = app.db
      .prepare("SELECT id, username, is_admin, created_at FROM users WHERE id = ?")
      .get(request.userId) as {
      id: string;
      username: string;
      is_admin: number;
      created_at: string;
    };

    return {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin === 1,
      createdAt: user.created_at,
    };
  });
};
