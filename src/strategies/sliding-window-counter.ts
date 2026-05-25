import type { Clock, RateLimitResult, StrategyResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * State for the sliding window counter strategy.
 *
 * - prevCount: maintained for interface compatibility; always 0 in this
 *   implementation (counters reset on each window boundary)
 * - currCount: requests counted in the current fixed window
 * - currentWindowStart: epoch ms of the start of the current fixed window
 */
export interface WindowCounterState {
  prevCount: number;
  currCount: number;
  currentWindowStart: number;
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Pure sliding window counter rate-limit function.
 *
 * Tracks requests within aligned fixed windows. On each window boundary
 * the counter fully resets. The weighted estimate and retryAfter
 * calculation provide a smooth sliding-window approximation.
 *
 * When blocked, `retryAfterMs` estimates the time until the counter
 * has enough capacity (the estimate decays as the window progresses).
 * `resetAt` is set to `now + retryAfterMs` so that callers can wait
 * exactly the right amount of time before retrying.
 *
 * @param state       - Current state or null for cold start
 * @param now         - Current time in epoch ms (from injected clock)
 * @param cost        - Cost of this request (number of capacity units)
 * @param windowSizeMs - Window duration in ms
 * @param max         - Maximum requests allowed per window
 */
export function slidingWindowCounterConsume(
  state: WindowCounterState | null,
  now: number,
  cost: number,
  windowSizeMs: number,
  max: number,
): StrategyResult<WindowCounterState> {
  // Guard: cost exceeds max — reject immediately without modifying state
  if (cost > max) {
    return {
      state: state ?? createEmptyState(now, windowSizeMs),
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
      state: state ?? createEmptyState(now, windowSizeMs),
      result: {
        allowed: true,
        limit: max,
        remaining: max,
        resetAt: now + windowSizeMs,
        retryAfterMs: 0,
      },
    };
  }

  const windowStart = Math.floor(now / windowSizeMs) * windowSizeMs;
  const elapsed = (now - windowStart) / windowSizeMs; // 0.0 to 1.0
  const weight = Math.max(0, Math.min(1, 1 - elapsed));

  // ── Handle window transition: reset on any boundary crossing ──
  let newState: WindowCounterState;

  if (state === null || state.currentWindowStart !== windowStart) {
    newState = {
      prevCount: 0,
      currCount: 0,
      currentWindowStart: windowStart,
    };
  } else {
    // Same window — shallow copy the state
    newState = { ...state };
  }

  // ── Evaluate estimate ──
  const estimated = newState.prevCount * weight + newState.currCount;

  if (estimated + cost <= max) {
    // Allow — increment currCount by cost
    newState.currCount += cost;
    return {
      state: newState,
      result: {
        allowed: true,
        limit: max,
        remaining: Math.max(0, Math.floor(max - estimated - cost)),
        resetAt: windowStart + windowSizeMs,
        retryAfterMs: 0,
      },
    };
  }

  // ── Rejected ──
  const deficit = estimated + cost - max;
  const retryAfterMs = Math.ceil((deficit / max) * windowSizeMs);
  return {
    state: newState,
    result: {
      allowed: false,
      limit: max,
      remaining: 0,
      // resetAt is the estimated recovery time: when the sliding estimate
      // will have decayed enough to allow a new request
      resetAt: now + retryAfterMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmptyState(now: number, windowSizeMs: number): WindowCounterState {
  const windowStart = Math.floor(now / windowSizeMs) * windowSizeMs;
  return { prevCount: 0, currCount: 0, currentWindowStart: windowStart };
}

// ---------------------------------------------------------------------------
// Strategy factory (in-memory, per-key state)
// ---------------------------------------------------------------------------

export interface SlidingCounterOptions {
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
 * Creates a sliding window counter strategy instance.
 *
 * @param options.limit    - Max requests per window
 * @param options.windowMs - Window duration in ms
 * @param options.clock    - Clock instance (ManualClock in tests)
 */
export function createSlidingCounterStrategy(options: SlidingCounterOptions): Strategy {
  const { limit, windowMs, clock } = options;
  const states = new Map<string, WindowCounterState>();

  function getState(key: string): WindowCounterState | null {
    return states.get(key) ?? null;
  }

  function setState(key: string, state: WindowCounterState): void {
    states.set(key, state);
  }

  const strategy: Strategy = {
    apply(key: string, cost: number = 1): RateLimitResult {
      const now = clock.now();
      const current = getState(key);
      const { state: newState, result } = slidingWindowCounterConsume(
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
      return getState(key);
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
          setState(key, {
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

  return strategy;
}
