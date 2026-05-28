# Architecture

ThrottleKit is built around a few core principles that keep the code predictable, testable, and fast under load.

## Pure Function Design

Every strategy is a pure function: `(state, now, cost) -> { state, result }`. There are no side effects, no background timers, and no hidden global state. This makes strategies trivial to unit test and trivial to port to other languages. You can snapshot `state`, ship it over the wire, and resume on another machine with identical results.

The `LimiterImpl` class wires a strategy to a `Store` via `store.apply()`, which performs an atomic read-modify-write. The store fetches the current state, calls the pure strategy function inside its transaction boundary, persists the new state, and returns the result. This separation means strategies never touch I/O, and stores never touch business logic.

```typescript
import { rateLimit } from 'throttlekit';

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10,
});

const result = await limiter.check('user:123', 1);
```

## Float64Array State

Token Bucket, GCRA, and Leaky Bucket use `Float64Array` for state instead of plain objects. This avoids GC pressure in hot paths and produces compact, JSON-serializable arrays when persisted to Redis. The tradeoff is slightly more verbose state access (`state[0]` instead of `state.tokens`), but the performance gain is worth it for high-throughput services.

MemoryStore even provides `applySync()` for Float64Array-based strategies, bypassing the promise chain entirely for single-process deployments.

## Clock Injection

All time-dependent code receives a `Clock` interface:

```typescript
interface Clock {
  now(): number; // epoch ms
}
```

Production uses `SystemClock` (wraps `Date.now()`). Tests use `ManualClock`, which advances only when told. This eliminates `setTimeout` from tests and makes boundary behavior deterministic.

```typescript
import { rateLimit, ManualClock } from 'throttlekit';

const clock = new ManualClock(1_000_000);
const limiter = rateLimit({ strategy: 'token-bucket', capacity: 10, refillRate: 1, clock });

await limiter.check('key', 1);
clock.advanceBy(1000);
await limiter.check('key', 1); // exactly 1 token refilled
```

Because `now()` is just a number, you can also implement a custom clock that reads from a distributed timestamp service or a test fixture file.

## Store Abstraction

The `Store` interface is intentionally minimal:

```typescript
interface Store {
  apply<S, T>(key: string, ttlMs: number, transform: (state: S | null) => { state: S; result: T }): Promise<T>;
  get?<T>(key: string): Promise<T | null>;
  set?<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete?(key: string): Promise<void>;
}
```

Only `apply()` is required. Optional `get`/`set`/`delete` are used by adapters, two-tier stores, and peek operations. `MemoryStore` adds `applySync()` for synchronous fast paths.

This minimal interface means you can write a store backed by DynamoDB, SQLite, or even a flat file without implementing methods you do not need.

## Lua Parity Philosophy

For Redis-backed deployments, the Lua-backed built-in strategies have matching scripts that run the same logic atomically inside Redis. The JS and Lua implementations are kept in sync and verified against conformance tests. If you can run a Lua-backed strategy in-memory, you can run it in Redis with matching semantics.

`RedisStore` detects most built-in strategies and automatically loads the matching Lua script via `setLuaStrategy()`. GCRA exports `gcraLua` for explicit registration, but the first-class `gcra()` factory currently uses the generic store path. On the first Lua call RedisStore uses `EVAL`; subsequent calls use `EVALSHA`. If Redis evicts the script cache, it falls back to `EVAL` and re-caches the SHA.

## Two-Tier Modes

`TwoTierStore` layers an L1 in-memory cache over an L2 backing store. Three modes control the caching behavior:

- `strict`: every check hits L2. No local caching, full consistency. Useful when you want the two-tier plumbing but no actual caching.
- `cached-deny`: L1 caches denial results for `retryAfterMs`. If a client is blocked, subsequent checks from the same client are served from L1 without touching Redis. This protects Redis from rejection storms.
- `leased`: L1 holds a batch of tokens fetched from L2 and consumes them locally. When the batch drops below `lowWater`, it refills from L2. This is the highest-performance mode for high-throughput endpoints that can tolerate slight batching.

```typescript
import { createTwoTierStore } from 'throttlekit';

const store = createTwoTierStore({
  l2: redisStore,
  mode: 'leased',
  lease: { batch: 100, lowWater: 20 },
});
```

This lets you tune the latency-vs-consistency tradeoff per endpoint without changing strategy code.
