# Stores

ThrottleKit provides three store implementations. Choose based on your consistency, latency, and deployment requirements.

## MemoryStore

In-memory store with per-key promise-chain mutex. Supports both async `apply()` and sync `applySync()` for Float64Array-based strategies. Zero required dependencies.

```typescript
import { MemoryStore } from 'throttlekit';

const store = new MemoryStore({ defaultTtlMs: 60_000 });
```

The promise-chain mutex guarantees that two concurrent `apply()` calls for the same key are serialized, while calls for different keys run in parallel. For even lower latency, `applySync()` bypasses the mutex and performs a direct synchronous read-modify-write. This is safe only in single-threaded, single-process contexts.

Best for: single-process deployments, tests, and L1 caches inside a TwoTierStore.

## RedisStore

Redis-backed store with Lua EVALSHA fast path for built-in strategies. Falls back to WATCH/MULTI/EXEC with exponential backoff and jitter for custom strategies or when Lua is unavailable.

```typescript
import { createRedisStore } from 'throttlekit/redis';

const store = await createRedisStore({ url: 'redis://localhost:6379' });
```

RedisStore uses `redis.call('TIME')` inside Lua scripts to avoid clock skew between the application server and Redis. For custom strategies that do not have a Lua script, it uses optimistic locking with `WATCH`, retries up to 3 times, and adds jitter to prevent thundering herd.

Best for: multi-process deployments, shared rate limits across nodes, and any scenario where state must survive process restarts.

## TwoTierStore

Layers a fast in-memory L1 over a slower L2 (typically Redis). Three modes control the caching behavior.

```typescript
import { createTwoTierStore } from 'throttlekit';

const store = createTwoTierStore({
  l2: redisStore,
  mode: 'leased',
  lease: { batch: 100, lowWater: 20 },
});
```

`createTwoTierStore` returns a full `Store` implementation. It delegates `apply()` to the appropriate mode logic, caches denials or leased tokens in L1, and passes through to L2 when needed. The L1 store is a `MemoryStore` with a default clock; you can override the clock via the `clock` option.

Best for: high-traffic endpoints where a small amount of local caching dramatically reduces Redis round-trips.

## Selection Guide

| Requirement | Recommended Store |
|-------------|-------------------|
| Single server, no Redis | MemoryStore |
| Shared across processes | RedisStore |
| Minimize Redis latency | TwoTierStore (leased) |
| Protect Redis from rejection storms | TwoTierStore (cached-deny) |
| Full consistency, no local cache | TwoTierStore (strict) or RedisStore |
| Deterministic tests without mocking | MemoryStore + ManualClock |
