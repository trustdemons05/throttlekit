import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createSlidingWindowStrategy, slidingWindowConsume } from '../../src/strategies/sliding-window.js';
import { createSlidingCounterStrategy } from '../../src/strategies/sliding-window-counter.js';
import { ManualClock } from '../helpers/manual-clock.js';

// ---------------------------------------------------------------------------
// Bucketed mode (buckets > 1)
// ---------------------------------------------------------------------------

describe('createSlidingWindowStrategy (bucketed)', () => {
  it('allows requests under the limit', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 5, windowMs: 10_000, buckets: 5, clock });

    for (let i = 0; i < 5; i++) {
      const r = s.apply('key', 1);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5 - i - 1);
    }
  });

  it('blocks requests over the limit', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 3, windowMs: 10_000, buckets: 5, clock });

    s.apply('key', 1);
    s.apply('key', 1);
    s.apply('key', 1);
    const r = s.apply('key', 1);

    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets stale buckets after window passes', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 3, windowMs: 1_000, buckets: 5, clock });

    // Exhaust limit
    s.apply('key', 1);
    s.apply('key', 1);
    s.apply('key', 1);
    expect(s.apply('key', 1).allowed).toBe(false);

    // Advance past window — all buckets should be stale
    clock.advanceBy(1_100);
    const r = s.apply('key', 1);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });

  it('zeros only aged-out buckets on partial rollover', () => {
    const clock = new ManualClock(0);
    const s = createSlidingWindowStrategy({ limit: 10, windowMs: 1_000, buckets: 10, clock });

    // bucketSize = 100ms
    // Fill bucket 0 (index 0, time 0..99ms)
    s.apply('key', 3);

    // Jump to bucket 5 (time 500ms) — buckets 1..4 should be zeroed
    clock.advanceBy(500);
    s.apply('key', 2);

    // Jump back is not possible with monotonic clock, so advance further
    clock.advanceBy(100);
    const r = s.apply('key', 1);
    expect(r.allowed).toBe(true);

    // Total in window = 3 (bucket0) + 2 (bucket5) + 1 (bucket6) = 6
    // Remaining = 10 - 6 = 4
    expect(r.remaining).toBe(4);
  });

  it('handles cost > 1', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 5, windowMs: 10_000, buckets: 5, clock });

    const r1 = s.apply('key', 3);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = s.apply('key', 3);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it('returns correct retryAfter on denial', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 2, windowMs: 1_000, buckets: 4, clock });

    s.apply('key', 1);
    s.apply('key', 1);
    const r = s.apply('key', 1);

    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.resetAt).toBe(clock.now() + r.retryAfterMs);
  });

  it('peek returns state without mutating', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 3, windowMs: 10_000, buckets: 5, clock });

    s.apply('key', 1);
    const peek1 = s.peek!('key');
    const peek2 = s.peek!('key');

    expect(peek1).not.toBeNull();
    expect(peek2).not.toBeNull();
    expect(peek1!.remaining).toBe(2);
    expect(peek2!.remaining).toBe(2); // peek must not consume
  });

  it('isolates keys', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 2, windowMs: 10_000, buckets: 5, clock });

    s.apply('a', 1);
    s.apply('a', 1);
    const r = s.apply('b', 1);

    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it('exportState and importState round-trip', () => {
    const clock = new ManualClock(1_000_000);
    const s = createSlidingWindowStrategy({ limit: 3, windowMs: 10_000, buckets: 5, clock });

    s.apply('key', 1);
    s.apply('key', 1);

    const exported = s.exportState!('key');
    expect(Array.isArray(exported)).toBe(true);

    s.reset!('key');
    expect(s.peek!('key')).toBeNull();

    s.importState!('key', exported);
    const peek = s.peek!('key');
    expect(peek).not.toBeNull();
    expect(peek!.remaining).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buckets = 1 compatibility mode
// ---------------------------------------------------------------------------

describe('createSlidingWindowStrategy (buckets=1)', () => {
  it('behaves identically to sliding-window-counter for identical sequences', () => {
    const clock = new ManualClock(1_000_000);
    const sw = createSlidingWindowStrategy({ limit: 10, windowMs: 1_000, buckets: 1, clock });
    const sc = createSlidingCounterStrategy({ limit: 10, windowMs: 1_000, clock });

    for (let i = 0; i < 50; i++) {
      const r1 = sw.apply('key', 1);
      const r2 = sc.apply('key', 1);

      expect(r1.allowed).toBe(r2.allowed);
      expect(r1.remaining).toBe(r2.remaining);
      expect(r1.retryAfterMs).toBe(r2.retryAfterMs);
      expect(r1.limit).toBe(r2.limit);
      expect(r1.resetAt).toBe(r2.resetAt);

      clock.advanceBy(25);
    }
  });

  it('behaves identically with varying costs', () => {
    const clock = new ManualClock(1_000_000);
    const sw = createSlidingWindowStrategy({ limit: 10, windowMs: 1_000, buckets: 1, clock });
    const sc = createSlidingCounterStrategy({ limit: 10, windowMs: 1_000, clock });

    const costs = [1, 2, 3, 1, 1, 5, 1];
    for (const cost of costs) {
      const r1 = sw.apply('key', cost);
      const r2 = sc.apply('key', cost);

      expect(r1.allowed).toBe(r2.allowed);
      expect(r1.remaining).toBe(r2.remaining);
      expect(r1.retryAfterMs).toBe(r2.retryAfterMs);

      clock.advanceBy(100);
    }
  });

  it('behaves identically with window rollovers', () => {
    const clock = new ManualClock(1_000_000);
    const sw = createSlidingWindowStrategy({ limit: 5, windowMs: 1_000, buckets: 1, clock });
    const sc = createSlidingCounterStrategy({ limit: 5, windowMs: 1_000, clock });

    for (let i = 0; i < 5; i++) {
      const r1 = sw.apply('key', 1);
      const r2 = sc.apply('key', 1);
      expect(r1.allowed).toBe(r2.allowed);
    }

    // Cross window boundary
    clock.advanceBy(1_000);

    for (let i = 0; i < 5; i++) {
      const r1 = sw.apply('key', 1);
      const r2 = sc.apply('key', 1);
      expect(r1.allowed).toBe(r2.allowed);
      expect(r1.remaining).toBe(r2.remaining);
    }
  });

  it('behaves identically for cost > limit', () => {
    const clock = new ManualClock(1_000_000);
    const sw = createSlidingWindowStrategy({ limit: 5, windowMs: 1_000, buckets: 1, clock });
    const sc = createSlidingCounterStrategy({ limit: 5, windowMs: 1_000, clock });

    const r1 = sw.apply('key', 10);
    const r2 = sc.apply('key', 10);

    expect(r1.allowed).toBe(r2.allowed);
    expect(r1.remaining).toBe(r2.remaining);
    expect(r1.retryAfterMs).toBe(r2.retryAfterMs);
    expect(r1.resetAt).toBe(r2.resetAt);
  });

  it('behaves identically for cost = 0', () => {
    const clock = new ManualClock(1_000_000);
    const sw = createSlidingWindowStrategy({ limit: 5, windowMs: 1_000, buckets: 1, clock });
    const sc = createSlidingCounterStrategy({ limit: 5, windowMs: 1_000, clock });

    const r1 = sw.apply('key', 0);
    const r2 = sc.apply('key', 0);

    expect(r1.allowed).toBe(r2.allowed);
    expect(r1.remaining).toBe(r2.remaining);
    expect(r1.retryAfterMs).toBe(r2.retryAfterMs);
  });
});

// ---------------------------------------------------------------------------
// fast-check invariants
// ---------------------------------------------------------------------------

describe('SlidingWindow invariants', () => {
  it('remaining ∈ [0, limit]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 100, max: 5_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 5, maxLength: 50 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 5, maxLength: 50 }),
        (limit, windowMs, buckets, costs, advances) => {
          const clock = new ManualClock(1_000_000);
          const s = createSlidingWindowStrategy({ limit, windowMs, buckets, clock });

          for (let i = 0; i < costs.length; i++) {
            // Arrays have minLength 5 and loop bound is array.length, so index is safe
            clock.advanceBy(advances[i]!);
            const r = s.apply('key', costs[i]!);
            expect(r.remaining).toBeGreaterThanOrEqual(0);
            expect(r.remaining).toBeLessThanOrEqual(limit);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('retryAfterMs === 0 iff allowed === true', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 100, max: 5_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 50 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 5, maxLength: 50 }),
        (limit, windowMs, buckets, costs, advances) => {
          const clock = new ManualClock(1_000_000);
          const s = createSlidingWindowStrategy({ limit, windowMs, buckets, clock });

          for (let i = 0; i < costs.length; i++) {
            clock.advanceBy(advances[i]!);
            const r = s.apply('key', costs[i]!);
            expect(r.retryAfterMs === 0).toBe(r.allowed);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('allowed is a strict boolean', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 100, max: 5_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 5, maxLength: 50 }),
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 5, maxLength: 50 }),
        (limit, windowMs, buckets, costs, advances) => {
          const clock = new ManualClock(1_000_000);
          const s = createSlidingWindowStrategy({ limit, windowMs, buckets, clock });

          for (let i = 0; i < costs.length; i++) {
            clock.advanceBy(advances[i]!);
            const r = s.apply('key', costs[i]!);
            expect(typeof r.allowed).toBe('boolean');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keys are isolated', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 100, max: 2_000 }),
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 0, max: 50 }),
        (limit, windowMs, buckets, callsOnA) => {
          const clock = new ManualClock(1_000_000);
          const s = createSlidingWindowStrategy({ limit, windowMs, buckets, clock });

          for (let i = 0; i < callsOnA; i++) {
            s.apply('a', 1);
          }

          const r = s.apply('b', 1);
          expect(r.allowed).toBe(true);
          expect(r.remaining).toBe(limit - 1);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('slidingWindowConsume', () => {
  it('creates fresh state on null', () => {
    const now = 1_000_000;
    const { state } = slidingWindowConsume(null, now, 1, 5, 1_000, 10);
    expect(state.length).toBe(11);
    expect(state[10]).toBe(Math.floor(now / 100)); // bucketSize = 1000/10 = 100
  });

  it('never mutates caller-owned state', () => {
    const now = 1_000_000;
    const original = new Float64Array(11);
    original[0] = 3;
    original[10] = Math.floor(now / 100);

    const { state: newState } = slidingWindowConsume(original, now, 1, 5, 1_000, 10);
    expect(newState).not.toBe(original);
    expect(original[0]).toBe(3); // unchanged
  });
});
