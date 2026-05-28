import type { Clock, RateLimitResult, StrategyResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State for the sliding window log strategy.
 * Sorted ascending array of request timestamps (epoch ms) within the current window.
 */
export type SlidingLogState = number[];

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Pure sliding window log rate-limit function.
 *
 * @param state  - Current state (sorted timestamps) or null for cold start
 * @param now    - Current time in epoch ms (from injected clock)
 * @param cost   - Cost of this request (number of capacity units to consume)
 * @param windowSizeMs - Sliding window duration in ms
 * @param max    - Maximum requests allowed per window
 */
export function slidingLogConsume(
  state: SlidingLogState | null,
  now: number,
  cost: number,
  windowSizeMs: number,
  max: number,
): StrategyResult<SlidingLogState> {
  // Guard: cost exceeds max — reject immediately without modifying state
  if (cost > max) {
    return {
      state: state ?? [],
      result: {
        allowed: false,
        limit: max,
        remaining: max,
        resetAt: now + windowSizeMs,
        retryAfterMs: windowSizeMs,
      },
    };
  }

  // Guard: zero or negative cost — allow without consuming capacity
  if (cost <= 0) {
    return {
      state: state ?? [],
      result: {
        allowed: true,
        limit: max,
        remaining: max,
        resetAt: now + windowSizeMs,
        retryAfterMs: 0,
      },
    };
  }

  const windowStart = now - windowSizeMs;
  const log = state ?? [];

  // Find first live entry — survivors are log[firstLive..length)
  const firstLive = binarySearchFirstGE(log, windowStart);
  const liveCount = log.length - firstLive;

  if (liveCount + cost <= max) {
    // ALLOW — single slice + append (no intermediate arrays)
    const newLog = log.slice(firstLive);        // one alloc
    for (let i = 0; i < cost; i++) newLog.push(now); // append in-place
    return {
      state: newLog,
      result: {
        allowed: true,
        limit: max,
        remaining: max - liveCount - cost,
        resetAt: now + windowSizeMs,
        retryAfterMs: 0,
      },
    };
  }

  // DENY — zero alloc: reuse the log array, just update the view
  const oldest = log[firstLive]!;
  const retryAfterMs = Math.max(0, oldest + windowSizeMs - now);
  // Only slice if we pruned entries, otherwise reuse
  const newState = firstLive === 0 ? log : log.slice(firstLive);
  return {
    state: newState,
    result: {
      allowed: false,
      limit: max,
      remaining: 0,
      resetAt: oldest + windowSizeMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Binary search helper
// ---------------------------------------------------------------------------

/**
 * Binary search for the first element >= target.
 * Returns arr.length if no such element exists.
 */
function binarySearchFirstGE(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // mid is in [0, arr.length) because lo < hi guarantees mid < arr.length
    if (arr[mid]! < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Strategy factory (in-memory, per-key state)
// ---------------------------------------------------------------------------

export interface SlidingLogOptions {
  limit: number;
  windowMs: number;
  clock: Clock;
}

export interface Strategy {
  apply(key: string, cost?: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
  reset?(key: string): void;
}

/**
 * Creates a sliding window log strategy instance.
 *
 * @param options.limit    - Max requests per window
 * @param options.windowMs - Window duration in ms
 * @param options.clock    - Clock instance (ManualClock in tests)
 */
export function createSlidingLogStrategy(options: SlidingLogOptions): Strategy {
  const { limit, windowMs, clock } = options;
  const states = new Map<string, SlidingLogState>();

  function getState(key: string): SlidingLogState | null {
    return states.get(key) ?? null;
  }

  function setState(key: string, state: SlidingLogState): void {
    states.set(key, state);
  }

  const strategy: Strategy = {
    apply(key: string, cost: number = 1): RateLimitResult {
      const now = clock.now();
      const current = getState(key);
      const { state: newState, result } = slidingLogConsume(
        current,
        now,
        cost,
        windowMs,
        limit,
      );
      setState(key, newState);
      return result;
    },

    peek(key: string): RateLimitResult | null {
      const state = getState(key);
      if (!state || state.length === 0) return null;
      const now = clock.now();
      const windowStart = now - windowMs;
      const firstValid = binarySearchFirstGE(state, windowStart);
      const pruned = state.slice(firstValid);
      return {
        allowed: pruned.length < limit,
        limit,
        remaining: Math.max(0, limit - pruned.length),
        resetAt: now + windowMs,
        retryAfterMs: 0,
      };
    },

    exportState(key: string): unknown {
      return getState(key);
    },

    importState(key: string, state: unknown): void {
      if (Array.isArray(state)) {
        // Validate that array contains only numbers
        if (state.every((v) => typeof v === 'number' && !Number.isNaN(v))) {
          setState(key, [...state]);
        }
      }
    },

    reset(key: string): void {
      states.delete(key);
    },
  };

  return strategy;
}
