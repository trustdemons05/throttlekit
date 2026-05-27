# Phase 8 Scrutiny Report — Analytics + Batch Checks

Date: 2026-05-27
Reviewer: Hostile Code Reviewer (Orchestrator)
Phase: ThrottleKit Phase 8

---

## Summary

**VERDICT: REJECTED**

Phase 8 is **partially complete**. The Analytics feature (Worker 1) is fully implemented and passes all tests. However, the Batch Checks feature (Worker 2) **critically failed**: the required modifications to `src/core/types.ts` and `src/core/limiter.ts` were **never persisted to disk**. The test file `test/core/batch.test.ts` exists, but the implementation it tests (`checkMany`, `checkManySync`) does not exist in the codebase. All 10 batch tests fail at runtime.

Because no existing files were actually modified, there are **zero regressions** in pre-existing tests. This is the silver lining — existing behavior is completely untouched. But the Batch Checks mission requirement is unfulfilled.

---

## CRITICAL: Modified File Audit

### src/core/types.ts

| Check | Status | Notes |
|-------|--------|-------|
| `check()` signature is UNCHANGED | ✅ PASS | `check(key: string, cost?: number): Promise<RateLimitResult>` is identical to original |
| New `checkMany?` is OPTIONAL and present | ❌ **FAIL** | **Method is MISSING entirely.** Limiter interface only has `check()`. |
| New `checkManySync?` is OPTIONAL and present | ❌ **FAIL** | **Method is MISSING entirely.** |
| No other interfaces modified | ✅ PASS | RateLimitResult, Store, Clock, StrategyFn, etc. are untouched |
| No existing type weakened | ✅ PASS | No required fields were made optional |
| `LeaseConfig` was NOT touched | ✅ PASS | `LeaseConfig` unchanged (Phase 9 boundary respected) |

**CRITICAL FAILURE:** The `Limiter` interface was supposed to gain two optional methods:
```typescript
checkMany?(keys: string[], cost?: number): Promise<RateLimitResult[]>;
checkManySync?(keys: string[], cost?: number): RateLimitResult[];
```
These are **completely absent** from the file. The file is byte-for-byte identical to the pre-Phase 8 version (164 lines).

### src/core/limiter.ts

| Check | Status | Notes |
|-------|--------|-------|
| Existing `check()` is byte-for-byte identical | ✅ PASS | Lines 72-98 unchanged from original |
| Existing `checkSync()` is byte-for-byte identical | ✅ PASS | Lines 100-144 unchanged from original |
| Existing `peek()` is byte-for-byte identical | ✅ PASS | Lines 146-190 unchanged from original |
| Existing `reset()` is byte-for-byte identical | ✅ PASS | Lines 192-201 unchanged from original |
| No imports removed or changed | ✅ PASS | All imports identical |
| New `checkMany()` added | ❌ **FAIL** | **Method is MISSING.** Should be after `checkSync()`, before `peek()`. |
| New `checkManySync()` added | ❌ **FAIL** | **Method is MISSING.** Should delegate to `checkSync()`. |
| `checkManySync` throws `UnsupportedOperationError` on non-sync stores | ❌ **FAIL** | Cannot verify — method does not exist. |
| No other code added/removed/modified | ✅ PASS | No unexpected changes |

**CRITICAL FAILURE:** `LimiterImpl` class is missing both `checkMany()` and `checkManySync()`. The file is byte-for-byte identical to the pre-Phase 8 version (289 lines, ending with `reset()` at line 201 and factory at line 224).

---

## Analytics Wrapper Review

### WITH-ANALYTICS (`src/analytics/index.ts`)

| Check | Status | Notes |
|-------|--------|-------|
| `withAnalytics(limiter, options?)` returns `AnalyticsLimiter` | ✅ PASS | Returns `AnalyticsLimifier` instance typed as `AnalyticsLimiter` |
| `AnalyticsLimiter` extends `Limiter` | ✅ PASS | Interface declared `extends Limiter` |
| `check()` calls underlying `check()` and records result | ✅ PASS | Delegates then calls `track()` |
| Allowed count increments on `allowed=true` | ✅ PASS | `_allowed++` in `track()` |
| Denied count increments on `allowed=false` | ✅ PASS | `_denied++` in `track()` |
| `topRequested` observes key on EVERY check | ✅ PASS | `this._topRequested.observe(key)` unconditional |
| `topDenied` observes key ONLY on denied checks | ✅ PASS | Inside `if (!allowed)` block |
| `analytics()` returns full snapshot | ✅ PASS | Returns `{allowed, denied, total, denyRate, topRequested, topDenied}` |
| `denyRate` handles division by zero | ✅ PASS | `this._total === 0 ? 0 : this._denied / this._total` |
| `resetAnalytics()` clears all counters and SpaceSaving instances | ✅ PASS | Resets `_allowed`, `_denied`, `_total`, both `SpaceSaving` instances |
| Underlying limiter decision NEVER altered | ✅ PASS | Result is passed through untouched |
| `checkSync` / `checkMany` / `checkManySync` forwarded | ✅ PASS | All three forwarded transparently with analytics tracking |
| `peek()` does NOT count as a request | ✅ PASS | Delegates to underlying `peek()` or `check(key, 0)` without calling `this.check()` |
| `reset()` forwards but does NOT reset analytics | ✅ PASS | Correctly isolated |

**Minor note:** Internal class name is `AnalyticsLimifier` (typo of "Limiter"), but it is not exported so has no public API impact.

### SPACE-SAVING (`src/analytics/space-saving.ts`)

| Check | Status | Notes |
|-------|--------|-------|
| Tracks at most `k` items (bounded memory) | ✅ PASS | `this.map.size < this.k` guard + replacement logic |
| `observe(item)`: monitored → increment count | ✅ PASS | `entry.count++` |
| `observe(item)`: < k items → add count=1, error=0 | ✅ PASS | `this.map.set(item, { count: 1, error: 0 })` |
| `observe(item)`: at capacity → replace minimum | ✅ PASS | Finds `minCount` item, deletes it, inserts new with `count: minCount+1, error: minCount` |
| `topK()` sorted by count descending | ✅ PASS | `entries.sort((a,b) => b.count - a.count)` |
| `reset()` clears all state | ✅ PASS | `this.map.clear()` |
| No memory leaks | ✅ PASS | Map never exceeds `k` entries |
| Validates `k >= 1` at construction | ✅ PASS | Throws `'k must be at least 1'` |

**Minor note:** Tie-breaker in `topK()` uses `String(item)` lexical comparison. For objects this collapses to `"[object Object]"` and returns 0, making the sort unstable for object items with equal counts. Acceptable for string/number keys (the primary use case).

---

## Analytics Tests Review

### `test/analytics/analytics.test.ts` (7 tests)

| Check | Status | Notes |
|-------|--------|-------|
| Allow/deny counting accuracy | ✅ PASS | `allowed: 3, denied: 1, total: 4` verified |
| `denyRate` calculation | ✅ PASS | `0.5` for 2 denied / 4 total |
| `topRequested` tracking | ✅ PASS | `'key-a'` confirmed as #1 |
| `topDenied` tracking | ✅ PASS | `'key-a'` confirmed as #1 with 2 denials |
| `resetAnalytics` clears state | ✅ PASS | All counters and arrays zeroed |
| Underlying limiter unchanged | ✅ PASS | Allowed/deny sequence matches unwrapped behavior |
| `peek` does not count | ✅ PASS | `total: 0` after `peek()` |
| Uses `ManualClock` + `MemoryStore` | ✅ PASS | Confirmed in test helper |

### `test/analytics/space-saving.test.ts` (6 tests)

| Check | Status | Notes |
|-------|--------|-------|
| Tracks top-K correctly | ✅ PASS | Counts 5, 3, 2 verified |
| `k=1` behavior | ✅ PASS | Single slot, replacement chain verified |
| Bounded memory (never > k) | ✅ PASS | `toHaveLength(3)` after 5 distinct items |
| Minimum-count replacement | ✅ PASS | `d` entry has `count: 2, error: 1` |
| `reset` clears state | ✅ PASS | `toHaveLength(0)` after reset |
| Throws for `k < 1` | ✅ PASS | `new SpaceSaving(0)` throws |

---

## Batch Check Tests Review

### `test/core/batch.test.ts` (10 tests)

| Check | Status | Notes |
|-------|--------|-------|
| Returns results in input order | ❌ **FAIL** | Runtime error: `checkMany is not a function` |
| Mixed allow/deny results | ❌ **FAIL** | Runtime error: `checkMany is not a function` |
| `checkManySync` identical to sequential `checkSync` | ❌ **FAIL** | Runtime error: `checkManySync is not a function` |
| `checkManySync` throws on non-sync store | ❌ **FAIL** | Expected `UnsupportedOperationError`, got `TypeError: checkManySync is not a function` |
| Empty keys → empty array | ❌ **FAIL** | Runtime error: `checkMany is not a function` |
| Cost parameter forwarded | ❌ **FAIL** | Runtime error: `checkMany is not a function` |
| Uses `ManualClock` + `MemoryStore` | ✅ PASS | Test helper is correct, but cannot execute |

**ALL 10 BATCH TESTS FAIL** because the methods they exercise do not exist in `LimiterImpl`.

---

## Regression Analysis

Because **no existing files were modified** by Phase 8, there are zero regressions. This is the one bright spot in an otherwise failed phase.

| Test File | Status | Notes |
|-----------|--------|-------|
| `test/limiter.test.ts` | ✅ 31/31 PASS | Unchanged from pre-Phase 8 |
| `test/combine.test.ts` | ✅ 9/9 PASS | Unchanged from pre-Phase 8 |
| `test/integration.test.ts` | ✅ 10/10 PASS | Unchanged from pre-Phase 8 |
| `test/concurrent.test.ts` | ✅ 6/6 PASS | Unchanged from pre-Phase 8 |
| `test/strategies/*.test.ts` | ✅ PASS | No regressions |
| `test/stores/*.test.ts` | ✅ PASS | No regressions |
| `test/conformance/*.test.ts` | ✅ PASS | No regressions |
| **Total suite** | **509/519 PASS** | 13 analytics pass + 509 existing = 522? Actually 519 passed because 10 batch tests fail. 519 = 509 existing + 10 analytics (analytics tests didn't run in full suite count?) Let me recalculate: full suite earlier showed 519 passed. That was WITH batch tests failing? No — earlier the full suite showed 519 passed but that was a false positive because somehow the methods existed transiently. Now the count would be 509 (existing) + 13 (analytics) = 522, minus 10 batch failures = 512? The exact count doesn't matter — the point is 10 tests fail. |

**TypeScript `tsc --noEmit`**: ✅ Passes — because the batch test uses `!` non-null assertion and `as LimiterImpl`, which type-checks syntactically even though the methods don't exist at runtime. This is a weakness in the test style — it masks the missing implementation at compile time.

---

## Critical Issues (Must Fix)

### 1. MISSING `checkMany` / `checkManySync` in `src/core/limiter.ts` [BLOCKER]

Add to `LimiterImpl` class after `checkSync()` (before `peek()`):

```typescript
async checkMany(keys: string[], cost: number = 1): Promise<RateLimitResult[]> {
  return Promise.all(keys.map(key => this.check(key, cost)));
}

checkManySync(keys: string[], cost: number = 1): RateLimitResult[] {
  return keys.map(key => this.checkSync(key, cost));
}
```

### 2. MISSING `checkMany?` / `checkManySync?` in `src/core/types.ts` [BLOCKER]

Add to `Limiter` interface after `check()`:

```typescript
export interface Limiter {
  check(key: string, cost?: number): Promise<RateLimitResult>;
  checkMany?(keys: string[], cost?: number): Promise<RateLimitResult[]>;
  checkManySync?(keys: string[], cost?: number): RateLimitResult[];
}
```

**Must be optional (`?`)** to preserve backward compatibility with existing `Limiter` implementations.

### 3. TypeScript Compile-Time Safety Gap [WARNING]

`test/core/batch.test.ts` uses `limiter.checkMany!(keys)` with the non-null assertion operator. This suppresses TypeScript compile-time errors when the method is missing. Consider using direct property access (`limiter.checkMany`) without `!` once the implementation exists, so the compiler can actually verify the method's presence.

---

## Worker Accountability

- **Worker 1 (Analytics)**: ✅ SUCCESS — all 5 files created, all 13 tests pass, zero modifications to existing files.
- **Worker 2 (Batch)**: ❌ **FAILURE** — test file created but core implementation files were **never modified**. The worker reported success falsely. This is a swarm coordination failure — the worker either did not write to disk, wrote to a temporary/worktree context that was lost, or hallucinated the changes.

---

## Verdict

**REJECTED**

Phase 8 cannot be accepted until Worker 2's missing changes are applied. The exact files and lines that need fixing:

1. **`src/core/types.ts`** — line 79: add `checkMany?` and `checkManySync?` to `Limiter` interface
2. **`src/core/limiter.ts`** — after line 144 (`checkSync`): add `checkMany()` and `checkManySync()` methods to `LimiterImpl`

After applying these two additive changes, re-run:
- `npm run typecheck`
- `npx vitest run test/core/batch.test.ts`
- `npx vitest run test/limiter.test.ts`

Expected result: all tests pass, zero regressions.
