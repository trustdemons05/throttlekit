/**
 * GCRA (Generic Cell Rate Algorithm) rate-limiting strategy.
 *
 * Also known as the leaky bucket algorithm with burst support.
 * Uses Float64Array(1) for state: [tat] (Theoretical Arrival Time).
 *
 * Algorithm:
 *   emission_interval = periodMs / limit
 *   burst_offset = burst * emission_interval
 *   new_tat = max(now, tat) + emission_interval * cost
 *   allowed if new_tat - burst_offset <= now
 *   remaining = floor((burst_offset - (new_tat - now)) / emission_interval) clamped [0, burst]
 *
 * Lua constant `gcraLua` is provided for Redis atomic operations.
 */

import type { Clock, RateLimitResult, StrategyResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Consume `cost` units from a GCRA state.
 *
 * @param state     - Current state (Float64Array[1]) or null for fresh state
 * @param now       - Current time in epoch ms (from injected clock)
 * @param cost      - Number of units to consume
 * @param limit     - Maximum sustained rate (requests per periodMs)
 * @param periodMs  - Period in milliseconds over which the limit applies
 * @param burst     - Maximum burst size (defaults to limit)
 * @returns StrategyResult with new state and rate-limit result
 */
export function gcraConsume(
  state: Float64Array | null,
  now: number,
  cost: number,
  limit: number,
  periodMs: number,
  burst: number,
): StrategyResult<Float64Array> {
  const emissionInterval = periodMs / limit;
  const burstOffset = burst * emissionInterval;

  // Cost exceeds limit: reject immediately without modifying state
  if (cost > limit) {
    return {
      state: state ?? new Float64Array([now]),
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now,
        retryAfterMs: Infinity,
      },
    };
  }

  // Zero or negative cost: allow without consuming capacity
  if (cost <= 0) {
    const tat = state?.[0] ?? now;
    const headroom = burstOffset - (tat - now);
    const remaining = Math.max(0, Math.min(burst, Math.floor(headroom / emissionInterval)));
    return {
      state: state ?? new Float64Array([now]),
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt: now + burstOffset,
        retryAfterMs: 0,
      },
    };
  }

  const tat = state?.[0] ?? now;
  const newTat = Math.max(now, tat) + emissionInterval * cost;

  if (newTat - burstOffset <= now) {
    // Allowed — advance TAT
    const headroom = burstOffset - (newTat - now);
    const remaining = Math.max(0, Math.min(burst, Math.floor(headroom / emissionInterval)));

    return {
      state: new Float64Array([newTat]),
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt: now + burstOffset,
        retryAfterMs: 0,
      },
    };
  }

  // Blocked — TAT unchanged
  const retryAfterMs = Math.max(0, newTat - burstOffset - now);
  return {
    state: new Float64Array([tat]),
    result: {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: now + retryAfterMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Lua script constant for Redis atomic GCRA operations
// ---------------------------------------------------------------------------

/**
 * Redis Lua script for atomic GCRA rate limiting.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = emission_interval (ms)
 * ARGV[2] = burst_offset (ms)
 * ARGV[3] = now (epoch ms)
 * ARGV[4] = burst (max burst count)
 * ARGV[5] = limit (max rate)
 * ARGV[6] = ttl_ms (TTL for the key)
 *
 * Returns: { allowed: 1|0, remaining: number, retryAfterMs: number }
 */
export const gcraLua: string = `
local tat = redis.call('GET', KEYS[1])
if not tat then
    tat = ARGV[3]
end

local now = tonumber(ARGV[3])
local emission_interval = tonumber(ARGV[1])
local burst_offset = tonumber(ARGV[2])
local burst = tonumber(ARGV[4])
local limit = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

local new_tat = math.max(now, tonumber(tat)) + emission_interval

if new_tat - burst_offset <= now then
    redis.call('SET', KEYS[1], new_tat, 'PX', ttl)
    local headroom = burst_offset - (new_tat - now)
    local remaining = math.floor(headroom / emission_interval)
    if remaining > burst then remaining = burst end
    if remaining < 0 then remaining = 0 end
    return {1, remaining, 0}
else
    local retryAfter = math.max(0, new_tat - burst_offset - now)
    return {0, 0, retryAfter}
end
`.trim();

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
  reset?(key: string): void;
}

export interface GcraOptions {
  limit: number;
  periodMs: number;
  burst?: number;
  clock: Clock;
}

/**
 * Create a GCRA strategy instance.
 *
 * @param options.limit    - Maximum sustained rate (requests per periodMs)
 * @param options.periodMs - Period in milliseconds over which limit applies
 * @param options.burst    - Maximum burst size (defaults to limit)
 * @param options.clock    - Clock implementation (injected for deterministic testing)
 */
export function createGcraStrategy(options: GcraOptions): Strategy {
  const { limit, periodMs, clock } = options;
  const burst = options.burst ?? limit;
  const stateMap = new Map<string, Float64Array>();

  return {
    apply(key: string, cost: number = 1): RateLimitResult {
      const now = clock.now();
      const currentState = stateMap.get(key) ?? null;
      const { state: newState, result } = gcraConsume(currentState, now, cost, limit, periodMs, burst);
      stateMap.set(key, newState);
      return result;
    },

    peek(key: string): RateLimitResult | null {
      const state = stateMap.get(key);
      if (!state) return null;

      const now = clock.now();
      const emissionInterval = periodMs / limit;
      const burstOffset = burst * emissionInterval;
      const tat = state[0];

      // Show the current remaining capacity without mutating state
      const headroom = burstOffset - (tat - now);
      const remaining = Math.max(0, Math.min(burst, Math.floor(headroom / emissionInterval)));

      return {
        allowed: true,
        limit,
        remaining,
        resetAt: now + burstOffset,
        retryAfterMs: 0,
      };
    },

    exportState(key: string): unknown {
      const state = stateMap.get(key);
      if (!state) return null;
      return Array.from(state);
    },

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
