import { describe, it, expect } from "vitest";
import {
  parseSsdpResponse,
  parseDeviceDescription,
} from "../src/services/sonos-discovery.js";

describe("parseSsdpResponse", () => {
  it("parses a Sonos M-SEARCH response", () => {
    const buf = Buffer.from(
      [
        "HTTP/1.1 200 OK",
        "CACHE-CONTROL: max-age = 1800",
        "EXT:",
        "LOCATION: http://192.168.1.42:1400/xml/device_description.xml",
        "SERVER: Linux UPnP/1.0 Sonos/74.1-12345 (ZPS19)",
        "ST: urn:schemas-upnp-org:device:ZonePlayer:1",
        "USN: uuid:RINCON_5CAAFD12345601400::urn:schemas-upnp-org:device:ZonePlayer:1",
        "",
        "",
      ].join("\r\n"),
    );
    const parsed = parseSsdpResponse(buf);
    expect(parsed).not.toBeNull();
    expect(parsed?.location).toBe(
      "http://192.168.1.42:1400/xml/device_description.xml",
    );
    expect(parsed?.usn).toMatch(/RINCON_/);
  });

  it("rejects non-200 responses", () => {
    const buf = Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(parseSsdpResponse(buf)).toBeNull();
  });

  it("rejects responses from non-Sonos servers", () => {
    const buf = Buffer.from(
      [
        "HTTP/1.1 200 OK",
        "LOCATION: http://192.168.1.99:8080/desc.xml",
        "SERVER: Linux UPnP/1.0 RokuMediaPlayer/1.0",
        "USN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1",
        "",
        "",
      ].join("\r\n"),
    );
    expect(parseSsdpResponse(buf)).toBeNull();
  });
});

describe("parseDeviceDescription", () => {
  it("extracts id, room, model from a Sonos description xml", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <UDN>uuid:RINCON_5CAAFD12345601400</UDN>
    <roomName>Living Room</roomName>
    <modelName>Sonos One</modelName>
  </device>
</root>`;
    const parsed = parseDeviceDescription(xml);
    expect(parsed).toEqual({
      id: "RINCON_5CAAFD12345601400",
      room: "Living Room",
      model: "Sonos One",
    });
  });

  it("returns null when required tags are missing", () => {
    const xml = "<root><device><UDN>uuid:abc</UDN></device></root>";
    expect(parseDeviceDescription(xml)).toBeNull();
  });
});
