/**
 * Token Bucket rate-limiting strategy.
 *
 * Uses Float64Array(2) for state to avoid GC pressure:
 *   index 0 = current tokens (can be fractional)
 *   index 1 = last refill timestamp (epoch ms)
 *
 * Lazy refill: no background timer; tokens are computed on access.
 * When refillRate <= 0 the bucket never refills (useful for testing).
 */

import type { Clock, RateLimitResult, StrategyResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Consume `cost` tokens from a token bucket state.
 *
 * @param state   - Current state (Float64Array[2]) or null for fresh bucket
 * @param now     - Current time in epoch ms
 * @param cost    - Number of tokens to consume
 * @param capacity- Maximum token capacity
 * @param refillRate - Tokens added per second (0 = never refills)
 * @returns StrategyResult with new state and rate-limit result
 */
export function tokenBucketConsume(
  state: Float64Array | null,
  now: number,
  cost: number,
  capacity: number,
  refillRate: number,
): StrategyResult<Float64Array> {
  // Cost exceeds capacity: reject without consuming any tokens
  if (cost > capacity) {
    return {
      state: state ?? new Float64Array([capacity, now]),
      result: {
        allowed: false,
        limit: capacity,
        remaining: capacity,
        resetAt: now,
        retryAfterMs: Infinity,
      },
    };
  }

  // Lazy refill: compute elapsed seconds since last refill
  const lastRefill = state?.[1] ?? now;
  const elapsed = (now - lastRefill) / 1000;
  const tokens = Math.min(capacity, (state?.[0] ?? capacity) + elapsed * refillRate);

  // No tokens and no refill possible — blocked forever
  if (tokens <= 0 && refillRate <= 0) {
    return {
      state: new Float64Array([0, now]),
      result: {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetAt: now,
        retryAfterMs: Infinity,
      },
    };
  }

  if (tokens >= cost) {
    // Allowed: consume tokens
    const newTokens = tokens - cost;
    return {
      state: new Float64Array([newTokens, now]),
      result: {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(newTokens),
        resetAt: computeResetAt(newTokens, capacity, refillRate, now),
        retryAfterMs: 0,
      },
    };
  }

  // Blocked: not enough tokens
  const deficit = cost - tokens;
  const retryAfterMs =
    refillRate > 0 ? Math.ceil((deficit / refillRate) * 1000) : Infinity;
  return {
    state: new Float64Array([tokens, now]),
    result: {
      allowed: false,
      limit: capacity,
      remaining: 0,
      resetAt: now + retryAfterMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the epoch ms when the bucket will be full again.
 */
function computeResetAt(
  tokens: number,
  capacity: number,
  refillRate: number,
  now: number,
): number {
  if (refillRate <= 0) return Infinity;
  const deficit = capacity - tokens;
  return now + Math.ceil((deficit / refillRate) * 1000);
}

// ---------------------------------------------------------------------------
// Strategy interface for shared contract tests
// ---------------------------------------------------------------------------

export interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
  reset?(key: string): void;
}

/**
 * Create a Token Bucket strategy instance.
 *
 * @param options.capacity   - Max tokens the bucket can hold
 * @param options.refillRate - Tokens added per second
 * @param options.clock      - Clock implementation (injected)
 */
export function createTokenBucketStrategy(options: {
  capacity: number;
  refillRate: number;
  clock: Clock;
}): Strategy {
  const { capacity, refillRate, clock } = options;
  const stateMap = new Map<string, Float64Array>();

  return {
    apply(key: string, cost: number): RateLimitResult {
      // Early reject for cost > capacity (don't touch state map)
      if (cost > capacity) {
        return {
          allowed: false,
          limit: capacity,
          remaining: capacity,
          resetAt: clock.now(),
        retryAfterMs: 2147483647,
        };
      }

      const now = clock.now();
      const currentState = stateMap.get(key) ?? null;
      const { state, result } = tokenBucketConsume(
        currentState,
        now,
        cost,
        capacity,
        refillRate,
      );
      stateMap.set(key, state);
      return result;
    },

    peek(key: string): RateLimitResult | null {
      const state = stateMap.get(key);
      if (!state) return null;

      const now = clock.now();
      // Float64Array elements always return numbers (defaults to 0) — guaranteed safe
      const lastRefill = state[1]!;
      const currentTokens = state[0]!;
      const elapsed = (now - lastRefill) / 1000;
      const tokens = Math.min(capacity, currentTokens + elapsed * refillRate);

      return {
        allowed: tokens > 0,
        limit: capacity,
        remaining: Math.floor(tokens),
        resetAt: computeResetAt(tokens, capacity, refillRate, now),
        retryAfterMs: 0,
      };
    },

    /**
     * Export state as a plain number array for JSON serialization.
     */
    exportState(key: string): unknown {
      const state = stateMap.get(key);
      if (!state) return null;
      return Array.from(state);
    },

    /**
     * Import state from a previously exported value.
     * Accepts both Float64Array and plain number arrays.
     */
    importState(key: string, raw: unknown): void {
      if (raw === null || raw === undefined) return;
      const arr = raw as number[];
      stateMap.set(key, new Float64Array(arr));
    },

    reset(key: string): void {
      stateMap.delete(key);
    },
  };
}
