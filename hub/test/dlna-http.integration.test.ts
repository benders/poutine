/**
 * Integration test for the DLNA HTTP surface. Boots the hub on a random
 * port with `DLNA_ENABLED=true` and drives it over loopback from a minimal
 * UPnP control point (`ControlPoint` below).
 *
 * Not run in regular `pnpm test` — exercises a live HTTP server. Run via
 * `pnpm test:integration`.
 *
 * Why a control point rather than raw fetches: it follows the
 * device-description + SOAP control flow a real UPnP client uses (control
 * URLs are discovered from device.xml, never hardcoded), so the assertions
 * are about the contract our SOAP handlers expose, not about XML byte
 * equality. It is in-file because the `node-upnp` library it replaced is
 * unmaintained and pulled in dependencies with unpatched advisories (#313).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { XMLParser } from "fast-xml-parser";
import { buildApp } from "../src/server.js";

interface ServiceDescription {
  serviceType: string;
  SCPDURL: string;
  controlURL: string;
  eventSubURL: string;
}

interface DeviceDescription {
  deviceType: string;
  friendlyName: string;
  UDN: string;
  services: Record<string, ServiceDescription>;
}

/** Minimal UPnP control point: device description → control URL → SOAP action. */
class ControlPoint {
  private readonly xml = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name) => name === "service",
  });
  private description: DeviceDescription | undefined;

  constructor(private readonly descriptionUrl: string) {}

  async getDeviceDescription(): Promise<DeviceDescription> {
    if (this.description) return this.description;
    const res = await fetch(this.descriptionUrl);
    if (!res.ok) throw new Error(`device description: HTTP ${res.status}`);
    const device = this.xml.parse(await res.text()).root.device;
    const services: Record<string, ServiceDescription> = {};
    for (const svc of device.serviceList.service) services[svc.serviceId] = svc;
    this.description = {
      deviceType: device.deviceType,
      friendlyName: device.friendlyName,
      UDN: device.UDN,
      services,
    };
    return this.description;
  }

  /** Invoke `action` on the service whose id contains `serviceName`; returns its out-arguments. */
  async call(
    serviceName: string,
    action: string,
    args: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    const { services } = await this.getDeviceDescription();
    const id = Object.keys(services).find((k) => k.includes(serviceName));
    if (!id) throw new Error(`no such service: ${serviceName}`);
    const svc = services[id];
    const argXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join("");
    const res = await fetch(new URL(svc.controlURL, this.descriptionUrl), {
      method: "POST",
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${svc.serviceType}#${action}"`,
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${svc.serviceType}">${argXml}</u:${action}></s:Body>
</s:Envelope>`,
    });
    if (!res.ok) throw new Error(`${action}: HTTP ${res.status}`);
    const out = this.xml.parse(await res.text()).Envelope.Body[`${action}Response`];
    return typeof out === "object" && out !== null ? out : {};
  }
}

describe("DLNA HTTP surface (integration)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let client: ControlPoint;
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

    client = new ControlPoint(`${baseUrl}/dlna/device.xml`);
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

  describe("ContentDirectory SOAP (via control point)", () => {
    it("Browse(ObjectID=0, BrowseDirectChildren) returns the Music container", async () => {
      const out = await client.call("ContentDirectory", "Browse", {
        ObjectID: "0",
        BrowseFlag: "BrowseDirectChildren",
        Filter: "*",
        StartingIndex: 0,
        RequestedCount: 0,
        SortCriteria: "",
      });
      expect(Number(out.NumberReturned)).toBe(1);
      expect(Number(out.TotalMatches)).toBe(1);
      // The DIDL-Lite Result travels XML-escaped inside the SOAP body; the
      // control point's parser has already decoded the entities.
      const result = String(out.Result);
      expect(result).toContain('id="0/music"');
      expect(result).toContain("<dc:title>Music</dc:title>");
    });

    // #280: stream cast tokens are signed for the owner — the identity
    // Browse runs as — never a separately configured (and deletable) user.
    it("Browse signs stream URLs for the owner", async () => {
      const spy = vi.spyOn(app.dlnaObjects, "browse");
      try {
        await client.call("ContentDirectory", "Browse", {
          ObjectID: "0",
          BrowseFlag: "BrowseDirectChildren",
          Filter: "*",
          StartingIndex: 0,
          RequestedCount: 0,
          SortCriteria: "",
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][2].username).toBe("alice");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Asserted against the raw SOAP body: empty-element shape matters here.
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

  describe("Stream endpoint (#218 — handed off to /rest/stream.view)", () => {
    it("/dlna/stream/:trackId is no longer mounted (404)", async () => {
      // Confirms the relay path was deleted. DLNA Browse responses now
      // emit `/rest/stream.view?...&dlna=1` URIs with embedded cast tokens.
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
