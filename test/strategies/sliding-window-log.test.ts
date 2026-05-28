import { it, expect } from 'vitest';
import { runStrategyTests } from '../helpers/strategy-test-runner.js';
import { ManualClock } from '../helpers/manual-clock.js';
import {
  createSlidingLogStrategy,
  slidingLogConsume,
} from '../../src/strategies/sliding-window-log.js';
import type { Strategy } from '../helpers/strategy-test-runner.js';

// ---------------------------------------------------------------------------
// Shared contract tests
// ---------------------------------------------------------------------------

runStrategyTests(
  'SlidingWindowLog',
  (limit: number, windowMs: number, clock: ManualClock): Strategy => {
    return createSlidingLogStrategy({ limit, windowMs, clock }) as unknown as Strategy;
  },
  () => {
    // ── Strategy-specific tests ──

    it('expires old entries outside the window', () => {
      const clock = new ManualClock(1000);
      const strategy = createSlidingLogStrategy({ limit: 3, windowMs: 1000, clock });

      // Use 3 slots at t=1000
      expect(strategy.apply('key', 1).allowed).toBe(true);
      expect(strategy.apply('key', 1).allowed).toBe(true);
      expect(strategy.apply('key', 1).allowed).toBe(true);

      // All consumed — next should be blocked
      expect(strategy.apply('key', 1).allowed).toBe(false);

      // Advance just past the window
      clock.advanceBy(1001);

      // Old entries expired — should allow again
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it('handles same-ms collisions (multiple requests at identical timestamp)', () => {
      const clock = new ManualClock(5000);
      const strategy = createSlidingLogStrategy({ limit: 10, windowMs: 1000, clock });

      // All 10 requests at the same timestamp
      for (let i = 0; i < 10; i++) {
        const result = strategy.apply('key', 1);
        expect(result.allowed).toBe(true);
      }

      // 11th should be blocked
      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);

      // State should have 10 entries all at the same timestamp
      const state = strategy.exportState!('key') as number[];
      expect(state).toHaveLength(10);
      expect(state.every((t) => t === 5000)).toBe(true);
    });

    it('memory grows then shrinks on prune', () => {
      const clock = new ManualClock(0);
      const strategy = createSlidingLogStrategy({ limit: 5, windowMs: 1000, clock });

      // Fill up at t=0
      for (let i = 0; i < 5; i++) {
        strategy.apply('key', 1);
      }
      expect((strategy.exportState!('key') as number[])).toHaveLength(5);

      // Advance past window
      clock.setTime(2000);

      // One request prunes all old entries and adds one new
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);

      // State should have only 1 entry now (the new one)
      const state = strategy.exportState!('key') as number[];
      expect(state).toHaveLength(1);
      expect(state[0]).toBe(2000);
    });

    it('pure function returns correct StrategyResult structure', () => {
      const result = slidingLogConsume(null, 1000, 1, 1000, 5);

      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('result');
      expect(Array.isArray(result.state)).toBe(true);
      expect(result.result).toHaveProperty('allowed', true);
      expect(result.result).toHaveProperty('limit', 5);
      expect(result.result).toHaveProperty('remaining', 4);
      expect(result.result).toHaveProperty('resetAt');
      expect(result.result).toHaveProperty('retryAfterMs');
    });

    it('exportState/importState roundtrip with JSON serialization', () => {
      const clock = new ManualClock(1000);
      const strategy = createSlidingLogStrategy({ limit: 5, windowMs: 1000, clock });

      strategy.apply('key-a', 1);
      strategy.apply('key-a', 1);

      const exported = strategy.exportState!('key-a');
      expect(Array.isArray(exported)).toBe(true);
      expect((exported as number[])).toHaveLength(2);

      // Simulate JSON serialization
      const cloned = JSON.parse(JSON.stringify(exported));
      strategy.importState!('key-b', cloned);

      const resultA = strategy.apply('key-a', 1);
      const resultB = strategy.apply('key-b', 1);
      expect(resultA.remaining).toBe(resultB.remaining);
    });

    it('deny path reuses same array reference when no entries expire', () => {
      const clock = new ManualClock(1000);
      const strategy = createSlidingLogStrategy({ limit: 3, windowMs: 1000, clock });

      // Fill to capacity
      strategy.apply('key', 1);
      strategy.apply('key', 1);
      strategy.apply('key', 1);

      // Next call should be denied (no entries expired yet)
      const stateBefore = strategy.exportState!('key') as number[];
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(false);
      const stateAfter = strategy.exportState!('key') as number[];

      // All timestamps are within the window, so firstLive === 0,
      // meaning the array reference should be reused (not re-sliced)
      expect(stateAfter).toBe(stateBefore);
    });

    it('property test: new impl produces identical results to old impl', () => {
      // Reference implementation matching the old triple-allocation algorithm
      function binarySearchFirstGE_ref(arr: number[], target: number): number {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (arr[mid]! < target) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        return lo;
      }

      function oldSlidingLogConsume(
        state: number[] | null,
        now: number,
        cost: number,
        windowSizeMs: number,
        max: number,
      ) {
        if (cost > max) {
          return { state: state ?? [], result: { allowed: false, limit: max, remaining: max, resetAt: now + windowSizeMs, retryAfterMs: windowSizeMs } };
        }
        if (cost <= 0) {
          return { state: state ?? [], result: { allowed: true, limit: max, remaining: max, resetAt: now + windowSizeMs, retryAfterMs: 0 } };
        }
        const windowStart = now - windowSizeMs;
        const log = state ?? [];
        const firstValid = binarySearchFirstGE_ref(log, windowStart);
        const pruned = log.slice(firstValid);
        if (pruned.length + cost <= max) {
          const insertIdx = binarySearchFirstGE_ref(pruned, now);
          const newEntries = Array.from({ length: cost }, () => now);
          const newLog = [...pruned.slice(0, insertIdx), ...newEntries, ...pruned.slice(insertIdx)];
          return { state: newLog, result: { allowed: true, limit: max, remaining: max - pruned.length - cost, resetAt: now + windowSizeMs, retryAfterMs: 0 } };
        }
        const oldest = pruned[0]!;
        const retryAfterMs = Math.max(0, oldest + windowSizeMs - now);
        return { state: pruned, result: { allowed: false, limit: max, remaining: 0, resetAt: oldest + windowSizeMs, retryAfterMs } };
      }

      const clock = new ManualClock(0);
      const numTests = 100;

      for (let test = 0; test < numTests; test++) {
        const max = Math.floor(Math.random() * 10) + 1;
        const windowMs = Math.floor(Math.random() * 2000) + 100;
        const strategy = createSlidingLogStrategy({ limit: max, windowMs, clock });

        const numOps = Math.floor(Math.random() * 50) + 1;
        let refState: number[] | null = null;

        for (let op = 0; op < numOps; op++) {
          // Random time advancement
          if (Math.random() < 0.3) {
            const advance = Math.floor(Math.random() * 500);
            clock.advanceBy(advance);
          }

          const now = clock.now();
          const cost = Math.floor(Math.random() * (max + 2)) + 1;

          // New implementation
          const newResult = slidingLogConsume(refState, now, cost, windowMs, max);

          // Reference implementation
          const oldResult = oldSlidingLogConsume(refState, now, cost, windowMs, max);

          // Compare results
          expect(newResult.result.allowed).toBe(oldResult.result.allowed);
          expect(newResult.result.limit).toBe(oldResult.result.limit);
          expect(newResult.result.remaining).toBe(oldResult.result.remaining);
          expect(newResult.result.resetAt).toBe(oldResult.result.resetAt);
          expect(newResult.result.retryAfterMs).toBe(oldResult.result.retryAfterMs);
          expect(newResult.state).toEqual(oldResult.state);

          refState = newResult.state;
        }
      }
    });
  },
);
