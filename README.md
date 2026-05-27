# ThrottleKit

![CI](https://github.com/trustdemons05/throttlekit/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/throttlekit)
![license](https://img.shields.io/npm/l/throttlekit)

> **Pluggable, framework-agnostic rate-limiting toolkit** with 8 algorithms, clock-injected deterministic testing, multi-dimensional limits, adaptive concurrency, DDoS sketching, and **zero required runtime dependencies** under 65 kB gzipped. Currently in **0.x** — the API is stable but minor breaking changes may occur before 1.0.

ThrottleKit is different because it separates *strategy logic* (pure functions) from *state persistence* (store interface) from *framework integration* (adapters). This means you can swap algorithms without touching your middleware, test rate-limit boundaries in milliseconds instead of wall-clock seconds, and deploy the same code in-memory, against Redis, PostgreSQL, or a two-tier composite — all without changing a single `limiter.check()` call.

## Highlights

- **8 algorithms** — Token Bucket, Fixed Window, Sliding Window Log, Sliding Window Counter, Sliding Window (bucketed), GCRA, Leaky Bucket, Adaptive Concurrency — each as a standalone pure-function strategy
- **Pluggable stores** — MemoryStore, RedisStore (Lua EVALSHA + WATCH/MULTI/EXEC fallback), PostgresStore (advisory-lock serialization), TwoTierStore (L1 cache + L2 backend)
- **Clock-injected deterministic testing** — `ManualClock` lets you run exhaustive rate-limit tests in under 50 ms with zero `setTimeout`
- **Framework adapters** — Express, Fetch/Edge, Hono, Fastify, Koa, Next.js — all sharing the same security and header-configuration options
- **Multi-dimensional limits** — `multiRateLimit()` with `all()` (AND) and `any()` (OR) combinators, per-dimension dynamic cost
- **DDoS sketching** — Count-Min Sketch rate limiter with mergeable snapshots for multi-region aggregation
- **Admission control** — Google SRE-style `adaptiveThrottle`, `fairShare`, and `weightedMaxMin` for overload protection
- **Traffic shaping** — Leaky bucket with `schedule()` that delays (not rejects) within configurable queue depth
- **Analytics** — `withAnalytics()` wraps any limiter to track top requested/denied keys, deny rate, and heavy hitters
- **OpenTelemetry integration** — `instrumentLimiter()` and `instrumentGuard()` emit standard metrics without a hard dependency on `@opentelemetry/api`
- **Security utilities** — `clientIp()` with trust-proxy hops and IPv6 prefix aggregation, `hmacKeyer()` / `hashKey()` for PII-safe key hashing, standards-compliant `buildRateLimitHeaders()` (draft, structured, legacy modes)

## Install

```bash
npm install throttlekit
```

One peer dependency — `ioredis` — is optional (only needed when using `createRedisStore()`).

```bash
npm install ioredis  # only if you use Redis
```

## Quick Start

The example below uses GCRA (Generic Cell Rate Algorithm) with an in-memory store — no Redis, no external dependencies.

```typescript
import { gcra } from 'throttlekit';

const limiter = gcra({ limit: 10, periodMs: 1000 });
const result = await limiter.check('api-key-1');
// → { allowed: true, remaining: 9, resetAt: 1700000001000, retryAfterMs: 0 }
```

For the five built-in algorithms you can use the higher-level `rateLimit()` factory directly (legacy approach, still works but deprecated):

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10, // tokens/second
});
```

## Migration from 0.1.x

In 0.3.x the recommended API uses named strategy factories instead of the `rateLimit()` string-dispatch factory:

```typescript
// 0.1.x (deprecated but still works)
import { rateLimit } from 'throttlekit';
const limiter = rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 });

// 0.3.x (recommended)
import { tokenBucket } from 'throttlekit';
const limiter = tokenBucket({ capacity: 100, refillRate: 10 });
```

`rateLimit()` is still functional and will remain so through the 0.x line.

## Algorithm Selection

| # | Algorithm | Access Pattern | Accuracy | Memory | Export |
|-------|-----------|---------------|----------|--------|--------|
| 1 | **Token Bucket** | `tokenBucket({capacity, refillRate})` or `createTokenBucketStrategy()` | Exact (continuous refill) | O(1) | `throttlekit` |
| 2 | **Fixed Window** | `fixedWindow({limit, windowMs})` or `createFixedWindowStrategy()` | Low — up to 2× burst at boundary | O(1) | `throttlekit` |
| 3 | **Sliding Window Log** | `slidingWindowLog({limit, windowMs})` or `createSlidingLogStrategy()` | Exact | O(n) timestamps | `throttlekit` |
| 4 | **Sliding Window Counter** | `slidingWindowCounter({limit, windowMs})` or `createSlidingCounterStrategy()` | ~98 % (weighted estimate) | O(1) | `throttlekit` |
| 5 | **Sliding Window (bucketed)** | `slidingWindow({limit, windowMs, buckets})` or `createSlidingWindowStrategy()` | Approximate (tunable by bucket count) | O(buckets) | `throttlekit` |
| 6 | **GCRA** | `gcra({limit, periodMs})` or `createGcraStrategy()` | Exact — telecom-grade ATM algorithm | O(1) Float64Array | `throttlekit` |
| 7 | **Leaky Bucket** | `leakyBucket(...)` (unchanged) | Exact shaping — delays, not drops | O(1) | `throttlekit` |
| 8 | **Adaptive Concurrency** | `adaptiveConcurrency(...)` (unchanged) | Latency-aware (gradient² algorithm) | O(1) | `throttlekit` |

**When to use what:**

- **Token Bucket** — general-purpose; supports bursts up to `capacity`, then smooths to `refillRate`.
- **Fixed Window** — cheapest; fine for internal tooling where the boundary burst is acceptable.
- **Sliding Window Log** — audit-grade; stores every request timestamp. Use at low limits/high value.
- **Sliding Window Counter** — best balance of accuracy and memory for most API gateways.
- **GCRA** — telecom-bred; single-float state, optimal for high-throughput Redis Lua paths.
- **Leaky Bucket** — when you want to *queue and delay* instead of responding 429.
- **Adaptive Concurrency** — replaces circuit breakers for latency-triggered load shedding.

## Subpath Exports

ThrottleKit uses Node.js conditional exports. Every path is available as ESM (`.js`) and CJS (`.cjs`).

| Import Path | What It Exports |
|-------------|-----------------|
| `throttlekit` | Core: `rateLimit`, `LimiterImpl`, `combine`, `multiRateLimit`, `all`, `any`, `ManualClock`, `SystemClock`, `MemoryStore`, all `create*Strategy` factories, first-class factories (`tokenBucket`, `fixedWindow`, `slidingWindowLog`, `slidingWindowCounter`, `slidingWindow`, `gcra`), `gcraLua`, `clientIp`, `hmacKeyer`, `hashKey`, `buildRateLimitHeaders`, `sketchRateLimit`, `mergeableSketch`, `sketchSnapshotFromBytes`, `adaptiveThrottle`, `fairShare`, `weightedFairShare`, `weightedMaxMin`, `withAnalytics`, `createTwoTierStore`, `twoTier`, `createDashboard`, `tokenBudgetLimiter`, `DurableObjectStore`, `ThrottleKitDO`, `D1Store`, `KVStore`, all types |
| `throttlekit/express` | `expressAdapter` — Express-style middleware factory |
| `throttlekit/fetch` | `fetchAdapter` — Web-standard fetch wrapper |
| `throttlekit/redis` | `createRedisStore`, `tokenBucketLua`, `fixedWindowLua`, `slidingWindowLogLua`, `slidingWindowCounterLua`, `gcraLua` |
| `throttlekit/hono` | `honoRateLimit` — Hono middleware factory |
| `throttlekit/fastify` | `fastifyRateLimit` — Fastify `onRequest` hook factory |
| `throttlekit/koa` | `koaRateLimit` — Koa middleware factory |
| `throttlekit/next` | `nextRateLimit` — Next.js middleware-compatible function |
| `throttlekit/otel` | `instrumentLimiter`, `instrumentGuard` — OpenTelemetry wrappers |
| `throttlekit/postgres` | `PostgresStore` — PostgreSQL-backed store class |

## Framework Adapters

All adapters share a common set of options: `keyExtractor`, `failStrategy` (`'open'` / `'closed'`), `trustProxy`, `ipv6Prefix`, `emit` (header mode), `cost`, and `onLimited` / `handler` for custom 429 responses.

### Express

```typescript
import { slidingWindowCounter } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const limiter = slidingWindowCounter({ limit: 100, windowMs: 60_000 });

app.use('/api', expressAdapter(limiter, {
  trustProxy: ['10.0.0.0/8'],
  ipv6Prefix: 64,
  cost: (req) => req.method === 'POST' ? 5 : 1,
  emit: { draft: true, legacy: true },
}));
```

The default 429 handler sends `{ error: 'Too Many Requests', retryAfterMs }`. Provide a custom `handler` to return your own response format.

### Fetch / Edge

```typescript
import { fixedWindow } from 'throttlekit';
import { fetchAdapter } from 'throttlekit/fetch';

const limiter = fixedWindow({ limit: 30, windowMs: 60_000 });

const rateLimitedFetch = fetchAdapter(limiter, {
  failStrategy: 'closed',
  onLimited: (req, result) => {
    console.warn(`Rate-limited: ${req.url}`);
  },
});

// Use as a drop-in replacement for fetch:
const response = await rateLimitedFetch(new Request('https://api.example.com/data'));
```

On allow: proxies the real `fetch()` call and injects `RateLimit-*` headers into the response. On deny: returns a 429 `Response` without touching upstream.

### Hono

```typescript
import { tokenBucket } from 'throttlekit';
import { honoRateLimit } from 'throttlekit/hono';
import { Hono } from 'hono';

const app = new Hono();
const limiter = tokenBucket({ capacity: 50, refillRate: 5 });

app.use('/api/*', honoRateLimit(limiter, { emit: { structured: true } }));
```

`honoRateLimit` returns a Hono middleware that works with both `app.use()` and per-route handlers. It consumes the Hono `c.req.raw` headers for IP extraction and attaches response headers via `c.header()`.

### Fastify

```typescript
import Fastify from 'fastify';
import { slidingWindowCounter } from 'throttlekit';
import { fastifyRateLimit } from 'throttlekit/fastify';

const app = Fastify();
const limiter = slidingWindowCounter({ limit: 100, windowMs: 60_000 });

app.addHook('onRequest', fastifyRateLimit(limiter, {
  trustProxy: 1,
  cost: (req) => req.url === '/expensive' ? 10 : 1,
}));
```

`fastifyRateLimit` creates an `onRequest` hook. When a request is denied it sets 429 status and sends a JSON error body without passing control to the route handler.

### Koa

```typescript
import Koa from 'koa';
import { tokenBucket } from 'throttlekit';
import { koaRateLimit } from 'throttlekit/koa';

const app = new Koa();
const limiter = tokenBucket({ capacity: 30, refillRate: 3 });

app.use(koaRateLimit(limiter, {
  ipv6Prefix: 128, // disable IPv6 aggregation
}));
```

`koaRateLimit` returns standard Koa middleware. It reads from `ctx.request.headers`, uses `ctx.set()` for response headers, and sets `ctx.status`/`ctx.body` on denial.

### Next.js

```typescript
import { NextResponse } from 'next/server';
import { fixedWindow } from 'throttlekit';
import { nextRateLimit } from 'throttlekit/next';

const limiter = fixedWindow({ limit: 20, windowMs: 60_000 });
const check = nextRateLimit(limiter);

export async function middleware(request: Request) {
  const result = await check(request);
  if (result.limited) return result.response!;

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(result.headers)) {
    response.headers.set(key, value);
  }
  return response;
}
```

`nextRateLimit` returns a function that accepts a Web `Request` and returns `{ limited, response?, headers }`. Unlike the other adapters it does *not* call `next()` — you inspect the result and decide how to merge headers onto your response.

## Going Distributed

### Redis

```typescript
import { slidingWindowCounter } from 'throttlekit';
import { createRedisStore } from 'throttlekit/redis';

const store = await createRedisStore({ url: 'redis://localhost:6379' });

const limiter = slidingWindowCounter({ limit: 1000, windowMs: 60_000, store });
```

When `rateLimit()` detects a RedisStore it calls `store.setLuaStrategy()` with the matching Lua script. The first `limiter.check()` loads the SHA via `SCRIPT LOAD`; subsequent calls use `EVALSHA` — a single round trip, no WATCH/MULTI/EXEC overhead.

Four Lua scripts are exported as strings (`tokenBucketLua`, `fixedWindowLua`, `slidingWindowLogLua`, `slidingWindowCounterLua`, plus `gcraLua` from the core) so you can register them in your own deployment pipeline.

### PostgreSQL

```typescript
import pg from 'pg';
import { PostgresStore } from 'throttlekit/postgres';

const pool = new pg.Pool({ connectionString: 'postgres://localhost/mydb' });
const store = new PostgresStore({ pool, tableName: 'rate_limit_state' });
await store.ensureTable();

const limiter = fixedWindow({ limit: 500, windowMs: 60_000, store });
```

`PostgresStore.apply()` uses `pg_advisory_xact_lock` inside a transaction for per-key serialization. This is slower than Redis (~1–3 ms per check on a local instance) but eliminates the need for a separate caching layer in small deployments.

### Two-Tier Store

Reduce round-trips by combining a local MemoryStore (L1) with a remote backend (L2):

```typescript
import { createTwoTierStore, createRedisStore, tokenBucket } from 'throttlekit';

const l2 = await createRedisStore({ url: 'redis://...' });
const store = createTwoTierStore({
  strategy: 'leased',
  l2,
  lease: { batch: 100, lowWater: 20, windowCoupled: true },
});

const limiter = tokenBucket({ capacity: 1000, refillRate: 50, store });
```

Three modes:
- **`strict`** — every check hits L2 (no caching, no over-counting).
- **`cached-deny`** — denials are cached for the retry-after duration; allows are always verified against L2.
- **`leased`** — grants a batch of capacity locally and only syncs with L2 when the local budget runs low. With `windowCoupled: true`, the admitted count stays within `limit` regardless of fleet size.

### Multi-Region Sketch

For global rate limits without a centralized store, use the mergeable Count-Min Sketch:

```typescript
import { mergeableSketch, sketchSnapshotFromBytes } from 'throttlekit';

// Region A
const sketch = mergeableSketch({ limit: 10_000, windowMs: 60_000 });
const result = sketch.checkSync('user:123');

// Serialise snapshot for aggregation
const snapshot = sketch.snapshot();

// Region B merges Region A's snapshot
sketch.merge(sketchSnapshotFromBytes(bytes, width, depth));
```

The CMS gives probabilistic guarantees (error bounded by `epsilon`, confidence by `delta`). It's ideal for multi-datacenter scenarios where eventual consistency of rate-limit counters is acceptable.

## Multi-Dimensional Limiting

Apply different limits to different dimensions — per-user AND per-IP AND per-route — in a single `check()` call:

```typescript
import { multiRateLimit, all, any, tokenBucket, fixedWindow } from 'throttlekit';

interface Ctx { userId: string; ip: string; isPremium: boolean }

const limiter = multiRateLimit<Ctx>({
  strategy: all({
    user: {
      key: (ctx) => `user:${ctx.userId}`,
      strategy: tokenBucket({ capacity: 100, refillRate: 10 }),
      cost: (ctx) => ctx.isPremium ? 1 : 2,
    },
    ip: {
      key: (ctx) => `ip:${ctx.ip}`,
      strategy: fixedWindow({ limit: 1000, windowMs: 60_000 }),
    },
  }),
});

const result = await limiter.check({ userId: 'abc', ip: '1.2.3.4', isPremium: true });
```

- **`all()`** — AND logic: every dimension must permit the request. Short-circuits on the first denial.
- **`any()`** — OR logic: the request is allowed if any dimension permits it. Useful for token-bucket + fixed-window fallback patterns.

## Adaptive Concurrency

Adaptive Concurrency is a *guard*, not a rate limiter. It monitors in-flight request latency and adjusts a concurrency ceiling in real time:

```typescript
import { createAdaptiveConcurrency } from 'throttlekit';

const guard = createAdaptiveConcurrency({
  minLimit: 4,
  maxLimit: 512,
  algorithm: 'gradient2',
});

function onRequest(req, res) {
  const lease = guard.acquire();
  if (!lease.ok) {
    res.status(503).end('Backend saturated');
    return;
  }

  handleRequest(req)
    .then(() => lease.release())
    .catch(() => lease.release({ dropped: true }));
}
```

The guard exposes `stats()` with `p50Rtt`, `p99Rtt`, and `noloadRtt` so you can observe how close to saturation you are.

## Leaky Bucket Shaping

Unlike rate limiters that *reject*, the leaky bucket *delays* requests within a configurable queue. Use it to smooth traffic spikes:

```typescript
import { createLeakyBucket, QueueFullError } from 'throttlekit';

const shaper = createLeakyBucket({
  ratePerSec: 5,
  maxQueueMs: 10_000, // 10 seconds of queuing capacity
});

// reserve() returns immediately with the computed delay
const result = shaper.reserve('key', 1);
if (result.accepted) {
  setTimeout(() => process(), result.delayMs);
}

// schedule() waits asynchronously — throws QueueFullError if maxQueueMs exceeded
try {
  await shaper.schedule('key', 1);
  process();
} catch (err) {
  if (err instanceof QueueFullError) {
    console.warn(`Queue full, retry after ${err.retryAfterMs}ms`);
  }
}

// Reset the bucket state
shaper.reset('key');
```

## DDoS / Sketch Limiter

For high-throughput scenarios where exact counting is too expensive, use the Count-Min Sketch limiter:

```typescript
import { sketchRateLimit } from 'throttlekit';

const limiter = sketchRateLimit({
  limit: 10_000,
  windowMs: 60_000,
  epsilon: 0.01,  // width = ceil(E/0.01) ≈ 272
  delta: 0.001,   // depth = ceil(ln(1/0.001)) ≈ 7
});

const result = await limiter.check('ip:1.2.3.4');
// Promise-wrapped synchronous; no I/O, no store needed
```

The CMS uses ≈ 7.6 kB of memory for the default parameters. Over-counting is bounded by `limit * epsilon * totalRequests`. Ideal for L7 DDoS detection at the edge.

## Overload & Fairness

ThrottleKit includes three admission-control strategies borrowed from Google SRE practices:

### `adaptiveThrottle`

Client-side adaptive throttling that estimates backend capacity by tracking request/accept ratios over a rolling window:

```typescript
import { adaptiveThrottle } from 'throttlekit';

const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000 });

// Before sending a request:
if (!throttle.request(/* priority= */ 2)) {
  return; // shed this request
}

// After receiving the backend response:
throttle.record(accepted);
```

Drop probability = `max(0, (requests - k * accepts) / (requests + 1))`. Higher priority values reduce the effective drop probability.

### `fairShare`

Divide a global capacity limit fairly among contending clients:

```typescript
import { fairShare } from 'throttlekit';

const limiter = fairShare({ limit: 100, decayMs: 30_000 });
const allowed = limiter.request('tenant-a');
// Uses exponentially weighted moving average to maintain fairness
```

### `weightedMaxMin`

Max-min fairness with per-client weights:

```typescript
import { weightedFairShare, weightedMaxMin } from 'throttlekit';

const limiter = weightedMaxMin({ limit: 100, decayMs: 30_000 });
const allowed = limiter.request({ client: 'tenant-a', weight: 2 });
```

## Analytics

Wrap any existing `Limiter` with analytics tracking:

```typescript
import { tokenBucket, withAnalytics } from 'throttlekit';

const inner = tokenBucket({ capacity: 100, refillRate: 10 });
const limiter = withAnalytics(inner, { topK: 20 });

await limiter.check('user:1');
await limiter.check('user:2');
await limiter.check('user:1');

const snapshot = limiter.analytics();
// → { total: 3, allowed: 3, denied: 0, denyRate: 0, topRequested: [...], topDenied: [...] }

limiter.resetAnalytics(); // clears counters, keeps underlying limiter state
```

The analytics layer uses the SpaceSaving algorithm for heavy-hitter detection with error bounds.

## Deterministic Testing

`ManualClock` lets you traverse time boundaries in milliseconds — no `setTimeout`, no flaky tests:

```typescript
import { ManualClock, LimiterImpl, createGcraStrategy, MemoryStore } from 'throttlekit';

const clock = new ManualClock(1_000_000); // start at t=1,000,000ms
const strategy = createGcraStrategy({ limit: 5, periodMs: 1000, clock });
const limiter = new LimiterImpl(strategy, new MemoryStore(), 2000);

// Fire 5 requests — all allowed
for (let i = 0; i < 5; i++) {
  await limiter.check('key');
}

// 6th request — blocked
let r = await limiter.check('key');
expect(r.allowed).toBe(false);

// Advance time by exactly one period
clock.advanceBy(1000);
r = await limiter.check('key');
expect(r.allowed).toBe(true); // refilled
```

`ManualClock.advanceBy()` and `ManualClock.setTime()` give you frame-accurate control over strategy behavior in unit tests.

## Headers, IPs, and PII

### `buildRateLimitHeaders`

```typescript
import { buildRateLimitHeaders } from 'throttlekit';

const headers = buildRateLimitHeaders(result, {
  emit: { draft: true, structured: true, legacy: false },
  now: Date.now(),
});
// → {
//   'RateLimit-Limit': '100',
//   'RateLimit-Remaining': '87',
//   'RateLimit-Reset': '1700000060000',
// }
```

Three emission modes:
- **`draft`** — uses IETF draft `RateLimit-*` fields with `remaining`, `reset`, `limit`, and `window`.
- **`structured`** — single `RateLimit` header with structured fields per RFC 9213.
- **`legacy`** — `X-RateLimit-*` headers.

### `clientIp`

Extract the client IP from request headers with configurable proxy trust:

```typescript
import { clientIp } from 'throttlekit';

const ip = clientIp(headers, {
  trustProxy: 1,                          // trust 1 hop of x-forwarded-for
  ipv6Prefix: 64,                          // aggregate /64 (default)
});
```

### `hmacKeyer` / `hashKey`

Hash rate-limit keys to avoid storing raw user identifiers:

```typescript
import { hmacKeyer, hashKey } from 'throttlekit';
import { createHmac } from 'node:crypto';

const keyer = hmacKeyer(createHmac('sha256', 'secret'));

// Hash the raw identifier:
const safeKey = keyer('user:alice@example.com');
// → 'a1b2c3d4...' (HMAC-SHA256, hex-encoded)

// Or one-shot:
const hash = hashKey('user:alice@example.com', 'sha256', 'secret');
```

## Performance

Numbers below are from a 2023 MacBook Pro (M2 Max, Node 22) with default parameters. **These are algorithmic micro-benchmarks, not real-world throughput.**

| Operation | Ops/sec (single key) | Notes |
|-----------|---------------------|-------|
| `MemoryStore.apply()` (no-op transform) | 6 200 000 | Pure Map read/write |
| Token Bucket (in-memory) | 3 800 000 | JS math, no I/O |
| Fixed Window (in-memory) | 4 100 000 | Counter increment |
| GCRA (in-memory) | 3 500 000 | Float64Array ops |
| Redis Lua (local instance) | ~48 000 | Network + EVALSHA |
| Postgres advisory-lock | ~1 200 | Transaction + serialization |

**Where we lose performance:**

- **Redis Lua WATCH/MULTI/EXEC fallback** — if Lua script registration fails or is evicted, we fall back to WATCH+GET+MULTI+SET+EXEC (5 round trips). This is 5–10× slower than the EVALSHA path. Use `setLuaStrategy()` explicitly if you pre-register scripts.
- **`sliding-window-log` at high limits** — stores every request timestamp. At `limit: 100 000` the state array is 100k entries; every check deserialises > 800 kB of JSON. Use `sliding-window-counter` instead.
- **PostgresStore** — each `apply()` acquires a dedicated client, runs a transaction, and acquires an advisory lock. Expect 1–3 ms per call on localhost. Not suitable for sub-millisecond critical paths.
- **TwoTier `leased` mode** — the first check after crossing `lowWater` synchronously refreshes from L2. This adds one L2 round trip. Subsequent checks are in-memory until the next low-water crossing.
- **`multiRateLimit()` with many dimensions** — dimensions are checked sequentially (no fused pipeline yet). 10 dimensions = 10× the store calls. Use Redis to keep each call under 0.1 ms.
- **Adaptive Concurrency `gradient2`** — maintains per-second latency histograms; the `acquire()` path is ≈ 1 µs, but `stats()` (called on every request) adds overhead proportional to histogram resolution.

## Design Philosophy

| Layer | Responsibility | Example |
|-------|---------------|---------|
| **Strategy** | Pure function: `(state, now, cost) → {state, result}` | `gcraConsume()`, token-bucket refill math |
| **Store** | Atomic read-modify-write: `apply(key, ttl, transform) → Promise<T>` | `MemoryStore`, `RedisStore`, `PostgresStore`, `TwoTierStore` |
| **Limiter** | Wires Strategy + Store + Clock: exposes `check(key, cost)` | `LimiterImpl`, `rateLimit()` factory |
| **Adapter** | Thin framework binding: calls `limiter.check()`, sends response | `expressAdapter()`, `honoRateLimit()`, `fetchAdapter()` |
| **Utils** | Security, observability, standards compliance | `clientIp()`, `hmacKeyer()`, `buildRateLimitHeaders()` |
| **Analytics** | Decorator: wraps any Limiter, tracks counts and heavy hitters | `withAnalytics()` |
| **Admission** | Overload protection: request/accept tracking, fair queuing | `adaptiveThrottle()`, `fairShare()`, `weightedMaxMin()` |

**Data flows down:** Adapter → Limiter → Store → Strategy (pure function).

**Results flow up:** Strategy returns `RateLimitResult` → Store persists new state → Limiter returns result → Adapter translates to framework response.

## How It's Tested

The test suite uses **vitest** with property-based testing (`fast-check`) and runs in under 3 seconds.

```
npm test          # 300+ tests
npm run coverage  # > 84 % line coverage across 20+ test files
```

- **Strategy-level tests** — each pure strategy function is tested with `ManualClock` at exact boundary conditions (exactly at limit, one over, one under, reset boundary, zero cost, negative cost, cost > limit). Property-based tests verify invariants (remaining never negative, resetAt monotonically increasing, retryAfterMs = 0 when allowed).
- **Store conformance suite** — `runStoreConformance(store, label)` from `throttlekit/testkit` runs atomicity, TTL, and round-trip tests against any Store implementation.
- **Adapter integration tests** — each adapter is tested with a mock framework object (Express req/res, Hono context, Fastify request/reply, etc.).
- **Distributed tests** — Redis tests run against `mockRedisClient()` (in-memory mock that simulates NOSCRIPT on first EVALSHA). A separate integration suite targets a real Redis instance (skipped unless `REDIS_URL` is set).
- **Admission control tests** — `adaptiveThrottle`, `fairShare`, and `weightedMaxMin` are tested with property-based scenarios (concurrent clients, varying weights, burst arrivals).
- **Sketch tests** — verifies that CMS error bounds hold (practically: estimate ≤ true count + `epsilon * total`), that merge is commutative, and that serialization round-trips preserve the sketch state.

## Migration

### From `express-rate-limit`

```typescript
// express-rate-limit v8
import rateLimit from 'express-rate-limit';
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// ThrottleKit
import { fixedWindow } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const limiter = fixedWindow({ limit: 100, windowMs: 60_000 });
app.use('/api', expressAdapter(limiter));
```

Key differences:
- ThrottleKit decouples the limiter from the middleware — you can reuse the same `limiter` across adapters.
- The 429 response body is `{ error, retryAfterMs }` by default (customisable via `handler`).
- Headers follow the IETF `RateLimit-*` draft by default; you can opt into legacy `X-RateLimit-*` with `emit: { legacy: true }`.
- `skip`, `keyGenerator`, and `draft_polli_ratelimit_headers` are replaced by `keyExtractor`, `emit`, and the full `HeaderEmitOptions` object.

### From `rate-limiter-flexible`

```typescript
// rate-limiter-flexible
import { RateLimiterRedis } from 'rate-limiter-flexible';
const limiter = new RateLimiterRedis({ storeClient: redis, points: 100, duration: 60 });

// ThrottleKit with Redis
import { tokenBucket } from 'throttlekit';
import { createRedisStore } from 'throttlekit/redis';

const store = await createRedisStore({ redis });
const limiter = tokenBucket({ capacity: 100, refillRate: 100 / 60, store });
```

Key differences:
- ThrottleKit uses `capacity` + `refillRate` (token bucket) or `limit` + `windowMs` (window-based) instead of `points` + `duration`.
- `limiter.check(key, cost?)` returns `{ allowed, remaining, resetAt, retryAfterMs }` instead of `{ remainingMs, consumedPoints, ... }`.
- `limiter.peek()` is non-mutating (does not consume capacity).
- Lua scripts are preferred over `WATCH/MULTI/EXEC` for Redis atomicity (fallback only when Lua is unavailable).

## License

MIT
