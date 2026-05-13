/**
 * Integration test for the DLNA SSDP advertiser. Drives the advertiser
 * end-to-end over a real UDP socket: bind ephemeral, send an M-SEARCH for
 * `MediaServer:1`, wait for the unicast 200 OK reply, assert headers.
 *
 * Not run in regular `pnpm test`. Requires UDP multicast support on the
 * test host and a free UDP port 1900 for the advertiser. Run via
 * `pnpm test:integration`.
 *
 * Library choice note: we evaluated `@achingbrain/ssdp` as the control
 * point here — it works (our advertiser responds and the bus receives
 * the search-response) but its `discover()` async iterator only yields
 * after fetching+parsing the LOCATION through its own pipeline, which
 * adds failure modes orthogonal to what we're trying to verify. Raw dgram
 * gives an unambiguous packet-level assertion. `node-upnp` is the right
 * library for the HTTP/SOAP control-point work — see the http integration
 * test file.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import dgram from "node:dgram";
import { SsdpAdvertiser } from "../src/services/ssdp-advertiser.js";

const TEST_UUID = "ssdp-int-test-0000-aaaa-bbbbbbbbbbbb";
const MEDIA_SERVER_ST = "urn:schemas-upnp-org:device:MediaServer:1";
const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const LOCATION_URL = "http://127.0.0.1:9/device.xml"; // never fetched

function parseHeaders(buf: Buffer): Record<string, string> {
  const lines = buf.toString("utf8").split(/\r\n/);
  const out: Record<string, string> = {};
  out.__status = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    out[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
      .slice(idx + 1)
      .trim();
  }
  return out;
}

function mSearchPacket(st: string): Buffer {
  return Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 1",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n"),
  );
}

describe("DLNA SSDP advertiser (integration)", () => {
  let advertiser: SsdpAdvertiser;

  beforeAll(async () => {
    advertiser = new SsdpAdvertiser({
      uuid: TEST_UUID,
      locationUrl: LOCATION_URL,
      serverString: "PoutineTest/0.0 UPnP/1.0",
      intervalMs: 1000,
      maxAgeSec: 60,
      log: { info: () => {}, error: () => {} },
    });
    advertiser.start();
    // Wait for bind + multicast join.
    await new Promise((res) => setTimeout(res, 300));
  });

  afterAll(() => {
    advertiser.stop();
  });

  it("responds to M-SEARCH for MediaServer:1 with our LOCATION + USN", async () => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

    const got = new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timeout waiting for M-SEARCH reply")),
        5000,
      );
      sock.on("message", (msg) => {
        const h = parseHeaders(msg);
        if ((h.usn ?? "").includes(TEST_UUID)) {
          clearTimeout(timer);
          resolve(h);
        }
      });
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await new Promise<void>((res) => sock.bind(0, () => res()));
    sock.send(mSearchPacket(MEDIA_SERVER_ST), SSDP_PORT, SSDP_ADDR);

    try {
      const reply = await got;
      expect(reply.__status).toMatch(/^HTTP\/1\.1 200 OK/);
      expect(reply.st).toBe(MEDIA_SERVER_ST);
      expect(reply.usn).toBe(
        `uuid:${TEST_UUID}::${MEDIA_SERVER_ST}`,
      );
      expect(reply.location).toBe(LOCATION_URL);
      expect(reply["cache-control"]).toMatch(/max-age=\d+/);
      expect(reply.server).toContain("Poutine");
    } finally {
      sock.close();
    }
  });

  it("M-SEARCH with ssdp:all returns one reply per advertised target", async () => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const replies: Record<string, string>[] = [];

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 1500);
      sock.on("message", (msg) => {
        const h = parseHeaders(msg);
        if ((h.usn ?? "").includes(TEST_UUID)) replies.push(h);
      });
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await new Promise<void>((res) => sock.bind(0, () => res()));
    sock.send(mSearchPacket("ssdp:all"), SSDP_PORT, SSDP_ADDR);
    await done;
    sock.close();

    const sts = replies.map((r) => r.st).sort();
    expect(sts).toEqual(
      [
        "upnp:rootdevice",
        MEDIA_SERVER_ST,
        "urn:schemas-upnp-org:service:ConnectionManager:1",
        "urn:schemas-upnp-org:service:ContentDirectory:1",
        `uuid:${TEST_UUID}`,
      ].sort(),
    );
  });
});
