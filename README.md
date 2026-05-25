# ThrottleKit

![CI](https://github.com/trustdemons05/throttlekit/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/throttlekit)
![license](https://img.shields.io/npm/l/throttlekit)

> A rate-limiting toolkit with **8 algorithms**, pluggable stores, clock-injected deterministic testing, multi-dimensional limits, adaptive concurrency, and **zero required dependencies**.

## Features

- **8 Rate-Limiting Algorithms**: Token Bucket, Fixed Window, Sliding Window Log, Sliding Window Counter, Sliding Window (bucketed), **GCRA**, **Leaky Bucket**, **Adaptive Concurrency**
- **4 Store Backends**: MemoryStore, RedisStore (WATCH/MULTI/EXEC + Lua EVALSHA), **Two-Tier Store** (L1 cache + L2 backend), applySync fast path
- **Clock Injection**: ManualClock for deterministic, instant tests without `setTimeout`
- **Framework Adapters**: Express, Fetch, **OpenTelemetry**
- **Multi-Limit Composition**: `combine()` for AND logic, `multiRateLimit()` for per-dimension rules
- **Security & Observability**: Client IP resolution (trustProxy, IPv6), HMAC-SHA256 key hashing, standards-compliant headers (draft/structured/legacy)
- **Zero Required Dependencies**: Core works without npm install overhead

## Quickstart

```bash
npm install throttlekit
```

```typescript
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  windowMs: 60_000,
});

app.use('/api', expressAdapter(limiter));
```

## Algorithm Selection

| Algorithm | Type | Accuracy | Memory | Best For |
|-----------|------|----------|--------|----------|
| Token Bucket | Rate Limiter | Exact | O(1) | Bursty traffic |
| Fixed Window | Rate Limiter | Low (2x burst) | O(1) | Simple/internal |
| Sliding Window Log | Rate Limiter | Exact | O(n) | Audit/security |
| Sliding Window Counter | Rate Limiter | ~98% | O(1) | General API |
| Sliding Window (bucketed) | Rate Limiter | Approximate | O(buckets) | Time-series analytics |
| **GCRA** | Rate Limiter | Exact | O(1) | Telecom-grade burst control |
| **Leaky Bucket** | Shaper | Exact | O(1) | Traffic smoothing (delays, not rejects) |
| **Adaptive Concurrency** | Guard | N/A | O(1) | Latency-aware load shedding |

See [docs/algorithms.md](docs/algorithms.md) for detailed mathematical descriptions and examples.

## Subpath Exports

| Import Path | Contents |
|-------------|----------|
| `throttlekit` | Core: rateLimit, combine, ManualClock, multiRateLimit |
| `throttlekit/express` | Express middleware adapter |
| `throttlekit/fetch` | Web-standard fetch wrapper |
| `throttlekit/redis` | RedisStore with Lua EVALSHA fast path |
| `throttlekit/otel` | **OpenTelemetry instrumentation** |
| `throttlekit/utils` | **Client IP, HMAC keys, standards-compliant headers** |
| `throttlekit/testkit` | **Store conformance suite + mock Redis** |

## Deterministic Testing with ManualClock

```typescript
import { rateLimit, ManualClock } from 'throttlekit';

const clock = new ManualClock(1_000_000);
const limiter = rateLimit({ strategy: 'token-bucket', capacity: 10, refillRate: 1, clock });

// Test exact boundary behavior without real time passing
await limiter.check('key', 1);
clock.advanceBy(1000); // 1 second passes instantly
const result = await limiter.check('key', 1); // Has refilled 1 token
```

## Multi-Limit Composition

```typescript
import { rateLimit, combine } from 'throttlekit';

const perSecond = rateLimit({ strategy: 'fixed-window', limit: 10, windowMs: 1000 });
const perHour = rateLimit({ strategy: 'fixed-window', limit: 1000, windowMs: 3_600_000 });

app.use('/api', expressAdapter(combine(perSecond, perHour)));
```

## Multi-Dimensional Rate Limiting

Apply different limits to different dimensions (e.g., per-user + per-IP + per-route) in a single check:

```typescript
import { multiRateLimit, all } from 'throttlekit';

const limiter = multiRateLimit({
  store: new MemoryStore(),
  strategy: all({
    user: {
      key: (ctx) => ctx.userId,
      strategy: rateLimit({ strategy: 'token-bucket', capacity: 100, refillRate: 10 }),
    },
    ip: {
      key: (ctx) => ctx.ip,
      strategy: rateLimit({ strategy: 'fixed-window', limit: 1000, windowMs: 60_000 }),
    },
  }),
});

const result = await limiter.check({ userId: 'u123', ip: '1.2.3.4' });
```

## Adaptive Concurrency

Automatically adjusts the in-flight request ceiling based on observed latency:

```typescript
import { createAdaptiveConcurrency } from 'throttlekit';

const guard = createAdaptiveConcurrency({
  minLimit: 4,
  maxLimit: 512,
  algorithm: 'gradient2',
});

const lease = guard.acquire();
if (lease.ok) {
  try {
    await handleRequest();
    lease.release();
  } catch {
    lease.release({ dropped: true });
  }
} else {
  return 503; // Shed load
}
```

## Leaky Bucket (Traffic Shaper)

Smooth traffic by delaying rather than rejecting:

```typescript
import { createLeakyBucket } from 'throttlekit';

const shaper = createLeakyBucket({
  ratePerSec: 5,
  maxQueueMs: 10_000,
});

// schedule() resolves after the computed delay
await shaper.schedule('key', 1); // waits if needed, throws QueueFullError if maxQueueMs exceeded
```

## Two-Tier Store

Reduce Redis round-trips with local caching:

```typescript
import { createTwoTierStore } from 'throttlekit';

const store = createTwoTierStore({
  strategy: 'leased',
  l2: redisStore,
  mode: 'leased',
  lease: { batch: 100, lowWater: 20 },
});
```

## Security-First Adapters

```typescript
import { expressAdapter } from 'throttlekit/express';

app.use('/api', expressAdapter(limiter, {
  trustProxy: ['10.0.0.0/8'],     // Only trust X-Forwarded-From from internal IPs
  ipv6Prefix: 64,                  // Aggregate IPv6 to /64 prefix
  emit: { draft: true, legacy: true },
  cost: (req) => req.method === 'POST' ? 5 : 1,
}));
```

## OpenTelemetry Integration

```typescript
import { instrumentLimiter } from 'throttlekit/otel';
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('my-app');
const instrumented = instrumentLimiter(limiter, meter);

// Metrics recorded automatically:
// - throttlekit.checks (counter)
// - throttlekit.store.latency (histogram)
```

## API Reference

### rateLimit(options)
Creates a rate limiter.
- `strategy`: `'token-bucket' | 'fixed-window' | 'sliding-window-log' | 'sliding-window-counter' | 'sliding-window'`
- `store`: Store implementation (defaults to MemoryStore)
- `clock`: Clock implementation (defaults to SystemClock)
- `ttlMs`: Auto-calculated if omitted

### combine(...limiters)
Combines multiple limiters. Short-circuits on first block.

### multiRateLimit({ store, strategy })
Multi-dimensional limiting. Use `all()` for AND logic, `any()` for OR logic.

### expressAdapter(limiter, options)
Express middleware with trustProxy, ipv6Prefix, emit, and cost options.

### fetchAdapter(limiter, options)
Fetch wrapper with identical security and header options.

## Design Philosophy

| Layer | Responsibility |
|-------|----------------|
| Strategies | Pure functions: `(state, now, cost) -> {state, result}` |
| Store | Atomic read-modify-write via `apply(key, ttl, transform)` |
| Adapters | Thin wrappers: wire limiter.check() to framework |
| Utils | Security, observability, standards compliance |

Data flows DOWN (adapter -> limiter -> store -> strategy). Results flow UP.

## Test Suite

```bash
npm test          # 304 tests, ~3 seconds
npm run coverage  # 84%+ coverage across 24 test files
```

## Documentation

- [Algorithms](docs/algorithms.md) — detailed algorithm descriptions and examples
- [Architecture](docs/architecture.md) — design principles and internal structure
- [Stores](docs/stores.md) — store selection guide
- [Security](docs/security.md) — client IP, HMAC, and fail strategies
- [Migration](docs/migration.md) — migrating from express-rate-limit and rate-limiter-flexible

## License

MIT
