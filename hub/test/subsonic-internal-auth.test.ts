/**
 * #224: Subsonic trusted-header auth path.
 *
 * `HubSubsonicCaller` invoked with `asUser` sets a per-boot shared secret +
 * username header pair on the injected request; the Subsonic auth middleware
 * resolves the user without password verification when both headers match.
 *
 * Eliminates the POUTINE_OWNER cred dependency on the Sonos cast hot-path —
 * previously a misconfigured owner u+p silently 404'd every cast attempt
 * because `getSong` returned `status:failed` (auth) and the route
 * interpreted that as "track not found".
 */
import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { createHubSubsonicCaller } from "../src/services/hub-subsonic-caller.js";

describe("Subsonic auth — trusted in-process headers (#224)", () => {
  let app: FastifyInstance | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makePaths() {
    const dir = mkdtempSync(join(tmpdir(), "poutine-internal-auth-"));
    tmpDirs.push(dir);
    return {
      keyPath: join(dir, "ed.pem"),
      pwKeyPath: join(dir, "pwkey"),
    };
  }

  async function boot(): Promise<FastifyInstance> {
    const { keyPath, pwKeyPath } = makePaths();
    const a = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "x",
      poutinePrivateKeyPath: keyPath,
      poutinePasswordKeyPath: pwKeyPath,
      // Deliberately *wrong* owner creds — this is the misconfig that
      // motivated #224. The trusted-header path must still work.
      poutineOwnerUsername: "nobody",
      poutineOwnerPassword: "does-not-match-a-real-user",
    });
    await a.ready();
    // Seed a real user that asUser can resolve to. We don't need a
    // verifiable password — the trusted path skips password checks.
    a.db
      .prepare(
        "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, ?)",
      )
      .run("u-real", "real-user", "", 0);
    return a;
  }

  it("accepts a request carrying matching secret + asUser headers", async () => {
    app = await boot();
    const caller = createHubSubsonicCaller(app, { client: "test" });
    // /rest/ping is the lightest auth-gated endpoint.
    const body = await caller.call("/rest/ping", {}, { asUser: "real-user" });
    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("rejects when the internal secret does not match", async () => {
    app = await boot();
    // Bypass HubSubsonicCaller — exercise the middleware directly with a
    // bogus secret to confirm timingSafeEqual catches it.
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?f=json&v=1.16.1&c=test&u=real-user",
      headers: {
        "x-poutine-internal": "wrong-secret",
        "x-poutine-as-user": "real-user",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].status).toBe("failed");
    expect(res.json()["subsonic-response"].error.code).toBe(40);
  });

  it("rejects when asUser does not match a real user", async () => {
    app = await boot();
    const caller = createHubSubsonicCaller(app, { client: "test" });
    // #230: caller throws on Subsonic status=failed (auth error here).
    await expect(
      caller.call("/rest/ping", {}, { asUser: "ghost" }),
    ).rejects.toThrow(/status=failed.*code=40/);
  });

  it("rejects when only one of the two headers is present", async () => {
    app = await boot();
    const res = await app.inject({
      method: "GET",
      url: "/rest/ping?f=json&v=1.16.1&c=test&u=real-user",
      headers: {
        "x-poutine-internal": app.internalAuthSecret,
        // x-poutine-as-user intentionally omitted
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()["subsonic-response"].status).toBe("failed");
  });

  it("falls back to owner u+p when asUser is omitted (DLNA path)", async () => {
    // DLNA browse has no user context — caller without `asUser` must use
    // POUTINE_OWNER creds. `seedOwner` auto-creates the owner row from
    // those creds, so the happy path succeeds. To prove the trusted-header
    // path was NOT silently invoked, also confirm that wiping the owner
    // password breaks the call.
    app = await boot();
    const caller = createHubSubsonicCaller(app, { client: "test" });
    const ok = await caller.call("/rest/ping", {});
    expect(ok["subsonic-response"].status).toBe("ok");

    app.db
      .prepare("UPDATE users SET password_enc = '' WHERE username = ?")
      .run("nobody");
    // #230: caller throws on Subsonic status=failed so the misconfig
    // surfaces loudly instead of silently empty results downstream.
    await expect(caller.call("/rest/ping", {})).rejects.toThrow(
      /status=failed/,
    );
  });

  it("uses a per-boot random secret (not derivable from config)", async () => {
    app = await boot();
    expect(app.internalAuthSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const a = app.internalAuthSecret;
    await app.close();
    app = await boot();
    expect(app.internalAuthSecret).not.toBe(a);
  });

  it("binary endpoints (/rest/stream) also honor trusted-header auth", async () => {
    // /rest/stream uses requireSubsonicAuthBinary — different code path,
    // same trusted-header check. We don't have a real track to stream;
    // just confirm auth passes (404 from the route's own missing-track
    // check is fine — what we're guarding against is 401).
    app = await boot();
    const res = await app.inject({
      method: "GET",
      url: "/rest/stream?id=tnonexistent&f=json&v=1.16.1&c=test&u=real-user",
      headers: {
        "x-poutine-internal": app.internalAuthSecret,
        "x-poutine-as-user": "real-user",
      },
    });
    expect(res.statusCode).not.toBe(401);
  });
});
