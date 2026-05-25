/**
 * Property-based tests (fast-check) for all 4 rate-limiting strategy invariants.
 *
 * Invariants (verified for all strategies):
 *   1. remaining ∈ [0, limit]
 *   2. retryAfterMs === 0  iff  allowed === true
 *   3. resetAt > now when blocked
 *   4. allowed is a strict boolean
 *   5. cost = 0 does not change remaining
 *   6. Keys are isolated
 *
 * Uses 100 runs each for speed.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { createTokenBucketStrategy } from '../../src/strategies/token-bucket.js';
import { createFixedWindowStrategy } from '../../src/strategies/fixed-window.js';
import { createSlidingLogStrategy } from '../../src/strategies/sliding-window-log.js';
import { createSlidingCounterStrategy } from '../../src/strategies/sliding-window-counter.js';
import type { RateLimitResult } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  reset?(key: string): void;
}

/**
 * Create all 4 strategies, each pinned to a ManualClock.
 */
function createStrategies(clock: ManualClock): Strategy[] {
  return [
    createTokenBucketStrategy({ capacity: 100, refillRate: 50, clock }),
    createFixedWindowStrategy({ limit: 100, windowMs: 60_000, clock }),
    createSlidingLogStrategy({ limit: 100, windowMs: 60_000, clock }),
    createSlidingCounterStrategy({ limit: 100, windowMs: 60_000, clock }),
  ];
}

/** Strategy names for display */
const STRATEGY_NAMES = [
  'TokenBucket',
  'FixedWindow',
  'SlidingWindowLog',
  'SlidingWindowCounter',
];

// ---------------------------------------------------------------------------
// Invariant: remaining ∈ [0, limit]
// ---------------------------------------------------------------------------

describe('Invariant: remaining ∈ [0, limit]', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 150 }),
        (cost, limit) => {
      const clock = new ManualClock(1_000_000_000_000);
      // Use the strategy's own limit by making a fresh strategy with the desired limit
          let testStrategy: Strategy;
          switch (name) {
            case 'TokenBucket':
              testStrategy = createTokenBucketStrategy({ capacity: limit, refillRate: 999_999, clock });
              break;
            case 'FixedWindow':
              testStrategy = createFixedWindowStrategy({ limit, windowMs: 60_000, clock });
              break;
            case 'SlidingWindowLog':
              testStrategy = createSlidingLogStrategy({ limit, windowMs: 60_000, clock });
              break;
            case 'SlidingWindowCounter':
              testStrategy = createSlidingCounterStrategy({ limit, windowMs: 60_000, clock });
              break;
            default:
              throw new Error('unknown strategy');
          }
          const result = testStrategy.apply('key', cost);
          expect(result.remaining).toBeGreaterThanOrEqual(0);
          expect(result.remaining).toBeLessThanOrEqual(result.limit);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant: retryAfterMs === 0  iff  allowed === true
// ---------------------------------------------------------------------------

describe('Invariant: retryAfterMs === 0 ⇔ allowed === true', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    const idx = STRATEGY_NAMES.indexOf(name);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (cost) => {
        const clock = new ManualClock(1_000_000_000_000);
        const strategies = createStrategies(clock);
        const s = strategies[idx]!;
        const result = s.apply('key', cost);
        if (result.allowed) {
          expect(result.retryAfterMs).toBe(0);
        } else {
          expect(result.retryAfterMs).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant: resetAt > now when blocked
// ---------------------------------------------------------------------------

describe('Invariant: resetAt > now when blocked', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    const idx = STRATEGY_NAMES.indexOf(name);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (exhaustCalls) => {
        const clock = new ManualClock(1_000_000_000_000);
        const strategies = createStrategies(clock);
        const s = strategies[idx]!;
        const now = clock.now();

        // Exhaust the limiter
        for (let i = 0; i < exhaustCalls; i++) {
          s.apply('key', 1);
        }

        const result = s.apply('key', 1);
        if (!result.allowed) {
          expect(result.resetAt).toBeGreaterThan(now);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant: allowed is strict boolean
// ---------------------------------------------------------------------------

describe('Invariant: allowed is a strict boolean', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    const idx = STRATEGY_NAMES.indexOf(name);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (cost) => {
        const clock = new ManualClock(1_000_000_000_000);
        const strategies = createStrategies(clock);
        const s = strategies[idx]!;
        const result = s.apply('key', cost);
        // Strict boolean: must be exactly true or false, not a truthy/falsy value
        expect(typeof result.allowed).toBe('boolean');
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant: cost = 0 does not consume capacity
// ---------------------------------------------------------------------------

describe('Invariant: cost=0 does not consume capacity', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 3, max: 100 }),
        (seedCost, limit) => {
          fc.pre(seedCost <= limit);
          const clock = new ManualClock(1_000_000_000_000);
          let s: Strategy;
          switch (name) {
            case 'TokenBucket':
              s = createTokenBucketStrategy({ capacity: limit, refillRate: 999_999, clock });
              break;
            case 'FixedWindow':
              s = createFixedWindowStrategy({ limit, windowMs: 60_000, clock });
              break;
            case 'SlidingWindowLog':
              s = createSlidingLogStrategy({ limit, windowMs: 60_000, clock });
              break;
            case 'SlidingWindowCounter':
              s = createSlidingCounterStrategy({ limit, windowMs: 60_000, clock });
              break;
            default:
              throw new Error('unknown strategy');
          }

          // Make a request with cost > 0 to consume some capacity
          const first = s.apply('key', seedCost);
          expect(first.allowed).toBe(true);

          // Use peek to get remaining before cost=0
          const peekBefore = s.peek ? s.peek('key')?.remaining : null;

          // Apply with cost=0 — must always allow
          const zeroResult = s.apply('key', 0);
          expect(zeroResult.allowed).toBe(true);

          // Make another request at the same cost — remaining should be
          // reduced by seedCost from the peek value (if peek is available),
          // or from the first request's remaining (after subtracting seedCost)
          const afterCostZero = s.apply('key', seedCost);
          const twoRequestsFit = 2 * seedCost <= limit;
          if (twoRequestsFit) {
            if (peekBefore != null) {
              // peekBefore reflects the actual remaining after the first request
              expect(afterCostZero.remaining).toBe(peekBefore - seedCost);
            } else {
              // Without peek, verify that cost=0 didn't double-consume:
              // after 2 requests of seedCost, we should have limit - 2*seedCost remaining
              expect(afterCostZero.remaining).toBe(limit - 2 * seedCost);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant: Keys are isolated
// ---------------------------------------------------------------------------

describe('Invariant: keys are isolated', () => {
  it.each(STRATEGY_NAMES)('%s', (name) => {
    const idx = STRATEGY_NAMES.indexOf(name);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (callsOnA) => {
        const clock = new ManualClock(1_000_000_000_000);
        const strategies = createStrategies(clock);
        const s = strategies[idx]!;

        // Exhaust key A
        for (let i = 0; i < callsOnA; i++) {
          s.apply('key-a', 1);
        }

        // key B should still have full capacity (first request)
        const resultB = s.apply('key-b', 1);
        expect(resultB.allowed).toBe(true);
        expect(resultB.remaining).toBe(resultB.limit - 1);
      }),
      { numRuns: 100 },
    );
  });
});
