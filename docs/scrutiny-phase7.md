# Phase 7 Scrutiny Report — Sketch + Admission Control
Date: 2026-05-27

## Summary
**PASS** — Both modules are functionally correct, type-safe, and well-tested. No regressions in existing tests. Two minor design quirks identified (non-critical).

## Files Found
### Sketch Rate Limiter
| Path | Type |
|------|------|
| `src/sketch/types.ts` | Types |
| `src/sketch/cms.ts` | CountMinSketch implementation |
| `src/sketch/index.ts` | Factory functions |
| `test/sketch/sketch.test.ts` | Basic tests |
| `test/sketch/mergeable.test.ts` | Merge/serialization tests |

### Admission Control
| Path | Type |
|------|------|
| `src/admission/types.ts` | Type re-exports |
| `src/admission/adaptive-throttle.ts` | Adaptive throttle implementation |
| `src/admission/fair-share.ts` | Fair share limiter |
| `src/admission/weighted.ts` | Weighted max-min + online limiter |
| `src/admission/index.ts` | Barrel exports |
| `test/admission/adaptive-throttle.test.ts` | Adaptive throttle tests |
| `test/admission/fair-share.test.ts` | Fair share tests |
| `test/admission/weighted.test.ts` | Weighted tests |

---

## Count-Min Sketch Implementation
| Check | Status | Notes |
|-------|--------|-------|
| Uses Uint32Array for counter storage | PASS | `private readonly counters: Uint32Array` |
| Default width = ceil(E / 0.01) = 272 | PASS | `Math.ceil(Math.E / 0.01)` in `defaultWidth()` |
| Default depth = ceil(ln(1/0.001)) = 7 | PASS | `Math.ceil(Math.log(1 / delta))` in `defaultDepth()` |
| Memory ≈ 7.6 KB | PASS | 272 × 7 × 4 = 7,616 bytes |
| Inline hash (no npm deps) | PASS | FNV-1a 32-bit + djb2 32-bit, both inline |
| Kirsch-Mitzenmacher trick | PASS | `col = (Math.imul(h2, row) + h1) >>> 0; return row * width + (col % width)` |
| Conservative update | PASS | Two-pass: find min, then only increment counters == min |
| estimate() returns minimum across rows | PASS | `let min = Infinity; for (...) if (val < min) min = val;` |
| increment() allocation-free | PASS | Only primitive ops: loops, `Math.imul`, `charCodeAt`, array indexing, `>>>` |
| estimate() allocation-free | PASS | Only primitive ops: loop, array indexing, comparison |
| reset() zeros all counters | PASS | `this.counters.fill(0)` |
| merge() element-wise addition | PASS | Validates dimensions, then `this.counters[i] + other.counters[i]` |
| snapshot() returns a copy | PASS | `this.counters.slice()` creates a new Uint32Array |
| toBytes() serializes correctly | PASS | Creates Uint8Array, creates Uint32Array view over it, `.set(this.counters)` |

## Sketch Rate Limiter
| Check | Status | Notes |
|-------|--------|-------|
| Window rotation resets CMS | PASS | `if (now >= windowStart + windowMs) { cms.reset(); windowStart = now; }` |
| Never over-admits (hard property) | PASS | CMS never undercounts; `estimate + 1 <= limit` guarantees `true_count + 1 <= limit` |
| RateLimitResult.allowed | PASS | Computed from estimate vs limit |
| RateLimitResult.limit | PASS | Returns configured limit |
| RateLimitResult.remaining | PASS | `Math.max(0, limit - cms.estimate(key))` using post-increment estimate |
| RateLimitResult.resetAt | PASS | `windowStart + windowMs` |
| RateLimitResult.retryAfterMs | PASS | `allowed ? 0 : resetAt - now` |
| checkSync exists | PASS | Implemented, `check()` wraps it in `Promise.resolve()` |
| Uses injected clock | PASS | Defaults to `SystemClock`, tests inject `ManualClock` |

## Mergeable Sketch
| Check | Status | Notes |
|-------|--------|-------|
| snapshot() returns copy | PASS | Delegates to `cms.snapshot()` which calls `.slice()` |
| toBytes() correct | PASS | Delegates to `cms.toBytes()` |
| merge() adds element-wise | PASS | Creates temporary `CountMinSketch` from snapshot, then `cms.merge(temp)` |
| sketchSnapshotFromBytes() deserializes | PASS | Validates length, creates new Uint32Array from sliced buffer |
| Roundtrip test passes | PASS | `toBytes()` → `sketchSnapshotFromBytes()` → counters match |

## Sketch Tests
| Check | Status | Notes |
|-------|--------|-------|
| Never-over-admit property tested | PASS | `limit + 100` checks, asserts `allowed <= limit` |
| Window rotation tested | PASS | Advance clock, verify fresh capacity |
| Conservative update tested | PASS | Compares false-positives against a naive scenario |
| Merge correctness tested | PASS | Two sketches merged, estimate reflects combined counts |
| Snapshot roundtrip tested | PASS | `toBytes` → `fromBytes` → counters equal |
| All tests use ManualClock | PASS | Every test creates `new ManualClock(...)` |

---

## Adaptive Throttle
| Check | Status | Notes |
|-------|--------|-------|
| Formula p = max(0, (reqs - k*accs) / (reqs + 1)) | PASS | Implemented exactly in `computeP()` and inline in `request()` |
| request() returns true with prob (1-p) | PASS | `Math.random() >= effectiveP` |
| Priority support | PASS | `effectiveP = p / Math.max(0.001, priority)`; priority>1 reduces p |
| record() updates counters | PASS | Increments `requests` and optionally `accepts` in current bucket |
| Rolling window expiry | PASS | `buckets.filter(b => b.ts >= cutoff)` evicts old buckets |
| Uses injected clock | PASS | Tests inject `ManualClock`; production defaults to `SystemClock` |
| dropProbability getter | PASS | Recomputes p on access after evicting stale buckets |
| reset() clears state | PASS | `buckets = []; _dropProbability = 0` |

## Fair Share
| Check | Status | Notes |
|-------|--------|-------|
| Each active tenant gets >= limit/N | PASS | `fairCap = limit / activeTenants` |
| Global total never exceeds limit | PASS | Guard: `globalSum + 1 <= limit` |
| Window rotation resets counters | PASS | `usage.clear(); windowStart = now` |
| Idle tenant's share redistributed | PASS | Only checked tenants enter `usage` map |
| Returns valid RateLimitResult | PASS | All 5 fields populated correctly |
| Uses injected clock | PASS | Tests inject `ManualClock` |

## Weighted Max-Min
| Check | Status | Notes |
|-------|--------|-------|
| weightedMaxMin returns correct allocations | PASS | Water-filling + proportional fallback, tested against known cases |
| Output sums to budget (or total demand if < budget) | PASS | Phase 2 floors and distributes remainder; if demand < budget, unsaturated list is empty, sum = total demand |
| Work-conserving | PASS | Unsatisfied tenants receive proportional share of remaining budget |
| Weighted proportionality | PASS | Weight-4 tenant gets ~4x share of weight-1 tenants in [100,100,100,100],[4,1,1,1],100 |
| Zero demand = zero allocation | PASS | Tenant with demand=0 gets exactAlloc=0, floor=0 |
| Edge cases (empty, zero budget, zero weights, single tenant) | PASS | All tested |
| weightedFairShare online limiter works | PASS | Uses injected clock; fairCap proportional to weight/totalWeight |

## Admission Tests
| Check | Status | Notes |
|-------|--------|-------|
| 100% acceptance → p ≈ 0 | PASS | Verified: p = 0 after 100 accepted records |
| 50% acceptance → p low | PASS | Verified: p = 0 at k=2 because (200 - 2×100) / 201 = 0 |
| 0% acceptance → p → 1.0 | PASS | Verified: p = 100/101 ≈ 0.99 after 100 rejected records |
| Window expiry resets | PASS | `clock.advanceBy(30_001)` → p resets to 0 |
| Priority test | PASS | Mocked Math.random with seeded PRNG; high priority passes more |
| fairShare 2 tenants → ~50 each | PASS | Alternating checks produce exactly 50 each |
| fairShare global total ≤ limit | PASS | 200 mixed-tenant checks, total allowed ≤ 50 |
| weightedMaxMin known case | PASS | `[100,100,100,100],[4,1,1,1],100` → sum=100, tenant0 ~57 |
| All tests use ManualClock | PASS | Zero real timers; zero `Date.now()` usage |

---

## Critical Issues
**None.** No critical bugs found.

## Minor Issues
1. **Fair-share / weightedFairShare first-check advantage**: When a new tenant checks for the first time in a window, `activeTenants` (or `totalWeight`) does NOT yet include that tenant. Its `fairCap` is therefore computed using the old count, giving it a slightly larger cap on its first request. After the first check, it enters the map and subsequent checks use the correct denominator. The global `globalSum + 1 <= limit` guard prevents over-admission, so this is a fairness quirk, not a safety bug.

2. **Adaptive throttle `request()` is read-only**: `request()` does not increment the internal request counter; only `record()` does. This matches the spec's separation of concerns, but means unshed requests (where `request()` returns `false`) are never counted. In a strict Google SRE interpretation, ALL attempted requests should be counted. Since the spec explicitly split the two methods, this is acceptable but should be noted.

3. **Sketch `merge()` uses `?? 0` on Uint32Array indices**: In `cms.ts` line 151: `this.counters[i] = (this.counters[i] ?? 0) + (other.counters[i] ?? 0)`. `Uint32Array` indexing always returns a `number`, so `?? 0` is redundant but harmless.

## Hot Path Analysis
### `increment(key, count)`
- Calls `fnv1a32(key)` and `djb2(key)` → loops over string, only primitives (`charCodeAt`, `Math.imul`, `>>>`)
- First pass: `for` loop over depth, reads `this.counters[idx]`, compares numbers
- Second pass: `for` loop over depth, reads `this.counters[idx]`, compares, adds `count`
- **Allocations found: ZERO**

### `estimate(key)`
- Calls `fnv1a32(key)` and `djb2(key)` → same as above
- Single `for` loop over depth, reads `this.counters[idx]`, compares numbers
- **Allocations found: ZERO**

## Test Results
| Metric | Value |
|--------|-------|
| Phase 7 sketch tests | 27 passed (13 + 14) |
| Phase 7 admission tests | 27 passed (7 + 7 + 13) |
| Total new tests | 54 passed |
| Full suite (excluding pre-existing broken untracked files) | 504 passed, 0 failed |
| Regressions in tracked existing tests | 0 |
| TypeScript type errors from Phase 7 files | 0 |

**Note:** Two pre-existing untracked test files (`test/core/batch.test.ts`, `test/stores/window-coupled.test.ts`) from earlier sessions fail against committed source. They are unrelated to Phase 7 and do not affect the regression count.

## Verdict
**ACCEPTED**

Both modules meet all acceptance criteria:
- Sketch CMS is allocation-free on the hot path.
- Sketch never over-admits (hard property guaranteed by CMS monotonicity).
- `adaptiveThrottle` uses injected clock exclusively in tests.
- `fairShare` global total never exceeds limit.
- `weightedMaxMin` output sums to exactly budget (or total demand if less).
- All tests use `ManualClock`.
- Zero modifications to existing files.
- strict TypeScript compiles cleanly for Phase 7 files.
