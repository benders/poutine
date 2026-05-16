/**
 * SSDP advertiser for the DLNA MediaServer.
 *
 * Two responsibilities:
 *  1. Periodically multicast NOTIFY `ssdp:alive` packets so control points
 *     learn we exist without having to send M-SEARCH.
 *  2. Bind UDP `239.255.255.250:1900` and respond unicast to M-SEARCH
 *     packets whose `ST` matches one of our advertised targets.
 *
 * On stop we multicast NOTIFY `ssdp:byebye` so clients can drop us
 * immediately instead of waiting for the max-age timeout.
 *
 * Multicast requires host networking inside Docker. See
 * `docker-compose.sonos.yml` — the same override applies to DLNA.
 */
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
/**
 * UPnP-DA 1.1 §1.2.3 recommends sending each byebye more than once because
 * UDP is unreliable. Three is the spec-suggested floor.
 */
const BYEBYE_REPEATS = 3;

export interface SsdpAdvertiserOptions {
  /** Stable UUID for this device. Used in the `usn:` / `USN` headers. */
  uuid: string;
  /** Absolute URL to the device description XML, reachable from clients. */
  locationUrl: string;
  /** Server header, e.g. `Linux/5.x UPnP/1.0 Poutine/0.5`. */
  serverString: string;
  /** Re-announce interval (ms). UPnP advisory: half of `max-age`. */
  intervalMs?: number;
  /** Value used in `CACHE-CONTROL: max-age=<seconds>`. */
  maxAgeSec?: number;
  /**
   * Explicit IPv4 address to bind multicast membership on. When omitted we
   * derive it from the host portion of `locationUrl` (resolving against
   * the local interface list). On a multi-NIC host the kernel otherwise
   * picks one — typically the wrong one for a Docker host where `docker0`
   * exists alongside the LAN NIC.
   */
  interfaceAddress?: string;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

/** Targets we advertise + respond to M-SEARCH for. Order: most-specific first. */
function buildTargets(uuid: string): { st: string; usn: string }[] {
  return [
    { st: "upnp:rootdevice", usn: `uuid:${uuid}::upnp:rootdevice` },
    { st: `uuid:${uuid}`, usn: `uuid:${uuid}` },
    {
      st: "urn:schemas-upnp-org:device:MediaServer:1",
      usn: `uuid:${uuid}::urn:schemas-upnp-org:device:MediaServer:1`,
    },
    {
      st: "urn:schemas-upnp-org:service:ContentDirectory:1",
      usn: `uuid:${uuid}::urn:schemas-upnp-org:service:ContentDirectory:1`,
    },
    {
      st: "urn:schemas-upnp-org:service:ConnectionManager:1",
      usn: `uuid:${uuid}::urn:schemas-upnp-org:service:ConnectionManager:1`,
    },
  ];
}

export function buildNotifyAlive(opts: {
  nt: string;
  usn: string;
  location: string;
  server: string;
  maxAgeSec: number;
}): Buffer {
  const lines = [
    "NOTIFY * HTTP/1.1",
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    `CACHE-CONTROL: max-age=${opts.maxAgeSec}`,
    `LOCATION: ${opts.location}`,
    "NTS: ssdp:alive",
    `NT: ${opts.nt}`,
    `SERVER: ${opts.server}`,
    `USN: ${opts.usn}`,
    "",
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}

export function buildNotifyByebye(opts: { nt: string; usn: string }): Buffer {
  const lines = [
    "NOTIFY * HTTP/1.1",
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    "NTS: ssdp:byebye",
    `NT: ${opts.nt}`,
    `USN: ${opts.usn}`,
    "",
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}

export function buildMSearchResponse(opts: {
  st: string;
  usn: string;
  location: string;
  server: string;
  maxAgeSec: number;
}): Buffer {
  // UPnP M-SEARCH responses are HTTP/1.1 200 OK with no body.
  // Note: `DATE` is required by some strict clients.
  const lines = [
    "HTTP/1.1 200 OK",
    `CACHE-CONTROL: max-age=${opts.maxAgeSec}`,
    `DATE: ${new Date().toUTCString()}`,
    "EXT:",
    `LOCATION: ${opts.location}`,
    `SERVER: ${opts.server}`,
    `ST: ${opts.st}`,
    `USN: ${opts.usn}`,
    "",
    "",
  ];
  return Buffer.from(lines.join("\r\n"));
}

/** Parse an incoming M-SEARCH datagram. Returns null if not an M-SEARCH. */
export function parseMSearch(buf: Buffer): {
  st: string;
  mx: number;
  man: string;
} | null {
  const text = buf.toString("utf8");
  const lines = text.split(/\r\n/);
  if (!/^M-SEARCH\s+\*\s+HTTP\/1\.\d/i.test(lines[0] ?? "")) return null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx < 0) continue;
    headers[lines[i].slice(0, idx).trim().toLowerCase()] =
      lines[i].slice(idx + 1).trim();
  }
  const st = headers.st;
  const man = (headers.man || "").replace(/^"|"$/g, "");
  if (!st || man !== "ssdp:discover") return null;
  // MX is a non-negative integer per spec, but clients sometimes omit or
  // garble it. Coerce non-finite values to 0 (== "answer immediately") so
  // the random-delay arithmetic below doesn't blow up to NaN.
  const mxRaw = parseInt(headers.mx || "0", 10);
  const mx = Number.isFinite(mxRaw) && mxRaw >= 0 ? mxRaw : 0;
  return { st, mx, man };
}

/**
 * Decide which target(s) we should respond to a given M-SEARCH `ST` with.
 * `ssdp:all` matches everything we advertise; a specific URN matches itself.
 */
export function matchTargets(
  st: string,
  uuid: string,
): { st: string; usn: string }[] {
  const all = buildTargets(uuid);
  if (st === "ssdp:all") return all;
  return all.filter((t) => t.st === st);
}

/**
 * Pick an IPv4 interface address suitable for multicast membership when the
 * caller didn't pin one. Strategy:
 *
 *  1. If `hostHint` is an IPv4 literal that matches a local interface, use it.
 *  2. Otherwise pick the first non-internal IPv4 interface.
 *  3. Fall back to `0.0.0.0` (kernel default) — the historical behavior.
 */
export function pickInterfaceAddress(hostHint?: string): string {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === "IPv4" && !info.internal) {
        candidates.push(info.address);
      }
    }
  }
  if (hostHint) {
    const literal = candidates.find((a) => a === hostHint);
    if (literal) return literal;
  }
  return candidates[0] ?? "0.0.0.0";
}

function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export class SsdpAdvertiser {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly maxAgeSec: number;
  private readonly log: NonNullable<SsdpAdvertiserOptions["log"]>;
  private readonly targets: { st: string; usn: string }[];
  private readonly interfaceAddress: string;

  constructor(private readonly opts: SsdpAdvertiserOptions) {
    this.maxAgeSec = opts.maxAgeSec ?? 1800;
    this.intervalMs = opts.intervalMs ?? Math.floor((this.maxAgeSec * 1000) / 2);
    this.log = opts.log ?? {
      info: () => {},
      error: () => {},
    };
    this.targets = buildTargets(opts.uuid);
    this.interfaceAddress =
      opts.interfaceAddress ?? pickInterfaceAddress(hostFromUrl(opts.locationUrl));
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;

    socket.on("error", (err) => {
      this.log.error(`SSDP advertiser socket error: ${err.message}`);
    });

    socket.on("message", (msg, rinfo) => {
      const parsed = parseMSearch(msg);
      if (!parsed) return;
      const targets = matchTargets(parsed.st, this.opts.uuid);
      if (targets.length === 0) return;
      // Spec says random delay between 0..MX seconds. Cap to 1s — Poutine
      // is a small LAN service, not a public responder, so delaying barely
      // matters.
      const window = Math.min(1000, parsed.mx * 1000);
      const delay = window > 0 ? Math.floor(Math.random() * window) : 0;
      setTimeout(() => {
        for (const t of targets) {
          const pkt = buildMSearchResponse({
            st: t.st,
            usn: t.usn,
            location: this.opts.locationUrl,
            server: this.opts.serverString,
            maxAgeSec: this.maxAgeSec,
          });
          this.socket?.send(pkt, 0, pkt.length, rinfo.port, rinfo.address, (err) => {
            if (err) this.log.error(`SSDP send M-SEARCH reply failed: ${err.message}`);
          });
        }
      }, delay);
    });

    socket.bind(SSDP_PORT, () => {
      try {
        // Explicit interface address: on a multi-NIC host (e.g. Docker with
        // both `docker0` and a LAN NIC) the kernel-default join may bind
        // the wrong one and silently lose all M-SEARCH replies.
        socket.addMembership(SSDP_ADDR, this.interfaceAddress);
        socket.setMulticastTTL(2);
        if (this.interfaceAddress !== "0.0.0.0") {
          try {
            socket.setMulticastInterface(this.interfaceAddress);
          } catch (err) {
            this.log.error(
              `SSDP setMulticastInterface(${this.interfaceAddress}) failed: ${String(err)}`,
            );
          }
        }
      } catch (err) {
        this.log.error(`SSDP addMembership failed: ${String(err)}`);
      }
      this.announceAlive();
      this.timer = setInterval(() => this.announceAlive(), this.intervalMs);
      this.timer.unref();
      this.log.info(
        `DLNA SSDP advertiser started on ${this.interfaceAddress} (interval ${this.intervalMs}ms, max-age ${this.maxAgeSec}s)`,
      );
    });
  }

  /**
   * Multicast byebye and close the socket. Resolves when all byebye sends
   * have been flushed to the wire (or errored) — closing immediately after
   * a synchronous send queues the packets in the socket buffer and the
   * kernel may drop them before they leave.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    try {
      for (let i = 0; i < BYEBYE_REPEATS; i++) {
        await this.announceByebye(socket);
      }
    } catch {
      // best-effort
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private announceAlive(): void {
    if (!this.socket) return;
    for (const t of this.targets) {
      const pkt = buildNotifyAlive({
        nt: t.st,
        usn: t.usn,
        location: this.opts.locationUrl,
        server: this.opts.serverString,
        maxAgeSec: this.maxAgeSec,
      });
      this.socket.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) this.log.error(`SSDP NOTIFY alive failed: ${err.message}`);
      });
    }
  }

  private announceByebye(socket: dgram.Socket): Promise<void> {
    const sends = this.targets.map(
      (t) =>
        new Promise<void>((resolve) => {
          const pkt = buildNotifyByebye({ nt: t.st, usn: t.usn });
          socket.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR, () => resolve());
        }),
    );
    return Promise.all(sends).then(() => undefined);
  }
}
