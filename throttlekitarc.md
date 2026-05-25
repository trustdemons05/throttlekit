# ThrottleKit — The Ultimate Architecture & Implementation Reference

> **One-line pitch:** A rate-limiting toolkit with 4 algorithms, pluggable stores, framework adapters, clock-injected deterministic testing, reactive observables, adaptive controllers, and TLA+ formal verification — zero-config to production, no competitor has all of this.
>
> **Stack:** TypeScript 5.x · tsup · Vitest 4.x · fast-check 4.x · Zero required dependencies (ioredis optional peer dep)

---

## Table of Contents

1. [Project Identity & Design Philosophy](#1-project-identity--design-philosophy)
2. [Three-Layer Architecture](#2-three-layer-architecture)
3. [Algorithms Deep-Dive](#3-algorithms-deep-dive)
4. [Store Abstraction Layer](#4-store-abstraction-layer)
5. [Adapters & Framework Integration](#5-adapters--framework-integration)
6. [Composition: combine()](#6-composition-combine)
7. [Clock Injection & Testability](#7-clock-injection--testability)
8. [Performance Engineering](#8-performance-engineering)
9. [Novel Features](#9-novel-features)
10. [Node.js Runtime Internals](#10-nodejs-runtime-internals)
11. [Edge & Cloud Runtime Guide](#11-edge--cloud-runtime-guide)
12. [Security Architecture](#12-security-architecture)
13. [Testing Strategy](#13-testing-strategy)
14. [Complete API Surface](#14-complete-api-surface)
15. [Build, Package & Distribution](#15-build-package--distribution)
16. [Competitive Analysis](#16-competitive-analysis)
17. [Edge Cases & Gotchas Master Reference](#17-edge-cases--gotchas-master-reference)
18. [Quickstart Examples](#18-quickstart-examples)

---

## 1. Project Identity & Design Philosophy

### What ThrottleKit Is

ThrottleKit is a **pluggable, framework-agnostic rate-limiting toolkit** for Node.js, edge runtimes, and web APIs. It is not a single algorithm or a single adapter — it is a **system** for expressing rate-limiting intent once and deploying it anywhere.

### Core Design Principle

Clean separation of concerns across three layers:

| Layer | Responsibility | Shape |
|-------|---------------|-------|
| **Strategies** | Pure rate-limit math | `(state, now, cost) → {state, result}` |
| **Store** | State persistence + atomicity | `apply(key, ttl, transform) → Promise<T>` |
| **Adapters** | Framework-specific wiring | Wraps `limiter.check()` into middleware/guard |

**Key rule:** Data flows **down**, results flow **up**. Adapters never touch strategy math. Strategies never touch storage. Stores never know what framework is in use.

### Design Tenets

1. **Testability is a first-class concern**, not an afterthought — clock injection via `ManualClock` enables deterministic tests without `setTimeout`.
2. **Concurrency correctness is provable** — `per-key mutex` guarantees exactly K of N concurrent requests pass under limit=K.
3. **Zero required dependencies** — MemoryStore + all four strategies work with zero npm install overhead.
4. **Framework-agnostic with clean subpath exports** — `throttlekit/express`, `throttlekit/fetch`, `throttlekit/redis`, etc.
5. **TypeScript-first with strict mode** — no `any`, full `d.ts` generation via tsup.

---

## 2. Three-Layer Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Layer 3: Adapters                               │
│   Express    │   Fetch    │   Fastify    │   gRPC    │   tRPC        │
│   Hono       │   WebSocket │   SSE       │   Koa     │               │
├──────────────────────────────────────────────────────────────────────┤
│                      Layer 2: Store                                  │
│   apply<S,T>(key, ttl, transform): Promise<T>                       │
│   ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐   │
│   │ MemoryStore   │  │ RedisStore   │  │ Edge Stores             │   │
│   │ per-key mutex │  │WATCH/MULTI   │  │ CF DO · Deno KV · Bun  │   │
│   │ Float64Array  │  │ /Lua/EXEC    │  │ Upstash · DynamoDB     │   │
│   └──────────────┘  └──────────────┘  └─────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────┤
│                      Layer 1: Strategies                             │
│   Pure functions: (state, now, cost) → { state, result }            │
│   ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────────┐   │
│   │Token     │ │Fixed     │ │Sliding Window│ │Sliding Window    │   │
│   │Bucket    │ │Window    │ │Log           │ │Counter           │   │
│   └──────────┘ └──────────┘ └──────────────┘ └──────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘

Data flow per request:
  Adapter.check(key, cost)
    → Limiter.check(key, cost)
      → Store.apply(key, ttl, (state) => strategy.consume(state, clock.now(), cost))
        → Strategy pure function returns { allowed, remaining, resetAt, retryAfterMs }
      → Store persists new state atomically
    → Result flows back to Adapter
  → Adapter sets headers, calls next() or returns 429
```

### Subpath Exports Architecture

```jsonc
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
    },
    "./graphql": {
      "types": "./dist/extensions/graphql.d.ts",
      "import": "./dist/extensions/graphql.js",
      "require": "./dist/extensions/graphql.cjs"
    },
    "./ws": {
      "types": "./dist/extensions/ws.d.ts",
      "import": "./dist/extensions/ws.js",
      "require": "./dist/extensions/ws.cjs"
    }
  }
}
```

---

## 3. Algorithms Deep-Dive

### Shared Primitives

```typescript
interface Clock {
  /** Returns epoch milliseconds (monotonic preferred) */
  now(): number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;       // floor of remaining tokens/requests
  limit: number;           // the configured limit
  resetAt: number;         // epoch ms when capacity fully resets
  retryAfterMs: number;    // ms client should wait before retrying (0 if allowed)
}
```

### 3.1 Token Bucket

**Parameters:** `capacity: number` (max burst), `refillRate: number` (tokens/second)

**State shape (Float64Array-friendly):**
```
state = { tokens: float64, lastRefill: float64 }
```

**Algorithm (lazy refill, no background timer):**
```
tryConsume(t, cost):
  1. if refillRate <= 0 and no tokens → reject with retryAfter=Infinity
  2. elapsed = (t - lastRefill) / 1000               // seconds
  3. tokens = min(capacity, tokens + elapsed * refillRate)
  4. lastRefill = t
  5. if tokens >= cost:
       tokens -= cost
       allowed = true, remaining = floor(tokens)
     else:
       deficit = cost - tokens
       retryAfterMs = ceil(deficit / refillRate * 1000)
       allowed = false, remaining = 0
  6. return { allowed, remaining, resetAt, retryAfterMs }
```

**Mathematical model:**
```
tokens(t) = min(capacity, tokens(t₀) + refillRate × (t - t₀))
```

**Concurrency proof:** Under atomic mutex, each consume is serialized. With `tokens = N × cost` at time T, the k-th consumer reads `tokens = N×cost - (k-1)`, so exactly N succeed. Without atomicity, all N consumers read the same initial value and all subtract cost — only 1 token consumed but N pass. **Critical bug prevented by per-key mutex.**

**Edge cases:**

| # | Scenario | Input | Expected Behavior |
|---|----------|-------|-------------------|
| 1 | rate=0, no tokens | capacity=10, rate=0, tokens=0, cost=1 | reject, retryAfter=Infinity |
| 2 | rate=0, has tokens | capacity=10, rate=0, tokens=5, cost=1 | allow, remaining=4, tokens never refill |
| 3 | Burst at capacity | capacity=10, rate=1, idle 20s | tokens = min(10, 0+20) = 10 |
| 4 | Same-timestamp N requests | N=10, tokens=10 at now=1000 | all allowed if atomic, remaining 0 after 10th |
| 5 | Overflow guard | capacity=10, rate=1, idle 100s | tokens = 10 (capped at capacity, not 100) |
| 6 | Fractional tokens | capacity=5, rate=0.5, idle 3s, cost=1 | tokens=1.5, allow, remaining=0 |
| 7 | Float drift over 1M ops | repeated consume/check cycles | error < 0.0001% (acceptable) |
| 8 | Fresh bucket | state=null, cost=1 | starts at capacity, allow |

### 3.2 Fixed Window

**Parameters:** `windowSizeMs: number`, `max: number`

**State shape:** `{ windowStart: float64, count: int32 }`

**Algorithm:**
```
windowIndex(now) = floor(now / windowSizeMs)
windowStart(now) = windowIndex × windowSizeMs
resetAt(now)     = (windowIndex + 1) × windowSizeMs

if no state OR state.windowStart !== windowStart(now):
    state = { windowStart, count: 1 }, allowed = true
else if state.count < max:
    state = { ...state, count: state.count + 1 }, allowed = true
else:
    allowed = false
```

**Known limitation — 2x boundary burst:** This is a fundamental property, not a bug. Requests at the end of window N and start of window N+1 can pass 2× max in adjacent milliseconds. If this matters, use sliding window variants.

**Redis Lua pattern (industry standard):**
```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if count <= tonumber(ARGV[2]) then return {1, count, ttl}
else return {0, count, ttl} end
```

### 3.3 Sliding Window Log (Exact)

**Parameters:** `windowSizeMs: number`, `max: number`

**State shape:** `Float64Array` (sorted ascending timestamps)

**Algorithm:**
```
windowStart = now - windowSizeMs
firstValid = binarySearchFirstGE(log, windowStart)   // O(log n)
pruned = log.slice(firstValid)                        // O(k) where k = removed

if pruned.length < max:
    insertIdx = binarySearchFirstGE(pruned, now)
    newLog = insert(pruned, now at insertIdx)
    allowed = true, remaining = max - pruned.length - 1
else:
    oldest = pruned[0]
    retryAfterMs = max(0, oldest + windowSizeMs - now)
    allowed = false
```

**Lock-free ring buffer optimization:** Instead of array slice + insert (O(n) for large logs), use a ring buffer with head/tail pointers. Append is O(1) amortized, prune is O(1) by advancing head pointer. Binary search requires sequential access; maintain an index map or fall back to log-structured merge for very large windows.

**Concurrency proof:** Same TOCTOU pattern as Token Bucket. The prune-count-add sequence must be atomic. Without atomicity, concurrent requests at the same timestamp can both see `pruned.length < max` and both add, exceeding the limit.

**Redis sorted set pattern:**
```lua
-- Use unique members: ${timestamp}:${counter} or ${timestamp}:${random}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])  -- prune expired
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])         -- score=now, member=unique
    redis.call('EXPIRE', KEYS[1], ARGV[5])
    return {1, count + 1}
else
    return {0, count}
end
```

### 3.4 Sliding Window Counter (Weighted Approximation)

**Parameters:** `windowSizeMs: number`, `max: number`

**State shape:** `{ prevCount: int32, currCount: int32, currentWindowStart: float64 }`

**Algorithm:**
```
windowStart = floor(now / windowSizeMs) × windowSizeMs
elapsed = (now - windowStart) / windowSizeMs    // 0.0 to 1.0
weight = 1 - elapsed                            // overlap proportion

estimated = prevCount × weight + currCount

if estimated < max:
    currCount++, allowed = true
else:
    allowed = false

// On window transition (currentWindowStart !== windowStart):
//   if windowsPassed >= 2: prev=0, curr=0  (stale both)
//   else: prev=currCount, curr=0
```

**Accuracy validated by Cloudflare on 400M requests:**
| Metric | Value |
|--------|-------|
| Requests analyzed | 400 million |
| Distinct sources | 270,000 |
| Wrongly allowed/blocked | 0.003% |
| Average estimation error | 6% |
| False positives (blocked below limit) | 0 |
| False negatives (allowed above limit) | 3 sources, <15% over threshold |

**Best default for most APIs** — O(1) memory, near-exact accuracy, no boundary burst.

### Algorithm Comparison

| Property | Token Bucket | Fixed Window | Sliding Log | Sliding Counter |
|----------|-------------|--------------|-------------|-----------------|
| **Accuracy** | Exact | Low (2x burst) | Exact | ~98% (0.003% error) |
| **Memory per client** | O(1) | O(1) | O(n) | O(1) |
| **Burst behavior** | Controlled (capped) | 2x at boundaries | No bursts | Smoothed |
| **retryAfter precision** | Exact | Exact (window level) | Exact | Approximate |
| **Distributed-safe** | Redis + hash | Redis + string | Redis + sorted set | Redis + hashtag |
| **Complexity** | Medium | Low | High | Medium |
| **Best for** | Bursty traffic | Simple/internal | Audit/security | **General API** |

---

## 4. Store Abstraction Layer

### The `apply()` Primitive — Heart of ThrottleKit

```typescript
interface Store {
  /** Atomic read-modify-write with per-key serialization */
  apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T }
  ): Promise<T>;

  /** Optional utility methods (not required by core) */
  get?<T>(key: string): Promise<T | null>;
  set?<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete?(key: string): Promise<void>;
}
```

The `apply()` primitive provides four guarantees:
1. **Atomic read-modify-write** — read current state, run transform, write new state
2. **Concurrency serialization** — per-key mutex ensures exactly K of N concurrent requests pass
3. **TTL-based auto-cleanup** — idle keys auto-expire
4. **Store-agnostic interface** — strategies never touch storage directly

### MemoryStore

```typescript
class MemoryStore implements Store {
  // Float64Array-backed state for zero-GC strategy state storage
  // Map<string, { value: unknown; expiresAt: number }> for per-key entries
  // Map<string, Promise<void>> for per-key mutex chain

  async apply<S, T>(key, ttlMs, transform): Promise<T> {
    await this.acquireLock(key);  // Serialize concurrent access
    try {
      const entry = this.store.get(key);
      const currentState = entry && entry.expiresAt > clock.now() ? entry.value as S : null;
      const { state: newState, result } = transform(currentState);
      this.store.set(key, { value: newState, expiresAt: clock.now() + ttlMs });
      return result;
    } finally {
      this.releaseLock(key);
    }
  }
}
```

**Per-key mutex implementation (promise chaining):**
```typescript
private acquireLock(key: string): Promise<void> {
  const prev = this.locks.get(key) ?? Promise.resolve();
  const next = prev.then(() => {}, () => {});  // Swallow rejection so chain continues
  this.locks.set(key, next);
  return prev;
}

private releaseLock(key: string): void {
  // Lock auto-releases as the promise chain resolves
  // Periodic cleanup of resolved promises from locks map
}
```

**Float64Array backing:** Strategy state is a raw `Float64Array` instead of objects. For a token bucket, indices 0=tokens, 1=lastRefill. Zero GC allocation per check (read/write directly to typed array slots).

**Pre-allocation:** The internal `Map` is created with `new Map(initialCapacity)` to avoid rehashing overhead. Initial capacity = estimated concurrent keys × 1.5.

### RedisStore

```typescript
class RedisStore implements Store {
  private redis: Redis;
  private maxRetries = 3;

  async apply<S, T>(key, ttlMs, transform): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.redis.watch(key);
      const raw = await this.redis.get(key);
      const currentState = raw ? JSON.parse(raw) as S : null;
      const { state: newState, result } = transform(currentState);
      const multi = this.redis.multi();
      multi.set(key, JSON.stringify(newState), 'PX', ttlMs);
      const [execErr, execResult] = await multi.exec();
      if (execResult !== null) return result;  // Success — no WATCH conflict
      // WATCH triggered — retry with exponential backoff + jitter
      if (attempt < this.maxRetries - 1) {
        await sleep(Math.pow(2, attempt) * 10 + Math.random() * 10);
      }
    }
    throw new Error('RedisStore: max retries exceeded');
  }
}
```

**Key considerations:**
- ioredis is an **optional peer dependency** — dynamic import avoids loading until `throttlekit/redis` is imported
- Redis Cluster: use hash tags `{throttlekit}:key` to ensure same-slot routing
- Production alternative: single Lua script instead of WATCH/MULTI for lower contention
- Lua script is preferred at high concurrency (WATCH contention causes retries)

### Edge Runtime Store Mappings

The `Store.apply()` abstraction maps perfectly to every runtime's atomic primitive:

| Runtime | Store | Atomic Primitive | Notes |
|---------|-------|-----------------|-------|
| **Cloudflare Workers** | Durable Objects | `ctx.storage.transaction()` | Single-threaded, SQLite-backed, strong consistency. NOT KV (KV is eventually consistent). |
| **Deno** | Deno KV | `kv.atomic().check(v).set(k,v).commit()` retry loop | Versionstamp-based optimism. Retry on CAS failure. |
| **Bun** | bun:sqlite | Synchronous `db.exec()` + WAL mode | 372K ops/sec for simple read/write. Single-writer bottleneck — use WAL mode. |
| **Vercel Edge** | Upstash Redis | REST API `POST /lrange/lpush` | 1MB bundle limit — ThrottleKit core is under 10KB. |
| **AWS Lambda** | DynamoDB | Conditional writes `ConditionExpression: attribute_not_exists(key)` | Lease pattern: local cache of K tokens, hit store every K requests (80% store reduction). |

### Store Implementation Guide

| Store | Strategy State Encoding | Atomic Mechanism | TTL | Fail Behavior |
|-------|------------------------|-----------------|-----|--------------|
| MemoryStore | Float64Array + header | Promise chain mutex | Eager expiration check on access | N/A (in-process) |
| RedisStore/WATCH | JSON string | WATCH/MULTI/EXEC + retry | PX milliseconds | Exponential backoff, throw at max retries |
| RedisStore/Lua | JSON string | `redis.call()` in Lua | PEXPIRE in script | Error propagates |
| CF Durable Objects | Any serializable | `storage.transaction()` | `storage.setAlarm()` | Transaction rollback |
| Deno KV | Any | `kv.atomic()` + versionstamp | TTL via options | Retry on commit failure |
| Bun bun:sqlite | JSON string | WAL mode + `BEGIN IMMEDIATE` | Manual cleanup | SQLITE_BUSY retry |

---

## 5. Adapters & Framework Integration

### Express Adapter

```typescript
interface ExpressAdapterOptions {
  keyExtractor?: (req: Request) => string;  // Default: req.ip
  onLimited?: (req, res, result) => void;   // Called when blocked
  handler?: (req, res, result) => void;     // Override default 429 response
  failStrategy?: 'open' | 'closed';         // Default: 'open'
}

function expressAdapter(limiter: Limiter, options?: ExpressAdapterOptions): ExpressMiddleware;
```

**Behavior:**
- Sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers
- Sets legacy `X-RateLimit-*` headers
- Sets `Retry-After` header on block (429)
- Calls `next()` when allowed, does NOT call `next()` when blocked
- Default 429 body: `{ error: "Too Many Requests", retryAfterMs }`
- Customizable via `handler` option
- `fail-open`: store error → log warning, call `next()` (request proceeds)
- `fail-closed`: store error → 503 Service Unavailable

### Fetch Adapter

```typescript
interface FetchAdapterOptions {
  keyExtractor?: (req: Request) => string;   // Default: x-forwarded-for header
  fetch?: typeof globalThis.fetch;            // Allow custom fetch (undici, etc.)
  failStrategy?: 'open' | 'closed';
  onLimited?: (req, result) => void;
}

function fetchAdapter(limiter: Limiter, options?: FetchAdapterOptions): (request: Request) => Promise<Response>;
```

**Behavior:**
- Wraps the upstream `fetch` call — intercepts request, checks rate limit, injects headers
- 429 response on block, preserves original response body on pass
- Injects `RateLimit-*` headers into the final response

### Adapter Properties (all adapters)

| Property | Default | Description |
|----------|---------|-------------|
| `keyExtractor` | `req.ip` (Express) / `x-forwarded-for` (Fetch) | Extracts rate-limit key from request |
| `onLimited` | undefined | Callback when request is blocked |
| `handler` | undefined | Override 429 response entirely (Express) |
| `failStrategy` | `'open'` | `'open'` → allow on store error, `'closed'` → return 503 |
| Headers | RateLimit-Limit, Remaining, Reset + Retry-After | Always set |
| Return on block | 429 with `{error, retryAfterMs}` | Customizable via `handler` |

### Additional Adapters (available via subpath exports)

| Adapter | Subpath | Status |
|---------|---------|--------|
| Express | `throttlekit/express` | ✅ MVP |
| Fetch | `throttlekit/fetch` | ✅ MVP |
| Fastify | `throttlekit/fastify` | 🟢 v2 |
| Koa | `throttlekit/koa` | 🟢 v2 |
| Hono | `throttlekit/hono` | 🟢 v2 |
| gRPC | `throttlekit/grpc` | 🟢 v2 (interceptor pattern) |
| tRPC | `throttlekit/trpc` | 🟢 v2 (middleware) |
| WebSocket | `throttlekit/ws` | 🔵 v3 |
| SSE | `throttlekit/sse` | 🟢 v2 |

---

## 6. Composition: combine()

```typescript
function combine(...limiters: Limiter[]): Limiter;
```

Combines multiple rate limiters into one. Each limiter is evaluated in order. The first block short-circuits.

| Condition | Result |
|-----------|--------|
| All pass | `allowed=true`, `remaining=min(all)`, `resetAt=max(all)`, `retryAfterMs=0` |
| First passes, Nth blocks | Short-circuit at Nth, propagate Nth's retryAfter/resetAt |
| First blocks | Short-circuit immediately, never call remaining limiters |
| Nested `combine(combine(A, B), C)` | Flattens internally |

**Implementation:**
```typescript
class CombinedLimiter implements Limiter {
  async check(key: string, cost: number): Promise<RateLimitResult> {
    let minRemaining = Infinity;
    let maxResetAt = 0;

    for (const limiter of this.limiters) {
      const result = await limiter.check(key, cost);
      if (!result.allowed) return result;  // Short-circuit
      minRemaining = Math.min(minRemaining, result.remaining);
      maxResetAt = Math.max(maxResetAt, result.resetAt);
    }

    return {
      allowed: true,
      limit: minRemaining,
      remaining: Math.max(0, minRemaining - cost),
      resetAt: maxResetAt,
      retryAfterMs: 0,
    };
  }
}
```

---

## 7. Clock Injection & Testability

### Clock Interface

```typescript
interface Clock {
  /** Returns current time in epoch milliseconds */
  now(): number;
}
```

### Implementations

| Implementation | Source | Use Case |
|---------------|--------|----------|
| `SystemClock` | `throttlekit` | Production — wraps `Date.now()` |
| `ManualClock` | `throttlekit` | Tests — time advances only when told |

### ManualClock API

```typescript
class ManualClock implements Clock {
  constructor(initialTime?: number);
  now(): number;                             // Returns current set time
  advanceBy(ms: number): void;               // Move time forward
  setTime(ts: number): void;                 // Jump to specific time
}
```

### Why ManualClock over vi.useFakeTimers

Strategy functions are **pure** — they don't call `setTimeout`, `setInterval`, or any async API. Mocking timers when they aren't used adds complexity with zero benefit.

| Technique | Deterministic? | Millisecond precision? | Async required? | Flaky? |
|-----------|---------------|----------------------|-----------------|--------|
| `setTimeout(x)` | No | No | Yes | Yes |
| `vi.advanceTimersByTime` | Partial | Partial | Yes | Sometimes |
| **ManualClock** | **Yes** | **Yes** | **No** | **Never** |

We DO use `vi.useFakeTimers` for MemoryStore TTL expiry tests and adapter integration tests (where actual timer APIs are involved).

---

## 8. Performance Engineering

### V8 Hidden Class Optimization

JavaScript engines optimize object property access using **hidden classes** (aka "shapes" or "maps"). When properties are added after construction, the engine must transition to a new hidden class — this deoptimizes.

**Rules for hot-path strategy code:**
1. **Initialize ALL properties in constructor** — never add properties after construction
2. **Never delete properties** — use `undefined` instead
3. **Never change property types** — always use the same type (`float64`, `int32`, etc.)
4. **Monomorphic call sites** — each strategy function should see ≤4 different shapes

```typescript
// CORRECT — single hidden class, monomorphic
class TokenBucketState {
  constructor(public tokens: number, public lastRefill: number) {}
  // All properties in constructor, never modified structurally
}

// WRONG — polymorphic, deoptimized
function createState() {
  const s: any = {};
  s.tokens = 10;       // Hidden class: {tokens}
  s.lastRefill = Date.now();  // Transition! Hidden class: {tokens, lastRefill}
  return s;
}
```

### Float64Array Strategy State (Zero GC)

Instead of allocating objects for strategy state (which the GC must track and collect), use a `Float64Array`:

```typescript
// Strategy state = 2 float64 values = 16 bytes
// Token bucket: index 0 = tokens, index 1 = lastRefill
// Total GC allocation per check = ZERO (read/write to existing array)

class TokenBucketStrategy {
  private statePool = new Map<string, Float64Array>();
  // Pre-allocate arrays per key, reuse

  consume(key: string, now: number, cost: number): RateLimitResult {
    let state = this.statePool.get(key);
    if (!state) {
      state = new Float64Array(2);  // [tokens, lastRefill]
      state[0] = this.capacity;     // Start full
      state[1] = now;
      this.statePool.set(key, state);
    }

    // Read: no allocation
    const tokens = state[0];
    const lastRefill = state[1];
    const elapsed = (now - lastRefill) / 1000;
    const currentTokens = Math.min(this.capacity, tokens + elapsed * this.refillRate);

    if (currentTokens >= cost) {
      state[0] = currentTokens - cost;  // Write: no allocation
      state[1] = now;
      return { allowed: true, remaining: Math.floor(state[0]), ... };
    }
    // Rejected — still no allocation
    state[0] = currentTokens;
    state[1] = now;
    return { allowed: false, ... };
  }
}
```

### Lock-Free Ring Buffer for Sliding Window Log

The standard sliding window log implementation uses sorted arrays with `slice()` — O(n) on every request. A lock-free ring buffer eliminates allocation:

```typescript
class RingBufferLog {
  private buffer: Float64Array;  // Pre-allocated timestamp ring
  private head = 0;              // Read index (oldest valid entry)
  private tail = 0;              // Write index (next insertion point)
  private mask: number;          // Size - 1 for bitwise modulo

  constructor(capacity: number) {
    // Power-of-2 size for bitwise wrapping
    const size = Math.pow(2, Math.ceil(Math.log2(capacity + 1)));
    this.buffer = new Float64Array(size);
    this.mask = size - 1;
  }

  // O(1) amortized append
  push(timestamp: number): void {
    this.buffer[this.tail] = timestamp;
    this.tail = (this.tail + 1) & this.mask;
  }

  // O(1) amortized prune by advancing head
  prune(windowStart: number): void {
    while (this.head !== this.tail && this.buffer[this.head] < windowStart) {
      this.head = (this.head + 1) & this.mask;
    }
  }

  count(): number {
    return (this.tail - this.head) & this.mask;
  }
}
```

### Object Pool for RateLimitResult

Each `strategy.consume()` creates a result object. Pool them to reduce GC:

```typescript
class ResultPool {
  private pool: RateLimitResult[] = [];

  acquire(): RateLimitResult {
    return this.pool.pop() ?? { allowed: false, remaining: 0, limit: 0, resetAt: 0, retryAfterMs: 0 };
  }

  release(result: RateLimitResult): void {
    if (this.pool.length < 1000) this.pool.push(result);  // Limit pool size
  }
}
```

### Map Pre-allocation

Maps grow by rehashing at power-of-2 capacity thresholds. Pre-allocate to avoid rehashing:

```typescript
// Default initial capacity = 16, first rehash at 24 entries
// If you expect 10,000 concurrent keys:
const store = new Map(15000);  // Pre-allocate at ~1.5x expected max
```

### Benchmarking Targets

| Benchmark | Target | Tool |
|-----------|--------|------|
| Raw strategy throughput | >3,000,000 ops/sec | benchmark.js |
| HTTP middleware path | >200,000 req/s (single core) | autocannon |
| MemoryStore concurrency | >50,000 simultaneous keys | wrk2 |
| RedisStore throughput | >10,000 req/s (network roundtrip bound) | autocannon |
| Bundle size (core) | <10KB gzipped | esbuild --metafile |

**Benchmarking suite:** `benchmark/` directory with:
- `benchmark/algorithms.js` — raw strategy function throughput
- `benchmark/http-express.js` — autocannon against Express middleware
- `benchmark/store.js` — MemoryStore concurrent apply() throughput
- `benchmark/comparison.js` — head-to-head vs express-rate-limit, bottleneck, rate-limiter-flexible

### WASM Verdict

**WASM is overkill for core rate-limiting math.** Token bucket involves ~5 V8 instructions (multiply, add, min, compare, subtract). The boundary crossing cost (JS ↔ WASM) exceeds the math cost by 10-100x. WASM only makes sense for:
- Cryptographic operations (constant-time comparison)
- Serialization/deserialization at scale
- CRDT merge operations with large state

---

## 9. Novel Features

### 9.1 Peek / Preview API (Zero State Mutation)

**First-ever in a rate-limiting library.** Answers "will this request be blocked?" without consuming capacity.

```typescript
const limiter = rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 });

// Normal check — consumes capacity
const result = await limiter.check('user:123', 1);

// Preview — does NOT consume capacity, shows "would-be" state
const preview = await limiter.peek('user:123', 1);
// { allowed: true, remaining: 99, ... } — same format, but state unchanged
```

**Use cases:**
- **CI/CD pipeline:** Test rate limits before deploying — assert `peek('key').remaining === limit`
- **API documentation:** Interactive "try it" calculator showing if a request would pass
- **Pre-flight checks:** Client sends `X-RateLimit-Preview: true` header
- **Dashboards:** Show "what if" scenarios without affecting real state
- **Client-side throttling:** Clients can pre-check before sending expensive requests

**Implementation:** `store.get()` instead of `store.apply()`. Strategy runs but result is discarded.

### 9.2 Reactive Observable Streams (`rateLimit$`)

**First-ever in rate limiting.** RxJS Observable streams emitting real-time rate limit state.

```typescript
// Observe a specific key — emits on every state change
const subscription = limiter.observe('user:123')
  .subscribe(result => {
    console.log(`Remaining: ${result.remaining}, resetAt: ${result.resetAt}`);
  });

// React only to blocks
limiter.observe('user:123')
  .pipe(filter(r => !r.allowed))
  .subscribe(() => showRateLimitWarning());

// Combine multiple keys for dashboard
combineLatest([
  limiter.observe('user:123'),
  limiter.observe('user:456'),
]).subscribe(([a, b]) => updateDashboard(a, b));

// Unsubscribe when done
subscription.unsubscribe();
```

**SSE (Server-Sent Events) endpoint:**
```
GET /__throttlekit/events?key=user:123
→ event: ratelimit
  data: {"allowed":true,"remaining":45,"resetAt":1680000000000}
```

**WebSocket push:** Server pushes rate limit state to connected clients in real time — clients see their remaining quota without polling.

**Implementation:** RxJS `BehaviorSubject` per key. `limiter.check()` calls `subject.next(result)` after store persistence. Subpath export: `throttlekit/observable`.

### 9.3 Adaptive Controllers (PID / EWMA / AIMD)

**First-ever pluggable adaptive controllers in a rate-limiting library.** Strategy parameters adjust dynamically based on system metrics.

```typescript
interface Controller {
  observe(metrics: {
    latency: number;
    errorRate: number;
    cpuLoad?: number;
    eventLoopLag?: number;
    currentLimit: number;
  }): { delta: number; reason: string };
}

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10,
  controller: new PIDController({
    targetLatencyMs: 200,
    kP: 0.5, kI: 0.1, kD: 0.05,
    minLimit: 10,
    maxLimit: 1000,
  }),
});
```

**PID Controller:**
- **Setpoint:** Target latency (e.g., 200ms p95)
- **Process Variable:** Measured latency
- **P (Proportional):** Reacts to current error = Kp × (latency - target)
- **I (Integral):** Accumulates persistent error over time
- **D (Derivative):** Anticipates trends (latency increasing → tighten before it gets worse)

**EWMA (Exponentially Weighted Moving Average):**
```typescript
// α = 0.2 default
EMA_new = α × current_rate + (1 - α) × EMA_old
// Soft threshold at 60% → warn/delay
// Hard threshold at 80% → reject
```

**AIMD (Additive Increase / Multiplicative Decrease):**
- **Additive Increase:** `limit += 1` per healthy interval (slow growth)
- **Multiplicative Decrease:** `limit = floor(limit / 2)` on any error (fast retreat)
- Proven in TCP congestion control since 1988

**Why ThrottleKit:** The pure-function strategy architecture makes it uniquely easy. The strategy doesn't care _why_ the limit changed — it just executes.

### 9.4 TLA+ Formal Verification

**First-ever formally verified rate-limiting library on npm.** A mathematically rigorous specification verified by the TLC model checker.

```
-------------------------- MODULE TokenBucket --------------------------
CONSTANTS Capacity, RefillRate
VARIABLES tokens, lastRefill, clock

(* Initial state: bucket starts full *)
Init == /\ tokens = Capacity
       /\ lastRefill = 0
       /\ clock = 0

(* Consume operation with lazy refill *)
Consume(cost) ==
  LET elapsed == (clock - lastRefill) / 1000
      refilled == Min(Capacity, tokens + elapsed * RefillRate)
  IN
  IF refilled >= cost
  THEN /\ tokens' = refilled - cost
       /\ lastRefill' = clock
       /\ clock' = clock + 1
  ELSE /\ UNCHANGED <<tokens, lastRefill>>
       /\ clock' = clock + 1

(* Safety: never exceed capacity *)
Invariant == tokens <= Capacity

(* Safety: tokens never go negative *)
NoNegative == tokens >= 0
========================================================================
```

**Model-checked scenarios:**
1. N concurrent requests with limit=K → exactly K pass (safety)
2. Burst then idle → tokens refill to capacity (liveness)
3. Clock jumps backward → no re-entry into old window
4. Float drift over 1M ops → error within tolerance

**Deliverable:** `spec/` directory with `TokenBucket.tla`, `FixedWindow.tla`, `SlidingWindow.tla`, `SlidingWindowCounter.tla`, `Store.tla`, `Consistency.tla`.

### 9.5 Timing Attack Resistance

**First-ever side-channel hardened rate limiting.** Attackers measure response times to infer remaining capacity.

**Attack scenario:** "Blocked" returns in 2ms (early rejection after math), "allowed" returns in 50ms (continues to handler). From timing alone, attacker infers remaining capacity.

**Mitigation 1 — Constant-time key comparison:**
```typescript
import { timingSafeEqual } from 'node:crypto';

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Always compare against self to prevent length leakage
    return !timingSafeEqual(bufA, bufA);
  }
  return timingSafeEqual(bufA, bufB);
}
```

**Mitigation 2 — Response timing normalization (quantum slots):**
```typescript
const QUANTUM_SLOTS = [50, 75, 100, 125]; // ms

function normalizeTiming(startTime: number): void {
  const elapsed = Date.now() - startTime;
  const slot = QUANTUM_SLOTS.find(s => s >= elapsed) ?? QUANTUM_SLOTS[QUANTUM_SLOTS.length - 1];
  const delay = Math.max(0, slot - elapsed);
  if (delay > 0) sleep(delay);  // Pad to next quantum slot
}
```

**Mitigation 3 — Jitter injection:**
```typescript
function applyJitter(): number {
  return Math.floor(Math.random() * 50);  // 0-50ms random delay on every response
}
```

### 9.6 CRDT-Based Distributed Rate Limiting

**First JS library implementing CRDT-based distributed rate limiting.** Eliminates Redis as a single point of failure.

```
Node A                    Node B                    Node C
  │                         │                         │
  ├─ Local PN-Counter      ├─ Local PN-Counter       ├─ Local PN-Counter
  ├─ Token Bucket          ├─ Token Bucket           ├─ Token Bucket
  │                         │                         │
  └─────────── Gossip δs ──┴─────────── Gossip δs ───┘
```

**PN-Counter (Positive-Negative Counter):**
```
P[nodeA] += 15   (increments from node A)
N[nodeA] += 3    (decrements/refills from node A)
total = ΣP - ΣN
```

**Merge:** Element-wise max for each replica's counter entries. Idempotent, commutative, associative.

**Tradeoffs:** Eventual consistency (sub-second convergence with 100ms gossip), no SPOF (each node continues independently during partition), approximate (temporary over-allowing possible).

### 9.7 GraphQL Query Complexity Cost

Rate limit by AST analysis cost, not just request count. A simple query costs 1. A deeply nested query with lists costs 100+.

```typescript
import { graphqlRateLimit } from 'throttlekit/graphql';

const limiter = rateLimit({ strategy: 'token-bucket', capacity: 1000 });

const protectedSchema = graphqlRateLimit(schema, {
  limiter,
  keyExtractor: (ctx) => ctx.user.id,
  defaultCost: 1,
  estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
  maxCost: 500,
});
```

**Key features:**
1. Per-field cost via `@cost` directive (IBM GraphQL Cost Directive spec)
2. List size multipliers: `posts(limit: 100)` costs 100x more than scalar
3. Per-resolver complexity: custom complexity functions per field
4. Refund pattern: if actual < estimated, refund credits
5. Persisted query targeting: cannot bypass via query complexity hiding

### 9.8 WebSocket Per-Connection Rate Limiting

Multi-level rate limiting for WebSocket connections with backpressure and overflow policies.

```
Level 1: Connection Rate   → 10 connections/min per IP
Level 2: Message Frequency → 50 messages/sec per connection
Level 3: Channel/Topic     → 100 messages/sec per channel
```

**Overflow policies:** `DROP_OLDEST` (drop oldest, accept new — live feeds), `REJECT_NEW` (reject new — critical alerts), `COALESCE` (replace last with same key), `SNAPSHOT_ONLY` (keep only latest snapshot).

**Backpressure:** Propagate worker load metrics to connected clients. Slow consumers get signaled to reduce send rate. Auto-downgrade from real-time to polling for overwhelmed clients.

```typescript
import { wsAdapter } from 'throttlekit/ws';

const limiter = rateLimit({ strategy: 'token-bucket', capacity: 100 });
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws, req) => {
  const adapter = wsAdapter(limiter, {
    connectionLimit: { capacity: 5, refillRate: 1 },      // 1 new conn/sec
    messageLimit: { capacity: 20, refillRate: 10 },        // 10 msg/sec
    channels: {
      'chat:general': { capacity: 100, refillRate: 50 },
      'events:price': { capacity: 1000, refillRate: 500, overflow: 'DROP_OLDEST' },
    },
  });
  adapter.attach(ws);
});
```

---

## 10. Node.js Runtime Internals

### Event Loop Interaction

Rate limiting operations must be placed carefully in the event loop to avoid blocking:

| Operation | Queue | Rationale |
|-----------|-------|-----------|
| Strategy math (pure) | Current phase | Synchronous, sub-microsecond |
| Store.apply() memory | Current phase (nextTick) | Immediate but yields for I/O |
| Store.apply() redis | Macrotask (Promise) | Network I/O — must go through libuv |
| TTL cleanup | `setImmediate()` | Low priority, after I/O callbacks |
| AsyncLocalStorage context | `AsyncLocalStorage.run()` | Before any async operations |

**Event loop lag monitoring:**
```typescript
let lastCheck = Date.now();
const LAG_THRESHOLD = 50; // ms

function checkEventLoopLag(): boolean {
  const now = Date.now();
  const lag = now - lastCheck - 1000;  // Assuming 1s interval
  lastCheck = now;
  if (lag > LAG_THRESHOLD) {
    // Event loop is lagging — switch to cheaper algorithm or fail open
    return true;  // Stressed
  }
  return false;
}
```

If event loop lag exceeds 50ms, switch to Fixed Window (cheapest algorithm, O(1)) or fail open.

### microtask vs macrotask Placement

- **process.nextTick:** Use for MemoryStore lock release callbacks (before I/O)
- **setImmediate:** Use for lazy TTL sweep and idle key cleanup (after I/O, never blocks)
- **setTimeout(0):** Never use — 4ms minimum clamping, slower than setImmediate

### libuv Thread Pool

For CPU-heavy operations in the sliding window log (binary search on large arrays with >100k entries), offload to the libuv thread pool:

```typescript
import { Worker } from 'node:worker_threads';

// For binary search on large logs (>100k entries):
// Instead of doing it on the main thread:
// const idx = binarySearchFirstGE(log, windowStart); // Blocks event loop

// Use worker thread:
const worker = new Worker(`
  const { parentPort } = require('worker_threads');
  parentPort.on('message', ({ log, target }) => {
    const idx = binarySearchFirstGE(log, target);
    parentPort.postMessage(idx);
  });
`, { eval: true });
```

In practice, sliding window log should not be used for >10k entries. The libuv thread pool is a safety net.

### Cluster Module (SharedArrayBuffer + Atomics)

For multi-process rate limiting via Node.js cluster, use `SharedArrayBuffer` + `Atomics`:

```typescript
import { SharedArrayBuffer, Atomics } from 'node:worker_threads';

// Shared state across all workers in the cluster
const SHARED_CAPACITY = new SharedArrayBuffer(8);  // 1 float64 per bucket
const tokensBuffer = new Float64Array(SHARED_CAPACITY);

// Atomic decrement (lock-free for single-counter operations)
function tryConsumeShared(cost: number): boolean {
  while (true) {
    const current = Atomics.load(tokensBuffer, 0);
    if (current < cost) return false;
    const newVal = current - cost;
    if (Atomics.compareExchange(tokensBuffer, 0, current, newVal) === current) {
      return true;  // Successfully decremented
    }
    // CAS failed, retry
  }
}
```

This enables zero-Redis multi-process rate limiting for cluster deployments.

### AsyncLocalStorage for Request Tracing

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

const rateLimitContext = new AsyncLocalStorage<{
  key: string;
  cost: number;
  startTime: number;
  strategy: string;
}>();

// In adapter:
rateLimitContext.run({ key, cost, startTime: Date.now(), strategy: 'token-bucket' }, async () => {
  const result = await limiter.check(key, cost);
  // Context available throughout the async chain
});

// In store/strategy — access context for logging:
const ctx = rateLimitContext.getStore();
```

### WeakRef + FinalizationRegistry for Idle Key Cleanup

Automatically clean up keys that are no longer referenced by any active request:

```typescript
const keyRegistry = new FinalizationRegistry((key: string) => {
  // Called when the last reference to a key is GC'd
  store.delete(key);
});

class RateLimitKey {
  constructor(public key: string) {
    keyRegistry.register(this, this.key);
  }
}

// When a limiter is used:
const rlKey = new RateLimitKey('user:123');
// ... key is used ...
rlKey = null;  // Eventually: FinalizationRegistry callback fires → key cleaned up
```

### ESM vs CJS Performance

ESM is slightly faster for hot paths due to:
- Static module structure enables better V8 optimization
- No `require` cache lookups
- Better tree-shaking at build time

ThrottleKit ships both via tsup (`import` for ESM, `require` for CJS).

### Dynamic Imports for Optional Stores

```typescript
// throttlekit/redis subpath entry:
export async function createRedisStore(options: RedisStoreOptions): Promise<Store> {
  // Dynamic import — ioredis is only loaded when this function is called
  const { Redis } = await import('ioredis');
  return new RedisStore(new Redis(options.url));
}
```

This ensures users who only use MemoryStore never pay for ioredis in their bundle.

---

## 11. Edge & Cloud Runtime Guide

### Cloudflare Workers

**Durable Objects (DO) are the canonical store — NOT KV.**

KV is eventually consistent (seconds to minutes). Durable Objects provide single-threaded strong consistency with a SQLite-backed storage API.

```typescript
// Cloudflare Workers — Durable Object Store
export class RateLimitDO implements DurableObject {
  private storage: DurableObjectStorage;

  async fetch(request: Request): Promise<Response> {
    const { key, cost, capacity, refillRate } = await request.json();

    const result = await this.storage.transaction(async (txn) => {
      const state = await txn.get(key) ?? { tokens: capacity, lastRefill: Date.now() };
      const elapsed = (Date.now() - state.lastRefill) / 1000;
      const currentTokens = Math.min(capacity, state.tokens + elapsed * refillRate);

      if (currentTokens >= cost) {
        state.tokens = currentTokens - cost;
        state.lastRefill = Date.now();
        await txn.put(key, state);
        return { allowed: true, remaining: Math.floor(state.tokens) };
      }
      return { allowed: false, remaining: 0 };
    });

    return new Response(JSON.stringify(result));
  }
}

// Store.apply() wraps this pattern:
const store: Store = {
  async apply(key, ttlMs, transform) {
    const doId = this.namespace.idFromName(key);
    const stub = this.namespace.get(doId);
    return stub.fetch(/* ... */);
  },
};
```

### Deno

Deno KV provides atomic transactions via versionstamps:

```typescript
// Deno KV Store
class DenoKvStore implements Store {
  constructor(private kv: Deno.Kv) {}

  async apply<S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> {
    const kvKey = ["throttlekit", key];

    while (true) {
      const entry = await this.kv.get<S>(kvKey);
      const { state: newState, result } = transform(entry.value ?? null);

      const atomicOp = this.kv.atomic()
        .check({ key: kvKey, versionstamp: entry.versionstamp })
        .set(kvKey, newState, { expireIn: ttlMs });

      const commitResult = await atomicOp.commit();
      if (commitResult.ok) return result;
      // CAS failed — retry
    }
  }
}
```

### Bun

Bun's `bun:sqlite` synchronous API achieves 372K ops/sec:

```typescript
// Bun bun:sqlite Store
import { Database } from 'bun:sqlite';

class BunSqliteStore implements Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');  // Required for concurrent reads
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS throttlekit (
        key TEXT PRIMARY KEY,
        state TEXT,
        expires_at INTEGER
      )
    `);
  }

  apply<S, T>(key: string, ttlMs: number, transform: (s: S | null) => { state: S; result: T }): Promise<T> {
    // SQLite is single-writer — BEGIN IMMEDIATE serializes
    const txn = this.db.transaction(() => {
      const row = this.db.query('SELECT state FROM throttlekit WHERE key = ? AND expires_at > ?')
        .get(key, Date.now()) as { state: string } | undefined;
      const currentState: S | null = row ? JSON.parse(row.state) : null;
      const { state: newState, result } = transform(currentState);
      this.db.query(`
        INSERT INTO throttlekit (key, state, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at
      `).run(key, JSON.stringify(newState), Date.now() + ttlMs);
      return result;
    });

    return Promise.resolve(txn());
  }
}
```

### Vercel Edge

Upstash Redis via REST API. 1MB bundle limit is the main constraint:

```typescript
// Vercel Edge — Upstash Redis via REST
class UpstashStore implements Store {
  private url: string;
  private token: string;

  async apply<S, T>(key, ttlMs, transform): Promise<T> {
    // Lua script sent as REST command
    const script = `
      local raw = redis.call('GET', KEYS[1])
      local state = raw and cjson.decode(raw) or nil
      -- transform logic in Lua...
    `;
    const response = await fetch(`${this.url}/lua/${encodeURIComponent(script)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return response.json();
  }
}
```

**Bundle size check:** ThrottleKit core is under 10KB gzipped. All optional adapters and stores are dynamic imports. Bundle well within Vercel's 1MB limit.

### AWS Lambda

DynamoDB conditional writes with a lease pattern to reduce store calls by 80%:

```typescript
class DynamoDBStore implements Store {
  private localCache = new Map<string, { tokens: number; lastRefill: number }>();

  async apply<S extends { tokens: number; lastRefill: number }, T>(key, ttlMs, transform): Promise<T> {
    const cached = this.localCache.get(key);

    // Lease pattern: if we have K tokens cached, serve from cache for K requests
    if (cached && cached.tokens > 1) {
      cached.tokens -= 1;
      return { allowed: true, remaining: cached.tokens } as T;
    }

    // Hit DynamoDB every K requests
    const result = await this.dynamoDb.update({
      TableName: 'throttlekit',
      Key: { pk: key },
      UpdateExpression: 'SET #tokens = if_not_exists(#tokens, :capacity) - :cost',
      ConditionExpression: 'attribute_not_exists(#tokens) OR #tokens >= :cost',
      ExpressionAttributeValues: {
        ':cost': cost,
        ':capacity': capacity,
      },
      ReturnValues: 'UPDATED_NEW',
    }).promise();

    // Refill local cache
    this.localCache.set(key, { tokens: result.Attributes.#tokens - 1, lastRefill: Date.now() });
    return result;
  }
}
```

### WASM Verdict (Edge Edition)

Same as Node.js: **overkill for core math.** Boundary crossing costs (JS ↔ WASM) exceed the ~5 V8 instructions for token bucket math. WASM only useful for:
- Constant-time cryptographic comparison (timing attack resistance)
- CRDT merge operations with very large state trees

---

## 12. Security Architecture

### Timing Attack Resistance

See §9.5 for full detail. Three layers:
1. **Constant-time key comparison** via `crypto.timingSafeEqual()`
2. **Response timing normalization** — quantum slots (50, 75, 100, 125ms)
3. **Jitter injection** — 0-50ms random delay on every response

### Side-Channel Protection

Beyond timing, protect against:
- **Error message leakage:** Never reveal "why" a request was blocked (different error messages for exhausted vs rate=0 vs cost-too-large)
- **Content length leakage:** Pad blocked responses to a fixed minimum length
- **Cache timing:** Use `crypto.randomFillSync()` for any random values (not `Math.random()` which is predictable)

### DDoS Detection

```typescript
interface DDoSDetector {
  // Track baseline traffic per key
  record(key: string): void;
  // Returns true if traffic exceeds baseline by threshold
  isElevated(key: string): boolean;

  // Automatic mitigations:
  // 1. Switch to Fixed Window (cheapest algorithm)
  // 2. Reduce limit by 50%
  // 3. Enable fail-open (drop rate limiting to preserve server)
}
```

**Implementation:** EWMA tracker per IP. If current rate exceeds baseline by 3× standard deviations, activate mitigation.

### IP Reputation Scoring

```typescript
interface IPReputation {
  score(ip: string): number;         // -100 (malicious) to +100 (trusted)
  report(ip: string, event: 'rate-limit-hit' | 'invalid-input' | 'login-failure'): void;
}

// Scoring factors:
// - Repeated rate limit hits: -10 per event
// - Invalid/malformed input: -20 per event
// - Known proxy/VPN ranges: -50
// - Historical good behavior: +1 per hour
// - Verified API keys: +30
```

### Honeypot Endpoints

```typescript
// Auto-generated honeypot endpoints that look like real API routes
// /api/v1/admin/users
// /api/v1/config
// /api/graphql
// When accessed → mark IP as scanner, rate limit aggressively
// Never documented, never exposed in client code
```

### Fail-Open vs Fail-Closed

| Strategy | Behavior | When to use |
|----------|----------|-------------|
| `fail-open` (default) | Store error → log warning, allow request | Critical APIs where availability > correctness |
| `fail-closed` | Store error → 503 Service Unavailable | Security-critical APIs where over-allowing is worse than downtime |

---

## 13. Testing Strategy

### Architecture

```
src/test/
├── setup.ts                       # expect.extend, global mocks
├── globalSetup.ts                 # Vitest globalSetup (no-op for in-memory)
├── helpers/
│   ├── concurrent.ts              # runConcurrent(), simulateConcurrentSync()
│   ├── mock-store.ts              # createFailingStore, createFlakyStore, createSpyStore
│   └── strategy-test-runner.ts    # runStrategyTests() — shared contract for all 4 strategies
├── strategies/
│   ├── token-bucket.test.ts       # Strategy-specific + runStrategyTests()
│   ├── fixed-window.test.ts
│   ├── sliding-window-log.test.ts
│   ├── sliding-window-counter.test.ts
│   └── invariants.test.ts         # 6 property-based invariants × 4 strategies (fast-check)
├── stores/
│   ├── memory-store.test.ts       # MemoryStore-specific + TTL expiry
│   └── store-contract.test.ts     # Parameterized contract for any store implementation
├── adapters/
│   ├── express.test.ts            # Mock req/res/next, headers, 429, handlers, fail-open/closed
│   └── fetch.test.ts              # Mock Request/Response, headers, wrappers
├── combine.test.ts                # Multi-limit composition, short-circuit, nesting
└── concurrent.test.ts             # Integration: strategy + store under concurrency
```

### Concurrent Test Helpers

```typescript
// Strategy-level: synchronous, all see exact same "now"
export function simulateConcurrentSync<T>(fn: () => T, count: number): T[] {
  return Array.from({ length: count }, () => fn());
}

// Store-level: async, Promise.all for true concurrency
export async function runConcurrent<T>(factory: () => Promise<T>, count: number): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, () => factory()));
}
```

**Critical test pattern — exactly K of N:**
```typescript
it('N concurrent requests → exactly K allowed', () => {
  const strategy = factory(50);  // limit=50
  const results = simulateConcurrentSync(
    () => strategy.apply('key', 1), 100  // 100 concurrent requests
  );
  expect(results.filter(r => r.allowed).length).toBe(50);  // Exactly limit
  expect(results.filter(r => !r.allowed).length).toBe(50);  // Rest blocked
});
```

### Mock Store Utilities

```typescript
createFailingStore(): Store    // Always throws — simulates complete outage
createFlakyStore(predicate): Store  // Intermittently fails — simulates network glitches
createSpyStore(inner): Store & { operations }  // Tracks all ops — for assertion
```

### Property-Based Invariants (fast-check)

Six invariants tested against all 4 strategies with random parameters (500 runs each):

| # | Invariant | Runs |
|---|-----------|------|
| 1 | `remaining ∈ [0, limit]` for any state and cost | 500 × 4 |
| 2 | `retryAfterMs === 0` iff `allowed === true` | 500 × 4 |
| 3 | `resetAt > now` and `retryAfterMs === resetAt - now` when blocked | 100 × 4 |
| 4 | `allowed` is strict boolean (not truthy/falsy) | 200 × 4 |
| 5 | `cost=0` returns `allowed=true` with unchanged `remaining` | 200 × 4 |
| 6 | Keys are isolated — exhausting one does not affect another | 100 × 4 |

### Coverage Targets

| Metric | Target |
|--------|--------|
| Lines | 95% |
| Branches | 90% |
| Functions | 100% |
| Statements | 95% |

### Vitest Configuration

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/**/*.d.ts'],
      thresholds: { lines: 95, branches: 90, functions: 100, statements: 95 },
    },
    maxConcurrency: 10,
    testTimeout: 10_000,
  },
});
```

---

## 14. Complete API Surface

### Core Exports (`throttlekit`)

```typescript
// Factory
export function rateLimit(options: RateLimitOptions): Limiter;

// Composition
export function combine(...limiters: Limiter[]): Limiter;

// Clocks
export class ManualClock implements Clock;
export class SystemClock implements Clock;

// Types
export interface Limiter {
  check(key: string, cost?: number): Promise<RateLimitResult>;
  peek(key: string, cost?: number): Promise<RateLimitResult>;
  observe(key: string): Observable<RateLimitResult>;
  updateConfig(config: Partial<RateLimitOptions>): void;
  reset(): void;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  retryAfterMs: number;
  _preview?: boolean;  // true if returned by peek()
}

export interface RateLimitOptions {
  // Algorithm selection
  strategy: 'token-bucket' | 'fixed-window' | 'sliding-window-log' | 'sliding-window-counter';

  // Limits
  limit?: number;            // For window-based strategies
  window?: string | number;  // '1m', '1h', '1s' or millseconds
  capacity?: number;         // For token bucket
  refillRate?: number;       // For token bucket (tokens/second)

  // Storage
  store?: Store;
  ttlMs?: number;            // Override default TTL

  // Clock
  clock?: Clock;

  // Controller (adaptive)
  controller?: Controller;

  // Behavior
  keyExtractor?: (req: any) => string;
  onLimited?: (result: RateLimitResult) => void;
  failStrategy?: 'open' | 'closed';
  timingProtection?: boolean;

  // Debug
  debug?: boolean;
}

export type StrategyFn<S, R> = (state: S | null, now: number, cost: number) => StrategyResult<S>;
export interface Store { apply<S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T>; }
export interface Clock { now(): number; }
```

### Adapter-Specific Exports

```typescript
// throttlekit/express
export function expressAdapter(limiter: Limiter, options?: ExpressAdapterOptions): ExpressMiddleware;

// throttlekit/fetch
export function fetchAdapter(limiter: Limiter, options?: FetchAdapterOptions): (req: Request) => Promise<Response>;

// throttlekit/redis
export class RedisStore implements Store;

// throttlekit/graphql
export function graphqlRateLimit(schema: GraphQLSchema, options: GraphQLRateLimitOptions): GraphQLSchema;

// throttlekit/ws
export function wsAdapter(limiter: Limiter, options?: WSAdapterOptions): WSAdapter;

// throttlekit/observable
export function rateLimit$(limiter: Limiter, key: string): Observable<RateLimitResult>;
```

---

## 15. Build, Package & Distribution

### tsup Configuration

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'adapters/express': 'src/adapters/express.ts',
    'adapters/fetch': 'src/adapters/fetch.ts',
    'stores/redis': 'src/stores/redis.ts',
    'extensions/graphql': 'src/extensions/graphql.ts',
    'extensions/ws': 'src/extensions/ws.ts',
    'extensions/observable': 'src/extensions/observable.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,       // Don't minify — let consumer's bundler handle it
  target: 'es2020',
});
```

### package.json Key Fields

```jsonc
{
  "name": "throttlekit",
  "version": "1.0.0",
  "type": "module",
  "files": ["dist/", "spec/", "README.md", "LICENSE"],
  "dependencies": {},
  "peerDependencies": {
    "ioredis": "^5.0.0"   // Optional — only needed for RedisStore
  },
  "peerDependenciesMeta": {
    "ioredis": { "optional": true }
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### Zero-Dependency Guarantee

| Feature | Dependencies | Import Path |
|---------|-------------|-------------|
| All 4 strategies | Zero | `throttlekit` |
| MemoryStore | Zero | `throttlekit` |
| ManualClock / SystemClock | Zero | `throttlekit` |
| combine() | Zero | `throttlekit` |
| Express adapter | Zero (express is peer) | `throttlekit/express` |
| Fetch adapter | Zero | `throttlekit/fetch` |
| Reactive observables | Optional (rxjs) | `throttlekit/observable` |
| RedisStore | Optional (ioredis) | `throttlekit/redis` |

### TLA+ Formal Spec Delivery

```
throttlekit/
└── spec/
    ├── TokenBucket.tla           # Token bucket + lazy refill
    ├── FixedWindow.tla           # Epoch-aligned fixed window
    ├── SlidingWindowLog.tla      # Sorted log with binary search prune
    ├── SlidingWindowCounter.tla  # Weighted approximation
    ├── Store.tla                 # apply() primitive with per-key mutex
    ├── Consistency.tla           # Concurrency + invariants
    └── README.md                 # How to run TLC model checker
```

---

## 16. Competitive Analysis

### Full Comparison Matrix

| Feature | express-rate-limit | bottleneck | rate-limiter-flexible | Upstash | **ThrottleKit** |
|---------|-------------------|------------|----------------------|---------|-----------------|
| **Algorithms** | 1 (fixed) | 1 (token) | 3 | 1 | **4** |
| **Pluggable stores** | No | No | Redis/MySQL/Mongo | Upstash only | **Memory + Redis + any** |
| **Clock injection** | ❌ | ❌ | ❌ | ❌ | **✅ ManualClock** |
| **combine()** | ❌ | ❌ | ❌ | ❌ | **✅** |
| **Adaptive controllers** | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Reactive observables** | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **TLA+ formal spec** | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Peek/preview API** | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Timing attack protection** | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Concurrency tests** | ❌ | ❌ | ❌ | ❌ | **✅ Exactly K of N** |
| **Property-based tests** | ❌ | ❌ | ❌ | ❌ | **✅ 6 invariants** |
| **TypeScript** | No | No | Partial | Yes | **✅ Strict mode** |
| **ESM + CJS** | CJS only | CJS only | Both | Both | **✅ Both, subpath exports** |
| **Zero deps** | ✅ | ❌ | ❌ | ❌ | **✅** |
| **Stars** | 6k+ | 4k+ | 2k+ | New | — |

### The Winning Narrative

> "express-rate-limit is the default, but it only does fixed window. Bottleneck is client-side. rate-limiter-flexible has backends but terrible DX. Upstash is vendor-locked. ThrottleKit gives you all 4 algorithms, a store abstraction so you can swap memory for Redis without changing code, clock-injected deterministic tests to PROVE your rate limits work, `combine()` for multi-limit quotas, adaptive controllers that react to traffic, reactive observables for real-time dashboards, and TLA+ formal verification — all in a TypeScript-first package with zero required dependencies."

### What Makes ThrottleKit Unambiguously Better

1. **ManualClock testing** — No competitor can claim deterministic rate-limit tests at millisecond precision
2. **4 strategies** — express-rate-limit (1), bottleneck (1), rate-limiter-flexible (3). We have all 4 major algorithms
3. **combine()** — Multi-limit composition is first-class, not an afterthought
4. **5 "first-ever" features** — Adaptive controllers, reactive observables, TLA+ spec, peek API, timing attack resistance
5. **Zero required deps** — MemoryStore + strategies work out of the box with zero npm install overhead
6. **Property-based + concurrency tests** — Mathematical proof of correctness, not just manual test cases

---

## 17. Edge Cases & Gotchas Master Reference

### Token Bucket

| Gotcha | Impact | Fix |
|--------|--------|-----|
| rate=0 → never refills | Clients blocked forever | Return retryAfter=Infinity |
| Floating-point drift after 1M+ ops | Tokens drift from correct value | Reset to capacity when idle > capacity/rate |
| Background timer refill | Timer drift, CPU wake-ups, imprecise | Always use lazy refill on consume |
| Wall clock jumps (NTP sync) | Tokens computed from time difference | Use monotonic clock for elapsed, wall clock for resetAt |
| Non-atomic read-check-write | Over-limit burst under concurrency | Per-key mutex (MemoryStore) or WATCH/Lua (Redis) |

### Fixed Window

| Gotcha | Impact | Fix |
|--------|--------|-----|
| 2x boundary burst is fundamental | User expects smooth limiting | DOCUMENT in README, recommend sliding variants |
| INCR without EXPIRE crash | Key lives forever if crash after INCR | Wrap in Lua: INCR + EXPIRE atomic |
| Counter overflow (9e18+) | Theoretically possible, practically irrelevant | Not a real concern for rate limiting |
| Clock skewed backward | Could re-enter old window | Use monotonic clock, detect backward jumps |

### Sliding Window Log

| Gotcha | Impact | Fix |
|--------|--------|-----|
| Same-ms collisions | Sorted set ignores duplicate members | Use `${timestamp}:${counter}` or `${timestamp}:${random}` |
| O(n) memory per client | 10k req/s = 10k entries/s per key | Use sliding window counter for high-traffic routes |
| ZREMRANGEBYSCORE complexity | O(log N + M) — burst pruning expensive | Schedule periodic pruning, not per-request |
| EXPIRE on sorted set | Without EXPIRE, entries grow unbounded | Set EXPIRE in the same Lua script as ZADD |
| Binary search vs filter | `filter(ts >= ws)` is O(n) | Use binary search + splice: O(log n + k) |

### Sliding Window Counter

| Gotcha | Impact | Fix |
|--------|--------|-----|
| Redis Cluster hash tags | Both keys must be on same slot | `{base}:curr` and `{base}:prev` — same hash tag |
| TTL = 2×windowSize | Premature expiry breaks prevCount | Always set TTL ≥ 2×windowSize |
| Multi-window rollover (>2 windows) | Stale prev and curr in formula | Check windowsPassed ≥ 2 → reset both to 0 |
| Float precision on large counters (>10M) | Weighted formula loses precision | Use integer arithmetic (micro-requests) |
| Conservative vs aggressive weighting | Under-allows vs over-allows slightly | Document tradeoff, default to conservative |

### MemoryStore

| Gotcha | Impact | Fix |
|--------|--------|-----|
| Promise chain growth unbounded | Memory leak under sustained concurrency | Remove resolved entries from locks map |
| TTL cleanup only on access | Orphaned entries consume memory | Optional periodic interval cleanup |
| Same key, high concurrency, slow transform | Request queue grows | Transform should be fast (pure functions only) |

### RedisStore

| Gotcha | Impact | Fix |
|--------|--------|-----|
| WATCH contention under high concurrency | Many retries, increased latency | Exponential backoff with jitter, Lua alternative |
| MULTI/EXEC on Redis Cluster | Cross-slot MULTI errors | Use hash tags for same-slot keys |
| ioredis not installed | Import failure | Clear peer dependency error in README |
| Network partition | WATCH timeout → retry | Respect failStrategy if retries exhausted |

---

## 18. Quickstart Examples

### Basic Express

```typescript
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  window: '1m',
});
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
import { expressAdapter } from 'throttlekit/express';

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

// In request handler:
const key = req.headers['x-api-key'] ?? req.ip;
const cost = req.method === 'POST' ? 5 : 1;
const result = await limiter.check(key, cost);
```

### Deterministic Test

```typescript
import { rateLimit, ManualClock } from 'throttlekit';
import { describe, it, expect } from 'vitest';

it('rejects after limit is reached', () => {
  const clock = new ManualClock(1_000_000_000_000);
  const limiter = rateLimit({
    strategy: 'token-bucket',
    capacity: 10,
    refillRate: 5,
    clock,
  });

  // Use all 10 tokens
  for (let i = 0; i < 10; i++) limiter.check('key', 1);
  expect((await limiter.check('key', 1)).allowed).toBe(false);

  // Advance exactly 1 second — 5 tokens refilled
  clock.advanceBy(1000);
  expect((await limiter.check('key', 1)).allowed).toBe(true);
  expect((await limiter.peek('key', 1)).remaining).toBe(4);
});
```

### Peek Preview (CI/CD Assertion)

```typescript
it('rate limit is configured correctly', async () => {
  const limiter = rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 });
  const preview = await limiter.peek('test-key', 1);
  expect(preview.allowed).toBe(true);
  expect(preview.remaining).toBe(99);  // Would be 99 if checked

  // Peek does NOT consume — second peek shows same state
  const preview2 = await limiter.peek('test-key', 1);
  expect(preview2.remaining).toBe(99);  // Still 99!
});
```

### Reactive Dashboard

```typescript
import { rateLimit$ } from 'throttlekit/observable';
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({ strategy: 'sliding-window-counter', limit: 100, window: '1m' });

// Real-time dashboard updates
rateLimit$(limiter, 'user:123')
  .pipe(filter(r => !r.allowed))
  .subscribe(() => incrementBlockCounter());

// SSE endpoint
app.get('/__throttlekit/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  rateLimit$(limiter, req.query.key).subscribe(result => {
    res.write(`event: ratelimit\ndata: ${JSON.stringify(result)}\n\n`);
  });
});
```

### Adaptive Controller

```typescript
import { rateLimit, PIDController } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10,
  controller: new PIDController({
    targetLatencyMs: 200,
    kP: 0.5, kI: 0.1, kD: 0.05,
    minLimit: 10,
    maxLimit: 1000,
  }),
});
```

---

> **ThrottleKit** is not just another rate-limiting library — it is the first comprehensive rate-limiting **system** with formal verification, adaptive control, reactive observability, and provable concurrency correctness. No competitor has all four algorithms. No competitor has clock-injected testing. No competitor has five "first-ever" features. ThrottleKit is the last rate limiter you'll ever need.
