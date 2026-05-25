# Migration

## From express-rate-limit

ThrottleKit's `expressAdapter` is designed to be a drop-in replacement for most `express-rate-limit` setups:

```typescript
// Before
import rateLimit from 'express-rate-limit';
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// After
import { rateLimit, expressAdapter } from 'throttlekit';
const limiter = rateLimit({ strategy: 'fixed-window', limit: 100, windowMs: 60_000 });
app.use(expressAdapter(limiter));
```

Key differences:
- ThrottleKit uses `check()` instead of middleware internals, so you can reuse the same limiter outside Express (e.g., in WebSocket handlers, background jobs, or CLI tools).
- `trustProxy` is handled by `clientIp()` with CIDR support, not Express's `trust proxy` setting. This means you get the same behavior across Express, Fetch, and custom adapters.
- `skip` and `keyGenerator` are replaced by `keyExtractor` and `cost` functions, which are more explicit and typed.
- `standardHeaders` and `legacyHeaders` are replaced by the `emit` option, which supports draft, structured (RFC 9651), and legacy formats.

## From rate-limiter-flexible

`rate-limiter-flexible` uses a class-based API; ThrottleKit uses a functional pure-function approach:

```typescript
// Before
const RateLimiterRedis = require('rate-limiter-flexible').RateLimiterRedis;
const limiter = new RateLimiterRedis({ storeClient: redis, points: 10, duration: 1 });
const res = await limiter.consume(key);

// After
import { rateLimit, createRedisStore } from 'throttlekit';
const store = await createRedisStore({ redis });
const limiter = rateLimit({ strategy: 'token-bucket', capacity: 10, refillRate: 10, store });
const result = await limiter.check(key, 1);
```

Key differences:
- ThrottleKit strategies are pure functions; state is managed by the Store. This makes the code easier to test and reason about.
- `consume()` becomes `check(key, cost)`. The `cost` parameter lets you weight requests differently (e.g., POST costs 5, GET costs 1).
- `penalty()` can be emulated by calling `check(key, largeCost)` where `largeCost` exceeds the limit.
- ThrottleKit does not have built-in block durations. Use `retryAfterMs` from the result to implement custom blocking logic.
- ThrottleKit's Redis Lua scripts are automatically selected based on strategy. There is no need to manually write or maintain Lua.
