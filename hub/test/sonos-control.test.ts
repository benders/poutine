import { describe, it, expect } from "vitest";
import {
  buildDidlLite,
  buildSoapEnvelope,
} from "../src/services/sonos-control.js";

describe("buildSoapEnvelope", () => {
  it("wraps args in a SOAP envelope with the correct service type", () => {
    const env = buildSoapEnvelope("AVTransport", "Play", {
      InstanceID: 0,
      Speed: "1",
    });
    expect(env).toContain(
      'xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"',
    );
    expect(env).toContain("<u:Play");
    expect(env).toContain("<InstanceID>0</InstanceID>");
    expect(env).toContain("<Speed>1</Speed>");
  });

  it("xml-escapes argument values", () => {
    const env = buildSoapEnvelope("AVTransport", "SetAVTransportURI", {
      InstanceID: 0,
      CurrentURI: "http://x/y?a=1&b=2",
      CurrentURIMetaData: "<x/>",
    });
    expect(env).toContain("a=1&amp;b=2");
    expect(env).toContain("&lt;x/&gt;");
  });
});

describe("buildDidlLite", () => {
  it("escapes title/artist and wraps stream URI as res", () => {
    const didl = buildDidlLite(
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
    expect(didl).toContain(
      'protocolInfo="http-get:*:audio/mpeg:*"',
    );
    expect(didl).toContain("duration=\"00:05:01.000\"");
    expect(didl).toContain(">http://lan/cast/stream/t1?token=abc<");
  });

  it("omits albumArtURI when not provided", () => {
    const didl = buildDidlLite(
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
