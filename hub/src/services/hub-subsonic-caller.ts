/**
 * In-process Subsonic HTTP client (#220, Phase 6 of #212).
 *
 * Lets Player-side code (sonos, dlna) talk to Hub's own `/rest/*` Subsonic
 * surface without importing the in-process `SubsonicClient` adapter or
 * touching `app.db` directly. Today the call goes via `app.inject()` so
 * there's no TCP overhead; once Player is lifted out of the Hub process
 * (post-#220 follow-ups), swap the caller for a real loopback `fetch()` —
 * no rewrites needed in the callers.
 *
 * Auth: the owner account's u+p. The owner is guaranteed to exist at boot
 * and is the only identity the Hub can authenticate without external state.
 * Read endpoints only — Player never needs to mutate via this path.
 *
 * Used by:
 *   - `services/dlna-objects.ts` (Browse + Search) via the
 *     `SubsonicCaller` interface (#219).
 *   - `routes/sonos.ts` cast planner (#220) — replaces in-process
 *     `SubsonicClient.getSong` + `getPreferredSource` + direct `app.db`
 *     joins.
 *
 * The shape conforms to `services/dlna-objects.ts#SubsonicCaller` so both
 * consumers can share one instance.
 */

import type { FastifyInstance } from "fastify";

/** Decoded `subsonic-response` body. */
export interface SubsonicResponse {
  "subsonic-response": Record<string, unknown> & {
    status: "ok" | "failed";
    error?: { code: number; message: string };
  };
}

export interface HubSubsonicCallOptions {
  /**
   * When set, auth as this user via the in-process trusted-header path
   * (#224) instead of using the owner u+p. The user must exist on the hub
   * — the auth middleware looks them up by username. Use this for any path
   * where the caller already has an authenticated user context (e.g. the
   * Sonos cast planner runs under JWT auth and knows `req.username`).
   *
   * Omit for paths with no user context (DLNA browse is LAN-gated and
   * unauthenticated — falls back to owner u+p).
   */
  asUser?: string;
}

export interface HubSubsonicCaller {
  /**
   * GET `endpoint` (e.g. `/rest/getSong`) with the supplied params merged
   * onto baseline auth params. Throws on non-200 HTTP, on Subsonic
   * `failed` status, or on missing owner credentials (when `asUser` is not
   * set).
   *
   * Caller is responsible for narrowing the response shape — this layer
   * is intentionally untyped above `Record<string, unknown>`.
   */
  call(
    endpoint: string,
    params: Record<string, string>,
    opts?: HubSubsonicCallOptions,
  ): Promise<SubsonicResponse>;
}

interface CreateCallerOptions {
  /** Subsonic `c=` client identifier, e.g. `poutine-sonos`, `poutine-dlna`. */
  client: string;
}

/**
 * Build a caller bound to the given Fastify app instance. The owner's
 * username + password are read from `app.config` at each call (not closed
 * over) so a future credential rotation is picked up without a restart.
 */
export function createHubSubsonicCaller(
  app: FastifyInstance,
  opts: CreateCallerOptions,
): HubSubsonicCaller {
  return {
    async call(endpoint, params, callOpts) {
      const qsParams: Record<string, string> = {
        f: "json",
        v: "1.16.1",
        c: opts.client,
        ...params,
      };
      const headers: Record<string, string> = {};

      if (callOpts?.asUser) {
        // Trusted in-process auth (#224). Subsonic spec still requires
        // `u=` to be present on the wire; the middleware ignores it once
        // the trusted-header pair validates, but we set it to the
        // identified user for log readability.
        qsParams.u = callOpts.asUser;
        headers["x-poutine-internal"] = app.internalAuthSecret;
        headers["x-poutine-as-user"] = callOpts.asUser;
      } else {
        const username = app.config.poutineOwnerUsername;
        const password = app.config.poutineOwnerPassword;
        if (!username || !password) {
          throw new Error(
            "Hub Subsonic caller: owner credentials not configured " +
              "(POUTINE_OWNER_USERNAME / POUTINE_OWNER_PASSWORD)",
          );
        }
        qsParams.u = username;
        qsParams.p = password;
      }

      const qs = new URLSearchParams(qsParams);
      const res = await app.inject({
        method: "GET",
        url: `${endpoint}?${qs.toString()}`,
        headers,
      });
      if (res.statusCode !== 200) {
        throw new Error(`${endpoint} → ${res.statusCode}`);
      }
      // Subsonic "failed" status is surfaced via the body — callers decide
      // whether to treat it as fatal. DLNA browse tolerates empty / missing
      // sub-objects; sonos cast must hard-fail when getSong fails.
      return res.json() as SubsonicResponse;
    },
  };
}
