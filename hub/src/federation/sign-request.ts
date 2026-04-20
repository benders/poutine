import type { KeyObject } from "node:crypto";
import {
  canonicalSigningPayload,
  sha256Hex,
  signRequest,
} from "./signing.js";
import type { Peer } from "./peers.js";
import { USER_AGENT, FEDERATION_API_VERSION } from "../version.js";

export interface FederatedFetchOptions {
  method?: string; // default GET
  asUser: string; // local username acting on behalf of
  body?: Buffer; // optional, treated as binary
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function createFederationFetcher(deps: {
  privateKey: KeyObject;
  instanceId: string;
}): (
  peer: Peer,
  path: string,
  opts: FederatedFetchOptions,
) => Promise<Response> {
  const { privateKey, instanceId } = deps;

  return async function federatedFetch(
    peer: Peer,
    path: string,
    opts: FederatedFetchOptions,
  ): Promise<Response> {
    const method = (opts.method ?? "GET").toUpperCase();
    const timestamp = String(Date.now());
    const bodyHash = opts.body ? sha256Hex(opts.body) : "-";

    const payload = canonicalSigningPayload({
      method,
      path,
      bodyHash,
      timestamp,
      instanceId,
      userAssertion: opts.asUser,
    });

    const signature = signRequest(privateKey, payload);

    const headers: Record<string, string> = {
      ...opts.headers,
      "user-agent": USER_AGENT,
      "x-poutine-instance": instanceId,
      "x-poutine-user": opts.asUser,
      "x-poutine-timestamp": timestamp,
      "x-poutine-signature": signature,
      "poutine-api-version": String(FEDERATION_API_VERSION),
    };

    if (opts.body) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(opts.body.length);
    }

    return fetch(peer.url + path, {
      method,
      headers,
      body: opts.body ? opts.body.buffer.slice(
        opts.body.byteOffset,
        opts.body.byteOffset + opts.body.byteLength,
      ) as ArrayBuffer : undefined,
      signal: opts.signal,
    });
  };
}
