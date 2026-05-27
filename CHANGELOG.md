# Changelog

## [0.3.0] - 2026-05-27

### Added
- First-class strategy factories: tokenBucket(), fixedWindow(), slidingWindowLog(), slidingWindowCounter(), slidingWindow()
- Live dashboard with WebSocket-powered real-time UI
- Cloudflare Workers stores: DurableObjectStore, D1Store, KVStore
- LLM token budget limiter with pre-flight estimation and post-flight reconciliation
- Model pricing tables for 10 popular LLMs
- Dollar-cost budget conversion

### Deprecated
- rateLimit() factory — use named strategy factories instead

## [0.2.0] - 2026-05-27

### Added
- Framework adapters: Hono, Fastify, Koa, Next.js
- Sketch rate limiter (Count-Min Sketch) for DDoS scenarios
- Admission control: adaptiveThrottle, fairShare, weightedMaxMin
- Analytics wrapper (withAnalytics) with Space-Saving top-K
- Batch checks: checkMany, checkManySync
- PostgresStore (advisory-lock serialization)
- node-redis and Upstash REST adapter wrappers
- Window-coupled leasing (overshoot independent of fleet size)
- SCOREBOARD.md with reproducible benchmarks
- CI/CD workflows (Node 18/20/22 matrix)
- Biome linting

### Changed
- Subpath exports expanded from 4 to 11
- README completely rewritten

## [0.1.0] - 2026-05-26

### Added
- Initial release
- 8 rate-limiting algorithms
- MemoryStore, RedisStore, Two-Tier Store
- Express, Fetch, OTel adapters
- ManualClock for deterministic testing
- JS/Lua conformance suite
- Property-based invariant testing
