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

export interface HubSubsonicCaller {
  /**
   * GET `endpoint` (e.g. `/rest/getSong`) with the supplied params merged
   * onto baseline auth params. Throws on non-200 HTTP, on Subsonic
   * `failed` status, or on missing owner credentials.
   *
   * Caller is responsible for narrowing the response shape — this layer
   * is intentionally untyped above `Record<string, unknown>`.
   */
  call(
    endpoint: string,
    params: Record<string, string>,
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
    async call(endpoint, params) {
      const username = app.config.poutineOwnerUsername;
      const password = app.config.poutineOwnerPassword;
      if (!username || !password) {
        throw new Error(
          "Hub Subsonic caller: owner credentials not configured " +
            "(POUTINE_OWNER_USERNAME / POUTINE_OWNER_PASSWORD)",
        );
      }
      const qs = new URLSearchParams({
        u: username,
        p: password,
        f: "json",
        v: "1.16.1",
        c: opts.client,
        ...params,
      });
      const res = await app.inject({
        method: "GET",
        url: `${endpoint}?${qs.toString()}`,
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
