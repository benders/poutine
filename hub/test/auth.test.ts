import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { createAccessToken, createRefreshToken, verifyToken } from "../src/auth/jwt.js";
import { encrypt, decrypt } from "../src/auth/encryption.js";
import { buildApp } from "../src/server.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
  jwtAccessExpiresIn: "15m",
  jwtRefreshExpiresIn: "7d",
  encryptionKey: "test-encryption-key",
};

describe("Password hashing", () => {
  it("should hash a password", async () => {
    const hash = await hashPassword("mysecretpassword");
    expect(hash).toBeTruthy();
    expect(hash).not.toBe("mysecretpassword");
    expect(hash.startsWith("$argon2")).toBe(true);
  });

  it("should verify a correct password", async () => {
    const hash = await hashPassword("mysecretpassword");
    const valid = await verifyPassword(hash, "mysecretpassword");
    expect(valid).toBe(true);
  });

  it("should reject an incorrect password", async () => {
    const hash = await hashPassword("mysecretpassword");
    const valid = await verifyPassword(hash, "wrongpassword");
    expect(valid).toBe(false);
  });

  it("should produce different hashes for the same password", async () => {
    const hash1 = await hashPassword("mysecretpassword");
    const hash2 = await hashPassword("mysecretpassword");
    expect(hash1).not.toBe(hash2);
  });
});

describe("JWT tokens", () => {
  const config = {
    ...testConfig,
    jwtSecret: "test-secret-key-for-testing-purposes",
    jwtAccessExpiresIn: "15m",
    jwtRefreshExpiresIn: "7d",
  } as Config;

  it("should create and verify an access token", async () => {
    const userId = "user-123";
    const token = await createAccessToken(userId, config);
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");

    const decoded = await verifyToken(token, config);
    expect(decoded.userId).toBe(userId);
  });

  it("should create and verify a refresh token", async () => {
    const userId = "user-456";
    const token = await createRefreshToken(userId, config);
    expect(token).toBeTruthy();

    const decoded = await verifyToken(token, config);
    expect(decoded.userId).toBe(userId);
  });

  it("should reject a token with wrong secret", async () => {
    const userId = "user-789";
    const token = await createAccessToken(userId, config);

    const wrongConfig = { ...config, jwtSecret: "wrong-secret" };
    await expect(verifyToken(token, wrongConfig)).rejects.toThrow();
  });

  it("should reject a tampered token", async () => {
    const userId = "user-abc";
    const token = await createAccessToken(userId, config);
    const tampered = token.slice(0, -5) + "XXXXX";
    await expect(verifyToken(tampered, config)).rejects.toThrow();
  });
});

describe("Credential encryption", () => {
  it("should encrypt and decrypt a string", () => {
    const plaintext = '{"username":"admin","password":"secret123"}';
    const key = "my-encryption-key";
    const encrypted = encrypt(plaintext, key);

    expect(encrypted).not.toBe(plaintext);
    expect(typeof encrypted).toBe("string");

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertexts for same plaintext", () => {
    const plaintext = "same input";
    const key = "my-key";
    const e1 = encrypt(plaintext, key);
    const e2 = encrypt(plaintext, key);
    expect(e1).not.toBe(e2);
  });

  it("should fail to decrypt with wrong key", () => {
    const encrypted = encrypt("secret data", "correct-key");
    expect(() => decrypt(encrypted, "wrong-key")).toThrow();
  });
});

describe("Auth routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("should register a new user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "testuser", password: "password123" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe("testuser");
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it("should make the first user an admin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "firstuser", password: "password123" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.isAdmin).toBe(true);
  });

  it("should not make the second user an admin", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "firstuser", password: "password123" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "seconduser", password: "password123" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.isAdmin).toBe(false);
  });

  it("should reject duplicate username", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "testuser", password: "password123" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "testuser", password: "password456" },
    });

    expect(response.statusCode).toBe(409);
  });

  it("should login with valid credentials", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "loginuser", password: "password123" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "loginuser", password: "password123" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.username).toBe("loginuser");
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it("should reject login with wrong password", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "loginuser", password: "password123" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "loginuser", password: "wrongpassword" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should reject login with nonexistent user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "password123" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("should refresh an access token", async () => {
    const regResponse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "refreshuser", password: "password123" },
    });

    const { refreshToken } = regResponse.json();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accessToken).toBeTruthy();
  });

  it("should get current user via /me", async () => {
    const regResponse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "meuser", password: "password123" },
    });

    const { accessToken } = regResponse.json();

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.username).toBe("meuser");
    expect(body.isAdmin).toBe(true);
  });

  it("should reject /me without auth", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });

    expect(response.statusCode).toBe(401);
  });
});
