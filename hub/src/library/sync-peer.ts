/**
 * sync-peer.ts
 *
 * Syncs a peer hub's Navidrome library into local instance_* tables by reading
 * through the peer's /proxy/* endpoint with Ed25519-signed requests.
 *
 * Replaces the old /federation/library/export approach (removed in federation v3).
 * Signing reuses the same key pair and createFederationFetcher as other federation
 * routes — the canonical signing path always includes the /proxy prefix.
 */

import type Database from "better-sqlite3";
import type { Peer } from "../federation/peers.js";
import type { createFederationFetcher } from "../federation/sign-request.js";
import { readNavidromeViaProxy } from "./sync-instance.js";
import type { SyncLogger } from "./sync-instance.js";
import type { SyncResult } from "./sync.js";

export type FederationFetcher = ReturnType<typeof createFederationFetcher>;

export async function syncPeer(
  db: Database.Database,
  peer: Peer,
  federatedFetch: FederationFetcher,
  asUser: string,
  opts: { concurrency?: number; log?: SyncLogger } = {},
): Promise<SyncResult> {
  // Build a ProxyFetch for this peer's /proxy/* endpoint.
  //
  // subPath is e.g. "/rest/getArtists?f=json&v=1.16.1&c=poutine-sync"
  // We prepend /proxy so the Ed25519 signing payload uses the full path that
  // the peer's Fastify router sees (i.e. /proxy/rest/getArtists?...).
  //
  // federatedFetch(peer, path) does: fetch(peer.url + path, signed headers)
  // We substitute peer.proxyUrl for peer.url so the HTTP request goes to the
  // correct host when proxy_url differs from url (both default to the same host).
  const { log } = opts;

  log?.info(`[${peer.id}] syncing peer via proxyUrl=${peer.proxyUrl}`);

  const proxyFetch = async (subPath: string): Promise<Response> => {
    const signingPath = `/proxy${subPath}`;
    const proxyPeer: Peer = { ...peer, url: peer.proxyUrl };
    return federatedFetch(proxyPeer, signingPath, { asUser });
  };

  return readNavidromeViaProxy(db, peer.id, proxyFetch, {
    concurrency: opts.concurrency,
    log,
  });
}
