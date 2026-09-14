import { describe, it, expect } from "vitest";
import {
  isSubsonicEnvelopeType,
  parseSubsonicEnvelopeError,
  readEnvelopeError,
} from "../src/routes/upstream-envelope.js";

describe("isSubsonicEnvelopeType", () => {
  it.each([
    ["application/xml", true],
    ["text/xml; charset=utf-8", true],
    ["Application/JSON; charset=UTF-8", true],
    ["audio/mpeg", false],
    ["application/octet-stream", false],
    ["", false],
    [null, false],
  ])("%s → %s", (ct, expected) => {
    expect(isSubsonicEnvelopeType(ct)).toBe(expected);
  });
});

describe("parseSubsonicEnvelopeError", () => {
  it("XML error 70 → 404", () => {
    expect(parseSubsonicEnvelopeError('<error code="70" message="data not found"/>')).toEqual({
      httpStatus: 404,
      code: 70,
    });
  });

  it("JSON error 70 → 404", () => {
    const body = JSON.stringify({ "subsonic-response": { status: "failed", error: { code: 70 } } });
    expect(parseSubsonicEnvelopeError(body)).toEqual({ httpStatus: 404, code: 70 });
  });

  it("other codes → 502", () => {
    expect(parseSubsonicEnvelopeError("<error code='40' message='auth'/>")).toEqual({
      httpStatus: 502,
      code: 40,
    });
  });

  it("unparseable body → 502 with no code", () => {
    expect(parseSubsonicEnvelopeError("garbage")).toEqual({ httpStatus: 502, code: null });
  });
});

describe("readEnvelopeError", () => {
  it("returns null and leaves audio bodies unread", async () => {
    const res = new Response(new Uint8Array([0xff, 0xfb]), { headers: { "content-type": "audio/mpeg" } });
    expect(await readEnvelopeError(res)).toBeNull();
    expect(res.bodyUsed).toBe(false);
  });

  it("consumes and maps an envelope body", async () => {
    const res = new Response('<error code="70"/>', { headers: { "content-type": "application/xml" } });
    expect(await readEnvelopeError(res)).toEqual({ httpStatus: 404, code: 70 });
  });
});
