# Algorithms

ThrottleKit ships with eight rate-limiting strategies, each with different trade-offs between accuracy, memory, and burst tolerance.

| Algorithm | Type | Accuracy | Memory | Best For |
|-----------|------|----------|--------|----------|
| Token Bucket | Rate Limiter | Exact | O(1) | Bursty traffic with smooth refill |
| Fixed Window | Rate Limiter | Low (2x burst) | O(1) | Simple counters, internal tools |
| Sliding Window Log | Rate Limiter | Exact | O(n) | Audit trails, strict security |
| Sliding Window Counter | Rate Limiter | ~98% | O(1) | General API rate limiting |
| Sliding Window (bucketed) | Rate Limiter | Approximate | O(buckets) | Time-series analytics |
| GCRA | Rate Limiter | Exact | O(1) | Telecom-grade burst control |
| Leaky Bucket | Shaper | Exact | O(1) | Traffic smoothing with delay |
| Adaptive Concurrency | Guard | N/A | O(1) | Latency-aware load shedding |

## Token Bucket

State: `Float64Array(2)` — `[tokens, lastRefillMs]`

```
tokens = min(capacity, tokens + elapsedSeconds * refillRate)
allowed = tokens >= cost
newTokens = tokens - cost
```

Lazy refill: no background timer. Tokens are computed on every check.

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10, // tokens per second
});

const result = await limiter.check('user:123', 1);
// result: { allowed, limit, remaining, resetAt, retryAfterMs }
```

## Fixed Window

State: `{ windowStart: number, count: number }`

```
windowStart = floor(now / windowMs) * windowMs
allowed = count + cost <= limit
```

Known characteristic: a client can send `limit` requests just before the boundary and another `limit` just after, resulting in 2x throughput at the edge.

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'fixed-window',
  limit: 100,
  windowMs: 60_000,
});
```

## Sliding Window Log

State: sorted `number[]` of timestamps within the current window.

Prunes expired entries with binary search (`O(log n)`), then checks capacity.

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'sliding-window-log',
  limit: 100,
  windowMs: 60_000,
});
```

## Sliding Window Counter

State: `{ prevCount, currCount, currentWindowStart }`

Uses a weighted estimate across the current and previous fixed windows:

```
elapsed = (now - windowStart) / windowSizeMs
weight = max(0, min(1, 1 - elapsed))
estimated = prevCount * weight + currCount
allowed = estimated + cost <= limit
```

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  windowMs: 60_000,
});
```

## Sliding Window (bucketed)

Divides the window into fixed sub-buckets and maintains a circular buffer of counts. Provides a time-series view of request rates.

[API verification pending]

## GCRA

State: `Float64Array(1)` — `[tat]` (Theoretical Arrival Time)

```
emissionInterval = periodMs / limit
burstOffset = burst * emissionInterval
newTat = max(now, tat) + emissionInterval * cost
allowed = newTat - burstOffset <= now
```

A Lua script (`gcraLua`) is provided for atomic Redis execution.

```typescript
import { LimiterImpl, createGcraStrategy, SystemClock } from 'throttlekit';
import { MemoryStore } from 'throttlekit';

const strategy = createGcraStrategy({
  limit: 100,
  periodMs: 60_000,
  burst: 20,
  clock: new SystemClock(),
});

const limiter = new LimiterImpl(strategy, new MemoryStore(), 120_000);
```

## Leaky Bucket

State: `Float64Array(1)` — `[nextSendTime]`

```
delay = max(0, nextSendTime - now)
nextSendTime = max(now, nextSendTime) + (cost / ratePerSec * 1000)
```

Rejects with `QueueFullError` when `delay > maxQueueMs`.

```typescript
import { createLeakyBucket } from 'throttlekit';

const shaper = createLeakyBucket({
  ratePerSec: 5,
  maxQueueMs: 10_000,
});

await shaper.schedule('key', 1); // resolves after delay
```

## Adaptive Concurrency

Maintains a 128-sample rolling RTT window. Uses the `gradient2` algorithm:

```
gradient = clamp(noloadRtt / measuredRtt, 0.5, 1.0)
newLimit = current * gradient + sqrt(current)
if dropped: newLimit = current * 0.75
```

```typescript
import { createAdaptiveConcurrency } from 'throttlekit';

const guard = createAdaptiveConcurrency({
  minLimit: 4,
  maxLimit: 512,
});

const lease = guard.acquire();
if (lease.ok) {
  try {
    await handleRequest();
    lease.release();
  } catch {
    lease.release({ dropped: true });
  }
}
```
