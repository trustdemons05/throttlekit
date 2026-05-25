/**
 * Fixed Window rate-limiting strategy.
 *
 * Tracks request count within aligned calendar windows.
 * The window is determined by: windowStart = floor(now / windowMs) * windowMs
 *
 * ── Known property: 2× boundary burst ──
 * A client can send LIMIT requests just before the window boundary and
 * another LIMIT requests just after, resulting in 2× throughput at the
 * boundary. This is a documented characteristic of fixed-window strategies
 * (not a bug). For stricter rate enforcement use sliding window.
 */

import type { Clock, RateLimitResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface FixedWindowState {
  /** Start of the current window (epoch ms) */
  windowStart: number;
  /** Total count of tokens consumed in this window */
  count: number;
}

// ---------------------------------------------------------------------------
// Strategy factory
// ---------------------------------------------------------------------------

export interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
}

/**
 * Create a Fixed Window strategy instance.
 *
 * @param limit    - Maximum requests allowed per window
 * @param windowMs - Window duration in milliseconds
 * @param clock    - Clock implementation (injected for deterministic testing)
 */
export function createFixedWindowStrategy(
  limit: number,
  windowMs: number,
  clock: Clock,
): Strategy {
  const stateMap = new Map<string, FixedWindowState>();

  return {
    apply(key: string, cost: number): RateLimitResult {
      const now = clock.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;

      // Cost exceeds limit: reject without consuming
      if (cost > limit) {
        return {
          allowed: false,
          limit,
          remaining: limit,
          resetAt: now,
          retryAfterMs: Infinity,
        };
      }

      const state = stateMap.get(key) ?? null;

      // New window or first request → start fresh window
      if (state === null || state.windowStart !== windowStart) {
        stateMap.set(key, { windowStart, count: cost });
        return {
          allowed: true,
          limit,
          remaining: limit - cost,
          resetAt,
          retryAfterMs: 0,
        };
      }

      // Within current window — check capacity
      const newCount = state.count + cost;
      if (newCount <= limit) {
        state.count = newCount;
        return {
          allowed: true,
          limit,
          remaining: limit - newCount,
          resetAt,
          retryAfterMs: 0,
        };
      }

      // Blocked — window still has capacity
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterMs: resetAt - now,
      };
    },

    peek(key: string): RateLimitResult | null {
      const state = stateMap.get(key);
      if (!state) return null;

      const now = clock.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;

      // If a new window has started, capacity is fully available
      if (state.windowStart !== windowStart) {
        return {
          allowed: true,
          limit,
          remaining: limit,
          resetAt,
          retryAfterMs: 0,
        };
      }

      return {
        allowed: state.count < limit,
        limit,
        remaining: Math.max(0, limit - state.count),
        resetAt,
        retryAfterMs: 0,
      };
    },

    exportState(key: string): unknown {
      return stateMap.get(key) ?? null;
    },

    importState(key: string, raw: unknown): void {
      if (raw === null || raw === undefined) return;
      stateMap.set(key, raw as FixedWindowState);
    },
  };
}
