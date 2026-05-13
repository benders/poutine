import { describe, it, expect } from "vitest";
import {
  buildSoapEnvelope,
  buildSoapResponse,
  parseSoapAction,
  pickXmlTag,
  xmlEscape,
  formatUpnpDuration,
  parseUpnpDuration,
} from "../src/services/soap.js";

describe("xmlEscape", () => {
  it("escapes the five XML special characters", () => {
    expect(xmlEscape(`<a> & "b" 'c'`)).toBe("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;");
  });
});

describe("buildSoapEnvelope", () => {
  it("wraps the action with the given service type", () => {
    const out = buildSoapEnvelope("urn:foo:Service:1", "Do", { A: "1" });
    expect(out).toContain('xmlns:u="urn:foo:Service:1"');
    expect(out).toContain("<u:Do");
    expect(out).toContain("<A>1</A>");
  });
});

describe("buildSoapResponse", () => {
  it("wraps as <Action>Response and escapes argument values", () => {
    const out = buildSoapResponse("urn:foo:Service:1", "Browse", {
      Result: "<DIDL-Lite/>",
    });
    expect(out).toContain("<u:BrowseResponse");
    expect(out).toContain("&lt;DIDL-Lite/&gt;");
  });
});

describe("parseSoapAction", () => {
  it("parses the SOAPACTION header", () => {
    expect(parseSoapAction('"urn:x:Service:1#Browse"')).toEqual({
      serviceType: "urn:x:Service:1",
      action: "Browse",
    });
  });
  it("tolerates unquoted values", () => {
    expect(parseSoapAction("urn:x:S:1#A")).toEqual({
      serviceType: "urn:x:S:1",
      action: "A",
    });
  });
  it("returns null for malformed headers", () => {
    expect(parseSoapAction(undefined)).toBeNull();
    expect(parseSoapAction("no-hash-here")).toBeNull();
  });
});

describe("pickXmlTag", () => {
  it("picks tag content and decodes entities", () => {
    expect(pickXmlTag("<ObjectID>0/music/artists</ObjectID>", "ObjectID")).toBe(
      "0/music/artists",
    );
    expect(pickXmlTag("<X>a &amp; b</X>", "X")).toBe("a & b");
  });
  it("tolerates namespace prefixes", () => {
    expect(pickXmlTag("<ns:Foo>bar</ns:Foo>", "Foo")).toBe("bar");
  });
  it("returns null when the tag is missing", () => {
    expect(pickXmlTag("<a/>", "b")).toBeNull();
  });
});

describe("formatUpnpDuration / parseUpnpDuration", () => {
  it("round-trips seconds via HH:MM:SS.000", () => {
    expect(formatUpnpDuration(3661)).toBe("01:01:01.000");
    expect(parseUpnpDuration("01:01:01.000")).toBe(3661);
  });
  it("treats NOT_IMPLEMENTED as 0", () => {
    expect(parseUpnpDuration("NOT_IMPLEMENTED")).toBe(0);
  });
});
