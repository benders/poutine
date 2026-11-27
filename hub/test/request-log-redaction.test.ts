/**
 * Request logging must never carry credentials from the query string (#317).
 * Drives a real `buildApp()` with a captured log stream and asserts no log
 * line contains the secret values.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { createHubSubsonicCaller } from "../src/services/hub-subsonic-caller.js";
import { requireLan } from "../src/auth/lan-only.js";
import { redactingLoggerOptions } from "../src/util/redact-url.js";
import type { Config } from "../src/config.js";

const PASSWORD = "Sup3r-Secret-Pw";

function captureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("request log redaction (#317)", () => {
  let app: FastifyInstance;
  let logs: ReturnType<typeof captureStream>;
  const prevLevel = process.env.LOG_LEVEL;

  beforeEach(async () => {
    process.env.LOG_LEVEL = "info";
    logs = captureStream();
    const config: Partial<Config> = {
      databasePath: ":memory:",
      jwtSecret: "test-secret-key-for-testing-purposes",
      poutineOwnerUsername: "owner",
      poutineOwnerPassword: PASSWORD,
    };
    app = await buildApp(config, { logStream: logs.stream });
    await app.ready();
    app.db
      .prepare(
        "INSERT OR IGNORE INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
      )
      .run("user-1", "tester", setPassword(PASSWORD, app.passwordKey));
  });

  afterEach(async () => {
    await app.close();
    if (prevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prevLevel;
  });

  it("/rest/ping?u=..&p=.. logs the request without the password", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/rest/ping?u=tester&p=${PASSWORD}&f=json`,
    });
    expect(res.json()["subsonic-response"].status).toBe("ok");
    const out = logs.text();
    // The request was logged (the test would be vacuous otherwise)…
    expect(out).toContain("/rest/ping?u=tester&p=[REDACTED]&f=json");
    // …and the password never appears.
    expect(out).not.toContain(PASSWORD);
  });

  it("redacts enc:, t+s, castToken and token values", async () => {
    const hex = Buffer.from(PASSWORD, "utf8").toString("hex");
    const urls = [
      `/rest/ping?u=tester&p=enc:${hex}&f=json`,
      "/rest/ping?u=tester&t=tok3n0000ffff&s=salt99&f=json",
      "/rest/stream?id=x&castToken=cast-secret-123",
      "/api/library/artists?token=jwt-secret-abc",
    ];
    for (const url of urls) await app.inject({ method: "GET", url });
    const out = logs.text();
    for (const secret of [hex, "tok3n0000ffff", "salt99", "cast-secret-123", "jwt-secret-abc"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("castToken=[REDACTED]");
    // Fastify's built-in 404 message interpolates the raw URL.
    expect(out).toContain("Route GET:/api/library/artists?token=[REDACTED] not found");
  });

  it("the owner u+p injected by HubSubsonicCaller is not logged", async () => {
    const caller = createHubSubsonicCaller(app, { client: "test" });
    await caller.call("/rest/ping", {}).catch(() => undefined);
    const out = logs.text();
    expect(out).toContain("/rest/ping");
    expect(out).not.toContain(PASSWORD);
  });
});

describe("requireLan rejection log (#317)", () => {
  it("logs the URL with credentials redacted", async () => {
    const logs = captureStream();
    const app = Fastify({
      logger: {
        level: "info",
        stream: logs.stream,
        ...redactingLoggerOptions,
      },
    });
    app.get("/lan", { preHandler: requireLan }, async () => "ok");
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: `/lan?u=owner&p=${PASSWORD}`,
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(res.statusCode).toBe(403);
    const out = logs.text();
    expect(out).toContain("Rejected non-LAN request");
    expect(out).not.toContain(PASSWORD);
    await app.close();
  });
});
