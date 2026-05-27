/**
 * Tests for strategy factories in src/core/factories.ts.
 *
 * Covers:
 *   - Each factory creates a working limiter (tokenBucket, fixedWindow, etc.)
 *   - Custom clock, store, and Lua scripting integration
 *   - Backward compat: rateLimit() still works with strategy parameter
 */

import { describe, it, expect, vi } from 'vitest';
import {
  tokenBucket, fixedWindow, slidingWindowLog,
  slidingWindowCounter, slidingWindow, gcra,
} from '../../src/core/factories.js';
import { rateLimit } from '../../src/core/limiter.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock store that records setLuaStrategy calls. */
function createMockLuaStore() {
  const store: any = {
    luaScript: null,
    setLuaStrategy(script: string) {
      store.luaScript = script;
    },
    async apply<S, T>(_key: string, _ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T> {
      const { result } = transform(null);
      return result;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// tokenBucket
// ---------------------------------------------------------------------------

describe('tokenBucket', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = tokenBucket({ capacity: 10, refillRate: 1, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = tokenBucket({ capacity: 10, refillRate: 10, clock });
    // Advance time so tokens refill
    clock.advanceBy(1100); // > 1s → 10 tokens refilled (but capped at capacity)
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(9);
    // Consume all tokens
    for (let i = 0; i < 9; i++) {
      await limiter.check('key');
    }
    const blocked = await limiter.check('key');
    expect(blocked.allowed).toBe(false);
    // Advance by 1s to refill 10 tokens
    clock.advanceBy(1000);
    const refilled = await limiter.check('key');
    expect(refilled.allowed).toBe(true);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = tokenBucket({ capacity: 10, refillRate: 1, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);

    // Verify state persisted by reading store directly
    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('wires Lua script for Redis-like store', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    tokenBucket({ capacity: 10, refillRate: 1, clock, store: store as any });
    expect((store as any).luaScript).toBeDefined();
    expect(typeof (store as any).luaScript).toBe('string');
    expect((store as any).luaScript.length).toBeGreaterThan(0);
    expect((store as any).luaScript.toLowerCase()).toContain('token');
  });
});

// ---------------------------------------------------------------------------
// fixedWindow
// ---------------------------------------------------------------------------

describe('fixedWindow', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = fixedWindow({ limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = fixedWindow({ limit: 5, windowMs: 1000, clock });
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);

    // Advance past window → resets
    clock.advanceBy(1001);
    const r2 = await limiter.check('key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(4);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = fixedWindow({ limit: 5, windowMs: 1000, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);

    // Verify state persisted by reading store directly
    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('wires Lua script for Redis-like store', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    fixedWindow({ limit: 5, windowMs: 1000, clock, store: store as any });
    expect((store as any).luaScript).toBeDefined();
    expect(typeof (store as any).luaScript).toBe('string');
    expect((store as any).luaScript.length).toBeGreaterThan(0);
    expect((store as any).luaScript.toLowerCase()).toContain('window');
  });
});

// ---------------------------------------------------------------------------
// slidingWindowLog
// ---------------------------------------------------------------------------

describe('slidingWindowLog', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = slidingWindowLog({ limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = slidingWindowLog({ limit: 5, windowMs: 1000, clock });
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);

    // Advance past window → resets
    clock.advanceBy(1001);
    const r2 = await limiter.check('key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(4);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = slidingWindowLog({ limit: 5, windowMs: 1000, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);

    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('wires Lua script for Redis-like store', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    slidingWindowLog({ limit: 5, windowMs: 1000, clock, store: store as any });
    expect((store as any).luaScript).toBeDefined();
    expect(typeof (store as any).luaScript).toBe('string');
    expect((store as any).luaScript.length).toBeGreaterThan(0);
    expect((store as any).luaScript.toLowerCase()).toContain('log');
  });
});

// ---------------------------------------------------------------------------
// slidingWindowCounter
// ---------------------------------------------------------------------------

describe('slidingWindowCounter', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = slidingWindowCounter({ limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = slidingWindowCounter({ limit: 5, windowMs: 1000, clock });
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);

    clock.advanceBy(1001);
    const r2 = await limiter.check('key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(4);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = slidingWindowCounter({ limit: 5, windowMs: 1000, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);

    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('wires Lua script for Redis-like store', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    slidingWindowCounter({ limit: 5, windowMs: 1000, clock, store: store as any });
    expect((store as any).luaScript).toBeDefined();
    expect(typeof (store as any).luaScript).toBe('string');
    expect((store as any).luaScript.length).toBeGreaterThan(0);
    expect((store as any).luaScript.toLowerCase()).toContain('prevcount');
  });
});

// ---------------------------------------------------------------------------
// slidingWindow (bucketed)
// ---------------------------------------------------------------------------

describe('slidingWindow', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = slidingWindow({ limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = slidingWindow({ limit: 5, windowMs: 1000, clock });
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);

    clock.advanceBy(1001);
    const r2 = await limiter.check('key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(4);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = slidingWindow({ limit: 5, windowMs: 1000, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);

    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('does NOT wire Lua script (no Lua fast path)', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    slidingWindow({ limit: 5, windowMs: 1000, clock, store: store as any });
    // slidingWindow has no Lua fast path → setLuaStrategy should NOT be called
    expect((store as any).luaScript).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gcra
// ---------------------------------------------------------------------------

describe('gcra', () => {
  it('creates a working limiter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = gcra({ limit: 5, periodMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('accepts a custom clock', async () => {
    const clock = new ManualClock(1000000);
    const limiter = gcra({ limit: 5, periodMs: 1000, clock });
    const r1 = await limiter.check('key');
    expect(r1.allowed).toBe(true);

    clock.advanceBy(1001);
    const r2 = await limiter.check('key');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(4);
  });

  it('accepts a custom store', async () => {
    const clock = new ManualClock(Date.now());
    const store = new MemoryStore({ clock });
    const limiter = gcra({ limit: 5, periodMs: 1000, clock, store });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);

    const state = await store.get('key');
    expect(state).not.toBeNull();
  });

  it('does NOT wire Lua script (no Lua fast path)', async () => {
    const clock = new ManualClock(Date.now());
    const store = createMockLuaStore();
    gcra({ limit: 5, periodMs: 1000, clock, store: store as any });
    // gcra has no Lua fast path → setLuaStrategy should NOT be called
    expect((store as any).luaScript).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backward compat: rateLimit() still works
// ---------------------------------------------------------------------------

describe('backward compat', () => {
  it('rateLimit still works for token-bucket', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = rateLimit({ strategy: 'token-bucket', capacity: 10, refillRate: 1, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
  });

  it('rateLimit still works for fixed-window', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = rateLimit({ strategy: 'fixed-window', limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
  });

  it('rateLimit still works for sliding-window-log', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = rateLimit({ strategy: 'sliding-window-log', limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
  });

  it('rateLimit still works for sliding-window-counter', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = rateLimit({ strategy: 'sliding-window-counter', limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
  });

  it('rateLimit still works for sliding-window', async () => {
    const clock = new ManualClock(Date.now());
    const limiter = rateLimit({ strategy: 'sliding-window', limit: 5, windowMs: 1000, clock });
    const result = await limiter.check('key');
    expect(result.allowed).toBe(true);
  });
});
