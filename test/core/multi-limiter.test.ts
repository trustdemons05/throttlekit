/**
 * Tests for the multi-dimensional rate limiter (multiRateLimit).
 *
 * Covers:
 *   - all() mode: ALL dimensions must allow the request
 *   - any() mode: ANY dimension can allow the request
 *   - Per-dimension cost function
 *   - Short-circuit behavior
 */

import { describe, it, expect } from 'vitest';
import { multiRateLimit, all, any } from '../../src/core/multi-limiter.js';
import { tokenBucket, fixedWindow } from '../../src/core/factories.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx {
  userId: string;
  ip: string;
  cost?: number;
}

function createLimiters(clock: ManualClock, store: MemoryStore) {
  const ipLimiter = tokenBucket({
    capacity: 10,
    refillRate: 10,
    clock,
    store,
  });

  const userLimiter = fixedWindow({
    limit: 5,
    windowMs: 60_000,
    clock,
    store,
  });

  return { ipLimiter, userLimiter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('multiRateLimit', () => {
  describe('all() mode', () => {
    it('allows when all dimensions allow', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });
      const { ipLimiter, userLimiter } = createLimiters(clock, store);

      const limiter = multiRateLimit<Ctx>({
        strategy: all({
          ip: {
            key: (ctx) => `ip:${ctx.ip}`,
            strategy: ipLimiter,
          },
          user: {
            key: (ctx) => `user:${ctx.userId}`,
            strategy: userLimiter,
          },
        }),
      });

      const result = await limiter.check({ userId: 'abc', ip: '1.2.3.4' });
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(5); // min(10, 5) = 5
      expect(result.remaining).toBe(4); // min(9, 4)
    });

    it('blocks when any dimension blocks (short-circuit)', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });
      const { ipLimiter, userLimiter } = createLimiters(clock, store);

      const limiter = multiRateLimit<Ctx>({
        strategy: all({
          ip: {
            key: (ctx) => `ip:${ctx.ip}`,
            strategy: ipLimiter,
          },
          user: {
            key: (ctx) => `user:${ctx.userId}`,
            strategy: userLimiter,
          },
        }),
      });

      // Exhaust the ip limiter (capacity=10)
      const ctx: Ctx = { userId: 'abc', ip: '1.2.3.4' };
      for (let i = 0; i < 10; i++) {
        await limiter.check(ctx);
      }

      // Next call should be blocked by ip limiter (not user)
      const blocked = await limiter.check(ctx);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('works with per-dimension cost functions', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });
      const { ipLimiter, userLimiter } = createLimiters(clock, store);

      const limiter = multiRateLimit<Ctx>({
        strategy: all({
          ip: {
            key: (ctx) => `ip:${ctx.ip}`,
            strategy: ipLimiter,
            cost: (ctx) => ctx.cost ?? 1,
          },
          user: {
            key: (ctx) => `user:${ctx.userId}`,
            strategy: userLimiter,
            cost: (ctx) => ctx.cost ?? 1,
          },
        }),
      });

      // Use cost=3
      const result = await limiter.check({ userId: 'abc', ip: '1.2.3.4', cost: 3 });
      expect(result.allowed).toBe(true);
      // ip: 10 - 3 = 7, user: 5 - 3 = 2, min = 2
      expect(result.remaining).toBe(2);
    });
  });

  describe('any() mode', () => {
    it('allows when any dimension allows', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });
      const { ipLimiter, userLimiter } = createLimiters(clock, store);

      const limiter = multiRateLimit<Ctx>({
        strategy: any({
          ip: {
            key: (ctx) => `ip:${ctx.ip}`,
            strategy: ipLimiter,
          },
          user: {
            key: (ctx) => `user:${ctx.userId}`,
            strategy: userLimiter,
          },
        }),
      });

      const result = await limiter.check({ userId: 'abc', ip: '1.2.3.4' });
      expect(result.allowed).toBe(true);
    });

    it('blocks only when ALL dimensions block', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });

      const strictIp = tokenBucket({
        capacity: 1,
        refillRate: 0, // no refill
        clock,
        store,
      });

      const strictUser = fixedWindow({
        limit: 1,
        windowMs: 60_000,
        clock,
        store,
      });

      const limiter = multiRateLimit<Ctx>({
        strategy: any({
          ip: {
            key: (ctx) => `ip:${ctx.ip}`,
            strategy: strictIp,
          },
          user: {
            key: (ctx) => `user:${ctx.userId}`,
            strategy: strictUser,
          },
        }),
      });

      const ctx: Ctx = { userId: 'abc', ip: '1.2.3.4' };

      // First request: ip allows (both fresh, ip short-circuits user)
      const r1 = await limiter.check(ctx);
      expect(r1.allowed).toBe(true);

      // Second request: ip blocks, user is still fresh (was never called),
      // so ANY mode allows via user
      const r2 = await limiter.check(ctx);
      expect(r2.allowed).toBe(true);

      // Third request: ip blocks (still exhausted), user now blocks (limit=1 used on r2)
      const r3 = await limiter.check(ctx);
      expect(r3.allowed).toBe(false);
    });

    it('returns best retryAfterMs when all dimensions block', async () => {
      const clock = new ManualClock(1_000_000);
      const store = new MemoryStore({ clock });

      const fastRecover = tokenBucket({
        capacity: 1,
        refillRate: 0, // no refill for deterministic test
        clock,
        store,
      });

      const slowRecover = fixedWindow({
        limit: 1,
        windowMs: 60_000,
        clock,
        store,
      });

      const limiter = multiRateLimit<Ctx>({
        strategy: any({
          fast: {
            key: () => 'fast',
            strategy: fastRecover,
          },
          slow: {
            key: () => 'slow',
            strategy: slowRecover,
          },
        }),
      });

      const ctx: Ctx = { userId: 'abc', ip: '1.2.3.4' };

      // First request: fast allows (short-circuits slow)
      await limiter.check(ctx);

      // Second request: fast blocks, slow is fresh -> allows
      await limiter.check(ctx);

      // Third request: fast still blocks, slow now blocks too -> both blocked
      const blocked = await limiter.check(ctx);
      expect(blocked.allowed).toBe(false);
      // Should return best (shortest) retryAfterMs
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('combinator helpers', () => {
    it('all() creates type="all" combinator', () => {
      const result = all({});
      expect(result.type).toBe('all');
      expect(result.dims).toEqual({});
    });

    it('any() creates type="any" combinator', () => {
      const result = any({});
      expect(result.type).toBe('any');
      expect(result.dims).toEqual({});
    });
  });
});
