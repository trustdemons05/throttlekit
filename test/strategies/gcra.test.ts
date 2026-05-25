/**
 * GCRA (Generic Cell Rate Algorithm) strategy tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createGcraStrategy, gcraConsume, gcraLua } from '../../src/strategies/gcra.js';
import { ManualClock } from '../helpers/manual-clock.js';
import type { Strategy } from '../../src/strategies/gcra.js';

describe('GCRA strategy', () => {
  // -----------------------------------------------------------------------
  // Lua constant
  // -----------------------------------------------------------------------
  it('exports gcraLua as a non-empty string', () => {
    expect(gcraLua).toBeTypeOf('string');
    expect(gcraLua.length).toBeGreaterThan(0);
    expect(gcraLua).toContain('redis.call');
    expect(gcraLua).toContain('new_tat');
  });

  // -----------------------------------------------------------------------
  // Pure function: basic behavior
  // -----------------------------------------------------------------------
  describe('gcraConsume (pure function)', () => {
    it('allows first request when state is null', () => {
      const { state, result } = gcraConsume(null, 1000, 1, 10, 1000, 10);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(result.retryAfterMs).toBe(0);
      expect(state[0]).toBeGreaterThan(1000); // TAT advanced
    });

    it('blocks after exhausting burst capacity', () => {
      let state: Float64Array | null = null;
      const now = 1000;

      // Consume burst + 1 requests (all at same time)
      for (let i = 0; i < 10; i++) {
        const r = gcraConsume(state, now, 1, 10, 1000, 10);
        state = r.state;
        expect(r.result.allowed).toBe(true);
      }

      // 11th request should be blocked
      const blocked = gcraConsume(state, now, 1, 10, 1000, 10);
      expect(blocked.result.allowed).toBe(false);
      expect(blocked.result.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.result.remaining).toBe(0);
    });

    it('recovers after time passes', () => {
      let state: Float64Array | null = null;

      // Exhaust bucket at t=1000 (limit=10, burst=10)
      // emission_interval = 100ms, burst_offset = 1000ms
      for (let i = 0; i < 10; i++) {
        const r = gcraConsume(state, 1000, 1, 10, 1000, 10);
        state = r.state;
      }

      // Blocked at same time — TAT should be at 2000
      const blocked = gcraConsume(state, 1000, 1, 10, 1000, 10);
      expect(blocked.result.allowed).toBe(false);

      // Advance by one emission interval (100ms) — exactly 1 request recovered
      // new_tat = max(1100, 2000) + 100 = 2100
      // remaining = floor((1000 - (2100-1100)) / 100) = floor(0/100) = 0
      const recovered = gcraConsume(state, 1100, 1, 10, 1000, 10);
      expect(recovered.result.allowed).toBe(true);
      expect(recovered.result.remaining).toBe(0);
    });

    it('rejects cost > limit immediately', () => {
      const { result } = gcraConsume(null, 1000, 11, 10, 1000, 10);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(10);
      expect(result.retryAfterMs).toBe(Infinity);
    });

    it('allows cost=0 without consuming capacity', () => {
      const now = 1000;
      const { state, result } = gcraConsume(null, now, 0, 10, 1000, 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10);
      // TAT should not advance meaningfully
      expect(state[0]).toBe(now);
    });

    it('handles burst larger than limit', () => {
      let state: Float64Array | null = null;
      const now = 1000;

      // With burst=20 and limit=10, should allow up to 20 requests at once
      for (let i = 0; i < 20; i++) {
        const r = gcraConsume(state, now, 1, 10, 1000, 20);
        state = r.state;
        expect(r.result.allowed).toBe(true);
      }

      // 21st should be blocked
      const blocked = gcraConsume(state, now, 1, 10, 1000, 20);
      expect(blocked.result.allowed).toBe(false);
    });

    it('burst defaults to limit', () => {
      // Test that the pure function with burst=limit behaves correctly
      let state: Float64Array | null = null;
      const now = 1000;

      for (let i = 0; i < 10; i++) {
        const r = gcraConsume(state, now, 1, 10, 1000, 10);
        state = r.state;
        expect(r.result.allowed).toBe(true);
      }

      const blocked = gcraConsume(state, now, 1, 10, 1000, 10);
      expect(blocked.result.allowed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Strategy factory
  // -----------------------------------------------------------------------
  describe('createGcraStrategy', () => {
    let clock: ManualClock;
    let strategy: Strategy;

    beforeEach(() => {
      clock = new ManualClock(1000);
      strategy = createGcraStrategy({
        limit: 5,
        periodMs: 1000,
        clock,
      }) as Strategy;
    });

    it('allows first request', () => {
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4);
    });

    it('allows exactly LIMIT requests then blocks', () => {
      for (let i = 0; i < 5; i++) {
        const result = strategy.apply('key', 1);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4 - i);
      }

      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('tracks separate state per key', () => {
      const r1 = strategy.apply('key-a', 1);
      const r2 = strategy.apply('key-b', 1);
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);

      // Exhaust key-a
      for (let i = 0; i < 4; i++) strategy.apply('key-a', 1);

      const blocked = strategy.apply('key-a', 1);
      expect(blocked.allowed).toBe(false);

      // key-b should still work
      const freshB = strategy.apply('key-b', 1);
      expect(freshB.allowed).toBe(true);
      expect(freshB.remaining).toBe(3);
    });

    it('cost=0 does not consume capacity', () => {
      // Consume 1 — remaining should be 4
      strategy.apply('key', 1);
      // Cost 0 should still see 4 remaining (no mutation)
      const r = strategy.apply('key', 0);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it('cost > LIMIT is immediately rejected', () => {
      const result = strategy.apply('key', 10);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(5);
      expect(result.retryAfterMs).toBe(Infinity);
    });

    it('recovers after time advances', () => {
      // limit=5, periodMs=1000 => emission_interval=200ms, burst_offset=1000ms
      // Exhaust at t=1000
      for (let i = 0; i < 5; i++) strategy.apply('key', 1);

      // Advance by 1 emission interval (200ms)
      clock.advanceBy(200);

      // Exactly 1 request recovered. After consuming it, remaining=0.
      const recovered = strategy.apply('key', 1);
      expect(recovered.allowed).toBe(true);
      expect(recovered.remaining).toBe(0);
    });

    it('allow burst of LIMIT requests at the same timestamp', () => {
      // With burst=5 and limit=5, all 5 should pass at once
      for (let i = 0; i < 5; i++) {
        const result = strategy.apply('key', 1);
        expect(result.allowed).toBe(true);
      }

      // 6th should block
      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);
    });

    it('retryAfterMs is 0 when allowed, >0 when blocked', () => {
      const allowed = strategy.apply('key', 1);
      expect(allowed.retryAfterMs).toBe(0);

      for (let i = 0; i < 4; i++) strategy.apply('key', 1);

      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it('retryAfterMs matches actual time until capacity', () => {
      for (let i = 0; i < 5; i++) strategy.apply('key', 1);

      const blocked = strategy.apply('key', 1);
      const now = clock.now();
      expect(blocked.retryAfterMs).toBe(blocked.resetAt - now);
    });

    it('peek returns null for unknown key', () => {
      expect(strategy.peek!('unknown')).toBeNull();
    });

    it('peek returns correct remaining without mutating', () => {
      // After 1 request, remaining should be 4
      strategy.apply('key', 1);
      const peeked = strategy.peek!('key');
      expect(peeked).not.toBeNull();
      expect(peeked!.remaining).toBe(4);

      // Peek should not change state — second peek shows same
      const peeked2 = strategy.peek!('key');
      expect(peeked2!.remaining).toBe(4);

      // Actual request should still work
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3);
    });

    it('state export/import roundtrip', () => {
      strategy.apply('key', 1);
      strategy.apply('key', 1);

      const stateA = strategy.exportState!('key');
      const cloned = JSON.parse(JSON.stringify(stateA));
      strategy.importState!('key-b', cloned);

      const resultA = strategy.apply('key', 1);
      const resultB = strategy.apply('key-b', 1);
      expect(resultA.remaining).toBe(resultB.remaining);
    });

    it('reset clears state', () => {
      strategy.apply('key', 1);
      strategy.reset!('key');
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('supports custom burst option', () => {
      clock = new ManualClock(1000);
      const bursty = createGcraStrategy({
        limit: 5,
        periodMs: 1000,
        burst: 10,
        clock,
      }) as Strategy;

      // Should allow 10 requests at once (burst=10, limit=5)
      for (let i = 0; i < 10; i++) {
        const r = bursty.apply('key', 1);
        expect(r.allowed).toBe(true);
      }

      // 11th should block
      const blocked = bursty.apply('key', 1);
      expect(blocked.allowed).toBe(false);
    });
  });
});
