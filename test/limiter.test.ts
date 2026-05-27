/**
 * Integration tests for LimiterImpl and rateLimit() factory.
 *
 * Tests cover:
 *   - rateLimit() creates working limiter for each strategy
 *   - check() allows then blocks
 *   - check() with cost > 1
 *   - peek() does not mutate state
 *   - reset() clears state
 *   - per-key isolation
 *   - default MemoryStore and SystemClock
 */

import { describe, it, expect } from 'vitest';
import { LimiterImpl, rateLimit } from '../src/core/limiter.js';
import { tokenBucket, fixedWindow, slidingWindowLog, slidingWindowCounter } from '../src/core/factories.js';
import { ManualClock } from '../src/core/clock.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import type { Limiter } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLimiter(
  strategy: string,
): { limiter: Limiter; clock: ManualClock; store: MemoryStore } {
  const clock = new ManualClock(1000000);
  const store = new MemoryStore({ clock });

  const base = { clock, store };

  switch (strategy) {
    case 'token-bucket':
      return {
        limiter: tokenBucket({
          ...base,
          capacity: 10,
          refillRate: 1,
        }),
        clock,
        store,
      };
    case 'fixed-window':
      return {
        limiter: fixedWindow({
          ...base,
          limit: 5,
          windowMs: 1000,
        }),
        clock,
        store,
      };
    case 'sliding-window-log':
      return {
        limiter: slidingWindowLog({
          ...base,
          limit: 5,
          windowMs: 1000,
        }),
        clock,
        store,
      };
    case 'sliding-window-counter':
      return {
        limiter: slidingWindowCounter({
          ...base,
          limit: 5,
          windowMs: 1000,
        }),
        clock,
        store,
      };
    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }
}

// ---------------------------------------------------------------------------
// Shared tests for all strategies
// ---------------------------------------------------------------------------

const STRATEGIES = [
  'token-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
] as const;

describe.each(STRATEGIES)('rateLimit with %s strategy', (strategyName) => {
  describe('check()', () => {
    it('allows first request and returns correct remaining', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      // Advance clock slightly so token bucket refills properly
      clock.advanceBy(100);

      const result = await limiter.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.limit).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBe(0);
    });

    it('blocks after exhausting capacity', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      clock.advanceBy(100);

      // Determine how many requests exhaust the limiter
      let limit = 0;
      if (strategyName === 'token-bucket') {
        limit = 10; // capacity
      } else {
        limit = 5; // fixed/sliding limit
      }

      // Exhaust all but 1
      for (let i = 0; i < limit - 1; i++) {
        const r = await limiter.check('test-key');
        expect(r.allowed).toBe(true);
      }

      // Last allowed request
      const last = await limiter.check('test-key');
      expect(last.allowed).toBe(true);

      // Should now be blocked
      const blocked = await limiter.check('test-key');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('handles cost > 1', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      clock.advanceBy(100);

      // A high-cost request should consume multiple units
      const r1 = await limiter.check('cost-key', 3);
      if (strategyName === 'token-bucket') {
        expect(r1.allowed).toBe(true);
      } else {
        // For window-based strategies, cost=3 should be fine if limit >= 3
        expect(r1.allowed).toBe(true);
      }
    });

    it('enforces per-key isolation', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      clock.advanceBy(100);

      const limit = strategyName === 'token-bucket' ? 10 : 5;

      // Exhaust key A
      for (let i = 0; i < limit; i++) {
        await limiter.check('key-a');
      }
      const blockA = await limiter.check('key-a');
      expect(blockA.allowed).toBe(false);

      // Key B should still be fresh
      const freshB = await limiter.check('key-b');
      expect(freshB.allowed).toBe(true);
      expect(freshB.remaining).toBe(limit - 1);
    });
  });

  describe('peek()', () => {
    it('does not mutate state', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      clock.advanceBy(100);

      // Check once
      const r1 = await limiter.check('peek-key');
      expect(r1.allowed).toBe(true);
      const remainingAfterCheck = r1.remaining;

      // Peek should return same state without consuming
      const peekResult = await (limiter as LimiterImpl).peek('peek-key');
      expect(peekResult.remaining).toBe(remainingAfterCheck);

      // A second check should see same state as if peek never happened
      const r2 = await limiter.check('peek-key');
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(remainingAfterCheck - 1);
    });

    it('returns null-like state for unknown key', async () => {
      const { limiter } = createLimiter(strategyName);
      const result = await (limiter as LimiterImpl).peek('unknown-key');
      // Should still return a valid RateLimitResult, not throw
      expect(result).toBeDefined();
      expect(typeof result.allowed).toBe('boolean');
    });
  });

  describe('reset()', () => {
    it('clears state for a key', async () => {
      const { limiter, clock } = createLimiter(strategyName);
      clock.advanceBy(100);

      const limit = strategyName === 'token-bucket' ? 10 : 5;

      // Exhaust the key
      for (let i = 0; i < limit; i++) {
        await limiter.check('reset-key');
      }
      const blocked = await limiter.check('reset-key');
      expect(blocked.allowed).toBe(false);

      // Reset and try again
      await (limiter as LimiterImpl).reset('reset-key');
      clock.advanceBy(100);

      const afterReset = await limiter.check('reset-key');
      expect(afterReset.allowed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Default store/clock integration
// ---------------------------------------------------------------------------

describe('rateLimit defaults', () => {
  it('uses MemoryStore and SystemClock by default', async () => {
    const limiter = fixedWindow({
      limit: 5,
      windowMs: 1000,
    });

    const result = await limiter.check('default-key');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
  });

  it('accepts explicit store and clock', async () => {
    const clock = new ManualClock(500000);
    const store = new MemoryStore({ clock });
    const limiter = fixedWindow({
      limit: 3,
      windowMs: 1000,
      clock,
      store,
    });

    const r1 = await limiter.check('custom-key');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.check('custom-key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.check('custom-key');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await limiter.check('custom-key');
    expect(r4.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('rateLimit error handling', () => {
  it('throws for unknown strategy', () => {
    expect(() =>
      rateLimit({
        strategy: 'invalid-strategy' as never,
      }),
    ).toThrow('Unknown strategy');
  });
});
