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

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

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
  log?: { info: (m: string) => void; error: (m: string) => void };
}

/** Targets we advertise + respond to M-SEARCH for. Order: most-specific first. */
const TARGETS = (uuid: string): { st: string; usn: string }[] => [
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
  return { st, mx: parseInt(headers.mx || "0", 10), man };
}

/**
 * Decide which target(s) we should respond to a given M-SEARCH `ST` with.
 * `ssdp:all` matches everything we advertise; a specific URN matches itself.
 */
export function matchTargets(
  st: string,
  uuid: string,
): { st: string; usn: string }[] {
  const all = TARGETS(uuid);
  if (st === "ssdp:all") return all;
  return all.filter((t) => t.st === st);
}

export class SsdpAdvertiser {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly maxAgeSec: number;
  private readonly log: NonNullable<SsdpAdvertiserOptions["log"]>;

  constructor(private readonly opts: SsdpAdvertiserOptions) {
    this.maxAgeSec = opts.maxAgeSec ?? 1800;
    this.intervalMs = opts.intervalMs ?? Math.floor((this.maxAgeSec * 1000) / 2);
    this.log = opts.log ?? {
      info: () => {},
      error: () => {},
    };
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
      const delay = Math.floor(Math.random() * Math.min(1000, parsed.mx * 1000));
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
        socket.addMembership(SSDP_ADDR);
        socket.setMulticastTTL(2);
      } catch (err) {
        this.log.error(`SSDP addMembership failed: ${String(err)}`);
      }
      this.announceAlive();
      this.timer = setInterval(() => this.announceAlive(), this.intervalMs);
      this.timer.unref();
      this.log.info(
        `DLNA SSDP advertiser started (interval ${this.intervalMs}ms, max-age ${this.maxAgeSec}s)`,
      );
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.socket) return;
    try {
      this.announceByebye();
    } catch {
      // best-effort
    }
    try {
      this.socket.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }

  private announceAlive(): void {
    if (!this.socket) return;
    for (const t of TARGETS(this.opts.uuid)) {
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

  private announceByebye(): void {
    if (!this.socket) return;
    for (const t of TARGETS(this.opts.uuid)) {
      const pkt = buildNotifyByebye({ nt: t.st, usn: t.usn });
      this.socket.send(pkt, 0, pkt.length, SSDP_PORT, SSDP_ADDR);
    }
  }
}
