# Phase 9 Scrutiny Report — Store Extensions

**Date:** 2026-05-27  
**Auditor:** Hostile Reviewer (Kimi K2.6)  
**Scope:** PostgresStore, Redis Client Adapters, Window-Coupled Leasing, Phase 8/9 existing-file modifications

---

## Summary

| Category | Verdict |
|---|---|
| New files (PostgresStore, Redis adapters, tests) | **PASS** — well-implemented, zero-dependency, fully tested |
| Modified files (types.ts, two-tier.ts) | **CRITICAL FAIL** — Phase 9 changes are **missing from disk** |
| Phase 8 legacy (checkMany/checkManySync) | **CRITICAL FAIL** — also **missing from disk** |
| Overall | **REJECTED** |

**516 tests pass, 13 fail.** All 13 failures stem from one root cause: modifications to existing source files (`src/core/types.ts`, `src/stores/two-tier.ts`, `src/core/limiter.ts`) were not persisted. The new files are excellent, but the mission-critical existing-file changes are absent.

---

## CRITICAL: Modified File Audit

### `src/core/types.ts`

| Check | Status | Notes |
|---|---|---|
| `LeaseConfig` still has `batch: number` | ✅ PASS | Unchanged |
| `LeaseConfig` still has `lowWater?: number` | ✅ PASS | Unchanged |
| **NEW:** `windowCoupled?: boolean` added to `LeaseConfig` | ❌ **FAIL** | **MISSING** — interface ends at `lowWater` |
| No other fields added/removed from `LeaseConfig` | ✅ PASS | — |
| `Limiter` interface has `checkMany?` / `checkManySync?` (Phase 8) | ❌ **FAIL** | **MISSING** — only `check()` exists |
| No other interfaces modified by Phase 9 | ✅ PASS | — |

**Evidence:**
```typescript
// Current src/core/types.ts (lines 153-157)
export interface LeaseConfig {
  batch: number;
  lowWater?: number;
}
```

`windowCoupled` is referenced by `test/stores/window-coupled.test.ts` but does not exist in the type system. TypeScript typecheck reports:
```
test/stores/window-coupled.test.ts(58,41): error TS2353:
Object literal may only specify known properties, and 'windowCoupled' does not exist in type 'LeaseConfig'.
```

---

### `src/stores/two-tier.ts`

| Check | Status | Notes |
|---|---|---|
| 'strict' mode: identical to original | ✅ PASS | Unchanged |
| 'cached-deny' mode: identical to original | ✅ PASS | Unchanged |
| 'leased' mode WITHOUT `windowCoupled`: identical to original | ✅ PASS | Because `windowCoupled` code is **completely absent** |
| 'leased' mode WITH `windowCoupled=true`: tracks `resetAt`, invalidates at boundary | ❌ **FAIL** | **MISSING** — no boundary check, no invalidation logic |
| `get` / `set` / `delete` methods unchanged | ✅ PASS | — |
| `LeasedState` interface unchanged | ✅ PASS | — |
| `CachedDenial` interface unchanged | ✅ PASS | — |
| `UnsupportedOperationError` class unchanged | ✅ PASS | — |

**Evidence:**
```typescript
// Current src/stores/two-tier.ts 'leased' case (lines 135-186)
case 'leased': {
  const batch = lease?.batch ?? 10;
  const lowWater = lease?.lowWater ?? Math.max(1, Math.floor(batch / 4));

  // Read current leased state from L1
  const leased = await l1.get<LeasedState>(key);

  // If no lease exists or remaining is below low-water, refill from L2
  if (leased === null || leased.remaining < lowWater) {
    // ... original logic only ...
  }
```

There is **no** `const windowCoupled = lease?.windowCoupled ?? false;`, **no** `clock.now() >= leased.resetAt` check, and **no** `leased.remaining = 0` invalidation. The file is byte-for-byte identical to the pre-Phase 9 committed version.

---

## PostgresStore

| Check | Status | Notes |
|---|---|---|
| Implements `Store` interface (`apply`, `get`, `set`, `delete`) | ✅ PASS | — |
| Duck-types `PgPool` / `PgClient` — zero `pg` import | ✅ PASS | — |
| `ensureTable()` creates table with correct schema | ✅ PASS | `key TEXT PK, state JSONB, expires_at TIMESTAMPTZ` |
| `apply()` acquires client, `BEGIN`, advisory lock, `SELECT`, transform, `UPSERT`, `COMMIT` | ✅ PASS | — |
| Error handling: `ROLLBACK`, release client, re-throw | ✅ PASS | `.catch()` swallows rollback errors — acceptable |
| `get()` checks `expires_at > NOW()` | ✅ PASS | — |
| `set()` is `UPSERT` with `expires_at` | ✅ PASS | — |
| `delete()` is `DELETE` by key | ✅ PASS | — |
| `prefix` option used in key construction | ✅ PASS | — |
| Parameterized queries (`$1`, `$2`, `$3`) | ✅ PASS | **All** user-provided values use placeholders |
| Tests use mock `PgPool` / `PgClient` (no real DB) | ✅ PASS | In-memory `Map` mock |
| Tests cover `apply`, `get`, `set`, `delete`, `ensureTable`, error handling, concurrency | ✅ PASS | 17 tests, all pass |

**Minor issue:** `tableName` is interpolated directly into SQL strings (not parameterized). This is acceptable because `tableName` comes from developer configuration, not user input. No runtime SQL injection vector exists.

---

## Redis Adapters

| Check | Status | Notes |
|---|---|---|
| `fromNodeRedis` returns `IoredisLikeClient` | ✅ PASS | — |
| `fromUpstash` returns `IoredisLikeClient` | ✅ PASS | — |
| Duck-types `NodeRedisLike` — no `'redis'` import | ✅ PASS | — |
| Duck-types `UpstashLike` — no `'@upstash/redis'` import | ✅ PASS | — |
| `fromNodeRedis`: maps `get`/`set`/`del` correctly | ✅ PASS | Coerces null set result to `'OK'` |
| `fromNodeRedis`: `eval`/`evalsha` splits args by `numkeys` | ✅ PASS | Adapts to node-redis `{keys, arguments}` shape |
| `fromNodeRedis`: `watch`/`multi` mapped correctly | ✅ PASS | — |
| `fromNodeRedis`: `multi().exec()` adapts result shape | ✅ PASS | Wraps raw results as `[null, result]` tuples |
| `fromUpstash`: maps `get`/`set`/`del` correctly | ✅ PASS | — |
| `fromUpstash`: `watch()` THROWS with exact message | ✅ PASS | `"Upstash REST does not support WATCH/MULTI. Use Lua-backed strategies only."` |
| `fromUpstash`: `multi()` THROWS with exact message | ✅ PASS | Same exact message |
| `fromUpstash`: `eval`/`evalsha` maps correctly | ✅ PASS | Adapts to Upstash array-based signatures |
| Tests: mock NodeRedisLike adaptation verified | ✅ PASS | — |
| Tests: mock UpstashLike adaptation verified | ✅ PASS | — |
| Tests: Upstash `watch`/`multi` throw verified | ✅ PASS | — |
| Tests: structural interface conformance verified | ✅ PASS | `expectTypeOf` compile-time checks |

**Minor issue:** `UnsupportedOperationError` is defined in both `redis-adapters.ts` and `two-tier.ts`. This is redundant but harmless since neither module re-exports the other.

---

## Window-Coupled Leasing Tests

| Check | Status | Notes |
|---|---|---|
| `windowCoupled=false` → behavior unchanged | ✅ PASS | Tests pass because code is unchanged |
| `windowCoupled=true` → lease invalidates at boundary | ❌ **FAIL** | `l2Calls` expected 2, got 1 — code is missing |
| After boundary cross, next check hits L2 | ❌ **FAIL** | `resetAt` expected `1100001`, got `1050000` — stale lease |
| Total admitted in one window ≤ limit | ❌ **FAIL** | `allowed` expected `false`, got `true` — overshoot unbounded |
| `windowCoupled=undefined` → behaves same as false | ✅ PASS | Tests pass because code is unchanged |
| Uses `ManualClock` for precise time control | ✅ PASS | — |
| Uses mock L2 store with spy | ✅ PASS | — |

**Test results:** 2/5 pass, 3/5 fail. The 2 passing tests verify that default behavior is unchanged — which is trivially true because the code was never modified.

---

## Conflict Detection (Phase 8 + Phase 9)

| Phase | Expected Change | Present on Disk? |
|---|---|---|
| Phase 8 | `Limiter` interface gains `checkMany?` / `checkManySync?` | ❌ **NO** |
| Phase 8 | `LimiterImpl` gains `checkMany()` / `checkManySync()` methods | ❌ **NO** |
| Phase 9 | `LeaseConfig` gains `windowCoupled?: boolean` | ❌ **NO** |
| Phase 9 | `two-tier.ts` 'leased' case gains boundary invalidation logic | ❌ **NO** |

**Both phases' modifications to existing files are absent.** The test files from both phases exist and actively reference the missing APIs:
- `test/core/batch.test.ts` → `checkMany` / `checkManySync` (10 failures)
- `test/stores/window-coupled.test.ts` → `windowCoupled` (3 failures)

This is not a merge conflict (no competing edits in the same hunk). It is a **total loss of uncommitted modifications** to existing files. The new files created by Phase 9 workers survived, but their edits to existing files did not.

---

## Regression Analysis

| Test File | Tests | Pass | Fail | Notes |
|---|---|---|---|---|
| `test/stores/two-tier.test.ts` | 7 | 7 | 0 | Original behavior preserved (trivially, since code is unchanged) |
| `test/stores/store-contract.test.ts` | 6 | 6 | 0 | No regression |
| `test/limiter.test.ts` | 31 | 31 | 0 | No regression |
| `test/integration.test.ts` | 10 | 10 | 0 | No regression |
| `test/stores/postgres.test.ts` | 17 | 17 | 0 | New file — passes |
| `test/stores/redis-adapters.test.ts` | 38 | 38 | 0 | New file — passes |
| `test/stores/window-coupled.test.ts` | 5 | 2 | **3** | Fails because `windowCoupled` implementation is missing |
| `test/core/batch.test.ts` | 10 | 0 | **10** | Fails because `checkMany`/`checkManySync` implementation is missing |

**Total test count across full suite:** ~519 tests (including new Phase 9 tests). Without the failing window-coupled and batch tests, the count is ~506. The acceptance criteria of `>= 349` passing is met (516 pass), but **13 tests fail due to missing implementations**.

---

## SQL Injection Check

| Query | Parameterized? | Risk |
|---|---|---|
| `SELECT state FROM {table} WHERE key = $1 AND expires_at > NOW()` | ✅ Yes (`$1`) | None |
| `INSERT INTO {table} ... VALUES ($1, $2::jsonb, NOW() + $3::bigint * ...)` | ✅ Yes (`$1`, `$2`, `$3`) | None |
| `DELETE FROM {table} WHERE key = $1` | ✅ Yes (`$1`) | None |
| `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)` | ✅ Yes (`$1`) | None |
| `CREATE TABLE IF NOT EXISTS {tableName}` | ⚠️ Interpolated | **Low** — `tableName` is developer config, not user input |

**Verdict:** Acceptable. All externally supplied values (keys, state, TTLs) use `$N` placeholders. The only interpolated value is `tableName`, which is a deployment-time configuration parameter.

---

## Critical Issues

### Issue 1: `windowCoupled` field missing from `LeaseConfig` (BLOCKER)
- **Severity:** CRITICAL
- **File:** `src/core/types.ts`
- **Impact:** TypeScript compilation errors, window-coupled tests fail
- **Fix:** Add `windowCoupled?: boolean` to `LeaseConfig`

### Issue 2: Window-coupled leasing logic missing from `two-tier.ts` (BLOCKER)
- **Severity:** CRITICAL
- **File:** `src/stores/two-tier.ts`
- **Impact:** 3/5 window-coupled tests fail; overshoot bound is unenforced
- **Fix:** Add boundary invalidation logic inside the `'leased'` case

### Issue 3: Phase 8 `checkMany` / `checkManySync` missing from `Limiter` interface and `LimiterImpl` (BLOCKER)
- **Severity:** CRITICAL
- **Files:** `src/core/types.ts`, `src/core/limiter.ts`
- **Impact:** 10/10 batch tests fail; `src/analytics/index.ts` duck-types to non-existent methods
- **Fix:** Add `checkMany?` and `checkManySync?` to `Limiter` interface; add implementations to `LimiterImpl`

### Issue 4: Uncommitted modifications lost (INFRASTRUCTURE)
- **Severity:** CRITICAL
- **Observation:** Existing files that were reportedly modified by Phase 8 and Phase 9 workers have reverted to their committed HEAD state. New files persist. This suggests a filesystem/git rollback of uncommitted edits to tracked files.
- **Action:** Re-apply the lost modifications and commit them.

---

## Verdict

**REJECTED**

Phase 9's **new** files (`PostgresStore`, Redis adapters, and their tests) are production-quality and pass all tests. However, the **mission-critical modifications to existing files** (`src/core/types.ts`, `src/stores/two-tier.ts`, and `src/core/limiter.ts`) are **absent from disk**. This causes:

1. TypeScript compilation errors (`windowCoupled` does not exist on `LeaseConfig`)
2. Runtime failures (`checkMany is not a function`)
3. Feature failures (window-coupled overshoot bound is not enforced)

**Required before acceptance:**
1. Re-apply `windowCoupled?: boolean` to `LeaseConfig` in `src/core/types.ts`
2. Re-apply window boundary invalidation logic to `'leased'` mode in `src/stores/two-tier.ts`
3. Re-apply `checkMany` / `checkManySync` to `Limiter` interface and `LimiterImpl`
4. Verify `npm run typecheck` passes with **zero** errors in new/modified files
5. Verify all `window-coupled` and `batch` tests pass
6. Verify no existing tests regress
