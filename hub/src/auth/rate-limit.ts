import type { FastifyRequest } from "fastify";

/**
 * In-process throttling for credential surfaces (#315). Deliberately
 * dependency-free and per-process: a hub serves tens of users from one
 * process, and state that resets on restart is an acceptable trade.
 *
 * Every key is derived from `request.ip`. Behind a reverse proxy that is the
 * proxy's address unless `TRUST_PROXY` is set — see `clientAddress`.
 */

/** Fixed-window counter keyed by string. */
export class WindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    /** Expired entries are swept once the map grows past this. */
    private readonly sweepAbove = 1000,
  ) {}

  /** Current count for `key` in its live window (0 if none or expired). */
  count(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    return entry && entry.resetAt > now ? entry.count : 0;
  }

  /** Count one event against `key`; returns the new count. */
  increment(key: string, now = Date.now()): number {
    if (this.hits.size > this.sweepAbove) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Seconds until `key`'s window ends (at least 1). */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return 1;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** Failed attempts allowed per (client address, username) per window. */
export const AUTH_FAILURES_PER_USER = 10;
/** Failed attempts allowed per client address, across all usernames, per window. */
export const AUTH_FAILURES_PER_ADDRESS = 100;

const MAX_USERNAME_KEY_LENGTH = 64;

/**
 * Failed-password throttle shared by `POST /admin/login` and Subsonic
 * `u+p` / `u+t+s` — the same password is being guessed on both, so they draw
 * on one budget.
 *
 * Two fixed-window limits, both on **failures** only:
 *
 * - per (address, username): stops guessing one account from one address.
 * - per address: stops spraying across usernames, and bounds how many
 *   per-username keys one address can create.
 *
 * There is no per-username limit across addresses. It would let anyone who
 * knows a username lock that user out of their own music from anywhere, and
 * a limit that exempts correct passwords stops no guessing.
 *
 * A blocked attempt is refused before the password is checked and is not
 * itself counted, so a client retrying with a stale password cannot extend
 * its own lockout or eat into the per-address budget. A success clears the
 * (address, username) count.
 */
export class AuthThrottle {
  private readonly perUser = new WindowCounter(AUTH_FAILURE_WINDOW_MS, 10_000);
  private readonly perAddress = new WindowCounter(AUTH_FAILURE_WINDOW_MS, 10_000);

  private static userKey(address: string, username: string): string {
    return `${address}|${username.slice(0, MAX_USERNAME_KEY_LENGTH).toLowerCase()}`;
  }

  /** Seconds to wait if this (address, username) is locked out, else 0. */
  blockedFor(address: string, username: string, now = Date.now()): number {
    const key = AuthThrottle.userKey(address, username);
    if (this.perUser.count(key, now) >= AUTH_FAILURES_PER_USER) {
      return this.perUser.retryAfterSeconds(key, now);
    }
    if (this.perAddress.count(address, now) >= AUTH_FAILURES_PER_ADDRESS) {
      return this.perAddress.retryAfterSeconds(address, now);
    }
    return 0;
  }

  recordFailure(address: string, username: string, now = Date.now()): void {
    this.perUser.increment(AuthThrottle.userKey(address, username), now);
    this.perAddress.increment(address, now);
  }

  recordSuccess(address: string, username: string): void {
    this.perUser.reset(AuthThrottle.userKey(address, username));
  }
}

let warnedSharedBucket = false;

/**
 * The address rate limits key on. Always `request.ip` — never a forwarding
 * header read directly, which any direct caller could vary per request to
 * dodge the limit.
 *
 * Consequence: behind a reverse proxy with `TRUST_PROXY` unset, `request.ip`
 * is the proxy, and every client shares one bucket. That is logged once so
 * the operator can fix it.
 */
export function clientAddress(request: FastifyRequest): string {
  if (
    !warnedSharedBucket &&
    !request.server.config.trustProxy &&
    (request.headers["x-forwarded-for"] !== undefined ||
      request.headers.forwarded !== undefined)
  ) {
    warnedSharedBucket = true;
    request.log.warn(
      "Request carries a forwarding header but TRUST_PROXY is unset: every client behind the proxy shares one rate-limit bucket. Set TRUST_PROXY (see docs/hub-internals.md).",
    );
  }
  return request.ip || "unknown";
}
