/**
 * Integration tests for /rest/getCoverArt's external-URL passthrough
 * (the fanart.tv path) — SSRF allowlist + content-type guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import sharp from "sharp";
import { buildApp } from "../src/server.js";
import { setPassword } from "../src/auth/passwords.js";
import { encodeCoverArtId } from "../src/library/cover-art.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";

const testConfig: Partial<Config> = {
  databasePath: ":memory:",
  jwtSecret: "test-secret-key-for-testing-purposes",
};

function seedUser(app: FastifyInstance) {
  const enc = setPassword("secret", app.passwordKey);
  app.db
    .prepare(
      "INSERT INTO users (id, username, password_enc, is_admin) VALUES (?, ?, ?, 1)",
    )
    .run("user-1", "tester", enc);
}

function artUrl(encodedId: string): string {
  return `/rest/getCoverArt?u=tester&p=secret&f=json&id=${encodeURIComponent(encodedId)}`;
}

describe("/rest/getCoverArt external URL passthrough", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    app = await buildApp(testConfig);
    await app.ready();
    seedUser(app);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("fetches an allowed fanart.tv URL and serves it as image bytes", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    fetchMock.mockResolvedValueOnce(
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/abc.png",
    );
    const res = await app.inject({ method: "GET", url: artUrl(id) });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://assets.fanart.tv/fanart/music/abc.png",
    );
  });

  it("accepts a raw external URL as id (3rd-party Subsonic client form)", async () => {
    // Supersonic / Vibrdrome echo back the coverArt value verbatim — for
    // artist images that's a fanart.tv URL with no `local:` prefix.
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    fetchMock.mockResolvedValueOnce(
      new Response(png, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const url = `/rest/getCoverArt?u=tester&p=secret&f=json&id=${encodeURIComponent(
      "https://assets.fanart.tv/fanart/stereolab.jpg",
    )}`;
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://assets.fanart.tv/fanart/stereolab.jpg",
    );
  });

  it("rejects a raw non-allowlisted URL id with 400", async () => {
    const url = `/rest/getCoverArt?u=tester&p=secret&f=json&id=${encodeURIComponent(
      "https://evil.example.com/x.jpg",
    )}`;
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted hostname with 400 and never fetches", async () => {
    const id = encodeCoverArtId("local", "https://evil.example.com/x.jpg");
    const res = await app.inject({ method: "GET", url: artUrl(id) });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://localhost/x.jpg",
    "https://127.0.0.1/x.jpg",
    "https://169.254.169.254/latest/meta-data/", // cloud metadata SSRF target
    "https://navidrome:4533/x.jpg", // internal compose service
    "https://10.0.0.5/x.jpg",
  ])("refuses to proxy internal/LAN target %s (400, no fetch)", async (target) => {
    // Raw-URL form (3rd-party client echoing back a coverArt value)…
    const raw = `/rest/getCoverArt?u=tester&p=secret&f=json&id=${encodeURIComponent(target)}`;
    const rawRes = await app.inject({ method: "GET", url: raw });
    expect(rawRes.statusCode).toBe(400);

    // …and the encoded `local:` form a malicious peer could federate.
    const encRes = await app.inject({
      method: "GET",
      url: artUrl(encodeCoverArtId("local", target)),
    });
    expect(encRes.statusCode).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects http:// (https only) with 400 and never fetches", async () => {
    const id = encodeCoverArtId("local", "http://assets.fanart.tv/x.jpg");
    const res = await app.inject({ method: "GET", url: artUrl(id) });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an HTML response from an allowed host as 404 (not cached)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/abc.png",
    );
    const res = await app.inject({ method: "GET", url: artUrl(id) });
    expect(res.statusCode).toBe(404);
  });

  it("returns 502 when the external fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("DNS"));
    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/abc.png",
    );
    const res = await app.inject({ method: "GET", url: artUrl(id) });
    expect(res.statusCode).toBe(502);
  });

  it("downsamples external art to the requested size", async () => {
    const original = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    fetchMock.mockResolvedValueOnce(
      new Response(original, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/resize-test.jpg",
    );
    const res = await app.inject({ method: "GET", url: `${artUrl(id)}&size=300` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBeLessThanOrEqual(300);
    expect(meta.height).toBeLessThanOrEqual(300);
  });

  it("dedupes unsized and size=1024 requests to the same cache key", async () => {
    const original = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    fetchMock.mockResolvedValueOnce(
      new Response(original, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/dedupe-test.jpg",
    );

    const first = await app.inject({ method: "GET", url: artUrl(id) });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");

    const second = await app.inject({ method: "GET", url: `${artUrl(id)}&size=1024` });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clamps size=4096 to the 1024 max", async () => {
    const original = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 5, g: 5, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    fetchMock.mockResolvedValueOnce(
      new Response(original, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/clamp-test.jpg",
    );
    const res = await app.inject({ method: "GET", url: `${artUrl(id)}&size=4096` });

    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(1024);
  });

  it("falls back to original bytes when upstream image data is unparseable", async () => {
    const garbage = Buffer.from("not actually a jpeg");
    fetchMock.mockResolvedValueOnce(
      new Response(garbage, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/garbage-test.jpg",
    );
    const res = await app.inject({ method: "GET", url: `${artUrl(id)}&size=300` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.from(res.rawPayload).equals(garbage)).toBe(true);
  });

  it("passes GIF bodies through without resizing", async () => {
    // Minimal valid 1x1 GIF (not resized regardless of dimensions since
    // image/gif is skipped outright).
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7",
      "base64",
    );
    fetchMock.mockResolvedValueOnce(
      new Response(gif, { status: 200, headers: { "content-type": "image/gif" } }),
    );

    const id = encodeCoverArtId(
      "local",
      "https://assets.fanart.tv/fanart/music/anim-test.gif",
    );
    const res = await app.inject({ method: "GET", url: `${artUrl(id)}&size=48` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/gif");
    expect(Buffer.from(res.rawPayload).equals(gif)).toBe(true);
  });
});
