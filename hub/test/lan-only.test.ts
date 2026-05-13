import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { detectProxyHeader, requireLan } from "../src/auth/lan-only.js";

describe("detectProxyHeader", () => {
  it("returns null when no proxy header is present", () => {
    expect(
      detectProxyHeader({ host: "lan:3000", "user-agent": "WMP/12" }),
    ).toBeNull();
  });

  it.each([
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
    "cf-ray",
  ])("detects %s", (h) => {
    expect(detectProxyHeader({ [h]: "anything" })).toBe(h);
  });

  it("ignores cookie / host / user-agent headers", () => {
    expect(
      detectProxyHeader({
        host: "x",
        cookie: "y",
        "user-agent": "z",
        accept: "*/*",
      }),
    ).toBeNull();
  });
});

describe("requireLan as a Fastify preHandler", () => {
  function buildApp() {
    const app = Fastify({ logger: false });
    app.addHook("preHandler", requireLan);
    app.get("/protected", async () => ({ ok: true }));
    return app;
  }

  it("allows a request with no proxy headers", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects a request carrying x-forwarded-for", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "LAN-only endpoint" });
  });

  it("rejects a request carrying cf-connecting-ip (Cloudflare Tunnel)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "cf-connecting-ip": "198.51.100.4" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when forwarded (RFC 7239) is present", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { forwarded: 'for=192.0.2.1;proto=https' },
    });
    expect(res.statusCode).toBe(403);
  });
});
