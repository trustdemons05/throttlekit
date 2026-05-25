# Contributing

Thanks for considering a contribution to ThrottleKit.

## Setup

```bash
git clone https://github.com/trustdemons05/throttlekit.git
cd throttlekit
npm install
```

You will need Node.js 18 or later. Redis is only required if you are working on RedisStore-specific features; the test suite uses an in-memory mock for most cases.

## Development Workflow

```bash
npm run typecheck   # TypeScript strict checks
npm test            # Run full test suite
npm run coverage    # Coverage report
npm run bench       # Run benchmarks
```

All code must pass `tsc --noEmit` with strict mode enabled. There are no lint-staged hooks; CI enforces quality. We do not use Prettier or ESLint in this repo; consistency is maintained by TypeScript strictness and human review.

## Style

- Prefer pure functions over classes for new strategies. The functional boundary is `(state, now, cost) -> { state, result }`.
- Use `Float64Array` for numeric state when performance matters. Token Bucket and GCRA both use this pattern.
- Inject `Clock` instead of calling `Date.now()` directly. This includes utility code, not just strategies.
- Keep strategy logic in the strategy file; keep store logic in the store file. Adapters should be thin wrappers.
- Add Lua scripts for any new strategy that targets Redis. The Lua script must produce bitwise-identical results to the JS implementation for all inputs.

## Testing

- Every strategy must have contract tests in `test/strategies/`.
- Every store must pass the store conformance suite in `test/stores/`.
- Use `ManualClock` for time-dependent tests. No `setTimeout` in unit tests.
- Property-based tests (fast-check) are encouraged for invariant verification. Examples: "remaining is never negative", "retryAfterMs is zero when allowed".
- If you change a strategy's math, update the corresponding Lua script and run the Redis conformance tests.

## Pull Request Process

1. Open an issue to discuss the change if it affects public API or adds a new strategy.
2. Branch from `main` with a descriptive name (e.g., `fix-token-bucket-infinity`).
3. Add tests for new behavior. If you fix a bug, add a regression test.
4. Ensure `npm run typecheck && npm test` passes locally.
5. Update relevant docs in `docs/` if behavior changes.
6. Update `CHANGELOG.md` under `[Unreleased]` with a concise description.

## Release Process

Maintainers bump the version in `package.json`, update the changelog date, and tag the release. CI handles publishing to npm automatically. Releases follow semantic versioning.
