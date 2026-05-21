/**
 * Integration test for the DLNA HTTP surface. Boots the hub on a random
 * port with `DLNA_ENABLED=true` and drives it from a real UPnP control
 * point (the `node-upnp` library) over loopback.
 *
 * Not run in regular `pnpm test` — exercises a live HTTP server. Run via
 * `pnpm test:integration`.
 *
 * Why node-upnp: it speaks the device-description + SOAP control flow a
 * real UPnP client uses, so the assertions are about the contract our
 * SOAP handlers expose, not about XML byte equality. Raw `fetch` is fine
 * for the stream endpoint where we only care about response headers.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UPnPClient = require("node-upnp");

interface UPnPClientInstance {
  getDeviceDescription(): Promise<{
    deviceType: string;
    friendlyName: string;
    UDN: string;
    services: Record<string, { SCPDURL: string; controlURL: string; eventSubURL: string }>;
  }>;
  call(
    serviceId: string,
    action: string,
    args: Record<string, string | number>,
  ): Promise<Record<string, unknown>>;
}

describe("DLNA HTTP surface (integration)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let client: UPnPClientInstance;
  const tmp = mkdtempSync(join(tmpdir(), "poutine-dlna-"));

  beforeAll(async () => {
    app = await buildApp({
      databasePath: ":memory:",
      jwtSecret: "x",
      poutinePrivateKeyPath: join(tmp, "ed.pem"),
      poutinePasswordKeyPath: join(tmp, "pwkey"),
      poutineInstanceId: "dlna-int-test",
      poutineOwnerUsername: "alice",
      poutineOwnerPassword: "hunter2",
      dlnaEnabled: true,
      dlnaFriendlyName: "Poutine Integration Test",
      // Browse needs lan_url to build res@uri, but we don't want SSDP
      // binding UDP 1900 (fights dlna-ssdp.integration.test.ts). The
      // dlnaSkipSsdp flag (#209) decouples the two — DLNA HTTP routes run,
      // SSDP does not, even on runtime lan_url change.
      dlnaSkipSsdp: true,
      initialLanUrl: undefined,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // ContentDirectory:Browse builds res@uri from the runtime `lan_url`
    // setting (#209) at request time — set it now to the real listening URL.
    app.sonosSettings.setLanUrl(baseUrl);

    client = new UPnPClient({ url: `${baseUrl}/dlna/device.xml` });
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("device description", () => {
    it("advertises a MediaServer:1 device with our friendly name and UDN", async () => {
      const desc = await client.getDeviceDescription();
      expect(desc.deviceType).toBe("urn:schemas-upnp-org:device:MediaServer:1");
      expect(desc.friendlyName).toBe("Poutine Integration Test");
      expect(desc.UDN).toMatch(/^uuid:[0-9a-f-]{36}$/);
      // Both required services present.
      expect(
        Object.keys(desc.services).some((k) => k.includes("ContentDirectory")),
      ).toBe(true);
      expect(
        Object.keys(desc.services).some((k) => k.includes("ConnectionManager")),
      ).toBe(true);
    });
  });

  describe("ContentDirectory SOAP (via node-upnp)", () => {
    it("Browse(ObjectID=0, BrowseDirectChildren) returns the Music container", async () => {
      const out = await client.call("ContentDirectory", "Browse", {
        ObjectID: "0",
        BrowseFlag: "BrowseDirectChildren",
        Filter: "*",
        StartingIndex: 0,
        RequestedCount: 0,
        SortCriteria: "",
      });
      // fast-xml-parser inside node-upnp coerces numeric-looking values.
      expect(Number(out.NumberReturned)).toBe(1);
      expect(Number(out.TotalMatches)).toBe(1);
      // The DIDL-Lite Result is XML-escaped because it travels as a string
      // inside the SOAP body. Decode entities before asserting shape.
      const result = String(out.Result)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
      expect(result).toContain('id="0/music"');
      expect(result).toContain("<dc:title>Music</dc:title>");
    });
  });

  // node-upnp's parseSOAPResponse builds its output map from each action's
  // SCPD argumentList via `Array.from(argumentList.argument)` — but
  // fast-xml-parser returns a plain object (not an array) for a single
  // `<argument>` child, so single-output actions come back as `{}`. We
  // assert against the raw SOAP body instead, via fetch.
  describe("ContentDirectory SOAP (raw, single-output actions)", () => {
    async function soapCall(action: string): Promise<string> {
      const res = await fetch(`${baseUrl}/dlna/control/content-directory`, {
        method: "POST",
        headers: {
          "content-type": 'text/xml; charset="utf-8"',
          soapaction: `"urn:schemas-upnp-org:service:ContentDirectory:1#${action}"`,
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"/></s:Body>
</s:Envelope>`,
      });
      expect(res.status).toBe(200);
      return await res.text();
    }

    it("GetSortCapabilities returns an empty SortCaps element", async () => {
      const body = await soapCall("GetSortCapabilities");
      expect(body).toContain("<u:GetSortCapabilitiesResponse");
      expect(body).toMatch(/<SortCaps><\/SortCaps>|<SortCaps\/>/);
    });

    it("GetSearchCapabilities returns an empty SearchCaps element", async () => {
      const body = await soapCall("GetSearchCapabilities");
      expect(body).toContain("<u:GetSearchCapabilitiesResponse");
      expect(body).toMatch(/<SearchCaps><\/SearchCaps>|<SearchCaps\/>/);
    });

    it("GetSystemUpdateID returns a numeric Id", async () => {
      const body = await soapCall("GetSystemUpdateID");
      expect(body).toMatch(/<Id>\d+<\/Id>/);
    });
  });

  describe("ConnectionManager SOAP", () => {
    it("GetProtocolInfo advertises http-get audio profiles for Source", async () => {
      const out = await client.call(
        "ConnectionManager",
        "GetProtocolInfo",
        {},
      );
      expect(String(out.Source)).toContain("http-get:*:audio/mpeg:*");
      expect(String(out.Source)).toContain("http-get:*:audio/flac:*");
      expect(out.Sink).toBe("");
    });
  });

  describe("Stream endpoint headers", () => {
    it("unknown track id returns 404", async () => {
      const res = await fetch(`${baseUrl}/dlna/stream/no-such-track`);
      expect(res.status).toBe(404);
    });
  });

  describe("LAN gate", () => {
    it("rejects /dlna/device.xml when x-forwarded-for is set", async () => {
      const res = await fetch(`${baseUrl}/dlna/device.xml`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects ContentDirectory SOAP when cf-connecting-ip is set", async () => {
      const res = await fetch(`${baseUrl}/dlna/control/content-directory`, {
        method: "POST",
        headers: {
          "content-type": "text/xml",
          soapaction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"',
          "cf-connecting-ip": "198.51.100.4",
        },
        body: "<?xml version=\"1.0\"?><s:Envelope/>",
      });
      expect(res.status).toBe(403);
    });
  });
});
