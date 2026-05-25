# ThrottleKit

> A rate-limiting toolkit with 4 algorithms, pluggable stores, clock-injected deterministic testing, and zero required dependencies.

## Features

- **4 Algorithms**: Token Bucket, Fixed Window, Sliding Window Log, Sliding Window Counter
- **Pluggable Stores**: MemoryStore (zero deps), RedisStore (optional peer dep)
- **Clock Injection**: ManualClock for deterministic tests without setTimeout
- **Framework Adapters**: Express, Fetch (Web-standard)
- **Multi-Limit Composition**: `combine()` for AND logic (e.g., 10/sec AND 1000/hour)
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

| Algorithm | Accuracy | Memory | Best For |
|-----------|----------|--------|----------|
| Token Bucket | Exact | O(1) | Bursty traffic |
| Fixed Window | Low (2x burst) | O(1) | Simple/internal |
| Sliding Window Log | Exact | O(n) | Audit/security |
| Sliding Window Counter | ~98% | O(1) | General API |

## Subpath Exports

| Import Path | Contents |
|-------------|----------|
| `throttlekit` | Core: rateLimit, combine, ManualClock |
| `throttlekit/express` | Express middleware adapter |
| `throttlekit/fetch` | Web-standard fetch wrapper |
| `throttlekit/redis` | RedisStore (requires ioredis) |

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

## API Reference

### rateLimit(options)
Creates a rate limiter.
- `strategy`: `'token-bucket' | 'fixed-window' | 'sliding-window-log' | 'sliding-window-counter'`
- `store`: Store implementation (defaults to MemoryStore)
- `clock`: Clock implementation (defaults to SystemClock)
- `ttlMs`: Auto-calculated if omitted

### combine(...limiters)
Combines multiple limiters. Short-circuits on first block.

### expressAdapter(limiter, options)
Express middleware. Sets RateLimit-* headers, Retry-After on 429.

### fetchAdapter(limiter, options)
Fetch wrapper. Returns 429 Response when blocked, injects headers on pass.

## Design Philosophy

| Layer | Responsibility |
|-------|----------------|
| Strategies | Pure functions: `(state, now, cost) → {state, result}` |
| Store | Atomic read-modify-write via `apply(key, ttl, transform)` |
| Adapters | Thin wrappers: wire limiter.check() to framework |

Data flows DOWN (adapter → limiter → store → strategy). Results flow UP.

## License

MIT
