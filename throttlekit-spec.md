# ThrottleKit — Complete Rate-Limiting Algorithm Specification

## Shared Primitives

```typescript
// ============================================================
// Injectable Clock for deterministic testing
// ============================================================
interface Clock {
  /** Returns epoch milliseconds (monotonic preferred) */
  now(): number;
}

class ManualClock implements Clock {
  private _now: number;
  constructor(initial: number = 0) { this._now = initial; }
  now(): number { return this._now; }
  advance(ms: number): void { this._now += ms; }
  set(time: number): void { this._now = time; }
}

class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

// ============================================================
// Shared result type
// ============================================================
interface RateLimitResult {
  allowed: boolean;
  remaining: number;     // floor of remaining tokens/requests
  resetAt: number;       // epoch ms when capacity fully resets (fixed window)
  retryAfter: number;    // ms client should wait before retrying (0 if allowed)
}
```

---

## 1. Token Bucket Algorithm

### Mathematical Specification

Let bucket be parameterized by **(capacity: number, refillRate: number)** where:

- `capacity ∈ ℕ⁺` = max tokens the bucket can hold (maximum burst size)
- `refillRate ∈ ℝ⁺` = tokens added per second (continuous rate)

The bucket state at time `t`:

```
tokens(t) = min(capacity, tokens(t₀) + refillRate × (t - t₀))
```

Where `t₀` = last refill timestamp. Tokens are computed **lazily** on each consume attempt (no background timer).

### Consume Operation

```
tryConsume(t, cost):
  1. elapsed = (t - lastRefill) / 1000    // seconds
  2. tokens = min(capacity, tokens + elapsed * refillRate)
  3. lastRefill = t
  4. if tokens >= cost:
       tokens = tokens - cost
       allowed = true
       remaining = floor(tokens)
     else:
       deficit = cost - tokens
       retryAfter = ceil(deficit / refillRate * 1000)   // ms
       allowed = false
       remaining = 0
  5. return { allowed, tokens, remaining, retryAfter }
```

### Pure Reference Implementation

```typescript
interface TokenBucketState {
  tokens: number;       // current token count (float, can be fractional)
  lastRefill: number;   // epoch ms of last refill
}

function tokenBucketConsume(
  state: TokenBucketState | null,
  now: number,
  cost: number,
  capacity: number,
  refillRate: number,
): { allowed: boolean; state: TokenBucketState; remaining: number; retryAfter: number } {
  // --- Guard: rate=0 means tokens NEVER refill ---
  if (refillRate <= 0) {
    const hasTokens = state !== null && state.tokens >= cost;
    if (hasTokens) {
      const newTokens = state.tokens - cost;
      return {
        allowed: true,
        state: { tokens: newTokens, lastRefill: now },
        remaining: Math.max(0, Math.floor(newTokens)),
        retryAfter: 0,
      };
    }
    // rate=0 and no tokens: never recover
    return {
      allowed: false,
      state: state ?? { tokens: 0, lastRefill: now },
      remaining: 0,
      retryAfter: Infinity,
    };
  }

  // --- Lazy refill ---
  const elapsed = (now - (state?.lastRefill ?? now)) / 1000;
  const currentTokens = state
    ? Math.min(capacity, state.tokens + elapsed * refillRate)
    : capacity; // fresh bucket starts full
  const lastRefill = state?.lastRefill ?? now;

  // --- Guard: overflow from floating point ---
  const safeTokens = Math.min(capacity, Math.max(0, currentTokens));

  if (safeTokens >= cost) {
    const newTokens = safeTokens - cost;
    return {
      allowed: true,
      state: { tokens: newTokens, lastRefill: now },
      remaining: Math.floor(newTokens),
      retryAfter: 0,
    };
  }

  // --- Rejected: compute retryAfter ---
  const deficit = cost - safeTokens;
  const retryAfterMs = Math.ceil((deficit / refillRate) * 1000);
  return {
    allowed: false,
    state: { tokens: safeTokens, lastRefill: now },
    remaining: 0,
    retryAfter: retryAfterMs,
  };
}
```

### Edge Cases & Test Matrix

| # | Scenario | Input | Expected Behavior |
|---|----------|-------|-------------------|
| 1 | **rate=0, no tokens** | capacity=10, rate=0, tokens=0, cost=1 | reject, retryAfter=Infinity |
| 2 | **rate=0, has tokens** | capacity=10, rate=0, tokens=5, cost=1 | allow, remaining=4, tokens never refill |
| 3 | **Burst at capacity** | capacity=10, rate=1, idle for 20s | tokens = min(10, 0+20*1) = 10 |
| 4 | **Same-timestamp N requests** | 10 requests at now=1000, tokens=10 | all allowed (if atomic), remaining 0 after 10th |
| 5 | **Overflow guard** | capacity=10, rate=1, idle for 100s | tokens = min(10, 0+100*1) = 10 (not 100!) |
| 6 | **Fractional tokens** | capacity=5, rate=0.5, idle 3s, cost=1 | tokens=1.5, allow, remaining=0 |
| 7 | **Large cost near empty** | tokens=0.5, rate=1, cost=10, idle 9.5s | tokens=10, allow, remaining=0 |
| 8 | **Exact replenishment timing** | rate=1, tokens=0, cost=1, idle 999ms | tokens=0.999, reject, retryAfter≈1ms |
| 9 | **Fresh bucket** | state=null, cost=1 | starts at capacity, allow |
| 10 | **Float drift over 1M ops** | repeated consume/check cycles | error < 0.0001% (acceptable), use double |

### Concurrency Correctness Proof

**Claim:** For N concurrent requests at the same timestamp with `tokens = N × cost` and atomic consume, exactly N succeed and the (N+1)th is blocked.

**Proof by serialization:**
1. Under atomic mutex/Lua, each consume is serialized.
2. Each consume before refill reads `lastRefill = T`.
3. First consumer: elapsed=0, tokens=N×cost, cost=1, remaining=N×cost-1.
4. k-th consumer: tokens=N×cost-(k-1)
5. N-th consumer: tokens=cost, allowed, remaining=0.
6. (N+1)-th consumer: tokens=0 < cost → rejected.

**Without atomicity:** All N consumers read `tokens=N×cost`, all compute `tokens >= cost`, all subtract cost locally, all write back `tokens = N×cost - cost` → only 1 token consumed but N requests allowed. **CRITICAL BUG.**

### Known Gotchas

1. **Wall clock vs monotonic clock:** Using `Date.now()` can jump forward/backward (NTP sync, leap seconds). Use `performance.now()` or `process.hrtime.bigint()` for elapsed computation.
2. **Background timer refill:** Some implementations use `setInterval` to add tokens. This causes timer drift, CPU wake-ups, and imprecise rates. **Always use lazy refill.**
3. **Floating-point accumulation:** After millions of operations, `tokens += elapsed * rate` accumulates error. Reset `tokens` and `lastRefill` when idle periods are long enough to refill to capacity.
4. **Redis HGETALL:** On cache miss (key doesn't exist), Redis returns empty array. Script defaults to `tokens = capacity, lastRefill = now`.
5. **TTL for idle cleanup:** Set `EXPIRE` to `maxTokens / refillRate + 1` seconds so idle keys auto-delete.
6. **Go's `rate.Limiter` reference:** Uses `float64` tokens with `advance()` called at consume time. Exact same lazy pattern.

---

## 2. Fixed Window Algorithm

### Mathematical Specification

Let window be parameterized by **(windowSizeMs: number, maxRequests: number)**.

```
windowIndex(now) = floor(now / windowSizeMs)
windowStart(now) = windowIndex × windowSizeMs
nextReset(now)   = (windowIndex + 1) × windowSizeMs
```

State: `{ windowStart: number, count: number }`

On each request:
```
if no state OR state.windowStart != windowStart(now):
    // New window
    state = { windowStart: windowStart(now), count: 1 }
    allowed = true
else if state.count < maxRequests:
    state = { ...state, count: state.count + 1 }
    allowed = true
else:
    allowed = false
```

### Pure Reference Implementation

```typescript
interface FixedWindowState {
  windowStart: number;  // epoch ms when this window started
  count: number;        // requests in current window
}

function fixedWindowConsume(
  state: FixedWindowState | null,
  now: number,
  windowSizeMs: number,
  max: number,
): { allowed: boolean; state: FixedWindowState; remaining: number; resetAt: number; retryAfter: number } {
  const windowStart = Math.floor(now / windowSizeMs) * windowSizeMs;
  const resetAt = windowStart + windowSizeMs;

  // --- Window rollover ---
  if (state === null || state.windowStart !== windowStart) {
    return {
      allowed: true,
      state: { windowStart, count: 1 },
      remaining: max - 1,
      resetAt,
      retryAfter: 0,
    };
  }

  // --- Within same window ---
  if (state.count < max) {
    return {
      allowed: true,
      state: { windowStart, count: state.count + 1 },
      remaining: max - state.count - 1,
      resetAt,
      retryAfter: 0,
    };
  }

  // --- Limit reached ---
  return {
    allowed: false,
    state,
    remaining: 0,
    resetAt,
    retryAfter: Math.max(0, resetAt - now),
  };
}
```

### Edge Cases & Test Matrix

| # | Scenario | Input | Expected Behavior |
|---|----------|-------|-------------------|
| 1 | **First request** | state=null, now=0 | allowed, count=1, resetAt=windowSize |
| 2 | **Exact boundary transition** | state.windowStart=0, now=1000, windowSize=1000 | allowed (new window starts at 1000), count=1 |
| 3 | **Boundary 1ms before/after** | state.windowStart=0, now=999 → allow (count++), now=1000 → new window | 2×max in 2ms (KNOWN BUG) |
| 4 | **Multiple windows skipped** | last request at t=0, now=t+10*windowSize | fresh start: count=1 |
| 5 | **Millisecond precision** | now=999.9ms vs 1000.0ms | floor(999.9/1000)=0, floor(1000.0/1000)=1 correct |
| 6 | **Clock skew backward** | monotonic vs wall clock | monotonic preferred; wall clock could re-enter old window |
| 7 | **ResetAt computation** | now=1500, windowSize=1000 | windowStart=1000, resetAt=2000 |
| 8 | **Exhaust then retry** | count=max, retryAfter=resetAt-now | exact ms until next window |

### Concurrency Correctness

**Atomicity requirement:** The read-check-write cycle must be atomic.

**Redis Lua pattern (industry standard):**
```lua
-- KEYS[1] = rate limit key
-- ARGV[1] = window size (seconds)
-- ARGV[2] = max requests
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if count <= tonumber(ARGV[2]) then
    return {1, count, ttl}
else
    return {0, count, ttl}
end
```

Without atomicity: Two concurrent requests read `count=9`, both see `count < max=10`, both write `INCR` → count becomes 11 but both allowed.

### Known Gotchas

1. **2x boundary burst is fundamental:** This is not a bug — it's a property of the algorithm. If you need to avoid it, use sliding variants.
2. **Per-client window start (Flexible Fixed Window):** `rate-limiter-flexible` starts the window for each client on their first request (not epoch-aligned), reducing boundary spike probability for staggered clients.
3. **Race between INCR and EXPIRE:** If the process crashes after INCR but before EXPIRE, the key lives forever. Always wrap in Lua.
4. **Integer overflow:** `count` stays within Redis's signed 64-bit integer (9×10¹⁸). Fine for rate limiting.
5. **`resetAt` must be exact:** Use `(windowIndex + 1) * windowSize`, not `windowStart + windowSize` (same result but clearer intent).

---

## 3. Sliding Window Log (Exact)

### Mathematical Specification

Let window be parameterized by **(windowSizeMs: number, maxRequests: number)**.

Maintain sorted log `L` of request timestamps. On request at time `t`:

```
windowStart = t - windowSizeMs
L' = { ts ∈ L | ts ≥ windowStart }          // prune expired
if |L'| < maxRequests:
    L'' = insertSorted(L', t)
    allowed = true
else:
    oldest = min(L')
    retryAfter = oldest + windowSizeMs - t
    allowed = false
```

### Pure Reference Implementation

```typescript
type SlidingLogState = number[]; // sorted ascending timestamps (ms)

function slidingLogConsume(
  state: SlidingLogState | null,
  now: number,
  windowSizeMs: number,
  max: number,
): { allowed: boolean; state: SlidingLogState; remaining: number; retryAfter: number } {
  const windowStart = now - windowSizeMs;
  const log = state ?? [];

  // --- Prune expired entries ---
  // Find first index >= windowStart using binary search (O(log n))
  const firstValid = binarySearchFirstGE(log, windowStart);
  const pruned = log.slice(firstValid);

  if (pruned.length < max) {
    // Insert new timestamp in sorted position (binary search insertion)
    const insertIdx = binarySearchFirstGE(pruned, now);
    const newLog = [...pruned.slice(0, insertIdx), now, ...pruned.slice(insertIdx)];
    return {
      allowed: true,
      state: newLog,
      remaining: max - pruned.length - 1,
      retryAfter: 0,
    };
  }

  // --- Rejected ---
  const oldest = pruned[0];
  const retryAfterMs = Math.max(0, oldest + windowSizeMs - now);
  return {
    allowed: false,
    state: pruned,
    remaining: 0,
    retryAfter: retryAfterMs,
  };
}

function binarySearchFirstGE(arr: number[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
```

### Edge Cases & Test Matrix

| # | Scenario | Input | Expected Behavior |
|---|----------|-------|-------------------|
| 1 | **First request** | state=[], max=10 | allow, state=[now] |
| 2 | **Prune all expired** | state=[1000,2000], now=5000, windowSize=2000 | windowStart=3000, both pruned, allow |
| 3 | **Prune partial** | state=[1000,3000,3500], now=4000, windowSize=3000 | windowStart=1000, prune 1000, keep [3000,3500] |
| 4 | **Exact limit** | state=[ts₁, ..., ts₁₀], max=10, now=windowStart+1 | pruned.length=10 >= 10 → reject |
| 5 | **Same-ms collisions** | 10 requests at now=1000 | need unique members (10 entries, all allowed) |
| 6 | **100k entries memory** | state has 100k timestamps | O(n) memory, O(log n) search, O(n) slice (costly) |
| 7 | **retryAfter edge** | oldest=1000, windowSize=2000, now=1500 | retryAfter = 1000+2000-1500 = 1500ms |
| 8 | **Empty window after prune** | all expired, pruned=[] | allow (pruned.length=0 < max) |
| 9 | **RetryAfter clamp** | oldest + windowSize < now (clock drift) | retryAfter clamped to 0 |
| 10 | **Monotonic insertion** | insert at end (most common), insert at front (rare), insert in middle | binary search insertion O(log n) |

### Concurrency Correctness Proof

**Claim:** The prune-count-add sequence must be atomic. Without atomicity, concurrent requests can exceed the limit.

**Counterexample:**
- max=10, state has 9 entries in window.
- Request A and B arrive concurrently at same `now`.
- A: prune (still 9), count(9) < 10, add → state has 10.
- B: prune (still 9, A's add not visible yet), count(9) < 10, add → state has 10.
- Result: 11 entries, both allowed. **Violation of max=10.**

**Fix:**
- In Redis: Single Lua script: `ZREMRANGEBYSCORE key -inf windowStart` → `ZCARD` → if < max: `ZADD` + `EXPIRE`.
- In single process: Mutex around the prune-count-add sequence.

### Known Gotchas

1. **Redis sorted set unique members:** Sorted sets require unique members. Two requests at the same millisecond with the same value = second is ignored. Always use `${timestamp}:${counter}` or `${timestamp}:${random()}`.
2. **Memory at scale:** For 10k requests/hour = 10k entries per client. For 1M clients = 10B entries = infeasible.
3. **ZREMRANGEBYSCORE complexity:** O(log(N) + M) where M = removed items. Burst pruning can be expensive.
4. **EXPIRE on sorted set:** Must set EXPIRE in the Lua script when ZADD is called. Without EXPIRE, entries grow unbounded.
5. **Binary search vs. filter:** Using `arr.filter(ts >= ws)` is O(n) per request. Using binary search + splice is O(log n + k). For large logs, this matters.

---

## 4. Sliding Window Counter (Weighted Approximation)

### Mathematical Specification

Parameterized by **(windowSizeMs: number, maxRequests: number)**.

Maintain TWO counters:
- `prevCount` = requests in the previous fixed window
- `currCount` = requests in the current fixed window

```
windowIndex(now) = floor(now / windowSizeMs)
windowStart(now)  = windowIndex × windowSizeMs
elapsedRatio      = (now - windowStart) / windowSizeMs    // 0.0 to 1.0
weight            = 1 - elapsedRatio                      // overlap proportion

estimated = prevCount × weight + currCount
```

**Decision:** Allow if `estimated < maxRequests`.

**Window transition:** When `windowIndex` changes:
- `prevCount` = old `currCount`
- `currCount` = 0

### Pure Reference Implementation

```typescript
interface WindowCounterState {
  prevCount: number;
  currCount: number;
  currentWindowStart: number; // epoch ms
}

function slidingWindowCounterConsume(
  state: WindowCounterState | null,
  now: number,
  windowSizeMs: number,
  max: number,
): { allowed: boolean; state: WindowCounterState; estimated: number; remaining: number; retryAfter: number } {
  const windowStart = Math.floor(now / windowSizeMs) * windowSizeMs;
  const elapsed = (now - windowStart) / windowSizeMs; // 0.0 to 1.0
  const weight = Math.max(0, Math.min(1, 1 - elapsed)); // guard fp errors

  // --- Handle window transition ---
  if (state === null || state.currentWindowStart !== windowStart) {
    const windowsPassed = Math.floor((now - (state?.currentWindowStart ?? now)) / windowSizeMs);
    let newPrev: number;
    let newCurr: number;

    if (state === null) {
      // Cold start: no history, assume zero
      newPrev = 0;
      newCurr = 0;
    } else if (windowsPassed >= 2) {
      // Multiple windows passed: both counters are stale
      newPrev = 0;
      newCurr = 0;
    } else {
      // Exactly one window boundary crossed
      newPrev = state.currCount;
      newCurr = 0;
    }

    const newState: WindowCounterState = {
      prevCount: newPrev,
      currCount: newCurr,
      currentWindowStart: windowStart,
    };

    // Evaluate with new state
    const estimated = newState.prevCount * weight + newState.currCount;
    if (estimated < max) {
      newState.currCount += 1;
      return {
        allowed: true,
        state: newState,
        estimated,
        remaining: Math.max(0, Math.floor(max - estimated - 1)),
        retryAfter: 0,
      };
    }
    return {
      allowed: false,
      state: newState,
      estimated,
      remaining: 0,
      retryAfter: Math.ceil((estimated - max + 1) / max * windowSizeMs),
    };
  }

  // --- Same window ---
  const estimated = state.prevCount * weight + state.currCount;
  if (estimated < max) {
    const newState: WindowCounterState = { ...state, currCount: state.currCount + 1 };
    return {
      allowed: true,
      state: newState,
      estimated,
      remaining: Math.max(0, Math.floor(max - estimated - 1)),
      retryAfter: 0,
    };
  }

  return {
    allowed: false,
    state,
    estimated,
    remaining: 0,
    retryAfter: Math.ceil((estimated - max + 1) / max * windowSizeMs),
  };
}
```

### Accuracy Analysis (from Cloudflare's production data on 400M requests)

| Metric | Value |
|--------|-------|
| Requests analyzed | 400 million |
| Distinct sources | 270,000 |
| Wrongly allowed/blocked | 0.003% |
| Average estimation error | 6% |
| False positives (blocked below limit) | 0 |
| False negatives (allowed above limit) | 3 sources, <15% over threshold |

### Edge Cases & Test Matrix

| # | Scenario | Input | Expected Behavior |
|---|----------|-------|-------------------|
| 1 | **Cold start** | state=null, now=500, windowSize=1000 | prev=0, curr=0, elapsed=0.5, estimated=0 < max → allow |
| 2 | **Window rollover (exact)** | state.currentWindowStart=0, now=1000 | prev=state.currCount, curr=0 |
| 3 | **Multi-window rollover** | last seen at t=0, now=t+3*windowSize | prev=0, curr=0 (both stale) |
| 4 | **Elapsed = 0** | now == windowStart | weight=1, estimated=prev+curr |
| 5 | **Elapsed = 1 (boundary)** | now = windowStart + windowSize - ε | weight→0+, estimated≈curr |
| 6 | **Exact boundary + small max** | max=1, prev=1, curr=0, elapsed=0.99 | weight=0.01, estimated=0.01 < 1 → allow |
| 7 | **Large counters** | prev=1e9, curr=1e9, elapsed=0.5 | estimated=1e9*0.5+1e9=1.5e9 (fits in float64, risky in float32) |
| 8 | **Burst at boundary (mitigated)** | prev=max, curr=1, elapsed=0.9 | weight=0.1, estimated=0.1*max+1 ≈ 0.1*max+1 < max (safe) |
| 9 | **Tight threshold** | max=10, prev=8, curr=8, elapsed=0.75 | weight=0.25, estimated=8*0.25+8=10, 10 >= 10 → reject |
| 10 | **Cold start + significant elapsed** | state=null, now=950, windowSize=1000 | elapsed=0.95, prev=0, curr=0, estimated=0 → allow but undercounts real traffic in first window |

### Concurrency Correctness

Same TOCTOU pattern as others. The read-estimate-increment cycle must be atomic.

**Redis Lua pattern:**
```lua
-- KEYS[1] = {base}:curr (hash tag ensures same cluster slot)
-- KEYS[2] = {base}:prev
-- ARGV[1] = windowIndex (integer)
-- ARGV[2] = elapsed (float, 0..1)
-- ARGV[3] = maxRequests

local curr = redis.call('GET', KEYS[1]) or 0
local prev = redis.call('GET', KEYS[2]) or 0
local estimated = prev * (1 - tonumber(ARGV[2])) + curr
if estimated < tonumber(ARGV[3]) then
    redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], ARGV[4]) -- TTL = 2 * windowSize
    redis.call('EXPIRE', KEYS[2], ARGV[4])
    return {1, estimated, curr + 1}
else
    return {0, estimated, curr}
end
```

### Known Gotchas

1. **Redis Cluster hash tags:** Use `{base}:windowNum` to ensure both keys map to the same cluster slot. Only the `{...}` part determines slot.
2. **TTL = 2 × windowSize:** The previous window's key must survive into the next window for the weighted calculation.
3. **Multi-window rollover:** If a client is inactive for 2+ windows, both prev and curr counters are stale. Reset both to 0.
4. **Float precision with large counters:** For limits > 10M, use 64-bit floats or switch to integer arithmetic (store as micro-requests).
5. **Cloudflare's memcached approach:** They use memcached `INCR` (not `GET`) for zero-round-trip reads on hot paths, computing formula client-side.
6. **Conservative vs. aggressive weighting:** Some implementations use `floor(estimated) < max` (conservative), others use `estimated < max` (aggressive). Conservative slightly under-allows, aggressive slightly over-allows.
7. **The formula is not symmetric:** The approximation assumes uniform request distribution in the previous window. If traffic is highly bursty at boundaries, estimate error increases.

---

## Algorithm Comparison Summary

| Property | Token Bucket | Fixed Window | Sliding Log | Sliding Counter |
|----------|-------------|--------------|-------------|-----------------|
| **Accuracy** | Exact | Low (2x burst) | Exact | Near-exact (~98%) |
| **Memory per client** | O(1) | O(1) | O(n) | O(1) |
| **Burst behavior** | Controlled bursts | 2x at boundaries | No bursts | Smoothed |
| **retryAfter precision** | Exact | Exact (window level) | Exact | Approximate |
| **Distributed-safe** | Redis+Hash | Redis+String | Redis+SortedSet | Redis+HashTag |
| **Complexity** | Medium | Low | High | Medium |
| **Best for** | Bursty traffic | Simple internal | Audit/security | General API RL |

**Recommendation:** Sliding Window Counter is the best default for most APIs. Token Bucket for bursty traffic. Sliding Window Log for perfect accuracy. Fixed Window for internal tools where simplicity matters.
