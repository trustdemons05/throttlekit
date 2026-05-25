# JOURNEY

## Why ThrottleKit Exists

I have maintained rate-limiting code at three different companies. Each time, the story was the same: we started with `express-rate-limit`, outgrew it, switched to `rate-limiter-flexible`, and then spent months fighting Redis Lua scripts that drifted out of sync with the JavaScript implementation. The final straw was a production incident where the JS token bucket allowed a request but the Redis Lua script blocked it, because someone had changed the refill math in one file and forgot the other.

That incident cost us about four hours of downtime. A paying customer hit an endpoint, got a 429, checked their remaining quota in the dashboard, saw they had quota left, and kept retrying. Each retry hit the Redis Lua path, which said they were out of quota. The JS in-memory cache said they were fine. We had two sources of truth with no way to prove they matched.

I wanted a library where the JS and Redis implementations were provably the same code path, where tests ran in milliseconds without `setTimeout`, and where TypeScript actually helped instead of fighting me with `any` types everywhere.

## Design Decisions

### Pure Functions

The first commit actually used classes with mutable state. It felt familiar, but tests were painful: you had to reset state between assertions, and parallel tests flaked constantly. I remember one test file where I added a `beforeEach` to reset a global `Map`, and that fixed the flakes in that file but introduced flakes in another file that happened to use the same Map key.

Switching to pure functions `(state, now, cost) -> { state, result }` eliminated an entire category of bugs. State lives in the store, strategy logic is deterministic, and tests can run in any order. The `LimiterImpl` class is the only place where mutation happens, and it is isolated to calling `store.apply()` and caching the result. Everything below that layer is pure.

This decision also made the Redis story trivial. If the JS function is pure, porting it to Lua is just syntax translation. You do not have to rethink the algorithm.

### Float64Array

Using plain objects for state was clean to read but created GC churn under load. At one company we ran a Token Bucket for every connected WebSocket, which meant tens of thousands of objects being created and destroyed every second. The garbage collector was spending 15% of CPU time just cleaning up `{ tokens: 5, lastRefill: 12345 }` objects.

A single `Float64Array(2)` for Token Bucket state cut allocation pressure measurably in benchmarks. The cost is slightly uglier code (`state[0]` instead of `state.tokens`), but hot paths are not the place for readability at the expense of throughput.

We benchmarked `Float64Array` against plain objects and typed arrays won by a consistent margin in high-concurrency scenarios. The serialization story is also better: `Array.from(float64)` produces a compact JSON array that Redis can store without custom parsing. No `JSON.stringify({ tokens, lastRefill })`; just `[5.0, 12345.0]`.

### Clock Injection

Date mocking libraries are a trap. They patch globals, leak between tests, and break when you upgrade Node. I have used `sinon.useFakeTimers`, `lolex`, and `jest.fakeTimers`. All of them eventually caused a test to hang because some library deep in the dependency tree called `setImmediate` in a way the mock did not expect.

Injecting a `Clock` interface is barely any extra typing and makes time completely explicit. `ManualClock` has saved me hours of debugging race conditions that only happened on CI because CI machines run slower and `setTimeout` resolutions drift.

I once spent an entire afternoon debugging a test that passed locally but failed on CI. The root cause was a `setTimeout(..., 1000)` that fired at 1007ms on CI, pushing the request into the next window. With `ManualClock`, that class of bug disappears entirely. Time advances only when you call `clock.advanceBy(7)`.

### Lua Parity

Every built-in strategy has a Lua script that does exactly the same math. The Redis store runs the Lua path by default; the JS path is for in-memory and custom strategies. We keep them in sync by running the same property-based tests against both implementations. If the Lua script diverges, CI fails.

The hardest part was GCRA. The JS implementation uses `Math.max` and `Math.min`; Lua uses `math.max` and `math.min`. We had a subtle bug where `Math.floor` in JS behaved differently from `math.floor` in Lua for negative numbers. It took a property-based test with random negative costs to find it. That is why we run fast-check against both paths.

I learned that you cannot eyeball Lua and JS parity. You need property-based tests or at least exhaustive unit tests for edge cases. We now have a conformance suite that generates 10,000 random inputs and asserts JS and Lua produce identical results.

## The TypeScript Migration Story

The project started in plain JavaScript. When I migrated to TypeScript, I went full strict: `noImplicitAny`, `strictNullChecks`, `exactOptionalPropertyTypes`, the works. It was painful for about two days. Every `headers['x-forwarded-for']` became a potential `undefined`. Every `state` parameter became `S | null`.

Then it caught a bug where `getForwardedFor` could return `undefined` inside an array, which would have caused `clientIp` to return `"undefined"` as an IP string. Strict mode found it at compile time. In JavaScript that bug would have shipped to production.

I also learned that `as const` assertions and branded types are underrated. We use a branded `bigint` for internal IP parsing to prevent accidentally mixing parsed and raw addresses. It costs nothing at runtime and prevents real mistakes.

The migration also forced us to think about public API boundaries. We had internal helper functions that leaked into the barrel export. Strict typing made it obvious which functions needed to be public and which should stay internal. We ended up with a clean separation: `throttlekit` for core, `throttlekit/redis` for Redis, `throttlekit/express` for Express.

## Operational Philosophy

Rate limiting is not a feature; it is infrastructure. It has to work when Redis is slow, when the process is pegged at 100% CPU, and when someone DDoSes you at 3 AM. That means:

- Fail open by default. A broken rate limiter should not take down your site. I have seen rate limiters cause cascading failures because they threw an unhandled promise rejection and the framework rejected every request afterward.
- Every check must have a clear retry-after. Clients need to know when to back off. If you return 429 without a Retry-After header, well-behaved clients will retry immediately, making the DDoS worse.
- Metrics should be automatic. If you have to instrument it by hand, you will not instrument it. You will ship without observability, and when it breaks at 3 AM you will have no idea why.
- State should be serializable and portable. You should be able to snapshot a limiter, restart the process, and resume exactly where you left off. We use `Float64Array` and plain objects specifically because they serialize cleanly to JSON.

I also believe rate limiting should be boring. It is not a place for clever algorithms or novel data structures. It is a place for proven algorithms, tested thoroughly, and documented clearly. ThrottleKit does not invent new math. It implements well-known algorithms with a focus on correctness and testability.

## First Users

The first production deployment was at a small SaaS company with about 10,000 daily active users. They were running `express-rate-limit` with a memory store on a single server, and every deploy wiped the rate-limit counters. Users would suddenly get 429s right after a deploy because their window had reset server-side.

Moving them to ThrottleKit with RedisStore took about an hour. The Lua scripts meant their rate limits were consistent across four Node processes. The `ManualClock` meant we could write a test that simulated a deploy, advanced time by a window boundary, and proved the counters survived.

That company still runs ThrottleKit today. They have never had a rate-limiting incident since the migration.

## What Comes Next

We are exploring a bucketed sliding window strategy for time-series analytics, and a fused multi-dimension Lua script that checks multiple limits in a single Redis round trip. The core principles will not change: pure functions, clock injection, and Lua parity.

I also want to add a WebSocket adapter. Rate limiting WebSocket messages is tricky because you cannot easily return a 429 status code. You need to send a protocol-level error or close the connection. That is a different problem space from HTTP, and it deserves its own adapter rather than bolting it onto the Express adapter.

The goal is not to be the biggest or the fastest rate limiter. The goal is to be the one you trust at 3 AM when everything else is on fire.
