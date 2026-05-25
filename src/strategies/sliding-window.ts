import type { Clock, RateLimitResult, StrategyResult } from '../core/types.js';
import {
  slidingWindowCounterConsume,
  type WindowCounterState,
} from './sliding-window-counter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State for the bucketed sliding window strategy.
 *
 * Float64Array layout:
 *   [0..buckets-1]  = bucket counts
 *   [buckets]       = last active absolute bucket index
 *
 * The absolute bucket index is `Math.floor(now / bucketSize)` where
 * `bucketSize = windowMs / buckets`.  It is never wrapped modulo
 * `buckets`; the wrap is applied only when indexing into the array.
 */
export type SlidingWindowState = Float64Array;

// ---------------------------------------------------------------------------
// Pure function — bucketed sliding window
// ---------------------------------------------------------------------------

/**
 * Consume `cost` capacity from a bucketed sliding window.
 *
 * @param state       - Current state or null for cold start
 * @param now         - Current time in epoch ms
 * @param cost        - Cost of this request
 * @param limit       - Max requests allowed per window
 * @param windowMs    - Window duration in ms
 * @param buckets     - Number of buckets (must be >= 1)
 */
export function slidingWindowConsume(
  state: SlidingWindowState | null,
  now: number,
  cost: number,
  limit: number,
  windowMs: number,
  buckets: number,
): StrategyResult<SlidingWindowState> {
  // Guard: cost exceeds limit — reject immediately
  if (cost > limit) {
    return {
      state: state ?? createEmptyState(now, windowMs, buckets),
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: windowMs,
      },
    };
  }

  // Guard: zero or negative cost — allow without consuming capacity
  if (cost <= 0) {
    return {
      state: state ?? createEmptyState(now, windowMs, buckets),
      result: {
        allowed: true,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      },
    };
  }

  const bucketSize = windowMs / buckets;
  const activeAbsIndex = Math.floor(now / bucketSize);

  // Initialise or copy state (copy-on-write)
  const newState = state === null
    ? createEmptyState(now, windowMs, buckets)
    : new Float64Array(state);

  // newState has length buckets+1, so index buckets is always valid
  const lastAbsIndex = newState[buckets]!;
  const elapsed = activeAbsIndex - lastAbsIndex;

  if (elapsed >= buckets) {
    // Full window rollover — every bucket is stale
    for (let i = 0; i < buckets; i++) {
      newState[i] = 0;
    }
  } else if (elapsed > 0) {
    // Zero only the buckets that have aged out of the window
    for (let i = 1; i <= elapsed; i++) {
      const bucketToZero = (lastAbsIndex + i) % buckets;
      newState[bucketToZero] = 0;
    }
  }

  newState[buckets] = activeAbsIndex;

  // Sum all active bucket counts
  let total = 0;
  for (let i = 0; i < buckets; i++) {
    // Loop bound i < buckets guarantees index is within [0, buckets-1]
    total += newState[i]!;
  }

  if (total + cost <= limit) {
    const bucketIdx = activeAbsIndex % buckets;
    // bucketIdx is in [0, buckets-1] by definition of modulo
    newState[bucketIdx]! += cost;
    return {
      state: newState,
      result: {
        allowed: true,
        limit,
        remaining: limit - total - cost,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      },
    };
  }

  // ── Rejected ──
  const deficit = total + cost - limit;
  const retryAfterMs = Math.ceil((deficit / limit) * windowMs);
  return {
    state: newState,
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
// Helpers
// ---------------------------------------------------------------------------

function createEmptyState(now: number, windowMs: number, buckets: number): SlidingWindowState {
  const bucketSize = windowMs / buckets;
  const activeAbsIndex = Math.floor(now / bucketSize);
  const state = new Float64Array(buckets + 1);
  state[buckets] = activeAbsIndex;
  return state;
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  buckets?: number;
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
 * Creates a bucketed sliding window strategy instance.
 *
 * When `buckets` is 1 the implementation delegates to
 * {@link slidingWindowCounterConsume} for exact semantic parity with the
 * sliding-window-counter strategy.
 *
 * @param options.limit    - Max requests per window
 * @param options.windowMs - Window duration in ms
 * @param options.buckets  - Number of buckets (default 10)
 * @param options.clock    - Clock instance (ManualClock in tests)
 */
export function createSlidingWindowStrategy(options: SlidingWindowOptions): Strategy {
  const { limit, windowMs, clock } = options;
  const buckets = options.buckets ?? 10;

  if (buckets === 1) {
    // Compatibility mode: exact sliding-window-counter semantics
    const states = new Map<string, WindowCounterState>();

    return {
      apply(key: string, cost: number = 1): RateLimitResult {
        const now = clock.now();
        const current = states.get(key) ?? null;
        const { state: newState, result } = slidingWindowCounterConsume(
          current,
          now,
          cost,
          windowMs,
          limit,
        );
        states.set(key, newState);
        return result;
      },

      peek(key: string): RateLimitResult | null {
        const state = states.get(key);
        if (!state) return null;
        const now = clock.now();
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const elapsed = (now - windowStart) / windowMs;
        const weight = Math.max(0, Math.min(1, 1 - elapsed));
        const estimated = state.prevCount * weight + state.currCount;
        return {
          allowed: estimated < limit,
          limit,
          remaining: Math.max(0, Math.floor(limit - estimated)),
          resetAt: windowStart + windowMs,
          retryAfterMs: 0,
        };
      },

      exportState(key: string): unknown {
        return states.get(key);
      },

      importState(key: string, rawState: unknown): void {
        if (
          rawState !== null &&
          typeof rawState === 'object' &&
          !Array.isArray(rawState) &&
          'prevCount' in (rawState as Record<string, unknown>) &&
          'currCount' in (rawState as Record<string, unknown>) &&
          'currentWindowStart' in (rawState as Record<string, unknown>)
        ) {
          const s = rawState as WindowCounterState;
          if (
            typeof s.prevCount === 'number' &&
            typeof s.currCount === 'number' &&
            typeof s.currentWindowStart === 'number' &&
            Number.isFinite(s.prevCount) &&
            Number.isFinite(s.currCount) &&
            Number.isFinite(s.currentWindowStart)
          ) {
            states.set(key, {
              prevCount: Math.floor(s.prevCount),
              currCount: Math.floor(s.currCount),
              currentWindowStart: s.currentWindowStart,
            });
          }
        }
      },

      reset(key: string): void {
        states.delete(key);
      },
    };
  }

  // Bucketed mode (buckets > 1)
  const states = new Map<string, SlidingWindowState>();

  return {
    apply(key: string, cost: number = 1): RateLimitResult {
      const now = clock.now();
      const current = states.get(key) ?? null;
      const { state: newState, result } = slidingWindowConsume(
        current,
        now,
        cost,
        limit,
        windowMs,
        buckets,
      );
      states.set(key, newState);
      return result;
    },

    peek(key: string): RateLimitResult | null {
      const state = states.get(key);
      if (!state) return null;
      const now = clock.now();
      const { result } = slidingWindowConsume(
        state,
        now,
        0, // cost = 0 to peek without mutating
        limit,
        windowMs,
        buckets,
      );
      // cost=0 path always returns allowed=true, remaining=limit;
      // compute the real remaining from the current total.
      let total = 0;
      for (let i = 0; i < buckets; i++) {
        // state is non-null here (checked above) and i < buckets guarantees valid index
        total += state[i]!;
      }
      return {
        allowed: total < limit,
        limit,
        remaining: Math.max(0, limit - total),
        resetAt: now + windowMs,
        retryAfterMs: 0,
      };
    },

    exportState(key: string): unknown {
      const state = states.get(key);
      return state ? Array.from(state) : undefined;
    },

    importState(key: string, rawState: unknown): void {
      if (Array.isArray(rawState) && rawState.length === buckets + 1) {
        const arr = new Float64Array(buckets + 1);
        for (let i = 0; i <= buckets; i++) {
          const v = rawState[i];
          if (typeof v === 'number' && Number.isFinite(v)) {
            arr[i] = v;
          }
        }
        states.set(key, arr);
      }
    },

    reset(key: string): void {
      states.delete(key);
    },
  };
}
