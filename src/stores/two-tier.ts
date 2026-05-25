/**
 * Two-tier Store — layers a fast in-memory L1 cache in front of a
 * (potentially slower) L2 backing store.
 *
 * Three modes:
 *   'strict'      — every check hits L2 (passthrough)
 *   'cached-deny' — L1 caches denial results for retryAfterMs; passes through
 *                   on allowed or cache miss
 *   'leased'      — L1 holds a batch of tokens fetched from L2; refills when
 *                   remaining drops below lowWater
 *
 * @example
 * ```ts
 * import { createTwoTierStore } from './two-tier.js';
 * import { createRedisStore } from './redis.js';
 *
 * const l2 = await createRedisStore({ url: 'redis://localhost:6379' });
 * const store = createTwoTierStore({
 *   strategy: 'token-bucket',
 *   l2,
 *   mode: 'cached-deny',
 * });
 * ```
 */

import type { Clock, RateLimitResult, Store } from '../core/types.js';
import type { LeaseConfig, TwoTierMode } from '../core/types.js';
import { MemoryStore } from './memory-store.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class UnsupportedOperationError extends Error {
  constructor(message: string = 'Operation not supported by this store') {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TwoTierStoreOptions {
  /** Strategy name (for logging / diagnostics) */
  strategy?: string;
  /** L2 backing store (e.g. RedisStore) */
  l2: Store;
  /** Two-tier mode */
  mode: TwoTierMode;
  /** Lease configuration (required for 'leased' mode) */
  lease?: LeaseConfig;
  /** Clock (defaults to ManualClock wrapping Date.now) */
  clock?: Clock;
}

// ---------------------------------------------------------------------------
// Cached denial payload stored in L1
// ---------------------------------------------------------------------------

interface CachedDenial {
  retryAfterMs: number;
  limit: number;
  resetAt: number;
}

// ---------------------------------------------------------------------------
// Leased state stored in L1
// ---------------------------------------------------------------------------

interface LeasedState {
  remaining: number;
  limit: number;
  resetAt: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a two-tier store that layers an in-memory L1 cache in front of an L2
 * backing store for reduced latency on repeated denials or leased token batches.
 */
export function createTwoTierStore(options: TwoTierStoreOptions): Store {
  const { l2, mode, lease, clock } = options;
  const l1 = new MemoryStore({ clock: clock ?? { now: () => Date.now() } });

  return {
    // -----------------------------------------------------------------------
    // apply — main rate-limit path
    // -----------------------------------------------------------------------
    async apply<S, T>(
      key: string,
      ttlMs: number,
      transform: (state: S | null) => { state: S; result: T },
    ): Promise<T> {
      switch (mode) {
        case 'strict':
          // Every check hits L2 directly — no caching
          return l2.apply<S, T>(key, ttlMs, transform);

        case 'cached-deny': {
          // Check L1 for a cached denial
          const cached = await l1.get<CachedDenial>(key);
          if (cached !== null) {
            // Return cached denial result
            return {
              allowed: false,
              limit: cached.limit,
              remaining: 0,
              resetAt: cached.resetAt,
              retryAfterMs: cached.retryAfterMs,
            } as T;
          }

          // No cached denial — hit L2
          const result = await l2.apply<S, T>(key, ttlMs, transform);

          // If L2 denied, cache the denial in L1 with TTL = retryAfterMs
          if (typeof result === 'object' && result !== null && !(result as any).allowed) {
            const r = result as any as RateLimitResult;
            const cacheTtl = Math.max(r.retryAfterMs, 1);
            await l1.set<CachedDenial>(key, {
              retryAfterMs: r.retryAfterMs,
              limit: r.limit,
              resetAt: r.resetAt,
            }, cacheTtl);
          }

          return result;
        }

        case 'leased': {
          const batch = lease?.batch ?? 10;
          const lowWater = lease?.lowWater ?? Math.max(1, Math.floor(batch / 4));

          // Read current leased state from L1
          const leased = await l1.get<LeasedState>(key);

          // If no lease exists or remaining is below low-water, refill from L2
          if (leased === null || leased.remaining < lowWater) {
            // Attempt to acquire a batch from L2
            // We apply the transform and capture the result
            const l2Result = await l2.apply<S, T>(key, ttlMs, transform);
            const r = l2Result as any as RateLimitResult;

            if (r.allowed) {
              // Got capacity — store batch in L1
              const newRemaining = Math.min(batch - 1, r.remaining);
              await l1.set<LeasedState>(key, {
                remaining: newRemaining,
                limit: batch,
                resetAt: r.resetAt,
              }, ttlMs);

              return {
                allowed: true,
                limit: batch,
                remaining: newRemaining,
                resetAt: r.resetAt,
                retryAfterMs: 0,
              } as T;
            }

            // L2 denied — propagate denial
            return l2Result;
          }

          // Consume from L1 lease
          const newRemaining = leased.remaining - 1;
          await l1.set<LeasedState>(key, {
            remaining: newRemaining,
            limit: leased.limit,
            resetAt: leased.resetAt,
          }, ttlMs);

          return {
            allowed: true,
            limit: leased.limit,
            remaining: newRemaining,
            resetAt: leased.resetAt,
            retryAfterMs: 0,
          } as T;
        }

        default:
          throw new Error(`Unknown two-tier mode: ${mode as string}`);
      }
    },

    // -----------------------------------------------------------------------
    // get
    // -----------------------------------------------------------------------
    async get<T>(key: string): Promise<T | null> {
      // Check L1 first for cached data, fall back to L2
      const l1Val = await l1.get<T>(key);
      if (l1Val !== null) return l1Val;
      if (l2.get) return l2.get<T>(key);
      return null;
    },

    // -----------------------------------------------------------------------
    // set
    // -----------------------------------------------------------------------
    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
      // Write to both tiers
      await l1.set(key, value, ttlMs);
      if (l2.set) await l2.set(key, value, ttlMs);
    },

    // -----------------------------------------------------------------------
    // delete
    // -----------------------------------------------------------------------
    async delete(key: string): Promise<void> {
      await l1.delete(key);
      if (l2.delete) await l2.delete(key);
    },
  };
}
