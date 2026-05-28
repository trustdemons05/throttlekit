/**
 * Clean-room JS mirrors of the Redis Lua scripts for each built-in strategy.
 *
 * These functions are derived directly from the Lua logic in src/stores/redis.ts
 * and src/strategies/gcra.ts — not copied from the in-memory JS implementations.
 * They are used by conformance tests to verify that the JS strategies produce the
 * same decisions and metadata as their Redis Lua counterparts.
 */

import type { RateLimitResult } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Token Bucket
// ---------------------------------------------------------------------------

export interface TokenBucketLuaState {
  tokens: number;
  lastRefill: number;
}

export function tokenBucketLuaMirror(
  state: TokenBucketLuaState | null,
  now: number,
  cost: number,
  capacity: number,
  refillRate: number,
): { state: TokenBucketLuaState; result: RateLimitResult } {
  let tokens: number;
  let lastRefill: number;
  const raw = state !== null;

  if (raw) {
    tokens = state.tokens;
    lastRefill = state.lastRefill;
  } else {
    tokens = capacity;
    lastRefill = now;
  }

  if (cost > capacity) {
    return {
      state: { tokens, lastRefill },
      result: {
        allowed: false,
        limit: capacity,
        remaining: capacity,
        resetAt: now,
        retryAfterMs: 2147483647,
      },
    };
  }

  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(capacity, tokens + elapsed * refillRate);

  if (tokens >= cost) {
    tokens = tokens - cost;
    const remaining = Math.floor(tokens);
    let resetAt: number;
    if (refillRate > 0) {
      resetAt = now + Math.ceil(((capacity - tokens) / refillRate) * 1000);
    } else {
      resetAt = now;
    }
    return {
      state: { tokens, lastRefill: now },
      result: {
        allowed: true,
        limit: capacity,
        remaining,
        resetAt,
        retryAfterMs: 0,
      },
    };
  } else {
    const deficit = cost - tokens;
    let retryAfterMs: number;
    if (refillRate > 0) {
      retryAfterMs = Math.ceil((deficit / refillRate) * 1000);
    } else {
      retryAfterMs = 2147483647;
    }
    const resetAt = now + retryAfterMs;
    return {
      state: { tokens, lastRefill: now },
      result: {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetAt,
        retryAfterMs,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fixed Window
// ---------------------------------------------------------------------------

export interface FixedWindowLuaState {
  count: number;
  windowStart: number;
}

export function fixedWindowLuaMirror(
  state: FixedWindowLuaState | null,
  now: number,
  cost: number,
  limit: number,
  windowMs: number,
): { state: FixedWindowLuaState; result: RateLimitResult } {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  if (cost > limit) {
    return {
      state: state ?? { count: 0, windowStart },
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now,
        retryAfterMs: 2147483647,
      },
    };
  }

  let count: number;
  let stateWindowStart: number;
  const raw = state !== null;

  if (raw) {
    count = state.count;
    stateWindowStart = state.windowStart;
  } else {
    count = 0;
    stateWindowStart = windowStart;
  }

  if (stateWindowStart !== windowStart) {
    count = cost;
    stateWindowStart = windowStart;
    const remaining = limit - cost;
    return {
      state: { count, windowStart: stateWindowStart },
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt,
        retryAfterMs: 0,
      },
    };
  }

  const newCount = count + cost;
  if (newCount <= limit) {
    const remaining = limit - newCount;
    return {
      state: { count: newCount, windowStart: stateWindowStart },
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt,
        retryAfterMs: 0,
      },
    };
  }

  const retryAfterMs = resetAt - now;
  return {
    state: { count, windowStart: stateWindowStart },
    result: {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Sliding Window Log
// ---------------------------------------------------------------------------

export function slidingWindowLogLuaMirror(
  state: number[] | null,
  now: number,
  cost: number,
  limit: number,
  windowMs: number,
): { state: number[]; result: RateLimitResult } {
  const windowStart = now - windowMs;

  if (cost > limit) {
    return {
      state: state ?? [],
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: windowMs,
      },
    };
  }

  if (cost <= 0) {
    return {
      state: state ?? [],
      result: {
        allowed: true,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      },
    };
  }

  const log = state ?? [];
  const pruned: number[] = [];
  for (let i = 0; i < log.length; i++) {
    // Loop bound guarantees index is valid
    if (log[i]! >= windowStart) {
      pruned.push(log[i]!);
    }
  }

  if (pruned.length + cost <= limit) {
    for (let i = 0; i < cost; i++) {
      pruned.push(now);
    }
    const remaining = limit - pruned.length;
    return {
      state: pruned,
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      },
    };
  }

  const oldest = pruned[0]!;
  const retryAfterMs = Math.max(0, oldest + windowMs - now);
  return {
    state: pruned,
    result: {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: oldest + windowMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Sliding Window Counter
// ---------------------------------------------------------------------------

export interface SlidingWindowCounterLuaState {
  prevCount: number;
  currCount: number;
  currentWindowStart: number;
}

export function slidingWindowCounterLuaMirror(
  state: SlidingWindowCounterLuaState | null,
  now: number,
  cost: number,
  limit: number,
  windowMs: number,
): { state: SlidingWindowCounterLuaState; result: RateLimitResult } {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  if (cost > limit) {
    return {
      state: state ?? { prevCount: 0, currCount: 0, currentWindowStart: windowStart },
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: windowMs,
      },
    };
  }

  if (cost <= 0) {
    return {
      state: state ?? { prevCount: 0, currCount: 0, currentWindowStart: windowStart },
      result: {
        allowed: true,
        limit,
        remaining: limit,
        resetAt: now + windowMs,
        retryAfterMs: 0,
      },
    };
  }

  const elapsed = (now - windowStart) / windowMs;
  const weight = Math.max(0, Math.min(1, 1 - elapsed));

  let prevCount = 0;
  let currCount = 0;
  let currentWindowStart = windowStart;
  const raw = state !== null;

  if (raw) {
    prevCount = state.prevCount;
    currCount = state.currCount;
    currentWindowStart = state.currentWindowStart;
  }

  if (currentWindowStart !== windowStart) {
    prevCount = 0;
    currCount = 0;
    currentWindowStart = windowStart;
  }

  const estimated = prevCount * weight + currCount;

  if (estimated + cost <= limit) {
    currCount = currCount + cost;
    const remaining = Math.max(0, Math.floor(limit - estimated - cost));
    return {
      state: { prevCount, currCount, currentWindowStart },
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt,
        retryAfterMs: 0,
      },
    };
  }

  const deficit = estimated + cost - limit;
  const retryAfterMs = Math.ceil((deficit / limit) * windowMs);
  return {
    state: { prevCount, currCount, currentWindowStart },
    result: {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: now + retryAfterMs,
      retryAfterMs,
    },
  };
}

// ---------------------------------------------------------------------------
// GCRA
// ---------------------------------------------------------------------------

export function gcraLuaMirror(
  state: number | null,
  now: number,
  cost: number,
  limit: number,
  periodMs: number,
  burst: number,
): { state: number; result: RateLimitResult } {
  const emissionInterval = periodMs / limit;
  const burstOffset = burst * emissionInterval;

  // Cost exceeds limit: reject immediately (mirrors gcraConsume behaviour)
  if (cost > limit) {
    return {
      state: state ?? now,
      result: {
        allowed: false,
        limit,
        remaining: limit,
        resetAt: now,
        retryAfterMs: Infinity,
      },
    };
  }

  // Zero or negative cost: allow without consuming capacity (mirrors gcraConsume)
  if (cost <= 0) {
    const tat = state ?? now;
    const headroom = burstOffset - (tat - now);
    const remaining = Math.max(0, Math.min(burst, Math.floor(headroom / emissionInterval)));
    return {
      state: state ?? now,
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt: now + burstOffset,
        retryAfterMs: 0,
      },
    };
  }

  // Lua reads tat from state or defaults to now
  let tat = state ?? now;

  const newTat = Math.max(now, tat) + emissionInterval * cost;

  if (newTat - burstOffset <= now) {
    const headroom = burstOffset - (newTat - now);
    let remaining = Math.floor(headroom / emissionInterval);
    if (remaining > burst) remaining = burst;
    if (remaining < 0) remaining = 0;
    return {
      state: newTat,
      result: {
        allowed: true,
        limit,
        remaining,
        resetAt: now + burstOffset,
        retryAfterMs: 0,
      },
    };
  } else {
    const retryAfter = Math.max(0, newTat - burstOffset - now);
    return {
      state: tat,
      result: {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: now + retryAfter,
        retryAfterMs: retryAfter,
      },
    };
  }
}
