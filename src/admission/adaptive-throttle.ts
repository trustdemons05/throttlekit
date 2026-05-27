import type { Clock } from '../core/types.js';
import { SystemClock } from '../core/clock.js';

export interface AdaptiveThrottleOptions {
  /** Multiplier (default 2) */
  k?: number;
  /** Rolling window in ms (default 30_000) */
  windowMs?: number;
  /** Number of buckets for the rolling window (default 10) */
  buckets?: number;
  /** Clock for deterministic testing */
  clock?: Clock;
}

export interface AdaptiveThrottle {
  /**
   * Returns true if the request should be sent, false to shed.
   * @param priority - Higher priority reduces drop chance (default 1).
   */
  request(priority?: number): boolean;
  /**
   * Feed back the backend outcome.
   * @param accepted - Whether the request was accepted by the backend.
   */
  record(accepted: boolean): void;
  /** Current drop probability [0, 1]. */
  readonly dropProbability: number;
  /** Reset all counts. */
  reset(): void;
}

interface Bucket {
  ts: number;
  requests: number;
  accepts: number;
}

/**
 * Create a Google SRE-style client-side adaptive throttle.
 *
 * Maintains rolling counts of requests and accepts over `windowMs` using
 * time-based buckets. Drop probability is computed as:
 *
 *   p = max(0, (requests - k * accepts) / (requests + 1))
 */
export function adaptiveThrottle(options?: AdaptiveThrottleOptions): AdaptiveThrottle {
  const {
    k = 2,
    windowMs = 30_000,
    buckets: bucketCount = 10,
    clock = new SystemClock(),
  } = options ?? {};

  const bucketInterval = Math.ceil(windowMs / bucketCount);
  let buckets: Bucket[] = [];
  let _dropProbability = 0;

  function currentBucket(now: number): Bucket {
    // Evict buckets older than windowMs
    const cutoff = now - windowMs;
    buckets = buckets.filter((b) => b.ts >= cutoff);

    // Find or create the current bucket
    const currentTs = Math.floor(now / bucketInterval) * bucketInterval;
    let bucket = buckets.find((b) => b.ts === currentTs);
    if (bucket === undefined) {
      bucket = { ts: currentTs, requests: 0, accepts: 0 };
      buckets.push(bucket);
    }
    return bucket;
  }

  function totalRequests(): number {
    return buckets.reduce((sum, b) => sum + b.requests, 0);
  }

  function totalAccepts(): number {
    return buckets.reduce((sum, b) => sum + b.accepts, 0);
  }

  function computeP(): number {
    const reqs = totalRequests();
    const accs = totalAccepts();
    if (reqs === 0) return 0;
    return Math.max(0, (reqs - k * accs) / (reqs + 1));
  }

  const api: AdaptiveThrottle = {
    request(priority?: number): boolean {
      // Recompute probability based on current state (without modifying it)
      const now = clock.now();
      // Temporarily advance window by filtering old buckets
      const cutoff = now - windowMs;
      const currentBuckets = buckets.filter((b) => b.ts >= cutoff);
      const reqs = currentBuckets.reduce((sum, b) => sum + b.requests, 0);
      const accs = currentBuckets.reduce((sum, b) => sum + b.accepts, 0);
      const p = reqs === 0 ? 0 : Math.max(0, (reqs - k * accs) / (reqs + 1));

      _dropProbability = p;

      if (p <= 0) return true;

      const effectiveP = priority !== undefined ? p / Math.max(0.001, priority) : p;
      return Math.random() >= effectiveP;
    },

    record(accepted: boolean): void {
      const now = clock.now();
      const cb = currentBucket(now);
      cb.requests += 1;
      if (accepted) {
        cb.accepts += 1;
      }
      _dropProbability = computeP();
    },

    get dropProbability(): number {
      // Recompute on access to ensure up-to-date after time passing
      const now = clock.now();
      const cutoff = now - windowMs;
      buckets = buckets.filter((b) => b.ts >= cutoff);
      _dropProbability = computeP();
      return _dropProbability;
    },

    reset(): void {
      buckets = [];
      _dropProbability = 0;
    },
  };

  return api;
}
