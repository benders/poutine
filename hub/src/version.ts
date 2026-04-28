/**
 * Single source of truth for version strings used across the hub.
 *
 * APP_VERSION: Semantic version of the Poutine application. Sent in the
 *   User-Agent header on outgoing federation requests and returned by /api/health.
 *
 * FEDERATION_API_VERSION: Integer version of the Poutine federation protocol.
 *   Incremented on breaking changes to /federation/* request/response contracts.
 *   Sent in the Poutine-Api-Version header on all federation responses, and
 *   returned in /library/export bodies and /api/health.
 *
 * When making a breaking change to federation:
 *   1. Increment FEDERATION_API_VERSION
 *   2. Add a changelog entry to docs/federation-api.md
 *   3. Update contract tests in hub/test/federation-routes.test.ts
 */

export const APP_VERSION = "0.4.2";
export const FEDERATION_API_VERSION = 3;

/** User-Agent header value sent on all outgoing federation requests. */
export const USER_AGENT = `Poutine/${APP_VERSION}`;
