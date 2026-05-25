/**
 * Limiter class and rateLimit() factory.
 *
 * Wires a Strategy + Store + Clock together to provide a Limiter interface.
 * Uses store.apply() for atomic check() and stores state in the backing store.
 */

import type { Limiter, RateLimitOptions, RateLimitResult, Store } from './types.js';
import { SystemClock } from './clock.js';
import { MemoryStore } from '../stores/memory-store.js';
import { createTokenBucketStrategy } from '../strategies/token-bucket.js';
import { createFixedWindowStrategy } from '../strategies/fixed-window.js';
import { createSlidingLogStrategy } from '../strategies/sliding-window-log.js';
import { createSlidingCounterStrategy } from '../strategies/sliding-window-counter.js';

// ---------------------------------------------------------------------------
// Internal strategy interface
// ---------------------------------------------------------------------------

/**
 * Internal strategy interface that all 4 strategy factories satisfy.
 */
interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
  reset?(key: string): void;
}

// ---------------------------------------------------------------------------
// LimiterImpl
// ---------------------------------------------------------------------------

/**
 * Limiter implementation that wires a Strategy + Store + Clock.
 *
 * For `check()`:
 *   Uses store.apply() for atomic read-modify-write.
 *   Imports state from store into strategy, runs the strategy, then exports
 *   the new state back into the store.
 *
 * For `peek()`:
 *   Reads state from store, runs the strategy, then reverts the strategy's
 *   internal state so that peek() is non-mutating.
 */
export class LimiterImpl implements Limiter {
  constructor(
    private strategy: Strategy,
    private store: Store,
    private ttlMs: number,
  ) {}

  async check(key: string, cost: number = 1): Promise<RateLimitResult> {
    return this.store.apply<unknown, RateLimitResult>(
      key,
      this.ttlMs,
      (rawState: unknown | null) => {
        // Import existing state from store into strategy
        if (rawState !== null && rawState !== undefined) {
          this.strategy.importState?.(key, rawState);
        }

        // Run the strategy (mutates strategy's internal state map)
        const result = this.strategy.apply(key, cost);

        // Export new state from strategy back to the store for persistence
        const newState = this.strategy.exportState?.(key);

        return { state: newState as unknown, result };
      },
    );
  }

  /**
   * Peek at the current rate-limit state WITHOUT consuming capacity.
   * Does NOT mutate the backing store or the strategy's internal state.
   *
   * Uses strategy.peek() when available (non-mutating by design).
   * Falls back to strategy.apply(key, 0) which does not consume capacity
   * for all 4 strategies (cost=0 is a no-op guard).
   */
  async peek(key: string, _cost: number = 1): Promise<RateLimitResult> {
    // Read current raw state from store (without modifying it)
    const rawState = this.store.get
      ? await this.store.get<unknown>(key)
      : null;

    // Save any existing strategy-internal state for this key
    const savedState = this.strategy.exportState?.(key);

    // Temporarily load store state into strategy
    if (rawState !== null && rawState !== undefined) {
      this.strategy.importState?.(key, rawState);
    } else if (this.strategy.reset) {
      // No state in store — clear from strategy to start fresh
      this.strategy.reset(key);
    }

    // Use strategy.peek() if available (truly non-mutating)
    // Otherwise fall back to apply(key, 0) which doesn't consume
    let result: RateLimitResult;
    const peeked = this.strategy.peek?.(key);
    if (peeked !== null && peeked !== undefined) {
      result = peeked;
    } else {
      // Fallback: cost=0 doesn't consume in any strategy
      result = this.strategy.apply(key, 0);
    }

    // REVERT: restore strategy's internal state to what it was before peek
    if (savedState !== null && savedState !== undefined) {
      this.strategy.importState?.(key, savedState);
    } else if (this.strategy.reset) {
      this.strategy.reset(key);
    }

    return result;
  }

  /**
   * Reset the rate-limit state for a key.
   */
  async reset(key: string): Promise<void> {
    if (this.store.delete) {
      await this.store.delete(key);
    }
    // Also clear strategy's internal state
    this.strategy.reset?.(key);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rate limiter from a RateLimitOptions configuration.
 *
 * @example
 * ```typescript
 * import { rateLimit } from 'throttlekit';
 *
 * const limiter = rateLimit({
 *   strategy: 'token-bucket',
 *   capacity: 10,
 *   refillRate: 1,
 * });
 *
 * const result = await limiter.check('user:123');
 * ```
 */
export function rateLimit(options: RateLimitOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  let strategy: Strategy;
  let ttlMs = options.ttlMs;

  switch (options.strategy) {
    case 'token-bucket': {
      const capacity = options.capacity as number;
      const refillRate = options.refillRate as number;
      strategy = createTokenBucketStrategy({ capacity, refillRate, clock });
      ttlMs ??=
        refillRate > 0
          ? Math.ceil((capacity / refillRate) * 1000) + 1000
          : 60_000;
      break;
    }
    case 'fixed-window': {
      const limit = options.limit as number;
      const windowMs = options.windowMs as number;
      strategy = createFixedWindowStrategy(limit, windowMs, clock);
      ttlMs ??= windowMs;
      break;
    }
    case 'sliding-window-log': {
      const limit = options.limit as number;
      const windowMs = options.windowMs as number;
      strategy = createSlidingLogStrategy({ limit, windowMs, clock });
      ttlMs ??= windowMs;
      break;
    }
    case 'sliding-window-counter': {
      const limit = options.limit as number;
      const windowMs = options.windowMs as number;
      strategy = createSlidingCounterStrategy({ limit, windowMs, clock });
      ttlMs ??= windowMs * 2;
      break;
    }
    default: {
      throw new Error(`Unknown strategy: ${options.strategy}`);
    }
  }

  return new LimiterImpl(strategy, store, ttlMs ?? 60_000);
}
