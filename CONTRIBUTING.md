# Contributing to ThrottleKit

Thanks for your interest in contributing. This guide covers everything you need to start contributing effectively.

## Prerequisites

- **Node.js 18+** (LTS recommended; CI runs on 18, 20, and 22)
- **npm** (comes with Node.js)
- **Redis** (optional — needed only for RedisStore feature work; the test suite uses an in-memory mock for most cases)
- **PostgreSQL** (optional — needed only for PostgresStore feature work)

## Setup

```bash
git clone https://github.com/trustdemons05/throttlekit.git
cd throttlekit
npm install
npm test          # Verify everything works
```

All commands assume you are in the project root.

## Architecture Overview

ThrottleKit follows a three-layer architecture:

```
┌──────────────────────────────────────────────┐
│                  Adapters                     │
│  Express / Fastify / Hono / Koa / Next.js    │
│  Fetch / OTel                                │
├──────────────────────────────────────────────┤
│                Strategies                     │
│  TokenBucket / GCRA / SlidingWindow / ...    │
│  FixedWindow / GenericCellRatelimit          │
│  SketchRateLimiter / LeakyBucket             │
├──────────────────────────────────────────────┤
│                  Stores                       │
│  MemoryStore / RedisStore / PostgresStore    │
│  TwoTierStore                                │
└──────────────────────────────────────────────┘
```

- **Strategies** implement the rate-limiting math as pure functions `(state, now, cost) -> { state, result }`. They are store-agnostic.
- **Stores** hold state and apply strategy output atomically. Each store implements the same conformance suite.
- **Adapters** bridge ThrottleKit to a framework (Express, Fastify, etc.). They are thin wrappers that translate framework request/response into ThrottleKit calls.

Additional layers include:
- **Admission control** (`adaptiveThrottle`, `fairShare`, `weightedMaxMin`) for coordinating across replicated instances.
- **Analytics** (`withAnalytics`) using Space-Saving top-K for hot-key detection.
- **Batch checks** (`checkMany`, `checkManySync`) for multi-key rate limits in one round trip.

## Testing

ThrottleKit takes testing seriously. Every store must pass the store conformance suite, and every strategy must have contract tests.

### ManualClock

**Never call `Date.now()` directly.** Always inject a `Clock` interface. Use `ManualClock` in tests:

```ts
import { ManualClock } from 'throttlekit';

const clock = new ManualClock(1_000_000); // epoch in ms
// Advance time deterministically — no setTimeout, no drift
clock.advanceBy(1000);
```

This eliminates flaky tests caused by timing drift on CI. Time advances only when you tell it to.

### Float64Array State

Strategies use `Float64Array` for numeric state instead of plain objects. This reduces GC pressure and serializes cleanly to JSON for Redis/Postgres:

```ts
const state = new Float64Array([tokens, lastRefill]);
// state[0] — tokens
// state[1] — lastRefill ms
```

When writing a new strategy, follow this pattern for state representation.

### What to Test

- **Contract tests** — every strategy must pass the standard contract (allowed/denied states, refill behavior, edge cases).
- **Store conformance** — every store must pass `test/stores/StoreConformance.ts`.
- **Lua parity** — if your strategy targets Redis, write a Lua script and run the conformance suite to prove JS and Lua produce identical results for 10,000+ random inputs.
- **Property-based tests** — fast-check is encouraged for invariant verification (e.g., "remaining is never negative", "retryAfterMs is zero when allowed").

## Pull Request Requirements

1. **Open an issue** first for public API changes or new strategies.
2. **Branch from `main`** with a descriptive name (e.g., `fix-token-bucket-edge-case`).
3. **Typecheck**: `npm run typecheck` must pass with zero errors.
4. **Test**: `npm test` must pass with no regressions.
5. **Coverage**: do not reduce overall coverage. Add tests for new code.
6. **Lint**: `npx biome check --write .` must pass.
7. **Update docs** in `docs/` if behavior changes.
8. **Update CHANGELOG.md** under `[Unreleased]` with a concise description of your change.
9. **No coverage regression** — CI will fail if coverage drops.

## Style Guide

ThrottleKit enforces strict TypeScript conventions:

- **Strict TypeScript** — `strict: true` in `tsconfig.json`. No `noImplicitAny` loopholes.
- **No `any`** — use `unknown` if the type is genuinely not known, then narrow it. `any` disables type-checking entirely and is not permitted.
- **No `@ts-ignore`** — if TypeScript complains about legitimate code, fix the types. If you need to work around a library type limitation, use `@ts-expect-error` with a comment explaining why.
- **Pure functions** over classes for new strategies. Functional boundary: `(state: S, now: number, cost: number) => { state: S; result: CheckResult }`.
- **`Float64Array`** for numeric state in hot paths.
- **Clock injection** — signature: `(clock: Clock)` or the clock is a constructor parameter. Never call `Date.now()` or `performance.now()` directly.
- **No Prettier or ESLint** — we use Biome for formatting and linting. Run `npx biome check --write .` before committing.
- **Descriptive naming** — avoid abbreviations in public API. Internal helpers can be concise.

### Biome

Formatting and linting are handled by Biome:

```bash
npx biome check --write .    # Format + lint + organize imports
npx biome ci .               # CI check (no writes)
```

Configuration lives in `biome.json` at the project root.

## Release Process

Maintainers bump the version in `package.json`, update the changelog date, tag the release, and CI handles publishing. Releases follow semantic versioning.
