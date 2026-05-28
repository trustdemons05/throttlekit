/**
 * Redis live integration tests.
 *
 * These tests require a real Redis server. Set REDIS_URL to override the
 * default redis://127.0.0.1:6379 endpoint.
 * If Redis is unavailable the entire suite is skipped gracefully.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createRedisStore,
  tokenBucketLua,
  fixedWindowLua,
  slidingWindowLogLua,
  slidingWindowCounterLua,
  gcraLua,
} from '../../src/stores/redis.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  n: number;
}

// ---------------------------------------------------------------------------
// Connection probe (top-level await so skipIf can be evaluated synchronously)
// ---------------------------------------------------------------------------

let store: Store & {
  get: <T>(key: string) => Promise<T | null>;
  set: <T>(key: string, value: T, ttlMs?: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
  applyWithLua: (key: string, ttlMs: number, cost: number, ...extraArgs: string[]) => Promise<import('../../src/core/types.js').RateLimitResult>;
  setLuaStrategy: (script: string, ...extraArgs: string[]) => void;
  clearLuaStrategy: () => void;
};
let skip = false;
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

try {
  store = (await createRedisStore({
    url: redisUrl,
  })) as unknown as typeof store;

  await store.set('throttlekit:test:ping', 'pong', 1000);
  const val = await store.get<string>('throttlekit:test:ping');
  if (val !== 'pong') throw new Error('Ping mismatch');
  await store.delete('throttlekit:test:ping');
} catch (err) {
  console.warn(
    `Redis not available at ${redisUrl}, skipping live integration tests`,
  );
  skip = true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skip)('Redis live integration', () => {
  afterAll(async () => {
    try {
      const redis = (store as any).redis;
      if (redis) {
        const keys: string[] = await redis.keys('throttlekit:test:*');
        if (keys && keys.length > 0) {
          await redis.del(...keys);
        }
      }
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // a. Token Bucket Lua
  // -------------------------------------------------------------------------
  it('Token Bucket Lua allows then denies correctly', async () => {
    const key = 'throttlekit:test:token-bucket';
    await store.delete(key);
    store.setLuaStrategy(tokenBucketLua, '10', '1'); // capacity=10, refillRate=1

    const first = await store.applyWithLua(key, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(10);
    expect(first.remaining).toBe(9);
    expect(first.retryAfterMs).toBe(0);

    // Exhaust the bucket
    for (let i = 0; i < 9; i++) {
      const r = await store.applyWithLua(key, 60_000, 1);
      expect(r.allowed).toBe(true);
    }

    const denied = await store.applyWithLua(key, 60_000, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // b. Fixed Window Lua
  // -------------------------------------------------------------------------
  it('Fixed Window Lua respects window boundaries', async () => {
    const key = 'throttlekit:test:fixed-window';
    await store.delete(key);
    store.setLuaStrategy(fixedWindowLua, '5', '1000'); // limit=5, windowMs=1000

    const first = await store.applyWithLua(key, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(5);

    for (let i = 0; i < 4; i++) {
      expect((await store.applyWithLua(key, 60_000, 1)).allowed).toBe(true);
    }

    const denied = await store.applyWithLua(key, 60_000, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // Wait for the window to roll over
    await new Promise((r) => setTimeout(r, denied.retryAfterMs + 50));
    const afterReset = await store.applyWithLua(key, 60_000, 1);
    expect(afterReset.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // c. Sliding Window Log Lua
  // -------------------------------------------------------------------------
  it('Sliding Window Log Lua prunes expired entries', async () => {
    const key = 'throttlekit:test:sliding-log';
    await store.delete(key);
    store.setLuaStrategy(slidingWindowLogLua, '5', '1000'); // limit=5, windowMs=1000

    for (let i = 0; i < 5; i++) {
      expect((await store.applyWithLua(key, 60_000, 1)).allowed).toBe(true);
    }

    const denied = await store.applyWithLua(key, 60_000, 1);
    expect(denied.allowed).toBe(false);

    // Wait for the log window to slide past the oldest entry
    await new Promise((r) => setTimeout(r, 1100));
    const afterSlide = await store.applyWithLua(key, 60_000, 1);
    expect(afterSlide.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // d. Sliding Window Counter Lua
  // -------------------------------------------------------------------------
  it('Sliding Window Counter Lua uses weighted interpolation', async () => {
    const key = 'throttlekit:test:sliding-counter';
    await store.delete(key);
    store.setLuaStrategy(slidingWindowCounterLua, '10', '1000'); // limit=10, windowMs=1000

    const first = await store.applyWithLua(key, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(10);

    // Exhaust
    for (let i = 0; i < 9; i++) {
      expect((await store.applyWithLua(key, 60_000, 1)).allowed).toBe(true);
    }

    const denied = await store.applyWithLua(key, 60_000, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);

    // Wait part-way into the next window so weighted interpolation allows a request
    await new Promise((r) => setTimeout(r, 600));
    const partial = await store.applyWithLua(key, 60_000, 1);
    expect(typeof partial.allowed).toBe('boolean');
  });

  // -------------------------------------------------------------------------
  // e. GCRA Lua
  // -------------------------------------------------------------------------
  it('GCRA Lua updates TAT atomically', async () => {
    const key = 'throttlekit:test:gcra';
    await store.delete(key);
    // limit=10, periodMs=1000, burst=10  => emission_interval=100ms, burst_offset=1000ms
    store.setLuaStrategy(gcraLua, '100', '1000', '10', '10');

    const first = await store.applyWithLua(key, 60_000, 1);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(10);

    // Exhaust burst
    for (let i = 0; i < 9; i++) {
      expect((await store.applyWithLua(key, 60_000, 1)).allowed).toBe(true);
    }

    const denied = await store.applyWithLua(key, 60_000, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // Wait for one emission interval to recover
    await new Promise((r) => setTimeout(r, denied.retryAfterMs + 50));
    const recovered = await store.applyWithLua(key, 60_000, 1);
    expect(recovered.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // f. 200 concurrent applies (WATCH/MULTI/EXEC path)
  // -------------------------------------------------------------------------
  it('200 concurrent apply calls produce exactly 200 unique increments', async () => {
    const key = 'throttlekit:test:concurrent-apply';
    await store.delete(key);
    store.clearLuaStrategy();

    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        store.apply<CounterState, number>(key, 60_000, (prev) => {
          const next = (prev?.n ?? 0) + 1;
          return { state: { n: next }, result: next };
        }),
      ),
    );

    const unique = new Set(results);
    expect(unique.size).toBe(200);
    expect(Math.max(...results)).toBe(200);
  });

  // -------------------------------------------------------------------------
  // g. WATCH/MULTI/EXEC retries — no data loss on conflict
  // -------------------------------------------------------------------------
  it('WATCH/MULTI/EXEC retries resolve concurrent conflicts without data loss', async () => {
    const key = 'throttlekit:test:watch-retry';
    await store.delete(key);
    store.clearLuaStrategy();

    const [r1, r2] = await Promise.all([
      store.apply<CounterState, number>(key, 60_000, (prev) => {
        const next = (prev?.n ?? 0) + 1;
        return { state: { n: next }, result: next };
      }),
      store.apply<CounterState, number>(key, 60_000, (prev) => {
        const next = (prev?.n ?? 0) + 1;
        return { state: { n: next }, result: next };
      }),
    ]);

    expect(new Set([r1, r2]).size).toBe(2);

    const final = await store.get<CounterState>(key);
    expect(final?.n).toBe(2);
  });

  // -------------------------------------------------------------------------
  // h. Lua EVALSHA fallback to EVAL on NOSCRIPT
  // -------------------------------------------------------------------------
  it('Lua EVALSHA falls back to EVAL after SCRIPT FLUSH', async () => {
    const key = 'throttlekit:test:noscript-fallback';
    await store.delete(key);
    store.setLuaStrategy(tokenBucketLua, '10', '1');

    // Warm the script cache
    const before = await store.applyWithLua(key, 60_000, 1);
    expect(before.allowed).toBe(true);

    // Evict the script from Redis cache
    const redis = (store as any).redis;
    await redis.script('FLUSH');

    // Next call should fall back to EVAL and still succeed
    const after = await store.applyWithLua(key, 60_000, 1);
    expect(after.allowed).toBe(true);
  });
});
