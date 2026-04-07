import { readFileSync, existsSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { parsePeerPublicKey } from "./signing.js";
import type { KeyObject } from "node:crypto";

export interface Peer {
  id: string;
  url: string; // base URL, no trailing slash
  publicKey: KeyObject;
  publicKeySpec: string; // original "ed25519:..." string for logging
}

export interface PeerRegistry {
  instanceId: string;
  peers: Map<string, Peer>;
  reload(): void;
}

interface PeersYaml {
  instance_id?: string;
  peers?: Array<{
    id?: string;
    url?: string;
    public_key?: string;
  }>;
}

function parseYamlFile(
  configPath: string,
  fallbackInstanceId: string,
  warnFn: (msg: string) => void,
): { instanceId: string; peers: Map<string, Peer> } {
  if (!existsSync(configPath)) {
    warnFn(`Peers config not found at ${configPath} — running without federation peers`);
    return { instanceId: fallbackInstanceId, peers: new Map() };
  }

  let raw: PeersYaml;
  try {
    const text = readFileSync(configPath, "utf8");
    raw = yamlParse(text) as PeersYaml;
  } catch (err) {
    warnFn(`Failed to parse peers config at ${configPath}: ${String(err)}`);
    return { instanceId: fallbackInstanceId, peers: new Map() };
  }

  if (!raw || typeof raw !== "object") {
    warnFn(`Peers config at ${configPath} is not a valid YAML object`);
    return { instanceId: fallbackInstanceId, peers: new Map() };
  }

  const instanceId =
    typeof raw.instance_id === "string" && raw.instance_id.trim()
      ? raw.instance_id.trim()
      : fallbackInstanceId;

  const peers = new Map<string, Peer>();

  if (Array.isArray(raw.peers)) {
    for (const entry of raw.peers) {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
        warnFn(`Skipping peer entry with missing id: ${JSON.stringify(entry)}`);
        continue;
      }
      if (typeof entry.url !== "string" || !entry.url.trim()) {
        warnFn(`Skipping peer "${entry.id}": missing url`);
        continue;
      }
      if (typeof entry.public_key !== "string") {
        warnFn(`Skipping peer "${entry.id}": missing public_key`);
        continue;
      }

      let publicKey: KeyObject;
      try {
        publicKey = parsePeerPublicKey(entry.public_key);
      } catch (err) {
        warnFn(`Skipping peer "${entry.id}": invalid public_key — ${String(err)}`);
        continue;
      }

      peers.set(entry.id.trim(), {
        id: entry.id.trim(),
        url: entry.url.trim().replace(/\/+$/, ""),
        publicKey,
        publicKeySpec: entry.public_key,
      });
    }
  }

  return { instanceId, peers };
}

export function loadPeerRegistry(
  configPath: string,
  fallbackInstanceId: string,
): PeerRegistry {
  // Use a console.warn-based logger initially; callers may swap it for a real
  // logger after construction. The Fastify app registers SIGHUP to call reload().
  const warn = (msg: string) => console.warn(`[peers] ${msg}`);

  let state = parseYamlFile(configPath, fallbackInstanceId, warn);

  const registry: PeerRegistry = {
    get instanceId() {
      return state.instanceId;
    },
    get peers() {
      return state.peers;
    },
    reload() {
      state = parseYamlFile(configPath, fallbackInstanceId, warn);
    },
  };

  return registry;
}
