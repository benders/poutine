import { describe, it, expect } from "vitest";
import {
  buildNotifyAlive,
  buildNotifyByebye,
  buildMSearchResponse,
  parseMSearch,
  matchTargets,
} from "../src/services/ssdp-advertiser.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("buildNotifyAlive", () => {
  it("sets the required SSDP NOTIFY headers", () => {
    const pkt = buildNotifyAlive({
      nt: "upnp:rootdevice",
      usn: `uuid:${UUID}::upnp:rootdevice`,
      location: "http://lan:3000/dlna/device.xml",
      server: "UPnP/1.0 Poutine/0.6",
      maxAgeSec: 1800,
    }).toString("utf8");
    expect(pkt).toMatch(/^NOTIFY \* HTTP\/1\.1\r\n/);
    expect(pkt).toContain("HOST: 239.255.255.250:1900");
    expect(pkt).toContain("CACHE-CONTROL: max-age=1800");
    expect(pkt).toContain("NTS: ssdp:alive");
    expect(pkt).toContain("NT: upnp:rootdevice");
    expect(pkt).toContain("LOCATION: http://lan:3000/dlna/device.xml");
    expect(pkt).toContain(`USN: uuid:${UUID}::upnp:rootdevice`);
    expect(pkt).toMatch(/\r\n\r\n$/);
  });
});

describe("buildNotifyByebye", () => {
  it("omits LOCATION/CACHE-CONTROL and uses NTS: ssdp:byebye", () => {
    const pkt = buildNotifyByebye({
      nt: "upnp:rootdevice",
      usn: `uuid:${UUID}::upnp:rootdevice`,
    }).toString("utf8");
    expect(pkt).toContain("NTS: ssdp:byebye");
    expect(pkt).not.toContain("LOCATION:");
    expect(pkt).not.toContain("CACHE-CONTROL:");
  });
});

describe("buildMSearchResponse", () => {
  it("starts with HTTP/1.1 200 OK and includes ST/USN/LOCATION", () => {
    const pkt = buildMSearchResponse({
      st: "urn:schemas-upnp-org:device:MediaServer:1",
      usn: `uuid:${UUID}::urn:schemas-upnp-org:device:MediaServer:1`,
      location: "http://lan:3000/dlna/device.xml",
      server: "UPnP/1.0 Poutine/0.6",
      maxAgeSec: 1800,
    }).toString("utf8");
    expect(pkt).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(pkt).toContain("ST: urn:schemas-upnp-org:device:MediaServer:1");
    expect(pkt).toContain(
      `USN: uuid:${UUID}::urn:schemas-upnp-org:device:MediaServer:1`,
    );
    expect(pkt).toContain("LOCATION: http://lan:3000/dlna/device.xml");
    expect(pkt).toContain("EXT:");
  });
});

describe("parseMSearch", () => {
  it("parses a well-formed M-SEARCH packet", () => {
    const buf = Buffer.from(
      [
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        'MAN: "ssdp:discover"',
        "MX: 3",
        "ST: urn:schemas-upnp-org:device:MediaServer:1",
        "",
        "",
      ].join("\r\n"),
    );
    expect(parseMSearch(buf)).toEqual({
      st: "urn:schemas-upnp-org:device:MediaServer:1",
      mx: 3,
      man: "ssdp:discover",
    });
  });

  it("rejects non-M-SEARCH packets", () => {
    const buf = Buffer.from("NOTIFY * HTTP/1.1\r\nHOST: x\r\n\r\n");
    expect(parseMSearch(buf)).toBeNull();
  });

  it("rejects M-SEARCH missing MAN: ssdp:discover", () => {
    const buf = Buffer.from(
      ["M-SEARCH * HTTP/1.1", "ST: ssdp:all", "", ""].join("\r\n"),
    );
    expect(parseMSearch(buf)).toBeNull();
  });
});

describe("matchTargets", () => {
  it("ssdp:all matches every advertised target", () => {
    const ts = matchTargets("ssdp:all", UUID);
    expect(ts.length).toBe(5);
    expect(ts.map((t) => t.st)).toContain(
      "urn:schemas-upnp-org:device:MediaServer:1",
    );
  });

  it("specific ST matches a single target", () => {
    const ts = matchTargets(
      "urn:schemas-upnp-org:service:ContentDirectory:1",
      UUID,
    );
    expect(ts.length).toBe(1);
    expect(ts[0].usn).toBe(
      `uuid:${UUID}::urn:schemas-upnp-org:service:ContentDirectory:1`,
    );
  });

  it("unrelated ST matches nothing", () => {
    expect(matchTargets("urn:not-us", UUID)).toEqual([]);
  });
});
