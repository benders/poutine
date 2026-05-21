import { describe, it, expect, vi, afterEach } from "vitest";
import { buildSoapEnvelope } from "../src/services/soap.js";
import { buildDidlLiteTrack } from "../src/services/didl.js";
import {
  SonosControl,
  SONOS_VOLUME_CAP,
  chooseSonosCastFormat,
  parseSinkProtocolInfo,
} from "../src/services/sonos-control.js";
import type { SonosDevice } from "../src/services/sonos-discovery.js";

const FAKE_DEVICE: SonosDevice = {
  id: "RINCON_TEST",
  room: "Test Room",
  model: "Sonos Test",
  ip: "192.0.2.10",
  port: 1400,
  lastSeen: new Date(),
};

const AVT = "urn:schemas-upnp-org:service:AVTransport:1";

describe("buildSoapEnvelope", () => {
  it("wraps args in a SOAP envelope with the correct service type", () => {
    const env = buildSoapEnvelope(AVT, "Play", {
      InstanceID: 0,
      Speed: "1",
    });
    expect(env).toContain(`xmlns:u="${AVT}"`);
    expect(env).toContain("<u:Play");
    expect(env).toContain("<InstanceID>0</InstanceID>");
    expect(env).toContain("<Speed>1</Speed>");
  });

  it("xml-escapes argument values", () => {
    const env = buildSoapEnvelope(AVT, "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: "http://x/y?a=1&b=2",
      CurrentURIMetaData: "<x/>",
    });
    expect(env).toContain("a=1&amp;b=2");
    expect(env).toContain("&lt;x/&gt;");
  });
});

describe("buildDidlLiteTrack", () => {
  it("escapes title/artist and wraps stream URI as res", () => {
    const didl = buildDidlLiteTrack(
      {
        trackId: "t1",
        title: "Smells <Like>",
        artist: "Nirvana & Friends",
        album: "Nevermind",
        albumArtUri: "http://lan/art.jpg",
        durationSec: 301,
        mimeType: "audio/mpeg",
      },
      "http://lan/cast/stream/t1?token=abc",
    );
    expect(didl).toContain("Smells &lt;Like&gt;");
    expect(didl).toContain("Nirvana &amp; Friends");
    expect(didl).toContain("<upnp:albumArtURI>http://lan/art.jpg</upnp:albumArtURI>");
    expect(didl).toContain('protocolInfo="http-get:*:audio/mpeg:*"');
    expect(didl).toContain('duration="00:05:01.000"');
    expect(didl).toContain(">http://lan/cast/stream/t1?token=abc<");
  });

  it("omits albumArtURI when not provided", () => {
    const didl = buildDidlLiteTrack(
      {
        trackId: "t1",
        title: "X",
        artist: "Y",
        album: "Z",
        durationSec: 60,
      },
      "http://lan/x",
    );
    expect(didl).not.toContain("albumArtURI");
  });
});

describe("parseSinkProtocolInfo", () => {
  it("extracts mime types from http-get sink entries", () => {
    const sink =
      "http-get:*:audio/mpeg:*,http-get:*:audio/flac:*,http-get:*:audio/mp4:*";
    const out = parseSinkProtocolInfo(sink);
    expect(out.has("audio/mpeg")).toBe(true);
    expect(out.has("audio/flac")).toBe(true);
    expect(out.has("audio/mp4")).toBe(true);
  });

  it("ignores non-http-get protocols (rtsp, x-sonos-spotify, etc.)", () => {
    const sink =
      "http-get:*:audio/mpeg:*,rtsp-rtp-udp:*:audio/x-pn-realaudio:*,x-sonos-spotify:*:application/x-spotify:*";
    const out = parseSinkProtocolInfo(sink);
    expect(Array.from(out)).toEqual(["audio/mpeg"]);
  });

  it("tolerates whitespace and empty entries", () => {
    const sink = " http-get:*:audio/mpeg:* , , http-get:*:audio/flac:* ";
    const out = parseSinkProtocolInfo(sink);
    expect(out.size).toBe(2);
    expect(out.has("audio/mpeg")).toBe(true);
    expect(out.has("audio/flac")).toBe(true);
  });

  it("returns an empty set on empty input", () => {
    expect(parseSinkProtocolInfo("").size).toBe(0);
  });
});

describe("chooseSonosCastFormat", () => {
  const eraSinks = new Set([
    "audio/mpeg",
    "audio/flac",
    "audio/mp4",
    "audio/wav",
  ]);

  it("passes FLAC through when the device advertises audio/flac", () => {
    expect(chooseSonosCastFormat("flac", eraSinks)).toEqual({
      mime: "audio/flac",
      transcode: false,
    });
  });

  it("falls back to audio/x-flac when that's what the firmware reports", () => {
    const sinks = new Set(["audio/mpeg", "audio/x-flac"]);
    expect(chooseSonosCastFormat("flac", sinks)).toEqual({
      mime: "audio/x-flac",
      transcode: false,
    });
  });

  it("transcodes OGG to MP3 — Sonos has no native OGG support", () => {
    expect(chooseSonosCastFormat("ogg", eraSinks)).toEqual({
      mime: "audio/mpeg",
      transcode: true,
    });
  });

  it("transcodes when source format is null (unknown)", () => {
    expect(chooseSonosCastFormat(null, eraSinks)).toEqual({
      mime: "audio/mpeg",
      transcode: true,
    });
  });

  it("transcodes when the device's sink set is unknown (probe pending)", () => {
    expect(chooseSonosCastFormat("flac", null)).toEqual({
      mime: "audio/mpeg",
      transcode: true,
    });
  });

  it("transcodes FLAC when the target device doesn't accept audio/flac", () => {
    const mp3Only = new Set(["audio/mpeg"]);
    expect(chooseSonosCastFormat("flac", mp3Only)).toEqual({
      mime: "audio/mpeg",
      transcode: true,
    });
  });

  it("passes MP3 through (no needless re-transcode)", () => {
    expect(chooseSonosCastFormat("mp3", eraSinks)).toEqual({
      mime: "audio/mpeg",
      transcode: false,
    });
  });

  it("maps AAC/ALAC/m4a to audio/mp4", () => {
    expect(chooseSonosCastFormat("aac", eraSinks).mime).toBe("audio/mp4");
    expect(chooseSonosCastFormat("alac", eraSinks).mime).toBe("audio/mp4");
    expect(chooseSonosCastFormat("m4a", eraSinks).mime).toBe("audio/mp4");
  });

  it("is case-insensitive on source format", () => {
    expect(chooseSonosCastFormat("FLAC", eraSinks).transcode).toBe(false);
  });
});

describe("SonosControl.setNextAvTransportUri (#202)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): Array<{ url: string; body: string; soapAction: string }> {
    const calls: Array<{ url: string; body: string; soapAction: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        calls.push({
          url,
          body: String(init.body ?? ""),
          soapAction: headers["soapaction"] ?? "",
        });
        return new Response("<ok/>", { status: 200 });
      }),
    );
    return calls;
  }

  const META = {
    trackId: "t-next",
    title: "Next Track",
    artist: "An Artist",
    album: "An Album",
    durationSec: 200,
    mimeType: "audio/flac",
  };

  it("issues SetNextAVTransportURI with NextURI + DIDL", async () => {
    const calls = stubFetch();
    await new SonosControl().setNextAvTransportUri(
      FAKE_DEVICE,
      "http://lan/cast/stream/t-next?token=abc",
      META,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.soapAction).toBe(`"${AVT}#SetNextAVTransportURI"`);
    expect(calls[0]!.body).toContain("<u:SetNextAVTransportURI");
    expect(calls[0]!.body).toContain(
      "<NextURI>http://lan/cast/stream/t-next?token=abc</NextURI>",
    );
    expect(calls[0]!.body).toContain("<NextURIMetaData>");
    expect(calls[0]!.body).toContain("&lt;DIDL-Lite");
  });

  it("clears the slot with empty NextURI when meta is null", async () => {
    const calls = stubFetch();
    await new SonosControl().setNextAvTransportUri(FAKE_DEVICE, "", null);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain("<NextURI></NextURI>");
    expect(calls[0]!.body).toContain("<NextURIMetaData></NextURIMetaData>");
  });
});

describe("SonosControl.getState includes trackUri (#202)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses TrackURI out of GetPositionInfo", async () => {
    const transportInfo =
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<u:GetTransportInfoResponse xmlns:u="${AVT}">` +
      `<CurrentTransportState>PLAYING</CurrentTransportState>` +
      `<CurrentTransportStatus>OK</CurrentTransportStatus>` +
      `</u:GetTransportInfoResponse></s:Body></s:Envelope>`;
    const positionInfo =
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<u:GetPositionInfoResponse xmlns:u="${AVT}">` +
      `<Track>1</Track>` +
      `<TrackDuration>00:03:21</TrackDuration>` +
      `<TrackURI>http://lan/cast/stream/abc?token=xyz</TrackURI>` +
      `<RelTime>00:00:42</RelTime>` +
      `</u:GetPositionInfoResponse></s:Body></s:Envelope>`;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = call++ === 0 ? transportInfo : positionInfo;
        return new Response(body, { status: 200 });
      }),
    );
    const state = await new SonosControl().getState(FAKE_DEVICE);
    expect(state.state).toBe("PLAYING");
    expect(state.position).toBe(42);
    expect(state.duration).toBe(201);
    expect(state.trackUri).toBe("http://lan/cast/stream/abc?token=xyz");
  });

  it("defaults trackUri to empty string when missing", async () => {
    const empty =
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<u:GetPositionInfoResponse xmlns:u="${AVT}">` +
      `<RelTime>00:00:00</RelTime><TrackDuration>00:00:00</TrackDuration>` +
      `</u:GetPositionInfoResponse></s:Body></s:Envelope>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(empty, { status: 200 })),
    );
    const state = await new SonosControl().getState(FAKE_DEVICE);
    expect(state.trackUri).toBe("");
  });
});

describe("SonosControl.setVolume cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(): Array<{ url: string; body: string }> {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body ?? "") });
        return new Response("<ok/>", { status: 200 });
      }),
    );
    return calls;
  }

  it("clamps DesiredVolume to SONOS_VOLUME_CAP when level exceeds the cap", async () => {
    const calls = stubFetch();
    const sc = new SonosControl();
    await sc.setVolume(FAKE_DEVICE, 75);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain(
      `<DesiredVolume>${SONOS_VOLUME_CAP}</DesiredVolume>`,
    );
  });

  it("passes through values at or below the cap unchanged", async () => {
    const calls = stubFetch();
    const sc = new SonosControl();
    await sc.setVolume(FAKE_DEVICE, 20);
    expect(calls[0]!.body).toContain("<DesiredVolume>20</DesiredVolume>");
  });

  it("clamps negatives to 0", async () => {
    const calls = stubFetch();
    const sc = new SonosControl();
    await sc.setVolume(FAKE_DEVICE, -5);
    expect(calls[0]!.body).toContain("<DesiredVolume>0</DesiredVolume>");
  });
});
