/**
 * Stream-source circuit breaker (#241).
 *
 * `/rest/stream` walks a track's ranked sources and fails over when one is
 * unreachable. Without memory, every request for a track preferring a dead
 * hub would first wait out that hub's failure. This remembers, per instance
 * id (`'local'` or a peer id), that a stream attempt failed, so the next
 * requests within `suspectTtlMs` try healthier sources first.
 *
 * In-memory only: no schema, no timers, resets on restart. A suspect source
 * is demoted, never dropped — when every candidate is suspect, they are all
 * still tried in rank order, so a single-source track behaves as before.
 * Only instance-level faults count (transport error, timeout, upstream 5xx);
 * a 404 or Subsonic error 70 is about the track, not the hub.
 */

export interface SourceHealthOptions {
  /** How long a failed source stays demoted. Default 60 s. */
  suspectTtlMs?: number;
  /** How long a source gets to answer with headers before it counts as down. Default 10 s. */
  connectTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class SourceHealth {
  readonly suspectTtlMs: number;
  readonly connectTimeoutMs: number;
  private readonly now: () => number;
  private readonly failedAt = new Map<string, number>();

  constructor(opts: SourceHealthOptions = {}) {
    this.suspectTtlMs = opts.suspectTtlMs ?? 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  recordFailure(instanceId: string): void {
    this.failedAt.set(instanceId, this.now());
  }

  recordSuccess(instanceId: string): void {
    this.failedAt.delete(instanceId);
  }

  isSuspect(instanceId: string): boolean {
    const at = this.failedAt.get(instanceId);
    if (at === undefined) return false;
    if (this.now() - at < this.suspectTtlMs) return true;
    this.failedAt.delete(instanceId);
    return false;
  }

  /**
   * Stable partition: healthy candidates first, suspects after, each group in
   * its incoming (ranked) order.
   */
  order<T extends { instance_id: string }>(candidates: readonly T[]): T[] {
    const healthy: T[] = [];
    const suspect: T[] = [];
    for (const c of candidates) (this.isSuspect(c.instance_id) ? suspect : healthy).push(c);
    return [...healthy, ...suspect];
  }
}
