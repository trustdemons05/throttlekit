# ThrottleKit — Complete Architecture & Implementation Reference

> **Purpose:** This document is the single source of truth for building ThrottleKit.  
> **Audience:** Orchestrator/coordinator spawning build workers.  
> **Status:** Research complete — ready to build.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture: Three-Layer Design](#2-architecture-three-layer-design)
3. [Package Structure & Build](#3-package-structure--build)
4. [Layer 1: Strategies](#4-layer-1-strategies)
5. [Layer 2: Store](#5-layer-2-store)
6. [Layer 3: Adapters](#6-layer-3-adapters)
7. [Composition: combine()](#7-composition-combine)
8. [Clock Injection](#8-clock-injection)
9. [Feature Inventory: MVP vs v2 vs v3](#9-feature-inventory-mvp-vs-v2-vs-v3)
10. [Testing Strategy](#10-testing-strategy)
11. [Competitive Differentiation](#11-competitive-differentiation)
12. [Build Order (Implementation Sequence)](#12-build-order-implementation-sequence)
13. [Acceptance Criteria](#13-acceptance-criteria)
14. [Edge Cases & Gotchas Reference](#14-edge-cases--gotchas-reference)

---

## 1. Project Overview

**ThrottleKit** is a pluggable, framework-agnostic rate-limiting toolkit for Node.js and web APIs. Drop it into any framework with a single import.

### One-Line Pitch

A rate-limiting toolkit with 4 algorithms, pluggable stores, framework adapters, and clock-injected deterministic testing — zero-config to production.

### Core Design Principle

Clean separation of concerns:
- **Strategies** = pure functions: `(state, now, cost) → {state, result}`
- **Store** = one atomic primitive: `apply(key, ttlMs, transform)`
- **Adapters** = thin wrappers wiring strategies+store to frameworks

### Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript 5.x | Type safety, ESM + CJS via tsup |
| Build | tsup | Zero-config TS bundler, ESM + CJS + .d.ts |
| Test | Vitest 4.x | Fast, compatible with ManualClock pattern |
| Property tests | fast-check | fuzz testing for strategy invariants |
| Redis | ioredis (optional peer dep) | Only needed for RedisStore |
| Runtime deps | **Zero required** | MemoryStore + strategies are dependency-free |

---

## 2. Architecture: Three-Layer Design

```
┌──────────────────────────────────────────────────────────┐
│                    Layer 3: Adapters                      │
│   Express middleware    │    Web-standard fetch wrapper   │
│   Fastify (v2)         │    Koa (v2)                     │
├──────────────────────────────────────────────────────────┤
│                    Layer 2: Store                         │
│   apply<S,T>(key, ttlMs, transform): Promise<T>          │
│   ┌─────────────────┐  ┌──────────────────┐              │
│   │   MemoryStore    │  │   RedisStore     │              │
│   │   per-key mutex  │  │  WATCH/MULTI/EXEC│              │
│   └─────────────────┘  └──────────────────┘              │
├──────────────────────────────────────────────────────────┤
│                    Layer 1: Strategies                    │
│   Pure functions: (state, now, cost) → { state, result } │
│   ┌──────────┐ ┌──────────┐ ┌──────┐ ┌───────────────┐  │
│   │Token     │ │Fixed     │ │Sliding│ │Sliding Window │  │
│   │Bucket    │ │Window    │ │Log    │ │Counter        │  │
│   └──────────┘ └──────────┘ └──────┘ └───────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Key Rule: Data flows DOWN, results flow UP

- Adapter → calls `limiter.check(key, cost)` → calls `store.apply()` → calls strategy function
- Strategy returns `{allowed, remaining, resetAt, retryAfterMs}` → store persists new state → adapter sets headers

### Subpath Exports

```jsonc
// package.json exports field
{
  "exports": {
    ".": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.js",
      "require": "./dist/core/index.cjs"
    },
    "./express": {
      "types": "./dist/adapters/express.d.ts",
      "import": "./dist/adapters/express.js",
      "require": "./dist/adapters/express.cjs"
    },
    "./fetch": {
      "types": "./dist/adapters/fetch.d.ts",
      "import": "./dist/adapters/fetch.js",
      "require": "./dist/adapters/fetch.cjs"
    },
    "./redis": {
      "types": "./dist/stores/redis.d.ts",
      "import": "./dist/stores/redis.js",
      "require": "./dist/stores/redis.cjs"
    }
  }
}
```

---

## 3. Package Structure & Build

### Directory Layout

```
throttlekit/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── LICENSE
├── demo/
│   └── server.ts              # Runnable demo server (zero-dep, ESM)
├── src/
│   ├── core/
│   │   ├── index.ts           # Re-exports public API
│   │   ├── clock.ts           # Clock interface, ManualClock, SystemClock
│   │   ├── combine.ts         # Multi-limit composition
│   │   ├── limiter.ts         # rateLimit() factory, Limiter class
│   │   └── types.ts           # Shared types: Strategy, Store, RateLimitResult, etc.
│   ├── strategies/
│   │   ├── types.ts           # StrategyFn type, Strategy interface
│   │   ├── token-bucket.ts    # Token bucket pure function + factory
│   │   ├── fixed-window.ts    # Fixed window pure function + factory
│   │   ├── sliding-window-log.ts
│   │   ├── sliding-window-counter.ts
│   │   └── index.ts           # Re-export all strategies
│   ├── stores/
│   │   ├── types.ts           # Store interface
│   │   ├── memory-store.ts    # In-memory store with per-key mutex
│   │   └── redis-store.ts     # Redis store (WATCH/MULTI/EXEC)
│   └── adapters/
│       ├── types.ts           # Adapter options types
│       ├── express.ts         # Express middleware
│       └── fetch.ts           # Web-standard fetch wrapper
├── test/
│   ├── setup.ts               # Vitest global setup
│   ├── helpers/
│   │   ├── concurrent.ts      # runConcurrent, simulateConcurrentSync
│   │   ├── mock-store.ts      # createFailingStore, createFlakyStore, createSpyStore
│   │   └── strategy-test-runner.ts  # runStrategyTests() shared contract
│   ├── strategies/
│   │   ├── token-bucket.test.ts
│   │   ├── fixed-window.test.ts
│   │   ├── sliding-window-log.test.ts
│   │   ├── sliding-window-counter.test.ts
│   │   └── invariants.test.ts     # Property-based tests (fast-check)
│   ├── stores/
│   │   ├── memory-store.test.ts
│   │   └── store-contract.test.ts  # Shared contract for any store impl
│   ├── adapters/
│   │   ├── express.test.ts
│   │   └── fetch.test.ts
│   ├── combine.test.ts
│   └── concurrent.test.ts     # Integration concurrency: store + strategy
└── examples/
    ├── express-basic.ts
    ├── express-custom-key.ts
    ├── express-multi-limit.ts
    ├── fetch-cloudflare.ts
    └── redis-scale-out.ts
```

### Build Configuration (tsup)

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'adapters/express': 'src/adapters/express.ts',
    'adapters/fetch': 'src/adapters/fetch.ts',
    'stores/redis': 'src/stores/redis.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
});
```

### Public API Surface

```typescript
// Core
export function rateLimit(options: RateLimitOptions): Limiter;
export function combine(...limiters: Limiter[]): Limiter;
export class ManualClock implements Clock;
export class SystemClock implements Clock;
export interface RateLimitResult { allowed, limit, remaining, resetAt, retryAfterMs }

// Types for extension
export type StrategyFn<S, R> = (state: S | null, now: number, cost: number) => StrategyResult<S>;
export interface Store { apply<S, T>(key, ttlMs, transform): Promise<T>; }
export interface Limiter { check(key, cost): Promise<RateLimitResult>; }

// Adapters
export function expressAdapter(limiter: Limiter, options?: ExpressAdapterOptions): ExpressMiddleware;
export function fetchAdapter(limiter: Limiter, options?: FetchAdapterOptions): FetchWrapper;
```

---

## 4. Layer 1: Strategies

### Strategy Interface

Every strategy is a **pure function** with this signature:

```typescript
type StrategyFn<S> = (
  state: S | null,     // Previous state (null = first request)
  now: number,          // Current time from injected clock (ms)
  cost: number          // Request cost (default 1)
) => StrategyResult<S>;

interface StrategyResult<S> {
  state: S;             // New state to persist
  allowed: boolean;     // Whether the request is permitted
  remaining: number;    // Remaining capacity (floor)
  resetAt: number;      // Epoch ms when capacity resets (for Retry-After)
  retryAfterMs: number; // Milliseconds client should wait (0 if allowed)
}
```

### Strategy: Token Bucket

**Parameters:** `capacity: number`, `refillRate: number` (tokens/second)

**State:** `{ tokens: number, lastRefill: number }`

**Algorithm:**
```
elapsed = (now - lastRefill) / 1000
tokens = min(capacity, tokens + elapsed * refillRate)   // Lazy refill
if tokens >= cost:
    tokens -= cost
    allowed = true, remaining = floor(tokens)
else:
    deficit = cost - tokens
    retryAfter = ceil(deficit / refillRate * 1000)
    allowed = false, remaining = 0
```

**Key Properties:**
- No background timer — refill is lazy (computed on next request)
- Burst = capacity tokens available instantly after idle period
- rate=0 means tokens never replenish (retryAfter=Infinity)
- Floating-point drift acceptable (<0.0001% over 1M ops)

**Edge Cases:**
| Scenario | Behavior |
|---|---|
| rate=0, no tokens | Reject, retryAfter=Infinity |
| rate=0, has tokens | Allow, tokens consumed and never refill |
| Idle for 100s, capacity=10 | min(10, 0+100*1) = 10 (capped) |
| Same-timestamp N requests with N*tokens capacity | All N allowed if atomic |
| Fractional tokens (rate=0.5, idle 3s, cost=1) | tokens=1.5, allow, remaining=floor(1.5-1)=0 |
| Large cost near empty (tokens=0.5, cost=10, idle 9.5s) | tokens=10, allow, remaining=0 |

### Strategy: Fixed Window

**Parameters:** `windowSizeMs: number`, `max: number`

**State:** `{ windowStart: number, count: number }`

**Algorithm:**
```
windowStart = floor(now / windowSizeMs) * windowSizeMs
resetAt = windowStart + windowSizeMs

if state is null OR state.windowStart !== windowStart:
    // New window
    state = { windowStart, count: 1 }, allowed = true
else if state.count < max:
    state = { ...state, count: state.count + 1 }, allowed = true
else:
    allowed = false
```

**Key Properties:**
- Aligned to wall-clock boundaries (not per-client start)
- Known 2x boundary burst: requests at end of window + start of next = double capacity
- Simple, fast, O(1) memory

**Edge Cases:**
| Scenario | Behavior |
|---|---|
| First request | Allowed, count=1, resetAt=windowSize |
| Exact boundary transition | New window starts at floor(now/windowSize)*windowSize |
| Boundary 1ms before/after | 2x limit in 2ms possible (DOCUMENTED) |
| Multiple windows skipped | Fresh start: count=1 |
| Clock skew backward | Use monotonic clock; wall clock could re-enter old window |

### Strategy: Sliding Window Log (Exact)

**Parameters:** `windowSizeMs: number`, `max: number`

**State:** `number[]` (sorted ascending timestamps)

**Algorithm:**
```
windowStart = now - windowSizeMs
pruned = log.filter(ts >= windowStart)          // Binary search first valid
if pruned.length < max:
    newLog = sortedInsert(pruned, now)           // Binary search insertion
    allowed = true, remaining = max - len - 1
else:
    oldest = pruned[0]
    retryAfter = oldest + windowSizeMs - now
    allowed = false
```

**Key Properties:**
- **Exact** — no approximation, no boundary bursts
- O(n) memory per client (stores every timestamp in current window)
- For 10k requests/hour = 10k entries per client. For 1M clients = infeasible.
- Redis: sorted set with `${timestamp}:${counter}` to handle same-ms collisions

**Edge Cases:**
| Scenario | Behavior |
|---|---|
| 100k entries in window | O(n) memory, O(log n) search, O(n) slice is costly |
| Same-ms collisions | Must use unique members: `${ts}:${random}` |
| retryAfter when blocked | = oldest timestamp + windowSize - now |
| All timestamps expired | pruned=[], allow (fresh start) |

### Strategy: Sliding Window Counter (Weighted Approximation)

**Parameters:** `windowSizeMs: number`, `max: number`

**State:** `{ prevCount: number, currCount: number, currentWindowStart: number }`

**Algorithm:**
```
windowStart = floor(now / windowSizeMs) * windowSizeMs
elapsed = (now - windowStart) / windowSizeMs      // 0.0 to 1.0
weight = 1 - elapsed

estimated = prevCount * weight + currCount

if estimated < max:
    currCount++, allowed = true
else:
    allowed = false

// On window transition:
//   prevCount = currCount (old window rolls into prev)
//   currCount = 0
```

**Key Properties:**
- Near-exact: Cloudflare validated 0.003% error on 400M requests
- 0 false positives (never blocks below limit)
- O(1) memory per client
- **Best default** for most APIs

**Edge Cases:**
| Scenario | Behavior |
|---|---|
| Cold start | prev=0, curr=0, estimated=0 < max → allow |
| Multi-window rollover (2+ windows) | Both prev and curr stale → reset to 0 |
| elapsed=0 (exact window start) | weight=1, estimated=prev+curr |
| elapsed=1 (exact boundary) | weight→0, estimated≈curr |
| Exact boundary + small max | Mitigates fixed-window 2x burst |

### Strategy Comparison

| Property | Token Bucket | Fixed Window | Sliding Log | Sliding Counter |
|---|---|---|---|---|
| Accuracy | Exact | Low (2x burst) | Exact | ~98% (0.003% error) |
| Memory per client | O(1) | O(1) | O(n) | O(1) |
| Burst behavior | Controlled (capped) | 2x at boundaries | No bursts | Smoothed |
| retryAfter precision | Exact | Exact (window level) | Exact | Approximate |
| Distributed-safe | Redis + hash | Redis + string | Redis + sorted set | Redis + hashtag |
| Complexity | Medium | Low | High | Medium |
| Best for | Bursty traffic | Simple/internal | Audit/security | **General API** |

---

## 5. Layer 2: Store

### Store Interface

```typescript
interface Store {
  apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T }
  ): Promise<T>;

  // Optional utility methods (not required by core, but useful for testing)
  get?<T>(key: string): Promise<T | null>;
  set?<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete?(key: string): Promise<void>;
}
```

### The `apply()` Primitive

This is the heart of ThrottleKit. `apply()` provides:

1. **Atomic read-modify-write** — read current state, run transform function, write new state
2. **Concurrency serialization** — per-key mutex ensures exactly K of N concurrent requests pass
3. **TTL-based auto-cleanup** — idle keys auto-expire
4. **Store-agnostic interface** — strategies never touch storage directly

### MemoryStore

**Implementation:**
```typescript
class MemoryStore implements Store {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  private locks = new Map<string, Promise<void>>();  // Per-key mutex chain

  async apply<S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T> {
    await this.acquireLock(key);  // Serialize concurrent access to same key
    try {
      const entry = this.store.get(key);
      const currentState = entry && entry.expiresAt > Date.now() ? entry.value as S : null;
      const { state: newState, result } = transform(currentState);
      this.store.set(key, { value: newState, expiresAt: Date.now() + ttlMs });
      return result;
    } finally {
      this.releaseLock(key);
    }
  }
}
```

**Per-key mutex pattern:** Use a promise chain per key. Each request chains off the previous one:

```typescript
private acquireLock(key: string): Promise<void> {
  const prev = this.locks.get(key) ?? Promise.resolve();
  const next = prev.then(() => {}, () => {}); // Swallow rejection so chain continues
  this.locks.set(key, next);
  return prev;
}

private releaseLock(key: string): void {
  // Lock is automatically released when the current promise resolves
  // Cleanup empty entries periodically
}
```

### RedisStore

**Implementation Pattern:** WATCH/MULTI/EXEC with retry on conflict.

```typescript
class RedisStore implements Store {
  private redis: Redis;
  private maxRetries = 3;

  async apply<S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.redis.watch(key);
      const raw = await this.redis.get(key);
      const currentState = raw ? JSON.parse(raw) as S : null;
      const { state: newState, result } = transform(currentState);
      const multi = this.redis.multi();
      multi.set(key, JSON.stringify(newState), 'PX', ttlMs);
      const [execErr, execResult] = await multi.exec();
      if (execResult !== null) return result; // Success
      // WATCH triggered — retry with backoff
      if (attempt < this.maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 10); // 10ms, 20ms, 40ms
      }
    }
    throw new Error('RedisStore: max retries exceeded');
  }
}
```

**Key considerations:**
- ioredis is an optional peer dependency (never installed unless user opts in)
- RedisCluster: use hash tags `{throttlekit}:key` to ensure same-token requests hit same node
- Lua script alternative: single atomic script for production use

---

## 6. Layer 3: Adapters

### Express Adapter

```typescript
// src/adapters/express.ts
import type { Request, Response, NextFunction } from 'express';

type KeyExtractor = (req: Request) => string;
type OnLimited = (req: Request, res: Response, result: RateLimitResult) => void;
type CustomHandler = (req: Request, res: Response, result: RateLimitResult) => void;

interface ExpressAdapterOptions {
  keyExtractor?: KeyExtractor;     // Default: req.ip
  onLimited?: OnLimited;           // Called when blocked
  handler?: CustomHandler;         // Override default 429 response
  failStrategy?: 'open' | 'closed'; // Default: 'open'
}

function expressAdapter(limiter: Limiter, options: ExpressAdapterOptions = {}): (req: Request, res: Response, next: NextFunction) => void {
  const keyExtractor = options.keyExtractor ?? ((req) => req.ip);
  const failStrategy = options.failStrategy ?? 'open';

  return async (req, res, next) => {
    try {
      const key = keyExtractor(req);
      const result = await limiter.check(key, 1); // cost can be extracted from req if needed

      // Set headers
      res.setHeader('RateLimit-Limit', result.limit);
      res.setHeader('RateLimit-Remaining', result.remaining);
      res.setHeader('RateLimit-Reset', Math.ceil(result.resetAt / 1000));
      // Legacy headers
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
        options.onLimited?.(req, res, result);
        if (options.handler) {
          options.handler(req, res, result);
        } else {
          res.status(429).json({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs });
        }
        return; // Do NOT call next()
      }

      next();
    } catch (err) {
      if (failStrategy === 'closed') {
        res.status(503).json({ error: 'Service Unavailable' });
        return;
      }
      // fail-open: log warning, allow request
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      next();
    }
  };
}
```

### Fetch Adapter

```typescript
// src/adapters/fetch.ts
type KeyExtractor = (req: Request) => string;

interface FetchAdapterOptions {
  keyExtractor?: KeyExtractor;
  fetch?: typeof globalThis.fetch;  // Allow custom fetch (e.g., undici)
  failStrategy?: 'open' | 'closed';
  onLimited?: (req: Request, result: RateLimitResult) => void;
}

function fetchAdapter(limiter: Limiter, options: FetchAdapterOptions = {}) {
  const keyExtractor = options.keyExtractor ?? ((req) => req.headers.get('x-forwarded-for') ?? 'unknown');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const failStrategy = options.failStrategy ?? 'open';

  return async (request: Request): Promise<Response> => {
    try {
      const key = keyExtractor(request);
      const result = await limiter.check(key, 1);

      // If blocked, return 429 directly
      if (!result.allowed) {
        options.onLimited?.(request, result);
        return new Response(JSON.stringify({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs }), {
          status: 429,
          headers: {
            'RateLimit-Limit': result.limit.toString(),
            'RateLimit-Remaining': '0',
            'RateLimit-Reset': Math.ceil(result.resetAt / 1000).toString(),
            'Retry-After': Math.ceil(result.retryAfterMs / 1000).toString(),
            'Content-Type': 'application/json',
          },
        });
      }

      // Proceed with actual fetch
      const response = await fetchFn(request);

      // Inject rate-limit headers into response
      const newHeaders = new Headers(response.headers);
      newHeaders.set('RateLimit-Limit', result.limit.toString());
      newHeaders.set('RateLimit-Remaining', result.remaining.toString());
      newHeaders.set('RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      if (failStrategy === 'closed') {
        return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // fail-open: allow request through
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      return fetchFn(request);
    }
  };
}
```

### Adapter Properties (both adapters)

| Property | Default | Description |
|---|---|---|
| `keyExtractor` | `req.ip` (Express) / `x-forwarded-for` (Fetch) | Extracts rate-limit key from request |
| `onLimited` | undefined | Callback when request is blocked |
| `handler` | undefined | Override 429 response entirely |
| `failStrategy` | `'open'` | `'open'` → allow on store error, `'closed'` → return 503 |
| Headers | RateLimit-Limit, Remaining, Reset + Retry-After + legacy X-RateLimit-* | Always set |
| Return on block | 429 with `{error, retryAfterMs}` | Customizable via `handler` |

---

## 7. Composition: combine()

### API

```typescript
function combine(...limiters: Limiter[]): Limiter;
```

### Semantics

| Condition | Behavior |
|---|---|
| All limiters pass | `allowed=true`, `remaining=min(all)`, `resetAt=max(all)`, `retryAfterMs=0` |
| First passes, second blocks | Short-circuit on second, propagate its retryAfter and resetAt |
| First blocks | Short-circuit immediately, never call remaining limiters |
| Nested combine | `combine(combine(A, B), C)` — flattens internally |

### Implementation

```typescript
class CombinedLimiter implements Limiter {
  private limiters: Limiter[];

  async check(key: string, cost: number): Promise<RateLimitResult> {
    let minRemaining = Infinity;
    let maxResetAt = 0;

    for (const limiter of this.limiters) {
      const result = await limiter.check(key, cost);
      if (!result.allowed) {
        return result; // Short-circuit: first block propagates
      }
      minRemaining = Math.min(minRemaining, result.remaining);
      maxResetAt = Math.max(maxResetAt, result.resetAt);
    }

    // All passed
    return {
      allowed: true,
      limit: minRemaining, // Approximate — limit varies per strategy
      remaining: Math.max(0, minRemaining - cost),
      resetAt: maxResetAt,
      retryAfterMs: 0,
    };
  }
}
```

---

## 8. Clock Injection

### Interface

```typescript
interface Clock {
  /** Returns current time in epoch milliseconds */
  now(): number;
}
```

### Implementations

| Implementation | When to use |
|---|---|
| `SystemClock` | Production — wraps `Date.now()` |
| `ManualClock` | Tests — time is set manually, never advances on its own |

### ManualClock API

```typescript
class ManualClock implements Clock {
  constructor(initialTime?: number);

  now(): number;           // Returns current set time
  advanceBy(ms: number): void;  // Advance time forward
  setTime(ts: number): void;    // Jump to a specific time
}
```

### Usage in Strategies

Strategies MUST use the injected clock, never call `Date.now()` directly.

```typescript
// CORRECT
function tokenBucketConsume(state, now, ...) {
  // 'now' comes from clock.now() injected via strategy factory
}

// WRONG — will cause non-deterministic tests and production bugs
function tokenBucketConsume(state, ...) {
  const now = Date.now(); // NEVER — use injected clock
}
```

### Why This Matters for Testing

Without clock injection:
- Tests must use `setTimeout` or `vi.advanceTimersByTime` — slow and flaky
- Race conditions between timer advancement and assertion code
- Cannot test exact boundary conditions with millisecond precision

With ManualClock:
- `clock.setTime(exactBoundaryMs)` — hit the exact window boundary
- `simulateConcurrentSync()` — 100 requests all see the exact same `now`
- No real time passes during tests — instant, deterministic, 100% reliable

---

## 9. Feature Inventory: MVP vs v2 vs v3

### MVP (Build Now — Core Differentiators)

| Feature | Why MVP | Effort |
|---|---|---|
| 4 strategies (token, fixed, sliding-log, sliding-counter) | Core value prop — no competitor has all 4 | Medium |
| MemoryStore | Zero-config works out of box | Low |
| RedisStore (ioredis peer dep) | Scale-out story | Medium |
| Express adapter | Most popular framework | Low |
| Fetch adapter | Works everywhere (CF Workers, Next.js, Deno) | Low |
| Clock injection (ManualClock + SystemClock) | **Killer differentiator** — deterministic testing | Low |
| `combine()` multi-limit composition | Unique feature — express-rate-limit can't do this | Medium |
| Custom key extractor | Flexible integration | Low |
| Per-request cost | Needed for weighted rate limiting | Low |
| RateLimit-* headers + Retry-After | Compliance | Low |
| Legacy X-RateLimit-* headers | Backward compat | Low |
| fail-open / fail-closed | Production readiness | Low |
| TypeScript-first + ESM/CJS | Modern DX | Low |
| Subpath exports | Clean imports: `throttlekit/express` | Low |
| Property-based tests (fast-check) | Proves correctness (unique) | Medium |
| Concurrency tests (exactly K of N) | Proves atomicity guarantee | Medium |

### v2 (Strong Signal — Build Next)

| Feature | Why v2 | Effort |
|---|---|---|
| Fastify adapter | 2nd most popular Node framework | Low |
| Koa adapter | Niche but loyal userbase | Low |
| Postgres store (advisory locks) | Users who already have PG | Medium |
| Debug mode (`X-RateLimit-Debug` header) | Dev UX — shows current state per request | Low |
| OpenTelemetry metrics | Production observability | Medium |
| Hono adapter | Edge compute framework | Low |
| `expressSlowDown()` adapter | Gradual delay before blocking | Low |
| `rateLimit({ keyGenerator: 'user-jwt' })` | Built-in key generators (IP, user, route+IP) | Low |

### v3 (Polishing)

| Feature | Why v3 | Effort |
|---|---|---|
| WebSocket rate limiting | Track per-connection message frequency | Medium |
| GraphQL cost analysis | Rate limit by query complexity | High |
| Programmatic overrides (whitelist/blacklist) | Admin bypass | Low |
| Dynamic limits (circuit breaker) | Limits react to system load | High |
| Plugin system | Third-party stores/strategies | High |
| Lua script for Redis | Production-grade Redis (vs WATCH/MULTI) | Low |
| Dashboard/visualizer | Show rate-limit state per key | High |

---

## 10. Testing Strategy

### Architecture

```
test/
├── setup.ts                       # expect.extend, global mocks
├── helpers/
│   ├── concurrent.ts              # runConcurrent(), simulateConcurrentSync()
│   ├── mock-store.ts              # createFailingStore, createFlakyStore, createSpyStore
│   └── strategy-test-runner.ts    # runStrategyTests() — shared contract for all strategies
├── strategies/
│   ├── token-bucket.test.ts       # Strategy-specific + runStrategyTests()
│   ├── fixed-window.test.ts
│   ├── sliding-window-log.test.ts
│   ├── sliding-window-counter.test.ts
│   └── invariants.test.ts         # Property-based tests (fast-check)
├── stores/
│   ├── memory-store.test.ts       # MemoryStore-specific tests
│   └── store-contract.test.ts     # Parameterized store contract
├── adapters/
│   ├── express.test.ts            # Mock req/res/next, headers, 429, handlers
│   └── fetch.test.ts              # Mock Request/Response, headers, wrappers
├── combine.test.ts                # Multi-limit composition
└── concurrent.test.ts             # Integration: strategy + store under concurrency
```

### Test Categories

| Category | Tests | Key Technique |
|---|---|---|
| **Strategy unit** | ~20 per strategy (80 total) | ManualClock — deterministic time |
| **Concurrency** | ~10 | simulateConcurrentSync + Promise.all |
| **Store** | ~15 per store | Per-key mutex verification |
| **Adapter** | ~10 per adapter | Mock req/res/next, mock Request/Response |
| **combine()** | ~10 | Short-circuit, nesting, mixed strategy types |
| **Property-based** | 6 invariants × 4 strategies | fast-check, 500 runs each |
| **Integration** | ~5 | Full stack: strategy → store → adapter |

### Key Test Patterns

**Strategy shared contract** (`runStrategyTests()`):
- Every strategy must pass identical tests: first request allowed, exactly K of K+1 blocked, per-key isolation, cost=0 no-op, cost>limit rejected, serialization roundtrip, window boundary reset, retryAfter=0 when allowed

**Concurrency test (critical):**
```typescript
// Strategy-level: synchronous, all see same "now"
const results = simulateConcurrentSync(
  () => strategy.apply('key', 1), 100
);
expect(results.filter(r => r.allowed).length).toBe(50); // Exactly limit

// Store-level: async, per-key mutex serialization
const results = await runConcurrent(
  () => store.apply('key', (prev) => /* atomic */), 200
);
expect(results.filter(r => !r.rejected).length).toBe(50);
```

**Property-based invariants:**
1. `remaining ∈ [0, limit]` for any state and cost
2. `retryAfterMs === 0` iff `allowed === true`
3. `resetAt > now` when blocked
4. `allowed` is strict boolean
5. `cost=0` does not change remaining
6. Keys are isolated (one key exhaust doesn't affect another)

### Coverage Targets

| Metric | Target |
|---|---|
| Lines | 95% |
| Branches | 90% |
| Functions | 100% |
| Statements | 95% |

---

## 11. Competitive Differentiation

### Comparison Table

| Package | Stars | Algos | Store Adapter | Testability | Frameworks | TS | combine() |
|---|---|---|---|---|---|---|---|
| **express-rate-limit** | 6k+ | Fixed window only | No | Poor (Date.now) | Express only | No | No |
| **bottleneck** | 4k+ | Token bucket only | No | Poor | Client-side | No | No |
| **rate-limiter-flexible** | 2k+ | 3 (token, fixed, sliding) | Redis/MySQL/Mongo | Poor | Raw API | Partial | No |
| **Upstash Rate Limit** | New | Fixed window | Upstash Redis | Requires Upstash | Edge | Yes | No |
| **p-limit / p-queue** | 5k+ | Concurrency limit | No | Poor | Promises | No | No |
| **ThrottleKit** | — | **4** (all major) | Memory + Redis + pluggable | **ManualClock** | Express + Fetch + pluggable | **Yes** | **Yes** |

### The Winning Narrative

> "express-rate-limit is the default, but it only does fixed window. Bottleneck is client-side. rate-limiter-flexible has backends but terrible DX. ThrottleKit gives you all 4 algorithms, a store abstraction so you can swap memory for Redis without changing code, clock-injected tests so you can PROVE your rate limits work, and `combine()` for multi-limit quotas — all in a TypeScript-first package with zero required dependencies."

### What Makes Us Unambiguously Better

1. **ManualClock testing** — No competitor can claim deterministic rate-limit tests. This is the single biggest differentiator.
2. **4 strategies** — express-rate-limit (1), bottleneck (1), rate-limiter-flexible (3). We have all 4.
3. **combine()** — Multi-limit composition is a first-class feature, not an afterthought.
4. **Framework-agnostic with subpath exports** — Clean imports for Express, Fetch, and (future) any framework.
5. **Zero required deps** — MemoryStore + strategies = no npm install overhead for basic use.

---

## 12. Build Order (Implementation Sequence)

This is the order workers should build in. Each step produces testable output before the next begins.

### Phase 1: Foundation (Worker 1)

**Files:** `clock.ts`, `types.ts`, `token-bucket.ts`, `fixed-window.ts`

- Clock interface + implementations (ManualClock, SystemClock)
- Shared types (RateLimitResult, StrategyFn, Store, Limiter)
- Token bucket pure function + tests
- Fixed window pure function + tests
- `runStrategyTests()` shared test runner
- `concurrent.ts`, `mock-store.ts` helpers

**Verification:** `npm test` — 2 strategies passing shared contract + strategy-specific tests

### Phase 2: Sliding Strategies (Worker 2 — parallel with Phase 1 if no dep conflict)

**Files:** `sliding-window-log.ts`, `sliding-window-counter.ts`

- Sliding window log pure function + tests
- Sliding window counter pure function + tests

**Verification:** All 4 strategies passing shared contract

### Phase 3: Store Layer (Worker 3 — after Phase 1)

**Files:** `memory-store.ts`, `stores/types.ts`

- MemoryStore with per-key mutex
- TTL expiry, basic apply/get/set/delete
- Store contract tests

**Verification:** MemoryStore tests + concurrency tests (exactly K of N)

### Phase 4: Core Limiter (Worker 4 — after Phase 1 + 3)

**Files:** `limiter.ts`, `core/index.ts`, `combine.ts`

- `rateLimit()` factory
- `Limiter` class (wires strategy + store)
- `combine()` with short-circuit + min/max aggregation
- Subpath exports configuration

**Verification:** Full integration test: strategy + store + combine

### Phase 5: Adapters (Worker 5 — after Phase 4)

**Files:** `express.ts`, `fetch.ts`

- Express middleware with all options (keyExtractor, onLimited, handler, failStrategy)
- Fetch wrapper with all options
- Headers: RateLimit-*, X-RateLimit-*, Retry-After

**Verification:** Adapter tests with mock req/res/next and mock Request/Response

### Phase 6: RedisStore (Worker 6 — after Phase 3, can be parallel)

**Files:** `redis-store.ts`, `stores/index.ts`

- RedisStore with WATCH/MULTI/EXEC
- Retry with exponential backoff
- ioredis as optional peer dependency

**Verification:** Integration tests (requires Redis — mark as such)

### Phase 7: Polish (Worker 7 — after everything)

**Files:** `README.md`, `demo/server.ts`, `examples/`

- README with quickstart, algorithm selection table, design tradeoffs
- Runnable demo server (zero-dep, ESM)
- Example files for different integration scenarios

### Dependency Graph

```
Phase 1 (foundation) ─┬─→ Phase 3 (store) ──→ Phase 4 (limiter) ──→ Phase 5 (adapters)
                       │                                                  │
                       └─→ Phase 2 (sliding) ──→ Phase 6 (redis) ────────┘
                                                                           │
                                                                    Phase 7 (polish)
```

---

## 13. Acceptance Criteria

### Build Verification

```bash
npm run build    # tsup — must produce ESM + CJS + .d.ts files
npm test         # vitest — must pass with 95%+ line coverage
npm run typecheck  # tsc --noEmit — zero type errors
```

### Functional Acceptance (Feature Checklist)

| Feature | Must | Should | Could |
|---|---|---|---|
| Token bucket | Exact lazy refill, rate=0 handling, capacity cap, fractional tokens | — | — |
| Fixed window | Wall-clock alignment, boundary detection, 2x burst documented | — | — |
| Sliding window log | Binary search prune, retryAfter from oldest, memory cleanup | Same-ms collision handling | — |
| Sliding window counter | Weighted formula, multi-window rollover, TTL=2×windowSize | Cloudflare-level accuracy | — |
| MemoryStore | get/set/delete/apply, TTL expiry, per-key mutex | Lazy cleanup of idle locks | — |
| RedisStore | WATCH/MULTI/EXEC, retry on conflict, JSON serialization | Lua script alternative | Cluster hash tags |
| Express adapter | Headers, 429, next() semantics, keyExtractor, handler, onLimited | fail-open/closed | — |
| Fetch adapter | Headers, 429, wraps response, keyExtractor | fail-open/closed | Custom fetch |
| combine() | Short-circuit, min/max aggregation, nesting | — | — |
| Clock injection | ManualClock with advanceBy/setTime, SystemClock | — | — |
| Tests | 95% lines, 90% branches, 100% functions | Concurrency tests (exactly K of N) | Property-based invariants |

### Non-Functional Acceptance

| Criteria | Standard |
|---|---|
| Runtime dependencies | Zero required (ioredis is optional) |
| Bundle size | <10KB gzipped for core |
| TypeScript | Strict mode, no any |
| Error handling | Every error path returns structured JSON, never throws raw |
| Concurrency | Exactly K of N concurrent requests pass under limit=K |
| Extensibility | Adding a strategy requires no changes to stores or adapters |

---

## 14. Edge Cases & Gotchas Reference

### Token Bucket

| Gotcha | Impact | Fix |
|---|---|---|
| rate=0 → never refills | Clients blocked forever | Return retryAfter=Infinity |
| Floating-point drift after 1M+ ops | Tokens slowly drift from correct value | Reset to capacity when idle > capacity/rate |
| Background timer refill | Timer drift, CPU wake-ups, imprecise | Always use lazy refill on consume |
| Wall clock jumps (NTP) | Tokens computed from time difference | Use monotonic clock for elapsed, wall clock for resetAt |
| Non-atomic read-check-write | Over-limit burst under concurrency | Per-key mutex (MemoryStore) or Lua/WATCH (Redis) |

### Fixed Window

| Gotcha | Impact | Fix |
|---|---|---|
| 2x boundary burst is fundamental | User expects smooth limiting | DOCUMENT in README, recommend sliding variants |
| INCR without EXPIRE | Key lives forever if crash after INCR | Wrap in Lua: INCR + EXPIRE atomic |
| Counter overflow (unlikely) | Count goes negative after 9e18 requests | Not a real concern for rate limiting |
| Clock skewed backward | Could re-enter old window | Use monotonic clock, detect backward jumps |

### Sliding Window Log

| Gotcha | Impact | Fix |
|---|---|---|
| Same-ms timestamps | Sorted set ignores duplicate values | Use `${timestamp}:${counter}` or `${timestamp}:${random}` |
| O(n) memory per client | 10k req/s = 10k entries/s per key | Use sliding window counter for high-traffic routes |
| ZREMRANGEBYSCORE complexity | O(log N + M) — burst pruning expensive | Schedule periodic pruning, not per-request |
| EXPIRE on sorted set | Without EXPIRE, entries grow unbounded | Set EXPIRE in the same Lua script as ZADD |
| Binary search vs filter | filter(ts >= ws) is O(n) per request | Use binary search + splice: O(log n + k) |

### Sliding Window Counter

| Gotcha | Impact | Fix |
|---|---|---|
| Redis Cluster hash tags | Both keys must be on same slot | Use `{base}:curr` and `{base}:prev` — hash tag same |
| TTL = 2×windowSize | Premature expiry breaks prevCount | Always set TTL ≥ 2×windowSize |
| Multi-window rollover (>2 windows) | Stale prev and curr in formula | Check windowsPassed ≥ 2 → reset both to 0 |
| Float precision on large counters (>10M) | Weighted formula loses precision | Use integer arithmetic (micro-requests) |
| Conservative vs aggressive weighting | Under-allows vs over-allows slightly | Document the tradeoff, default to conservative |

### MemoryStore

| Gotcha | Impact | Fix |
|---|---|---|
| Promise chain growth unbounded | Memory leak under sustained concurrency | Remove resolved entries from locks map |
| TTL cleanup only on access | Orphaned entries consume memory | Optional periodic interval cleanup |
| Same key, high concurrency, slow transform | Request queue grows | Transform should be fast (pure functions only) |

### RedisStore

| Gotcha | Impact | Fix |
|---|---|---|
| WATCH contention under high concurrency | Many retries, increased latency | Exponential backoff with jitter, Lua alternative |
| MULTI/EXEC on Redis Cluster | Cross-slot MULTI errors | Use hash tags for same-slot keys |
| ioredis not installed | Import of throttlekit/redis fails | Clear peer dependency error in README |
| Network partition | WATCH timeout → retry | Respect failStrategy if retries exhausted |

---

## Appendix: Quickstart Snippets

### Basic Express

```typescript
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const limiter = rateLimit({ strategy: 'sliding-window-counter', limit: 100, window: '1m' });
app.use('/api', expressAdapter(limiter));
```

### With Redis

```typescript
import { rateLimit } from 'throttlekit';
import { RedisStore } from 'throttlekit/redis';

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10,
  store: new RedisStore({ url: process.env.REDIS_URL }),
});
```

### Multi-Limit (10/sec AND 1000/hour)

```typescript
import { rateLimit, combine } from 'throttlekit';

const perSecond = rateLimit({ strategy: 'sliding-window-counter', limit: 10, window: '1s' });
const perHour = rateLimit({ strategy: 'fixed-window', limit: 1000, window: '1h' });

app.use(expressAdapter(combine(perSecond, perHour)));
```

### Custom Key + Cost

```typescript
const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 1000,
  refillRate: 50,
});

// In request handler
const key = req.headers['x-api-key'] ?? req.ip;
const cost = req.method === 'POST' ? 5 : 1;
const result = await limiter.check(key, cost);
```
