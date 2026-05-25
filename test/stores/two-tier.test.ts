/**
 * Tests for the two-tier store (createTwoTierStore).
 *
 * Covers:
 *   - strict mode: every check hits L2
 *   - cached-deny mode: L1 caches denials for retryAfterMs
 *   - leased mode: L1 holds batch tokens, refills at low-water
 *   - get/set/delete passthrough
 */

import { describe, it, expect } from 'vitest';
import { createTwoTierStore } from '../../src/stores/two-tier.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { ManualClock } from '../../src/core/clock.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NumState {
  n: number;
}

function createL2Spy(): { store: Store; applySpy: { callCount: number; lastKey: string } } {
  const clock = new ManualClock(1_000_000);
  const inner = new MemoryStore({ clock });
  const applySpy = { callCount: 0, lastKey: '' };

  const store: Store = {
    apply: <S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T> => {
      applySpy.callCount++;
      applySpy.lastKey = key;
      return inner.apply<S, T>(key, ttlMs, transform);
    },
    get: <T>(key: string): Promise<T | null> => {
      if (inner.get) return inner.get<T>(key);
      return Promise.resolve(null);
    },
    set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => {
      return inner.set(key, value, ttlMs);
    },
    delete: (key: string): Promise<void> => {
      return inner.delete(key);
    },
  };

  return { store, applySpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTwoTierStore', () => {
  describe('strict mode', () => {
    it('every check hits L2', async () => {
      const { store: l2, applySpy } = createL2Spy();
      const store = createTwoTierStore({ l2, mode: 'strict' });

      await store.apply<NumState, number>('key', 60_000, (prev) => {
        const state: NumState = { n: (prev?.n ?? 0) + 1 };
        return { state, result: state.n };
      });

      expect(applySpy.callCount).toBe(1);

      await store.apply<NumState, number>('key', 60_000, (prev) => {
        const state: NumState = { n: (prev?.n ?? 0) + 1 };
        return { state, result: state.n };
      });

      expect(applySpy.callCount).toBe(2);
    });

    it('get/set/delete work through both tiers', async () => {
      const { store: l2 } = createL2Spy();
      const store = createTwoTierStore({ l2, mode: 'strict' }) as Required<Store>;

      await store.set('test', { value: 42 });
      const result = await store.get<{ value: number }>('test');
      expect(result).toEqual({ value: 42 });

      await store.delete('test');
      const afterDelete = await store.get<unknown>('test');
      expect(afterDelete).toBeNull();
    });
  });

  describe('cached-deny mode', () => {
    it('allows first request through to L2', async () => {
      const { store: l2, applySpy } = createL2Spy();
      const store = createTwoTierStore({ l2, mode: 'cached-deny' });

      const result = await store.apply<NumState, { allowed: boolean }>(
        'key', 60_000, (prev) => {
          const state: NumState = { n: (prev?.n ?? 0) + 1 };
          return { state, result: { allowed: true } };
        },
      );

      expect(result.allowed).toBe(true);
      expect(applySpy.callCount).toBe(1);
    });

    it('caches denial and returns cached result without hitting L2', async () => {
      const { store: l2, applySpy } = createL2Spy();
      const store = createTwoTierStore({ l2, mode: 'cached-deny' });

      // First call: allowed
      await store.apply<NumState, { allowed: boolean; retryAfterMs: number }>(
        'key', 60_000, (prev) => {
          const state: NumState = { n: (prev?.n ?? 0) + 1 };
          return { state, result: { allowed: true, retryAfterMs: 0 } };
        },
      );
      expect(applySpy.callCount).toBe(1);

      // Second call: denied
      const denyResult = await store.apply<NumState, { allowed: boolean; retryAfterMs: number }>(
        'key', 60_000, (prev) => {
          return { state: prev ?? { n: 0 }, result: { allowed: false, retryAfterMs: 500 } };
        },
      );
      expect(denyResult.allowed).toBe(false);
      expect(applySpy.callCount).toBe(2);

      // Third call: should be cached in L1, no L2 hit
      const cached = await store.apply<NumState, { allowed: boolean; retryAfterMs: number }>(
        'key', 60_000, (prev) => {
          return { state: prev ?? { n: 0 }, result: { allowed: false, retryAfterMs: 500 } };
        },
      );
      expect(cached.allowed).toBe(false);
      // applySpy should still be 2 (no additional L2 call)
      expect(applySpy.callCount).toBe(2);
    });

    it('cached denial expires after retryAfterMs', async () => {
      const clock = new ManualClock(1_000_000);
      const inner = new MemoryStore({ clock });
      const applySpy = { callCount: 0 };
      const l2: Store = {
        apply: <S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T> => {
          applySpy.callCount++;
          return inner.apply<S, T>(key, ttlMs, transform);
        },
        get: <T>(key: string): Promise<T | null> => inner.get<T>(key),
        set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => inner.set(key, value, ttlMs),
        delete: (key: string): Promise<void> => inner.delete(key),
      };

      const store = createTwoTierStore({ l2, mode: 'cached-deny', clock });

      // Create a denial
      await store.apply<NumState, { allowed: boolean; retryAfterMs: number }>(
        'key', 60_000, (prev) => {
          return { state: prev ?? { n: 0 }, result: { allowed: false, retryAfterMs: 100 } };
        },
      );
      expect(applySpy.callCount).toBe(1);

      // Advance past the cached denial TTL
      clock.advanceBy(101);

      // Should hit L2 again
      await store.apply<NumState, { allowed: boolean; retryAfterMs: number }>(
        'key', 60_000, (prev) => {
          return { state: prev ?? { n: 0 }, result: { allowed: true, retryAfterMs: 0 } };
        },
      );
      expect(applySpy.callCount).toBe(2);
    });
  });

  describe('leased mode', () => {
    it('acquires batch from L2 on first request', async () => {
      const { store: l2, applySpy } = createL2Spy();
      const store = createTwoTierStore({
        l2,
        mode: 'leased',
        lease: { batch: 5, lowWater: 2 },
      });

      const result = await store.apply<NumState, { allowed: boolean; remaining: number }>(
        'key', 60_000, (prev) => {
          const state: NumState = { n: (prev?.n ?? 0) + 1 };
          return { state, result: { allowed: true, remaining: 10 } };
        },
      );

      expect(result.allowed).toBe(true);
      expect(applySpy.callCount).toBe(1);
    });

    it('refills from L2 when remaining drops below lowWater', async () => {
      let callCount = 0;
      const mockL2: Store = {
        apply: async <S, T>(_key: string, _ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> => {
          callCount++;
          return transform(null).result;
        },
      };

      const store = createTwoTierStore({
        l2: mockL2,
        mode: 'leased',
        lease: { batch: 5, lowWater: 2 },
      });

      // First call: hits L2 (acquires batch)
      const r1 = await store.apply<NumState, { allowed: boolean; remaining: number }>(
        'key', 60_000, () => ({ state: { n: 1 }, result: { allowed: true, remaining: 20 } }),
      );
      expect(r1.allowed).toBe(true);
      expect(callCount).toBe(1);

      // After acquisition, remaining = batch - 1 = 4 (1 consumed by the request)
      // lowWater = 2, so we can consume 3 more before refilling
      // (remaining goes 4 -> 3 -> 2 -> 1, then 1 < 2 triggers refill)
      for (let i = 0; i < 3; i++) {
        const r = await store.apply<NumState, { allowed: boolean; remaining: number }>(
          'key', 60_000, () => ({ state: { n: 1 }, result: { allowed: true, remaining: 20 } }),
        );
        expect(r.allowed).toBe(true);
      }
      // Should not have hit L2 again yet (4 calls + 3 = 7 total, still within batch)
      expect(callCount).toBe(1);

      // 5th call: remaining should be 1 < lowWater=2, triggers refill
      const r5 = await store.apply<NumState, { allowed: boolean; remaining: number }>(
        'key', 60_000, () => ({ state: { n: 1 }, result: { allowed: true, remaining: 20 } }),
      );
      expect(r5.allowed).toBe(true);
      expect(callCount).toBe(2);
    });
  });
});
