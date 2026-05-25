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
  },
);
