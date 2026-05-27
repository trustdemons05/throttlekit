/**
 * Tests for windowCoupled leasing mode in the two-tier store.
 *
 * Covers:
 *   - windowCoupled: false — existing leased behavior unchanged
 *   - windowCoupled: true — lease invalidates at L2 window boundary
 *   - windowCoupled: true — fresh L2 state after boundary cross
 *   - windowCoupled: true — total admitted in one window <= limit
 *   - windowCoupled: undefined — behaves same as false
 */

import { describe, it, expect } from 'vitest';
import { createTwoTierStore } from '../../src/stores/two-tier.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { ManualClock } from '../../src/core/clock.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Shape returned by check transforms
// ---------------------------------------------------------------------------

interface CheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfterMs: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('windowCoupled leasing mode', () => {
  // -----------------------------------------------------------------------
  // Test 1: windowCoupled: false → existing leased behavior unchanged
  // -----------------------------------------------------------------------
  describe('windowCoupled: false (default behavior)', () => {
    it('does not invalidate lease at window boundary', async () => {
      const clock = new ManualClock(1_000_000);

      let l2Calls = 0;
      const inner = new MemoryStore({ clock });

      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          l2Calls++;
          return inner.apply<S, T>(key, ttlMs, transform);
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 5, lowWater: 2, windowCoupled: false },
        clock,
      });

      // Set L2 result with a resetAt 50s in the future
      const resetAt = clock.now() + 50_000;

      // First call: acquires a batch from L2
      const r1 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 20, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(l2Calls).toBe(1);

      // Advance clock past resetAt but within TTL (60s TTL → expires at 1_060_000)
      // resetAt = 1_050_000, advancing to 1_055_000 means we're past resetAt but entry still in L1
      clock.advanceBy(55_000);

      // Next call: windowCoupled is false, so lease should NOT be invalidated
      const r2 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 19, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r2.allowed).toBe(true);
      // Should consume from L1 — no additional L2 hit
      expect(l2Calls).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: windowCoupled: true → lease invalidates at window boundary
  // -----------------------------------------------------------------------
  describe('windowCoupled: true — boundary invalidation', () => {
    it('invalidates lease when clock passes resetAt', async () => {
      const clock = new ManualClock(1_000_000);
      const inner = new MemoryStore({ clock });

      let l2Calls = 0;
      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          l2Calls++;
          return inner.apply<S, T>(key, ttlMs, transform);
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 10, lowWater: 3, windowCoupled: true },
        clock,
      });

      // Set L2 result with resetAt = now + 50s
      const resetAt = clock.now() + 50_000;

      // First call: hits L2, acquires batch
      const r1 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 10, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(l2Calls).toBe(1);

      // Advance past the L2 window boundary but within TTL
      clock.setTime(resetAt + 1); // 1_050_001 — past resetAt

      // Next call: lease should be invalidated, must hit L2
      const r2 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 10, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r2.allowed).toBe(true);
      expect(l2Calls).toBe(2); // hit L2 because lease expired via windowCoupled
    });
  });

  // -----------------------------------------------------------------------
  // Test 3: windowCoupled: true → fresh L2 state after boundary cross
  // -----------------------------------------------------------------------
  describe('windowCoupled: true — fresh L2 state after boundary', () => {
    it('returns L2 result after lease invalidation', async () => {
      const clock = new ManualClock(1_000_000);
      const inner = new MemoryStore({ clock });

      let l2Calls = 0;
      let nextL2Result: CheckResult = {
        allowed: true, remaining: 5, limit: 10, resetAt: 0, retryAfterMs: 0,
      };
      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          l2Calls++;
          return inner.apply<S, T>(key, ttlMs, (prev) => {
            const r = transform(prev);
            return { state: r.state, result: { ...(r.result as any), ...nextL2Result } as T };
          });
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 10, lowWater: 3, windowCoupled: true },
        clock,
      });

      const windowStart = clock.now();
      const resetAt = windowStart + 50_000;

      // First window: L2 has remaining=5, limit=10
      nextL2Result = { allowed: true, remaining: 5, limit: 10, resetAt, retryAfterMs: 0 };

      const r1 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 5, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(l2Calls).toBe(1);

      // Advance past boundary
      clock.setTime(resetAt + 1);

      // Second window: L2 has fresh remaining=10, new resetAt
      const newResetAt = clock.now() + 50_000;
      nextL2Result = { allowed: true, remaining: 10, limit: 10, resetAt: newResetAt, retryAfterMs: 0 };

      const r2 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 10, limit: 10, resetAt: newResetAt, retryAfterMs: 0 } }),
      );
      expect(r2.allowed).toBe(true);
      expect(r2.resetAt).toBe(newResetAt); // fresh L2 window
      expect(r2.remaining).toBeGreaterThanOrEqual(0);
      expect(l2Calls).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: windowCoupled: true → total admitted in one window <= limit
  // -----------------------------------------------------------------------
  describe('windowCoupled: true — overshoot bound', () => {
    it('does not admit more than L2 limit in a single window', async () => {
      const clock = new ManualClock(1_000_000);
      const inner = new MemoryStore({ clock });

      let l2Calls = 0;
      let nextL2Result: CheckResult = {
        allowed: true, remaining: 5, limit: 5, resetAt: 0, retryAfterMs: 0,
      };
      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          l2Calls++;
          return inner.apply<S, T>(key, ttlMs, (prev) => {
            const r = transform(prev);
            return { state: r.state, result: { ...(r.result as any), ...nextL2Result } as T };
          });
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 10, lowWater: 1, windowCoupled: true },
        clock,
      });

      const resetAt = clock.now() + 50_000;
      const limit = 5;

      // First request: L2 limit=5, only 5 tokens available
      nextL2Result = { allowed: true, remaining: limit, limit, resetAt, retryAfterMs: 0 };

      // This is the request that acquires the batch.
      // L1 stores remaining = min(batch - 1, r.remaining) = min(9, 5) = 5.
      const r1 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: limit, limit, resetAt, retryAfterMs: 0 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(l2Calls).toBe(1);

      // Consume 4 more from L1 (remaining: 5 -> 4 -> 3 -> 2 -> 1).
      // lowWater=1, so we stop at remaining=1 (1 is NOT < 1).
      for (let i = 0; i < 4; i++) {
        const r = await store.apply<{ n: number }, CheckResult>(
          'key', 60_000,
          (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 0, limit, resetAt, retryAfterMs: 0 } }),
        );
        expect(r.allowed).toBe(true);
      }
      // Still should not have hit L2 (all consumed from L1 lease)
      expect(l2Calls).toBe(1);

      // Now remaining = 1.  Next request: 1 < lowWater(1) is false,
      // so without windowCoupled it would consume from L1.
      // But windowCoupled fires because we cross the boundary.
      // Advance past resetAt so the lease is invalidated.
      clock.setTime(resetAt + 1);

      // This request should go to L2 because the lease expired.
      // L2 now has limit=5 but we've already used 5 (1 initial + 4 from L1).
      // Simulate deny for this window.
      nextL2Result = {
        allowed: false, remaining: 0, limit, resetAt: clock.now() + 50_000, retryAfterMs: 60_000,
      };

      const rBoundary = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: false, remaining: 0, limit, resetAt: clock.now() + 50_000, retryAfterMs: 60_000 } }),
      );
      expect(rBoundary.allowed).toBe(false);
      expect(l2Calls).toBe(2);

      // Total admitted: 5 (1 initial + 4 from L1) — within limit of 5.
      // The boundary-crossing request was denied, so no overshoot.
    });
  });

  // -----------------------------------------------------------------------
  // Test 5: windowCoupled: undefined → behaves same as false
  // -----------------------------------------------------------------------
  describe('windowCoupled: undefined (default)', () => {
    it('does not invalidate lease at window boundary', async () => {
      const clock = new ManualClock(1_000_000);

      let l2Calls = 0;
      const inner = new MemoryStore({ clock });

      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          l2Calls++;
          return inner.apply<S, T>(key, ttlMs, transform);
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      // windowCoupled not set (undefined)
      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 5, lowWater: 2 },
        clock,
      });

      // Set L2 result with a resetAt 50s in the future
      const resetAt = clock.now() + 50_000;

      // Acquire batch
      const r1 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 20, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(l2Calls).toBe(1);

      // Advance past resetAt but within TTL (60s)
      clock.advanceBy(55_000);

      // Should still consume from L1 — no L2 hit
      const r2 = await store.apply<{ n: number }, CheckResult>(
        'key', 60_000,
        (prev) => ({ state: { n: (prev?.n ?? 0) + 1 }, result: { allowed: true, remaining: 19, limit: 10, resetAt, retryAfterMs: 0 } }),
      );
      expect(r2.allowed).toBe(true);
      expect(l2Calls).toBe(1);
    });
  });
});
