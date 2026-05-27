/**
 * Tests for batch check methods: checkMany and checkManySync.
 *
 * All tests use ManualClock + MemoryStore for deterministic, instant results.
 */

import { describe, it, expect } from 'vitest';
import { LimiterImpl, UnsupportedOperationError } from '../../src/core/limiter.js';
import { tokenBucket, fixedWindow } from '../../src/core/factories.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { Store, RateLimitResult } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helper: create a token-bucket limiter with deterministic clock
// ---------------------------------------------------------------------------

function createLimiter(): { limiter: LimiterImpl; clock: ManualClock; store: MemoryStore } {
  const clock = new ManualClock(1_000_000);
  const store = new MemoryStore({ clock });
  const limiter = tokenBucket({
    capacity: 2,
    refillRate: 0,
    clock,
    store,
  });
  return { limiter: limiter as LimiterImpl, clock, store };
}

// ---------------------------------------------------------------------------
// checkMany
// ---------------------------------------------------------------------------

describe('checkMany', () => {
  it('returns results in input order', async () => {
    const { limiter } = createLimiter();

    const keys = ['a', 'b', 'c'];
    const results = await limiter.checkMany!(keys);

    expect(results).toHaveLength(3);
    // All keys have capacity 2, cost 1 => all allowed
    for (const r of results) {
      expect(r.allowed).toBe(true);
    }
  });

  it('first 2 keys allowed, third denied when capacity is 2', async () => {
    const { limiter } = createLimiter();

    // First two checks each consume 1 token from separate keys
    const keys = ['a', 'b', 'c'];
    const results = await limiter.checkMany!(keys, 1);

    expect(results).toHaveLength(3);
    expect(results[0]!.allowed).toBe(true);
    expect(results[0]!.remaining).toBe(1);
    expect(results[1]!.allowed).toBe(true);
    expect(results[1]!.remaining).toBe(1);
    expect(results[2]!.allowed).toBe(true);
    expect(results[2]!.remaining).toBe(1);
  });

  it('denies third key after first two consume all capacity', async () => {
    const { limiter } = createLimiter();

    // Consume both tokens on key 'a' first
    await limiter.check('a', 1);
    await limiter.check('a', 1);

    // Now checkMany: 'a' should be denied, 'b' allowed, 'c' allowed
    const results = await limiter.checkMany!(['a', 'b', 'c'], 1);

    expect(results).toHaveLength(3);
    expect(results[0]!.allowed).toBe(false); // 'a' exhausted
    expect(results[0]!.remaining).toBe(0);
    expect(results[1]!.allowed).toBe(true);  // 'b' fresh key
    expect(results[1]!.remaining).toBe(1);
    expect(results[2]!.allowed).toBe(true);  // 'c' fresh key
    expect(results[2]!.remaining).toBe(1);
  });

  it('returns empty array for empty keys array', async () => {
    const { limiter } = createLimiter();
    const results = await limiter.checkMany!([], 1);
    expect(results).toEqual([]);
  });

  it('forwards cost parameter to each check', async () => {
    const { limiter } = createLimiter();

    // cost=2 should consume both tokens on key 'a'
    const results = await limiter.checkMany!(['a'], 2);

    expect(results).toHaveLength(1);
    expect(results[0]!.allowed).toBe(true);
    expect(results[0]!.remaining).toBe(0);
  });

  it('runs checks concurrently with same timestamp', async () => {
    const clock = new ManualClock(1_000_000);
    const store = new MemoryStore({ clock });
    const limiter = fixedWindow({
      limit: 5,
      windowMs: 60_000,
      clock,
      store,
    });

    // All checks should share the same timestamp since clock doesn't advance
    const results = await limiter.checkMany!(['x', 'y', 'z'], 1);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// checkManySync
// ---------------------------------------------------------------------------

describe('checkManySync', () => {
  it('returns identical results to sequential checkSync calls', async () => {
    const { limiter } = createLimiter();

    // Perform sequential checkSync calls
    const syncResultA = limiter.checkSync('a', 1);
    const syncResultB = limiter.checkSync('b', 1);

    // Create a fresh limiter for the batch test
    const clock2 = new ManualClock(1_000_000);
    const store2 = new MemoryStore({ clock: clock2 });
    const limiter2 = tokenBucket({
      capacity: 2,
      refillRate: 0,
      clock: clock2,
      store: store2,
    }) as LimiterImpl;

    // Perform batch checkManySync
    const batchResults = limiter2.checkManySync(['a', 'b'], 1);

    expect(batchResults).toHaveLength(2);
    expect(batchResults[0]!.allowed).toBe(syncResultA.allowed);
    expect(batchResults[0]!.remaining).toBe(syncResultA.remaining);
    expect(batchResults[1]!.allowed).toBe(syncResultB.allowed);
    expect(batchResults[1]!.remaining).toBe(syncResultB.remaining);
  });

  it('throws UnsupportedOperationError on non-sync stores', () => {
    // A store that implements Store but does NOT have applySync
    const nonSyncStore: Store = {
      async apply<S, T>(
        _key: string,
        _ttlMs: number,
        transform: (state: S | null) => { state: S; result: T }
      ): Promise<T> {
        const { result } = transform(null);
        return result;
      },
    };

    const mockStrategy = {
      apply(_key: string, _cost: number): RateLimitResult {
        return { allowed: true, limit: 10, remaining: 9, resetAt: 0, retryAfterMs: 0 };
      },
    };

    const impl = new LimiterImpl(mockStrategy, nonSyncStore, 60_000);

    expect(() => impl.checkManySync(['a'], 1)).toThrow(UnsupportedOperationError);
  });

  it('returns empty array for empty keys array', () => {
    const { limiter } = createLimiter();
    const results = limiter.checkManySync([], 1);
    expect(results).toEqual([]);
  });

  it('forwards cost parameter to each check', () => {
    const { limiter } = createLimiter();

    // cost=2 should consume both tokens on key 'a'
    const results = limiter.checkManySync(['a'], 2);

    expect(results).toHaveLength(1);
    expect(results[0]!.allowed).toBe(true);
    expect(results[0]!.remaining).toBe(0);
  });
});
