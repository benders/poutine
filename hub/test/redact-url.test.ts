import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  REDACTED,
  redactText,
  redactUrl,
  redactingReqSerializer,
} from "../src/util/redact-url.js";

describe("redactUrl (#317)", () => {
  it("leaves URLs without a query string alone", () => {
    expect(redactUrl("/rest/ping")).toBe("/rest/ping");
    expect(redactUrl("")).toBe("");
  });

  it("redacts a plaintext Subsonic password, keeps u/c/f", () => {
    expect(redactUrl("/rest/ping?u=alice&p=hunter2&c=app&f=json")).toBe(
      `/rest/ping?u=alice&p=${REDACTED}&c=app&f=json`,
    );
  });

  it("redacts enc: hex passwords", () => {
    const out = redactUrl("/rest/ping.view?u=alice&p=enc:68756e74657232");
    expect(out).not.toContain("68756e74657232");
    expect(out).toBe(`/rest/ping.view?u=alice&p=${REDACTED}`);
  });

  it("redacts token+salt", () => {
    const out = redactUrl("/rest/getAlbum?id=al-1&u=bob&t=0123abcd&s=deadbeef&v=1.16.1");
    expect(out).toBe(`/rest/getAlbum?id=al-1&u=bob&t=${REDACTED}&s=${REDACTED}&v=1.16.1`);
  });

  it("redacts castToken, token and apiKey", () => {
    const out = redactUrl("/rest/stream?id=tr-1&castToken=CT&token=JWT&apiKey=AK");
    expect(out).toBe(
      `/rest/stream?id=tr-1&castToken=${REDACTED}&token=${REDACTED}&apiKey=${REDACTED}`,
    );
  });

  it("redacts every occurrence of a repeated key", () => {
    expect(redactUrl("/x?p=one&p=two&id=3")).toBe(`/x?p=${REDACTED}&p=${REDACTED}&id=3`);
  });

  it("matches percent-encoded and case-variant keys", () => {
    // %70 = "p", %74 = "t"
    expect(redactUrl("/x?%70=secret&%74oken=jwt")).toBe(
      `/x?%70=${REDACTED}&%74oken=${REDACTED}`,
    );
    expect(redactUrl("/x?P=secret&CASTTOKEN=ct")).toBe(
      `/x?P=${REDACTED}&CASTTOKEN=${REDACTED}`,
    );
  });

  it("redacts a valueless sensitive key and malformed escapes do not throw", () => {
    expect(redactUrl("/x?p&id=1")).toBe(`/x?p=${REDACTED}&id=1`);
    expect(redactUrl("/x?%zz=1&p=pw")).toBe(`/x?%zz=1&p=${REDACTED}`);
  });

  it("does not redact keys that merely contain a sensitive name", () => {
    const url = "/x?pid=1&size=2&type=album&offset=0&musicFolderId=3";
    expect(redactUrl(url)).toBe(url);
  });

  it("preserves the fragment and absolute-URL prefix", () => {
    expect(redactUrl("http://127.0.0.1:4533/rest/ping?u=a&t=T&s=S#frag")).toBe(
      `http://127.0.0.1:4533/rest/ping?u=a&t=${REDACTED}&s=${REDACTED}#frag`,
    );
  });

  it("redacts a userinfo password in an absolute URL", () => {
    expect(redactUrl("https://user:pw@host.example/path?id=1")).toBe(
      `https://user:${REDACTED}@host.example/path?id=1`,
    );
    // A port is not userinfo.
    expect(redactUrl("http://host:8080/path")).toBe("http://host:8080/path");
  });
});

describe("redactText", () => {
  it("redacts sensitive params inside free-form text", () => {
    expect(redactText("Route GET:/rest/ping?u=a&p=pw&f=json not found")).toBe(
      `Route GET:/rest/ping?u=a&p=${REDACTED}&f=json not found`,
    );
    expect(redactText('in the "/rest/stream?id=1&castToken=abc" route')).toBe(
      `in the "/rest/stream?id=1&castToken=${REDACTED}" route`,
    );
  });

  it("leaves text without query credentials untouched", () => {
    const msg = "Loaded peer registry with p=3 peers (top=1)";
    expect(redactText(msg)).toBe(msg);
  });
});

describe("redactingReqSerializer", () => {
  it("mirrors Fastify's default req shape with a redacted url", () => {
    const req = {
      method: "GET",
      url: "/rest/ping?u=alice&p=hunter2",
      headers: { "accept-version": "1" },
      host: "hub.local",
      ip: "10.0.0.5",
      socket: { remotePort: 51234 },
    } as unknown as FastifyRequest;
    expect(redactingReqSerializer(req)).toEqual({
      method: "GET",
      url: `/rest/ping?u=alice&p=${REDACTED}`,
      version: "1",
      host: "hub.local",
      remoteAddress: "10.0.0.5",
      remotePort: 51234,
    });
  });
});
