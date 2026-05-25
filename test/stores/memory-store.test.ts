/**
 * Dedicated MemoryStore tests.
 *
 * Covers:
 *   - set/get a value
 *   - get returns null for missing key
 *   - delete removes a key
 *   - expires entries after TTL
 *   - custom per-key TTL overrides default
 *   - returns value just before TTL expiry
 *   - TTL refreshed on set
 *   - apply creates new entry if none exists
 *   - apply reads existing state and can reject
 *   - apply is atomic under concurrency
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { ManualClock } from '../helpers/manual-clock.js';
import { runConcurrent } from '../helpers/concurrent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience type for a simple numeric counter stored in MemoryStore */
interface CounterState {
  count: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryStore', () => {
  describe('set and get', () => {
    it('stores and retrieves a value', async () => {
      const store = new MemoryStore();
      await store.set('key', { value: 42 });
      const result = await store.get<{ value: number }>('key');
      expect(result).toEqual({ value: 42 });
    });

    it('returns null for a missing key', async () => {
      const store = new MemoryStore();
      const result = await store.get<unknown>('nonexistent');
      expect(result).toBeNull();
    });

    it('delete removes a key', async () => {
      const store = new MemoryStore();
      await store.set('key', 'hello');
      await store.delete('key');
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });
  });

  describe('TTL behaviour', () => {
    it('expires entries after the default TTL', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock, defaultTtlMs: 100 });
      await store.set('key', 'value');
      // Advance past TTL
      clock.advanceBy(101);
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });

    it('custom per-key TTL overrides the default', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock, defaultTtlMs: 1000 });
      await store.set('short', 'short-lived', 50);
      await store.set('long', 'long-lived', 200);
      // Advance just past the short TTL but within the long TTL
      clock.advanceBy(60);
      expect(await store.get<string>('short')).toBeNull();
      expect(await store.get<string>('long')).toBe('long-lived');
    });

    it('returns value just before TTL expiry', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock, defaultTtlMs: 100 });
      await store.set('key', 'alive');
      // Advance to 99ms — still within TTL
      clock.advanceBy(99);
      const result = await store.get<string>('key');
      expect(result).toBe('alive');
    });

    it('TTL is refreshed on set', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock, defaultTtlMs: 100 });
      await store.set('key', 'first');
      clock.advanceBy(80);
      // Re-set — refreshes TTL
      await store.set('key', 'second');
      clock.advanceBy(80);
      // Original TTL would have expired, but new TTL is still valid
      const result = await store.get<string>('key');
      expect(result).toBe('second');
    });
  });

  describe('apply', () => {
    it('creates a new entry if none exists', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock });
      const result = await store.apply<CounterState, boolean>(
        'new-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );
      expect(result).toBe(true);
      const stored = await store.get<CounterState>('new-key');
      expect(stored).toEqual({ count: 1 });
    });

    it('reads existing state and can reject', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock });
      const LIMIT = 3;

      // Insert initial state
      await store.set('counter', { count: 0 });

      const attempt = async () =>
        store.apply<CounterState, { allowed: boolean }>(
          'counter',
          60_000,
          (prev) => {
            const current = prev?.count ?? 0;
            if (current >= LIMIT) {
              return { state: prev ?? { count: 0 }, result: { allowed: false } };
            }
            return { state: { count: current + 1 }, result: { allowed: true } };
          },
        );

      // First 3 should succeed
      expect((await attempt()).allowed).toBe(true);
      expect((await attempt()).allowed).toBe(true);
      expect((await attempt()).allowed).toBe(true);

      // 4th should be rejected
      expect((await attempt()).allowed).toBe(false);

      // Verify final count
      const stored = await store.get<CounterState>('counter');
      expect(stored?.count).toBe(LIMIT);
    });

    it('is atomic under concurrency (per-key mutex)', async () => {
      const clock = new ManualClock(1_000_000_000_000);
      const store = new MemoryStore({ clock });
      const CONCURRENCY = 100;

      const results = await runConcurrent(
        () =>
          store.apply<CounterState, boolean>('atomic-key', 60_000, (prev) => {
            const state: CounterState = { count: (prev?.count ?? 0) + 1 };
            return { state, result: true };
          }),
        CONCURRENCY,
      );

      expect(results.filter(Boolean).length).toBe(CONCURRENCY);
      const stored = await store.get<CounterState>('atomic-key');
      expect(stored?.count).toBe(CONCURRENCY);
    });
  });
});
