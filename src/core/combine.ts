/**
 * Combine multiple limiters into a single composite Limiter.
 *
 * All limiters must allow for the composite to allow.
 * The composite returns:
 *   - remaining: the minimum remaining across all limiters
 *   - resetAt: the maximum resetAt across all limiters
 *   - retryAfterMs: derived from the composite resetAt
 *
 * Short-circuits on the first limiter that blocks.
 */

import type { Limiter, RateLimitResult } from './types.js';

/**
 * Combine multiple limiters into a single Limiter.
 *
 * @param limiters - One or more Limiter instances
 * @returns A composite Limiter that checks all limiters
 *
 * @example
 * ```typescript
 * const ipLimiter = rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 });
 * const userLimiter = rateLimit({ strategy: 'fixed-window', limit: 10, windowMs: 60_000 });
 * const combined = combine(ipLimiter, userLimiter);
 *
 * await combined.check('user:123'); // checks both limiters
 * ```
 */
export function combine(...limiters: Limiter[]): Limiter {
  return {
    async check(key: string, cost?: number): Promise<RateLimitResult> {
      let minRemaining = Infinity;
      let maxResetAt = 0;
      let compositeLimit = 0;

      for (const limiter of limiters) {
        const result = await limiter.check(key, cost);

        // Short-circuit: if any limiter blocks, propagate its result
        if (!result.allowed) {
          return result;
        }

        minRemaining = Math.min(minRemaining, result.remaining);
        maxResetAt = Math.max(maxResetAt, result.resetAt);

        // Track the composite limit as the minimum of all limiter limits
        compositeLimit =
          compositeLimit === 0
            ? result.limit
            : Math.min(compositeLimit, result.limit);
      }

      return {
        allowed: true,
        limit: compositeLimit,
        remaining: minRemaining,
        resetAt: maxResetAt,
        retryAfterMs: 0,
      };
    },
  };
}
