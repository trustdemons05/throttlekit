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

## The Feature Expansion — Phases 6 Through 12

After the initial release with seven algorithms and two stores, the scope grew beyond what I had originally imagined. Each new feature started as a reasonable question: "Can it also do this?" The answer was usually yes, and each yes pulled in more dependencies, more adapters, and more complexity.

### Framework Adapters

The Express and Fetch adapters were the obvious first pair — they covered the two most common JavaScript server environments. But then came Fastify, which made different assumptions about request lifecycle. Then Koa, with its own middleware model. Then Hono, which wanted adapters for multiple runtimes. Then Next.js, which needed the adapter to work inside edge functions and serverless handlers simultaneously.

Each adapter looks trivial in isolation — maybe forty lines of glue code. But each one introduced a new surface area for bugs. The Fastify adapter had to deal with their plugin registration order. The Koa adapter had to handle async middleware correctly. The Next.js adapter had to differentiate between edge and Node runtimes at import time. None of these were hard problems individually, but together they demanded a level of integration testing that the project had not needed before.

I learned that framework-specific adapters are a tax you pay for being framework-agnostic. The alternative is to dictate the framework, which ThrottleKit will never do.

### Sketch Rate Limiter

The Count-Min Sketch rate limiter came from a real incident. A colleague was dealing with a DDoS that hit 200,000 distinct IPs, and the memory store's map of IP → counter ballooned to gigabytes. A sketch data structure trades perfect accuracy for bounded memory — you get sub-percent error rates with a fixed memory footprint regardless of how many keys you track.

I was skeptical at first. Sketch-based rate limiting feels like the wrong tool: rate limiting usually demands exact accounting. But for DDoS scenarios, where you only need to identify the top offenders and you do not care if a legitimate user gets a false positive once in a while, the trade-off makes sense. The sketch doubles as a defense-in-depth layer: you run a precise limiter (Token Bucket) alongside a sketch limiter, and if the sketch flags an IP, you escalate to a harder block.

The implementation itself was straightforward — two hash functions, a 2D counter array, and periodic decay. The interesting part was deciding when to decay. Every-decay (clearing the whole sketch periodically) drops too much information. Rolling decay (halving all counters every N seconds) preserves relative ordering. We settled on the rolling approach after benchmarking both.

### Admission Control

Admission control was the feature that I resisted the longest. Rate limiting tells a single node what to do. Admission control coordinates decisions across a fleet. They are related but fundamentally different problems.

The three policies — adaptiveThrottle, fairShare, weightedMaxMin — each solve a specific coordination pattern:

- **adaptiveThrottle** drops requests based on a probabilistic formula when a backend signals overload. It is the least precise but also the most resilient: it requires no consensus and no shared state.
- **fairShare** divides a global quota equally among active nodes. Useful when you have heterogeneous instances and want each one to get a proportional slice of the limit.
- **weightedMaxMin** is fairShare with explicit weights: bigger instances get bigger slices.

The hard part was not the math (fair queuing is well-studied) but the API design. How do you combine admission control with a per-node rate limiter? Is admission control a wrapper around the limiter, or a separate middleware that runs before it? We settled on admission control as a composable layer: you wrap an existing limiter with admission control logic, and the admissions policy feeds back into the limiter's decision. The API looks like `admissions(limiter, policy)` rather than `new Limiter({ admission: policy })`, which keeps the two concepts orthogonal.

### Analytics Wrapper

The analytics wrapper came from a support ticket: "Can you tell me which API keys are hitting the rate limit the most?" The answer was yes, but it required adding instrumentation around every check. The `withAnalytics` wrapper uses a Space-Saving algorithm to track the top-K consumers with bounded memory. It attaches to the limiter and records every decision, so you can query the hottest keys at any point.

Space-Saving is an elegant algorithm. It maintains a fixed-size set of counters and, when a new key arrives and the set is full, evicts the smallest counter (decrementing it to 0) and inserts the new key with a count of 1. The worst-case error is bounded by `N / (k + 1)` where N is total observations and k is the number of counters. For rate-limiting analytics, where you care about the relative ranking more than exact counts, this is more than adequate.

I also learned that adding observability retroactively is painful. The analytics wrapper should have been designed alongside the core limiter from the start. Adding it later meant refactoring the `LimiterImpl` class to emit hooks at each decision point, which touched code that had been stable for weeks.

### Batch Checks

Batch checks (`checkMany`, `checkManySync`) were a direct request from a user who managed multi-tenant rate limits. A single request could be subject to three separate limits: per-IP, per-API-key, and per-endpoint. Without batch checks, that meant three round trips to Redis. With batch checks, the strategy logic is merged into a single Lua script that checks all three in one atomic call.

The implementation required a new abstraction: a composite strategy that takes an array of strategies and applies them in order, stopping at the first denial. The tricky part was ensuring that partial success (first two checks pass, third fails) does not leak state. We had to revert the state changes of the passed checks if a later check fails. That required a checkpoint-and-rollback mechanism in the strategy pipeline.

### PostgresStore

Adding PostgresStore felt like going backward. Redis is the obvious choice for rate-limiting state: it is fast, it has built-in TTL, and its Lua support makes atomic operations trivial. Postgres has none of that. Why would anyone choose Postgres over Redis for rate limiting?

The answer is operational simplicity. Not every team runs Redis. Some teams have a Postgres database but no Redis, and they do not want to add a new stateful dependency just for rate limiting. PostgresStore uses advisory locks for serialization: `pg_try_advisory_xact_lock` to ensure only one process modifies a key at a time. It is slower than Redis (10 ms vs 1 ms per check), but it works without any infrastructure beyond the application database.

The implementation was straightforward but the testing was not. Postgres integration tests require a running Postgres instance, which means Docker in CI. We added a `test:pg` script that only runs when a Postgres connection string is set, keeping the default `npm test` fast for local development.

### Two-Tier Store Improvements

The Two-Tier Store (local memory + Redis backing) was in the initial release, but it was naive. It had a hard-coded sync interval and no backpressure. If the local store was stale and Redis was unavailable, the limiter would silently use stale data and make incorrect decisions.

The refactoring added health checking: the Two-Tier Store pings Redis every sync cycle, and if Redis is down, it falls back to local-only mode (with reduced accuracy) rather than blocking or using stale data. It also gained a configurable margin-of-error parameter that controls how aggressively it syncs. Tight margins mean fewer false positives but more Redis calls; loose margins mean better Redis availability but more local staleness.

This was the feature I was least satisfied with even after completion. Two-tier consistency is a hard problem, and the current solution is pragmatic but not theoretically clean. A future version might use a CRDT or version vectors to reconcile local and remote state more rigorously.

### CI/CD and Documentation Polish

The infrastructure work — SCOREBOARD.md with reproducible benchmarks, CI/CD workflows across Node 18/20/22, Biome linting, expanded subpath exports — was the least glamorous but arguably the most impactful. Before the CI overhaul, contributors had to remember to run linter, typecheck, and tests separately, and CI ran on a single Node version. Now CI is a matrix build that catches Node-version-specific bugs before they reach production.

The SCOREBOARD.md was inspired by a conversation with a developer who asked, "How does this compare to the other rate limiters?" We had benchmark numbers but they were scattered across PR descriptions and commit messages. Consolidating them into a single document with reproduction steps meant anyone could verify the claims without trusting the README.

Biome replaced a growing tangle of ESLint plugins and Prettier config overrides. The migration was painless — one `npx @biomejs/biome migrate` command and all the ESLint rules were translated automatically. The `noExplicitAny` and `noExcessiveCognitiveComplexity` warnings caught several code smells that ESLint had missed because the plugin configuration was incomplete.

The expanded subpath exports (from 4 to 11) were necessary to avoid bundling framework-specific code into applications that do not use those frameworks. A Next.js app should not import Fastify adapter code, even if it is tree-shaken. Subpath exports make the separation explicit at the package resolution level.

### Looking Back

Phase 6 through 12 were not in the original plan. They emerged from real-world usage: someone asked for Postgres support, someone needed batch checks, someone wanted to know which API keys were abusing their endpoint. Each addition made the library more complete but also more complex. The challenge now is keeping that complexity contained — exposing the right abstractions without leaking internal details.

The core philosophy — pure functions, clock injection, store-independence — held up through all of it. A new strategy still looks like `(state, now, cost) -> { state, result }`. A new store still implements the same `Store` interface. The decisions I made in the first week of the project are still the right decisions after adding ten times the surface area. That is the best outcome I could have hoped for.
