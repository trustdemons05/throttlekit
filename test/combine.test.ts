/**
 * Tests for combine().
 *
 * Coverage:
 *   - combine(A, B) where both pass → remaining=min, resetAt=max
 *   - combine(A, B) where A blocks → short-circuit, B not called
 *   - combine(A, B) where A passes, B blocks → B's result propagated
 *   - Nested combine
 *   - Mixed strategies
 *   - Single limiter
 */

import { describe, it, expect } from 'vitest';
import { combine } from '../src/core/combine.js';
import { rateLimit } from '../src/core/limiter.js';
import { ManualClock } from '../src/core/clock.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import type { Limiter, RateLimitResult } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a spy limiter that records each check call.
 */
function createSpyLimiter(_name: string): Limiter & { calls: Array<{ key: string; cost: number | undefined }> } {
  const calls: Array<{ key: string; cost: number | undefined }> = [];
  return {
    calls,
    async check(key: string, cost?: number): Promise<RateLimitResult> {
      calls.push({ key, cost });
      return {
        allowed: true,
        limit: 10,
        remaining: 9,
        resetAt: Date.now() + 1000,
        retryAfterMs: 0,
      };
    },
  };
}

/**
 * Create a limiter that always blocks.
 */
function createBlockingLimiter(): Limiter {
  return {
    async check(_key: string, _cost?: number): Promise<RateLimitResult> {
      return {
        allowed: false,
        limit: 5,
        remaining: 0,
        resetAt: Date.now() + 5000,
        retryAfterMs: 5000,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('combine()', () => {
  it('returns correct result when both limiters pass', async () => {
    const clock = new ManualClock(2000000);
    // Each limiter MUST have its own store to avoid key collisions
    const storeA = new MemoryStore({ clock });
    const storeB = new MemoryStore({ clock });

    const limiterA = rateLimit({
      strategy: 'fixed-window',
      limit: 10,
      windowMs: 1000,
      clock,
      store: storeA,
    });

    const limiterB = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 2000,
      clock,
      store: storeB,
    });

    const combined = combine(limiterA, limiterB);

    const result = await combined.check('test-key');

    expect(result.allowed).toBe(true);
    // remaining should be min of the two (both at full capacity initially)
    // Fixed-window: after first request, remaining = limit - 1
    // limiterA: 10 - 1 = 9, limiterB: 5 - 1 = 4
    // min = 4
    expect(result.remaining).toBe(4);
  });

  it('short-circuits when first limiter blocks', async () => {
    const spyA = createSpyLimiter('A');
    const limiterA: Limiter = {
      async check(key: string, cost?: number): Promise<RateLimitResult> {
        spyA.calls.push({ key, cost });
        return {
          allowed: false,
          limit: 5,
          remaining: 0,
          resetAt: Date.now() + 5000,
          retryAfterMs: 5000,
        };
      },
    };

    const spyB = createSpyLimiter('B');

    const combined = combine(limiterA, spyB);

    const result = await combined.check('short-circuit-key');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    // B should NOT have been called (short-circuit)
    expect(spyB.calls).toHaveLength(0);
  });

  it('propagates B result when A passes but B blocks', async () => {
    const limiterA: Limiter = {
      async check(_key: string, _cost?: number): Promise<RateLimitResult> {
        return {
          allowed: true,
          limit: 10,
          remaining: 5,
          resetAt: Date.now() + 1000,
          retryAfterMs: 0,
        };
      },
    };

    const limiterB = createBlockingLimiter();

    const combined = combine(limiterA, limiterB);

    const result = await combined.check('block-b-key');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBe(5000);
  });

  it('works with nested combine', async () => {
    const clock = new ManualClock(3000000);
    // Each limiter MUST have its own store to avoid key collisions
    const storeA = new MemoryStore({ clock });
    const storeB = new MemoryStore({ clock });
    const storeC = new MemoryStore({ clock });

    const limiterA = rateLimit({
      strategy: 'fixed-window',
      limit: 10,
      windowMs: 1000,
      clock,
      store: storeA,
    });

    const limiterB = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 2000,
      clock,
      store: storeB,
    });

    const limiterC = rateLimit({
      strategy: 'fixed-window',
      limit: 3,
      windowMs: 500,
      clock,
      store: storeC,
    });

    // Nested: combine(A, combine(B, C))
    const inner = combine(limiterB, limiterC);
    const outer = combine(limiterA, inner);

    const result = await outer.check('nested-key');

    expect(result.allowed).toBe(true);
    // All three pass, remaining = min(9, 4, 2) = 2
    expect(result.remaining).toBe(2);
  });

  it('works with mixed strategies', async () => {
    const clock = new ManualClock(4000000);
    const storeA = new MemoryStore({ clock });
    const storeB = new MemoryStore({ clock });

    const tokenBucket = rateLimit({
      strategy: 'token-bucket',
      capacity: 10,
      refillRate: 10,
      clock,
      store: storeA,
    });

    const fixedWindow = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store: storeB,
    });

    const combined = combine(tokenBucket, fixedWindow);

    const result = await combined.check('mixed-key');

    expect(result.allowed).toBe(true);
    // token-bucket: capacity=10, cost=1, remaining=9 (but it refills at 10/s, so at time 0 with no elapsed, it has 10)
    // Actually for token-bucket: at instant 0, state is null, so tokens = capacity = 10. After consumption: 9 remaining.
    // fixed-window: limit=5, cost=1, remaining=4
    // min(9, 4) = 4
    expect(result.remaining).toBe(4);
  });

  it('works with single limiter', async () => {
    const clock = new ManualClock(5000000);
    const store = new MemoryStore({ clock });

    const limiterA = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });

    const combined = combine(limiterA);

    const r1 = await combined.check('single-key');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);
  });

  it('empty combine returns default allowed result', async () => {
    const combined = combine();

    const result = await combined.check('empty-key');
    // With no limiters, technically everything is allowed
    // but the behavior depends on implementation
    // Our implementation initializes compositeLimit to 0, so the result might have limit=0
    expect(result.allowed).toBe(true);
  });

  it('handles cost parameter correctly', async () => {
    const spyA = createSpyLimiter('A');
    const spyB = createSpyLimiter('B');

    const combined = combine(spyA, spyB);

    await combined.check('cost-key', 3);

    expect(spyA.calls[0]!.key).toBe('cost-key');
    expect(spyA.calls[0]!.cost).toBe(3);
    expect(spyB.calls[0]!.key).toBe('cost-key');
    expect(spyB.calls[0]!.cost).toBe(3);
  });

  it('calls limiters in order', async () => {
    const callOrder: string[] = [];

    const limiterA: Limiter = {
      async check(_key: string, _cost?: number): Promise<RateLimitResult> {
        callOrder.push('A');
        return {
          allowed: true,
          limit: 10,
          remaining: 9,
          resetAt: Date.now() + 1000,
          retryAfterMs: 0,
        };
      },
    };

    const limiterB: Limiter = {
      async check(_key: string, _cost?: number): Promise<RateLimitResult> {
        callOrder.push('B');
        return {
          allowed: true,
          limit: 5,
          remaining: 4,
          resetAt: Date.now() + 2000,
          retryAfterMs: 0,
        };
      },
    };

    const combined = combine(limiterA, limiterB);
    await combined.check('order-key');

    expect(callOrder).toEqual(['A', 'B']);
  });
});
