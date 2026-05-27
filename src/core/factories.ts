/**
 * First-class strategy factories.
 *
 * Each factory returns a ready-to-use {@link Limiter} wired to a specific
 * strategy, without requiring the caller to construct intermediate objects.
 *
 * @example
 * ```typescript
 * import { tokenBucket } from 'throttlekit';
 *
 * const limiter = tokenBucket({ capacity: 10, refillRate: 1 });
 * const result = await limiter.check('user:123');
 * ```
 */

import type { Limiter, Store, Clock } from './types.js';
import { LimiterImpl } from './limiter.js';
import { SystemClock } from './clock.js';
import { MemoryStore } from '../stores/memory-store.js';
import { createTokenBucketStrategy } from '../strategies/token-bucket.js';
import { createFixedWindowStrategy } from '../strategies/fixed-window.js';
import { createSlidingLogStrategy } from '../strategies/sliding-window-log.js';
import { createSlidingCounterStrategy } from '../strategies/sliding-window-counter.js';
import { createSlidingWindowStrategy } from '../strategies/sliding-window.js';
import { createGcraStrategy } from '../strategies/gcra.js';
import {
  tokenBucketLua,
  fixedWindowLua,
  slidingWindowLogLua,
  slidingWindowCounterLua,
} from '../stores/redis.js';

// ---------------------------------------------------------------------------
// Shared base options
// ---------------------------------------------------------------------------

interface BaseOptions {
  store?: Store;
  clock?: Clock;
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Token Bucket
// ---------------------------------------------------------------------------

export interface TokenBucketOptions extends BaseOptions {
  capacity: number;
  refillRate: number; // tokens per second
}

export function tokenBucket(options: TokenBucketOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { capacity, refillRate } = options;
  const strategy = createTokenBucketStrategy({ capacity, refillRate, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= refillRate > 0 ? Math.ceil((capacity / refillRate) * 1000) + 1000 : 60_000;
  if (typeof (store as any).setLuaStrategy === 'function') {
    (store as any).setLuaStrategy(tokenBucketLua);
  }
  return new LimiterImpl(strategy, store, ttlMs);
}

// ---------------------------------------------------------------------------
// Fixed Window
// ---------------------------------------------------------------------------

export interface FixedWindowOptions extends BaseOptions {
  limit: number;
  windowMs: number;
}

export function fixedWindow(options: FixedWindowOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { limit, windowMs } = options;
  const strategy = createFixedWindowStrategy({ limit, windowMs, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= windowMs;
  if (typeof (store as any).setLuaStrategy === 'function') {
    (store as any).setLuaStrategy(fixedWindowLua);
  }
  return new LimiterImpl(strategy, store, ttlMs);
}

// ---------------------------------------------------------------------------
// Sliding Window Log
// ---------------------------------------------------------------------------

export interface SlidingWindowLogOptions extends BaseOptions {
  limit: number;
  windowMs: number;
}

export function slidingWindowLog(options: SlidingWindowLogOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { limit, windowMs } = options;
  const strategy = createSlidingLogStrategy({ limit, windowMs, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= windowMs;
  if (typeof (store as any).setLuaStrategy === 'function') {
    (store as any).setLuaStrategy(slidingWindowLogLua);
  }
  return new LimiterImpl(strategy, store, ttlMs);
}

// ---------------------------------------------------------------------------
// Sliding Window Counter
// ---------------------------------------------------------------------------

export interface SlidingWindowCounterOptions extends BaseOptions {
  limit: number;
  windowMs: number;
}

export function slidingWindowCounter(options: SlidingWindowCounterOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { limit, windowMs } = options;
  const strategy = createSlidingCounterStrategy({ limit, windowMs, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= windowMs * 2;
  if (typeof (store as any).setLuaStrategy === 'function') {
    (store as any).setLuaStrategy(slidingWindowCounterLua);
  }
  return new LimiterImpl(strategy, store, ttlMs);
}

// ---------------------------------------------------------------------------
// Sliding Window (bucketed)
// ---------------------------------------------------------------------------

export interface SlidingWindowOptions extends BaseOptions {
  limit: number;
  windowMs: number;
  buckets?: number; // default 10
}

export function slidingWindow(options: SlidingWindowOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { limit, windowMs } = options;
  const buckets = options.buckets ?? 10;
  const strategy = createSlidingWindowStrategy({ limit, windowMs, buckets, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= windowMs * 2;
  // No Lua fast path for bucketed sliding window (state layout differs)
  return new LimiterImpl(strategy, store, ttlMs);
}

// ---------------------------------------------------------------------------
// GCRA / Leaky Bucket
// ---------------------------------------------------------------------------

export interface GcraOptions extends BaseOptions {
  limit: number;
  periodMs: number;
  burst?: number;
}

export function gcra(options: GcraOptions): Limiter {
  const clock = options.clock ?? new SystemClock();
  const store = options.store ?? new MemoryStore();
  const { limit, periodMs } = options;
  const burst = options.burst ?? limit;
  const strategy = createGcraStrategy({ limit, periodMs, burst, clock });
  let ttlMs = options.ttlMs;
  ttlMs ??= periodMs * 2;
  // NOTE: gcraLua is NOT wired here because RedisStore.applyWithLua/evalLua
  // passes a generic (cost, ttlMs) arg list that is incompatible with
  // gcraLua's 6-parameter contract. This mirrors the pre-existing reality
  // that rateLimit() never supported gcra via Redis Lua.
  return new LimiterImpl(strategy, store, ttlMs);
}
