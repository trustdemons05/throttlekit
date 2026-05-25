/**
 * Property-based tests (fast-check) for ThrottleKit Phase 5 Ship Readiness.
 *
 * Covers:
 *   - GCRA rate limiter invariants
 *   - Leaky Bucket shaper invariants
 *   - Adaptive Concurrency guard invariants
 *   - Two-Tier Store invariants
 *
 * Uses 300+ runs per property for high confidence.
 * ManualClock only — no real timers, Date.now(), network, or Redis.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { createGcraStrategy } from '../../src/strategies/gcra.js';
import { createLeakyBucket, QueueFullError } from '../../src/strategies/leaky-bucket.js';
import { createAdaptiveConcurrency } from '../../src/strategies/adaptive-concurrency.js';
import { createTwoTierStore } from '../../src/stores/two-tier.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { Store, ShaperResult } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// GCRA Invariants
// ---------------------------------------------------------------------------

describe('GCRA Invariants', () => {
  const makeGcra = (clock: ManualClock, limit: number, periodMs: number) =>
    createGcraStrategy({ limit, periodMs, burst: limit, clock });

  describe('remaining never negative', () => {
    it('should have remaining >= 0 and <= limit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          (cost, limit, periodMs) => {
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            const result = strategy.apply('key', cost);
            expect(result.remaining).toBeGreaterThanOrEqual(0);
            expect(result.remaining).toBeLessThanOrEqual(result.limit);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('retryAfterMs === 0 iff allowed === true', () => {
    it('should satisfy the biconditional for all costs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          (cost, limit, periodMs) => {
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            const result = strategy.apply('key', cost);
            if (result.allowed) {
              expect(result.retryAfterMs).toBe(0);
            } else {
              expect(result.retryAfterMs).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('allowed is strict boolean', () => {
    it('should be exactly true or false', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          (cost, limit, periodMs) => {
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            const result = strategy.apply('key', cost);
            expect(typeof result.allowed).toBe('boolean');
            expect(result.allowed === true || result.allowed === false).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('resetAt > now when blocked', () => {
    it('should have resetAt > now for blocked requests', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          (exhaustCalls, limit, periodMs) => {
            fc.pre(exhaustCalls <= limit);
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            const now = clock.now();
            for (let i = 0; i < exhaustCalls; i++) {
              strategy.apply('key', 1);
            }
            const result = strategy.apply('key', 1);
            if (!result.allowed) {
              expect(result.resetAt).toBeGreaterThan(now);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('cost = 0 does not change remaining', () => {
    it('should preserve remaining after cost=0', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          (seedCost, limit, periodMs) => {
            fc.pre(seedCost <= limit);
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            const before = strategy.apply('key', seedCost);
            expect(before.allowed).toBe(true);
            const zero = strategy.apply('key', 0);
            expect(zero.allowed).toBe(true);
            expect(zero.remaining).toBe(before.remaining);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('keys are isolated', () => {
    it('should not affect other keys when one is exhausted', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 10, max: 100 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          (exhaustCalls, limit, keyA, keyB) => {
            fc.pre(keyA !== keyB);
            fc.pre(exhaustCalls <= limit);
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, 1000);
            // Reference strategy with identical params to verify fresh-key behaviour
            const clockRef = new ManualClock(1_000_000);
            const strategyRef = makeGcra(clockRef, limit, 1000);
            for (let i = 0; i < exhaustCalls; i++) {
              strategy.apply(keyA, 1);
            }
            const resultB = strategy.apply(keyB, 1);
            const refResult = strategyRef.apply(keyB, 1);
            expect(resultB.allowed).toBe(true);
            expect(resultB.remaining).toBe(refResult.remaining);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('invariants hold after time advances', () => {
    it('should maintain invariants after clock advances', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 100, max: 10_000 }),
          fc.integer({ min: 10, max: 500 }),
          (exhaustCalls, limit, periodMs, advanceMs) => {
            fc.pre(exhaustCalls <= limit);
            const clock = new ManualClock(1_000_000);
            const strategy = makeGcra(clock, limit, periodMs);
            for (let i = 0; i < exhaustCalls; i++) {
              strategy.apply('key', 1);
            }
            clock.advanceBy(advanceMs);
            const result = strategy.apply('key', 1);
            expect(result.remaining).toBeGreaterThanOrEqual(0);
            expect(result.remaining).toBeLessThanOrEqual(result.limit);
            if (result.allowed) {
              expect(result.retryAfterMs).toBe(0);
            } else {
              expect(result.retryAfterMs).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Leaky Bucket Invariants
// ---------------------------------------------------------------------------

describe('Leaky Bucket Invariants', () => {
  const makeLeaky = (clock: ManualClock, ratePerSec: number, maxQueueMs: number) =>
    createLeakyBucket({ ratePerSec, maxQueueMs, clock });

  describe('delay is never negative', () => {
    it('should have delayMs >= 0', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 5000 }),
          fc.integer({ min: 1, max: 50 }),
          (cost, maxQueueMs, ratePerSec) => {
            const clock = new ManualClock(1_000_000);
            const shaper = makeLeaky(clock, ratePerSec, maxQueueMs);
            const result = shaper.reserveSync('key', cost);
            expect(result.delayMs).toBeGreaterThanOrEqual(0);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('delay does not exceed maxQueueMs when accepted', () => {
    it('accepted => delayMs <= maxQueueMs; rejected => delayMs > maxQueueMs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 5000 }),
          fc.integer({ min: 1, max: 50 }),
          (cost, maxQueueMs, ratePerSec) => {
            const clock = new ManualClock(1_000_000);
            const shaper = makeLeaky(clock, ratePerSec, maxQueueMs);
            const result = shaper.reserveSync('key', cost);
            if (result.accepted) {
              expect(result.delayMs).toBeLessThanOrEqual(maxQueueMs);
            } else {
              expect(result.delayMs).toBeGreaterThan(maxQueueMs);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('reserveSync returns consistent results', () => {
    it('reserve and reserveSync agree on identical state', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 100, max: 5000 }),
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 0, max: 50 }),
          async (cost, maxQueueMs, ratePerSec, callCount) => {
            const clock = new ManualClock(1_000_000);
            const shaper1 = makeLeaky(clock, ratePerSec, maxQueueMs);
            const shaper2 = makeLeaky(clock, ratePerSec, maxQueueMs);

            const syncResults: ShaperResult[] = [];
            const asyncResults: ShaperResult[] = [];

            for (let i = 0; i < callCount; i++) {
              syncResults.push(shaper1.reserveSync('key', cost));
              asyncResults.push(await shaper2.reserve('key', cost));
            }

            expect(syncResults).toEqual(asyncResults);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('schedule delay monotonicity under load', () => {
    it('delay increases monotonically for successive calls at same time', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 100, max: 5000 }),
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 2, max: 50 }),
          (cost, maxQueueMs, ratePerSec, callCount) => {
            const clock = new ManualClock(1_000_000);
            const shaper = makeLeaky(clock, ratePerSec, maxQueueMs);
            let prevDelay = -1;
            for (let i = 0; i < callCount; i++) {
              const result = shaper.reserveSync('key', cost);
              if (result.accepted) {
                expect(result.delayMs).toBeGreaterThanOrEqual(prevDelay);
                prevDelay = result.delayMs;
              }
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Adaptive Concurrency Invariants
// ---------------------------------------------------------------------------

describe('Adaptive Concurrency Invariants', () => {
  const makeGuard = (minLimit: number, maxLimit: number) =>
    createAdaptiveConcurrency({ minLimit, maxLimit });

  describe('inflight never exceeds maxConcurrency', () => {
    it('should maintain inflight <= maxLimit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 200 }),
          (minLimit, maxLimitRaw, operations) => {
            const maxLimit = Math.max(minLimit, maxLimitRaw);
            const guard = makeGuard(minLimit, maxLimit);
            const leases = [];
            for (let i = 0; i < operations; i++) {
              leases.push(guard.acquire());
            }
            expect(guard.inflight).toBeLessThanOrEqual(maxLimit);
            const okCount = leases.filter((l) => l.ok).length;
            expect(okCount).toBeLessThanOrEqual(maxLimit);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('lease release restores capacity', () => {
    it('should decrement inflight on release', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 200 }),
          (minLimit, maxLimitRaw, acquireCount) => {
            const maxLimit = Math.max(minLimit, maxLimitRaw);
            const guard = makeGuard(minLimit, maxLimit);
            const leases = [];
            for (let i = 0; i < acquireCount; i++) {
              leases.push(guard.acquire());
            }
            for (const lease of leases) {
              lease.release();
            }
            expect(guard.inflight).toBe(0);
            const lease = guard.acquire();
            expect(lease.ok).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('limit stays within bounds', () => {
    it('limit is always in [minLimit, maxLimit]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 200 }),
          (minLimit, maxLimitRaw, operations) => {
            const maxLimit = Math.max(minLimit, maxLimitRaw);
            const guard = makeGuard(minLimit, maxLimit);
            for (let i = 0; i < operations; i++) {
              const lease = guard.acquire();
              lease.release();
            }
            expect(guard.limit).toBeGreaterThanOrEqual(minLimit);
            expect(guard.limit).toBeLessThanOrEqual(maxLimit);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('overshoot bounds under burst', () => {
    it('should recover to valid limit after burst of acquires/releases', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 300 }),
          (minLimit, maxLimitRaw, burstSize) => {
            const maxLimit = Math.max(minLimit, maxLimitRaw);
            const guard = makeGuard(minLimit, maxLimit);
            const leases = [];
            for (let i = 0; i < burstSize; i++) {
              leases.push(guard.acquire());
            }
            for (const lease of leases) {
              lease.release();
            }
            expect(guard.limit).toBeGreaterThanOrEqual(minLimit);
            expect(guard.limit).toBeLessThanOrEqual(maxLimit);
            expect(guard.inflight).toBe(0);
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Two-Tier Store Invariants
// ---------------------------------------------------------------------------

describe('Two-Tier Store Invariants', () => {
  const createCountingL2 = (clock: ManualClock) => {
    let callCount = 0;
    const inner = new MemoryStore({ clock });
    const store: Store = {
      apply: async <S, T>(
        key: string,
        ttlMs: number,
        transform: (state: S | null) => { state: S; result: T },
      ): Promise<T> => {
        callCount++;
        return inner.apply<S, T>(key, ttlMs, transform);
      },
      get: async <T>(key: string): Promise<T | null> => inner.get<T>(key),
      set: async <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
      delete: async (key: string): Promise<void> => inner.delete(key),
    };
    return { store, getCallCount: () => callCount };
  };

  describe('strict mode passes through exactly', () => {
    it('every apply hits L2 exactly once', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 50 }),
          async (callCount) => {
            const clock = new ManualClock(1_000_000);
            const { store: l2, getCallCount } = createCountingL2(clock);
            const store = createTwoTierStore({ l2, mode: 'strict', clock });
            for (let i = 0; i < callCount; i++) {
              await store.apply('key', 60_000, (prev: { n: number } | null) => ({
                state: { n: (prev?.n ?? 0) + 1 },
                result: { allowed: true },
              }));
            }
            expect(getCallCount()).toBe(callCount);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('cached-deny mode caches denials correctly', () => {
    it('repeated denials do not hit L2 after first denial', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 1, max: 20 }),
          async (allowsBeforeDeny, denialsAfter) => {
            const clock = new ManualClock(1_000_000);
            const { store: l2, getCallCount } = createCountingL2(clock);
            const store = createTwoTierStore({ l2, mode: 'cached-deny', clock });

            for (let i = 0; i < allowsBeforeDeny; i++) {
              await store.apply('key', 60_000, () => ({
                state: { n: 1 },
                result: { allowed: true, retryAfterMs: 0 },
              }));
            }
            const callsAfterAllows = getCallCount();

            await store.apply('key', 60_000, () => ({
              state: { n: 1 },
              result: { allowed: false, retryAfterMs: 100 },
            }));
            expect(getCallCount()).toBe(callsAfterAllows + 1);

            for (let i = 0; i < denialsAfter; i++) {
              const r = await store.apply('key', 60_000, () => ({
                state: { n: 1 },
                result: { allowed: false, retryAfterMs: 100 },
              }));
              expect(r.allowed).toBe(false);
            }
            expect(getCallCount()).toBe(callsAfterAllows + 1);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('leased mode respects lowWater/highWater', () => {
    it('refills from L2 when remaining drops below lowWater', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 5, max: 50 }),
          fc.integer({ min: 1, max: 10 }),
          async (batch, lowWaterRaw) => {
            const lowWater = Math.min(lowWaterRaw, Math.max(1, Math.floor(batch / 2)));
            const clock = new ManualClock(1_000_000);
            let callCount = 0;
            const mockL2: Store = {
              apply: async <S, T>(
                _key: string,
                _ttlMs: number,
                transform: (s: S | null) => { state: S; result: T },
              ): Promise<T> => {
                callCount++;
                return transform(null).result;
              },
            };
            const store = createTwoTierStore({
              l2: mockL2,
              mode: 'leased',
              lease: { batch, lowWater },
              clock,
            });

            const r1 = await store.apply('key', 60_000, () => ({
              state: { n: 1 },
              result: { allowed: true, remaining: 100 },
            }));
            expect(r1.allowed).toBe(true);
            expect(callCount).toBe(1);

            const callsBeforeRefill = Math.max(0, batch - lowWater);
            for (let i = 0; i < callsBeforeRefill; i++) {
              const r = await store.apply('key', 60_000, () => ({
                state: { n: 1 },
                result: { allowed: true, remaining: 100 },
              }));
              expect(r.allowed).toBe(true);
            }
            expect(callCount).toBe(1);

            const rNext = await store.apply('key', 60_000, () => ({
              state: { n: 1 },
              result: { allowed: true, remaining: 100 },
            }));
            expect(rNext.allowed).toBe(true);
            expect(callCount).toBe(2);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('deterministic replay produces identical results', () => {
    it('same operations on identical stores yield same results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.boolean()),
            { minLength: 1, maxLength: 30 },
          ),
          async (operations) => {
            const clock = new ManualClock(1_000_000);
            const inner1 = new MemoryStore({ clock });
            const inner2 = new MemoryStore({ clock });

            const l2_1: Store = {
              apply: async <S, T>(
                key: string,
                ttlMs: number,
                transform: (state: S | null) => { state: S; result: T },
              ): Promise<T> => inner1.apply<S, T>(key, ttlMs, transform),
            };
            const l2_2: Store = {
              apply: async <S, T>(
                key: string,
                ttlMs: number,
                transform: (state: S | null) => { state: S; result: T },
              ): Promise<T> => inner2.apply<S, T>(key, ttlMs, transform),
            };

            const store1 = createTwoTierStore({ l2: l2_1, mode: 'strict', clock });
            const store2 = createTwoTierStore({ l2: l2_2, mode: 'strict', clock });

            const results1: unknown[] = [];
            const results2: unknown[] = [];

            for (const [key, allowed] of operations) {
              const transform = (prev: { n: number } | null) => ({
                state: { n: (prev?.n ?? 0) + 1 },
                result: { allowed, value: (prev?.n ?? 0) + 1 },
              });
              results1.push(await store1.apply(key, 60_000, transform));
              results2.push(await store2.apply(key, 60_000, transform));
            }

            expect(results1).toEqual(results2);
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
