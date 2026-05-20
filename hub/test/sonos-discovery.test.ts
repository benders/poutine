import { describe, it, expect } from "vitest";
import {
  parseSsdpResponse,
  parseDeviceDescription,
  parseZoneGroupState,
  SonosDiscoveryService,
  type SonosDevice,
  type SonosTopologyClient,
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

describe("parseZoneGroupState", () => {
  const xml = `<ZoneGroupState>
    <ZoneGroups>
      <ZoneGroup Coordinator="RINCON_KITCHEN1" ID="RINCON_KITCHEN1:1">
        <ZoneGroupMember UUID="RINCON_KITCHEN1" Location="http://192.168.2.21:1400/xml/device_description.xml" ZoneName="Kitchen">
          <Satellite UUID="RINCON_KITCHEN2" Location="http://192.168.2.170:1400/xml/device_description.xml" ZoneName="Kitchen"/>
        </ZoneGroupMember>
      </ZoneGroup>
      <ZoneGroup Coordinator="uuid:RINCON_OFFICE" ID="RINCON_OFFICE:2">
        <ZoneGroupMember UUID="uuid:RINCON_OFFICE" Location="http://192.168.2.30:1400/xml/device_description.xml" ZoneName="Office"/>
      </ZoneGroup>
    </ZoneGroups>
  </ZoneGroupState>`;

  it("returns one entry per zone group with coordinator + members", () => {
    const groups = parseZoneGroupState(xml);
    expect(groups).toHaveLength(2);
    const kitchen = groups.find((g) => g.coordinator === "RINCON_KITCHEN1");
    expect(kitchen).toBeDefined();
    expect(kitchen?.members.sort()).toEqual(["RINCON_KITCHEN1", "RINCON_KITCHEN2"]);
  });

  it("collects nested <Satellite> UUIDs into the same group", () => {
    const groups = parseZoneGroupState(xml);
    const kitchen = groups.find((g) => g.coordinator === "RINCON_KITCHEN1");
    expect(kitchen?.members).toContain("RINCON_KITCHEN2");
  });

  it("strips uuid: prefixes from coordinator + members", () => {
    const groups = parseZoneGroupState(xml);
    const office = groups.find((g) => g.coordinator === "RINCON_OFFICE");
    expect(office).toBeDefined();
    expect(office?.members).toEqual(["RINCON_OFFICE"]);
  });

  it("returns [] on empty or malformed input", () => {
    expect(parseZoneGroupState("")).toEqual([]);
    expect(parseZoneGroupState("<not-xml")).toEqual([]);
    expect(parseZoneGroupState("<ZoneGroupState></ZoneGroupState>")).toEqual([]);
  });
});

describe("SonosDiscoveryService.collapseZoneGroups", () => {
  const makeDevice = (id: string, room: string, ip: string): SonosDevice => ({
    id,
    room,
    model: "Sonos Era 100",
    ip,
    port: 1400,
    lastSeen: new Date(),
  });

  const topologyXml = `<ZoneGroupState>
    <ZoneGroups>
      <ZoneGroup Coordinator="RINCON_KITCHEN1" ID="g1">
        <ZoneGroupMember UUID="RINCON_KITCHEN1" ZoneName="Kitchen">
          <Satellite UUID="RINCON_KITCHEN2" ZoneName="Kitchen"/>
        </ZoneGroupMember>
      </ZoneGroup>
      <ZoneGroup Coordinator="RINCON_OFFICE" ID="g2">
        <ZoneGroupMember UUID="RINCON_OFFICE" ZoneName="Office"/>
      </ZoneGroup>
    </ZoneGroups>
  </ZoneGroupState>`;

  it("drops bonded satellites and keeps coordinators", async () => {
    const control: SonosTopologyClient = {
      getZoneGroupState: async () => topologyXml,
    };
    const svc = new SonosDiscoveryService({ control });
    const devs = (svc as unknown as { devices: Map<string, SonosDevice> }).devices;
    devs.set("RINCON_KITCHEN1", makeDevice("RINCON_KITCHEN1", "Kitchen", "192.168.2.21"));
    devs.set("RINCON_KITCHEN2", makeDevice("RINCON_KITCHEN2", "Kitchen", "192.168.2.170"));
    devs.set("RINCON_OFFICE", makeDevice("RINCON_OFFICE", "Office", "192.168.2.30"));

    await svc.collapseZoneGroups();

    const ids = svc.list().map((d) => d.id).sort();
    expect(ids).toEqual(["RINCON_KITCHEN1", "RINCON_OFFICE"]);
  });

  it("is a no-op when no control client is configured", async () => {
    const svc = new SonosDiscoveryService();
    const devs = (svc as unknown as { devices: Map<string, SonosDevice> }).devices;
    devs.set("RINCON_KITCHEN1", makeDevice("RINCON_KITCHEN1", "Kitchen", "192.168.2.21"));
    devs.set("RINCON_KITCHEN2", makeDevice("RINCON_KITCHEN2", "Kitchen", "192.168.2.170"));
    await svc.collapseZoneGroups();
    expect(svc.list()).toHaveLength(2);
  });

  it("populates supportedMimes via probeProtocolInfo (#180)", async () => {
    const control: SonosTopologyClient = {
      getZoneGroupState: async () => topologyXml,
      getProtocolInfo: async () => new Set(["audio/mpeg", "audio/flac"]),
    };
    const svc = new SonosDiscoveryService({ control });
    const devs = (svc as unknown as { devices: Map<string, SonosDevice> }).devices;
    devs.set(
      "RINCON_OFFICE",
      makeDevice("RINCON_OFFICE", "Office", "192.168.2.30"),
    );
    await (svc as unknown as {
      probeProtocolInfo: (id: string) => Promise<void>;
    }).probeProtocolInfo("RINCON_OFFICE");
    const dev = svc.list().find((d) => d.id === "RINCON_OFFICE");
    expect(dev?.supportedMimes).toBeInstanceOf(Set);
    expect(dev?.supportedMimes?.has("audio/flac")).toBe(true);
  });

  it("leaves supportedMimes unset on GetProtocolInfo failure", async () => {
    const control: SonosTopologyClient = {
      getZoneGroupState: async () => topologyXml,
      getProtocolInfo: async () => {
        throw new Error("boom");
      },
    };
    const errors: string[] = [];
    const svc = new SonosDiscoveryService({
      control,
      log: { info: () => {}, error: (m) => errors.push(m) },
    });
    const devs = (svc as unknown as { devices: Map<string, SonosDevice> }).devices;
    devs.set(
      "RINCON_OFFICE",
      makeDevice("RINCON_OFFICE", "Office", "192.168.2.30"),
    );
    await (svc as unknown as {
      probeProtocolInfo: (id: string) => Promise<void>;
    }).probeProtocolInfo("RINCON_OFFICE");
    const dev = svc.list().find((d) => d.id === "RINCON_OFFICE");
    expect(dev?.supportedMimes).toBeUndefined();
    expect(errors[0]).toMatch(/GetProtocolInfo failed/);
  });

  it("leaves devices untouched if GetZoneGroupState throws", async () => {
    const control: SonosTopologyClient = {
      getZoneGroupState: async () => {
        throw new Error("network down");
      },
    };
    const errors: string[] = [];
    const svc = new SonosDiscoveryService({
      control,
      log: { info: () => {}, error: (m) => errors.push(m) },
    });
    const devs = (svc as unknown as { devices: Map<string, SonosDevice> }).devices;
    devs.set("RINCON_KITCHEN1", makeDevice("RINCON_KITCHEN1", "Kitchen", "192.168.2.21"));
    devs.set("RINCON_KITCHEN2", makeDevice("RINCON_KITCHEN2", "Kitchen", "192.168.2.170"));
    await svc.collapseZoneGroups();
    expect(svc.list()).toHaveLength(2);
    expect(errors[0]).toMatch(/GetZoneGroupState failed/);
  });
});
