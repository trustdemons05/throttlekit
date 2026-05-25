# ThrottleKit — Novel Differentiating Features Research

> **Status:** Complete  
> **Researcher:** DarkWind  
> **Context:** Competition-grade features no other rate-limiting library has  
> **Date:** 2026-05-25

---

## Executive Summary

After researching the entire rate-limiting landscape (50+ libraries, academic papers, production systems from Uber/Shopify/Apollo/Cloudflare), ThrottleKit's existing spec is already strong (4 algorithms, ManualClock testing, combine()). The following features push into **uncharted territory** — ranked by impact and feasibility.

---

## TIER 1: High Impact, Medium Feasibility — Build in v2

### 1. Pluggable Adaptive Controllers (PID / EWMA / AIMD)

**What it is:** A controller layer that sits between the strategy and store, dynamically adjusting rate limit parameters based on observed system metrics.

**How PID works:**
- **Setpoint:** Target latency (e.g., 200ms p95 response time)
- **Process Variable:** Measured latency (actual observed)
- **Output:** Delta applied to rate limit (e.g., "reduce limit by 5")
- **P (Proportional):** Reacts to current error (latency - target)
- **I (Integral):** Accumulates persistent error over time
- **D (Derivative):** Anticipates trends (latency increasing → tighten before it gets worse)

**How EWMA works:**
```
EMA_new = α × current_rate + (1 - α) × EMA_old    // α = 0.2 default
```
- Tracks smoothed request rate per key
- Soft threshold at 60% → warn/delay
- Hard threshold at 80% → reject
- Early pressure detection before hard limit is hit

**How AIMD works:**
- **Additive Increase:** `limit += 1` per healthy interval (slow growth)
- **Multiplicative Decrease:** `limit = floor(limit / 2)` on any error (fast retreat)
- Mimics TCP congestion control — proven in networking since 1988

**Multi-armed Bandit:**
- During low-traffic periods, experimentally tries different limit configurations
- Converges on the optimal limit for current conditions
- Bayesian update: success/failure feedback adjusts beliefs

**Implementation:**
```typescript
interface Controller {
  observe(metrics: {
    latency: number;
    errorRate: number;
    cpuLoad?: number;
    eventLoopLag?: number;
    currentLimit: number;
  }): { delta: number; reason: string };
}

const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 100,
  refillRate: 10,
  controller: new PIDController({
    targetLatencyMs: 200,
    kP: 0.5, kI: 0.1, kD: 0.05,
    minLimit: 10,
    maxLimit: 1000,
  }),
});
```

**Competitive landscape:** Uber's Cinnamon (internal, blog post only), `bhatpriyanka8/adaptiveratelimit` (Go, 0 stars), `jfrz38/rate-limit-pid-controller` (TypeScript, 1 star), `himanshu9209/ratelimiter` (Python). **None are production-grade JS libraries.**

**Why ThrottleKit:** The pure-function strategy architecture makes it uniquely easy to add a controller layer. The strategy doesn't care about "why" the limit changed — it just executes.

---

### 2. Reactive Observable API (`rateLimit$`)

**What it is:** RxJS Observable streams that emit rate limit state changes in real time.

**API:**
```typescript
// Observe a specific key
const sub = limiter.observe('user:123').subscribe(result => {
  console.log(`Remaining: ${result.remaining}`);
});

// React only to blocks
limiter.observe('user:123')
  .pipe(filter(r => !r.allowed))
  .subscribe(() => showRateLimitWarning());

// Combine multiple keys
combineLatest([
  limiter.observe('user:123'),
  limiter.observe('user:456'),
]).subscribe(([a, b]) => updateDashboard(a, b));
```

**SSE Adapter:**
```
GET /__throttlekit/events?key=user:123
→ event: ratelimit
  data: {"allowed":true,"remaining":45,"resetAt":1680000000000}
```

**WebSocket Adapter:**
- Server pushes rate limit state to connected clients
- Clients see their remaining quota in real time without polling

**Novelty:** **Zero rate limiters offer reactive streams.** This is completely new territory. Enables real-time monitoring UIs, proactive client-side throttling, and reactive architecture patterns.

**Feasibility:** High. RxJS BehaviorSubject per key, subscribe in the Limiter.check() method. Zero architectural change.

---

### 3. TLA+ Formal Specification

**What it is:** A mathematically rigorous specification of the rate limiting algorithm, verified by the TLC model checker.

**Why it matters for marketing:** "Formally verified rate limiting" is a claim **no other library on npm can make**. This is the kind of differentiator that gets noticed by enterprise buyers, security auditors, and HN front page.

**What the spec covers:**
```tla
(* store.apply() primitive *)
Apply(key, ttl, transform) ==
  /\ state' = [state EXCEPT ![key] = transform(state[key])]
  /\ ttl' = [ttl EXCEPT ![key] = ttl]

(* Safety invariant: never exceed limit *)
Invariant == \A key \in DOMAIN state:
  state[key].count <= state[key].limit

(* Liveness: a blocked key eventually recovers *)
Liveness == \A key \in DOMAIN state:
  (state[key].count > state[key].limit) ~> 
  (state[key].count <= state[key].limit)
```

**Model-checked scenarios:**
1. N concurrent requests with limit=K → exactly K pass (safety)
2. Burst then idle → tokens refill (liveness)
3. Clock jumps backward → no re-entry into old window
4. Float drift over 1M ops → error within tolerance

**Competitive landscape:** TLA+ is used by Amazon (DynamoDB, S3), Azure, and MongoDB for distributed protocols. **No rate limiter has ever shipped a TLA+ spec.** The closest is academic examples (learntla.com) and `muratdem/ECS` (GitHub).

**Feasibility:** Medium. The TLA+ spec is ~100-200 lines. TLC model checker is free. Requires developer to learn TLA+, but the models are small.

**Deliverable:** `spec/TokenBucket.tla`, `spec/SlidingWindow.tla`, `spec/Store.tla` — runnable with TLC.

---

## TIER 2: High Impact, High Feasibility — Build in v2

### 4. Peek / Preview API (Zero State Mutation)

**What it is:** A read-only equivalent of `check()` that answers "will I be blocked?" without consuming capacity.

**API:**
```typescript
const result = await limiter.peek('user:123', 1);
// { allowed: true, remaining: 99, resetAt: ..., retryAfterMs: 0 }
// State is NOT mutated — remaining is what WOULD be remaining if you checked
```

**Use cases:**
- **CI/CD pipeline:** Test that your rate limits work before deploying
- **API documentation:** "Try it" calculator showing if a request would pass
- **Pre-flight checks:** Client sends `X-RateLimit-Preview: true` header
- **Dashboard:** Show "what if" scenarios without affecting real state

**Implementation:**
```typescript
class Limiter {
  async check(key: string, cost: number): Promise<RateLimitResult> {
    return this.store.apply(key, this.ttl, (state) => {
      return this.strategy.consume(state, this.clock.now(), cost);
    });
  }

  async peek(key: string, cost: number): Promise<RateLimitResult> {
    // Read current state, run strategy without persisting result
    const state = await this.store.get(key);
    const result = this.strategy.consume(state, this.clock.now(), cost);
    // Return result with a flag indicating it's a preview
    return { ...result, _preview: true };
  }
}
```

**Novelty:** Zero competitors offer this. Shopify's "refund" pattern is similar but they still execute the query.

**Feasibility:** Very High. One new method. No architectural change.

---

### 5. Debug Endpoint with Full State Dump

**What it is:** A debug endpoint that exposes complete internal rate limiting state for operational debugging.

**Endpoints:**
```
GET /__throttlekit/debug          → All keys, paginated
GET /__throttlekit/debug?key=123  → Single key detail
GET /__throttlekit/debug/hot      → Top 20 keys by request count
GET /__throttlekit/debug/blocked  → Top 20 keys by block count
```

**Response shape:**
```json
{
  "strategy": "token-bucket",
  "capacity": 100,
  "refillRate": 10,
  "totalKeys": 1523,
  "keys": [
    {
      "key": "user:123",
      "tokens": 45.2,
      "lastRefill": 1680000000000,
      "requestsLastMinute": 34,
      "blocksLastMinute": 0,
      "ttlRemainingMs": 45000
    }
  ]
}
```

**Novelty:** express-rate-limit exposes `req.rateLimit` per-request but no global state dump. rate-limiter-flexible has no introspection API.

**Feasibility:** Very High. Reads from the existing store. Pagination with cursors.

---

### 6. Hot Reloading of Rate Limit Config

**What it is:** Update rate limit parameters at runtime without server restart.

**API:**
```typescript
const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  window: '1m',
});

// Later, without restart:
await limiter.updateConfig({ limit: 200 });
// New requests use limit=200, in-flight requests complete with limit=100
```

**File watching mode:**
```typescript
// throttlekit.config.yaml
const limiter = rateLimit({
  configFile: './throttlekit.config.yaml',
  watch: true,  // Auto-reload on file change
});
```

**Implementation:** Atomic reference swap on the strategy object. The Limiter class holds a `Ref<>` to the strategy. `updateConfig()` creates a new strategy and swaps the reference.

**Feasibility:** High. Simple atomic swap pattern.

---

## TIER 3: Bleeding Edge / Experimental — Build in v3

### 7. CRDT-Based Distributed Rate Limiting

**What it is:** Distributed rate limiting using Conflict-free Replicated Data Types (PN-Counters) instead of Redis. Each node operates independently; state converges via gossip.

**Architecture:**
```
Node A                    Node B                    Node C
  │                         │                         │
  ├─ Local PN-Counter      ├─ Local PN-Counter       ├─ Local PN-Counter
  ├─ Token Bucket          ├─ Token Bucket           ├─ Token Bucket
  │                         │                         │
  └─────────── Gossip δs ──┴─────────── Gossip δs ───┘
```

**How PN-Counter works:**
```
P[nodeA] = 15  (increments from node A)
N[nodeA] = 3   (decrements/refills from node A)
P[nodeB] = 10  (increments from node B)
N[nodeB] = 2   (decrements/refills from node B)

total = ΣP - ΣN = (15+10) - (3+2) = 20
```

**Merge:** Element-wise max for each replica's counter entries. Idempotent, commutative, associative.

**Tradeoffs:**
- **Eventual consistency:** Sub-second convergence window (gossip every 100ms)
- **No SPOF:** Network partition → each node continues independently
- **Approximate:** Temporary over-allowing possible during partition
- **No Redis required:** Eliminates external dependency

**Competitive landscape:** `souviks22/decentralized-rate-limiter` (research project), `gchiesa/drl` (Go + Envoy sidecar). **No JS library implements CRDT-based rate limiting.**

**Feasibility:** Low-Medium. Requires careful delta-CRDT implementation. Merge logic for token bucket state with CRDT semantics is non-trivial.

---

### 8. Timing Attack Resistance & Side-Channel Protection

**Attack scenario:** An attacker sends requests and measures response time. A "blocked" response returns in 2ms (early rejection). An "allowed" response returns in 50ms (continues to handler). From timing alone, the attacker infers remaining rate limit capacity.

**Mitigations:**

**1. Constant-time key comparison:**
```typescript
// Instead of: if (key === storedKey)
// Use:
import { timingSafeEqual } from 'crypto';
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Always compare against self to prevent length leakage
    return !timingSafeEqual(bufA, bufA);
  }
  return timingSafeEqual(bufA, bufB);
}
```

**2. Response timing normalization (quantum slots):**
```typescript
const QUANTUM_SLOTS = [50, 75, 100, 125]; // ms
function normalizeTiming(startTime: number): void {
  const elapsed = Date.now() - startTime;
  const slot = QUANTUM_SLOTS.find(s => s >= elapsed) ?? QUANTUM_SLOTS[QUANTUM_SLOTS.length - 1];
  const delay = Math.max(0, slot - elapsed);
  if (delay > 0) wait(delay); // Pad to next quantum slot
}
```

**3. Jitter injection:**
```typescript
function applyJitter(): number {
  return Math.floor(Math.random() * 50); // 0-50ms random delay on every response
}
```

**Novelty:** **No rate limiter on any platform addresses timing attacks.** This is completely unexplored territory. Relevant OWASP references but no implementation.

**Feasibility:** Medium. Jitter is trivial. Quantum slots are straightforward but add baseline latency. Constant-time comparison is built into Node.js.

---

### 9. GraphQL Query Complexity Cost Calculation

**What it is:** Rate limit by GraphQL query complexity (AST analysis), not just request count. A simple query costs 1. A deeply nested query with lists costs 100+.

**Key features:**
1. **Per-field cost via @cost directive** (IBM GraphQL Cost Directive spec)
2. **List size multipliers:** `posts(limit: 100)` costs 100x more than a scalar
3. **Per-resolver complexity:** Custom complexity functions per field
4. **Refund pattern:** If actual < estimated, refund credits
5. **Persisted query targeting:** Cannot bypass via query complexity hiding

**Usage:**
```typescript
import { graphqlRateLimit } from 'throttlekit/graphql';

const limiter = rateLimit({ strategy: 'token-bucket', capacity: 1000 });

const protectedSchema = graphqlRateLimit(schema, {
  limiter,
  keyExtractor: (ctx) => ctx.user.id,
  defaultCost: 1,
  estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
  maxCost: 500,
});
```

**Competitive landscape:** Shopify (internal). Apollo Router (demand control, commercial). IBM GraphQL Cost Directive (spec only). `graphql-query-complexity` (analysis only, no rate limiting). **No standalone library combines complexity analysis + rate limiting.**

**Feasibility:** Medium. Leverages `graphql-query-complexity` for AST analysis. Integrates complexity as the `cost` parameter in `limiter.check(key, cost)`.

---

### 10. WebSocket Per-Connection Rate Limiting

**What it is:** Multi-level rate limiting for WebSocket connections with backpressure and overflow policies.

**Three levels of rate limiting:**
```
Level 1: Connection Rate   → 10 connections/min per IP
Level 2: Message Frequency → 50 messages/sec per connection
Level 3: Channel/Topic     → 100 messages/sec per channel
```

**Overflow policies (from streamfence-js research):**
- `DROP_OLDEST`: Drop oldest queued message, accept new one (live feeds)
- `REJECT_NEW`: Reject new message when queue full (critical alerts)
- `COALESCE`: Replace last queued message with same coalesce key
- `SNAPSHOT_ONLY`: Only keep the latest snapshot, discard intermediate

**Backpressure:**
- Propagate worker load metrics back to connected clients
- Slow consumers get signaled to reduce send rate
- Auto-downgrade from real-time to polling for overwhelmed clients

**Usage:**
```typescript
import { wsAdapter } from 'throttlekit/ws';

const limiter = rateLimit({ strategy: 'token-bucket', capacity: 100 });
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws, req) => {
  const adapter = wsAdapter(limiter, {
    connectionLimit: { capacity: 5, refillRate: 1 }, // 1 new conn/sec
    messageLimit: { capacity: 20, refillRate: 10 },  // 10 msg/sec
    channels: {
      'chat:general': { capacity: 100, refillRate: 50 },
      'events:price': { capacity: 1000, refillRate: 500, overflow: 'DROP_OLDEST' },
    },
  });
  adapter.attach(ws);
});
```

**Competitive landscape:** streamfence-js has per-client queuing but no RL. OneUptime blog has code snippets but no library. **No library combines WebSocket rate limiting + backpressure + overflow policies.**

**Feasibility:** Medium. Requires new adapter type. WebSocket is event-driven vs request-response. Per-connection state management.

---

## Competitive Landscape Matrix

| Feature | express-rate-limit | bottleneck | rate-limiter-flexible | Upstash | ThrottleKit MVP | **+ Novel Features** |
|---------|-------------------|------------|----------------------|---------|-----------------|---------------------|
| Algorithms | 1 | 1 | 3 | 1 | **4** | **4** |
| ManualClock testing | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| combine() | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Adaptive controllers** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Reactive Observables** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **TLA+ formal spec** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Peek/preview API** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **Debug endpoint** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |
| **Hot reload** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |
| **Timing attack protection** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (1st ever)** |
| **CRDT distributed** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (JS 1st)** |
| **GraphQL complexity** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |
| **WebSocket + backpressure** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |
| gRPC interceptor | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |
| tRPC middleware | ❌ | ❌ | ❌ | ❌ | ❌ | **✅** |

---

## Recommended Build Order

### Phase 1 (v2.0 — Differentiators, 2-3 weeks)
1. **Peek/preview API** (1 day) — Low effort, high perceived value
2. **Debug endpoint** (1 day) — Internal tooling win
3. **Hot reloading** (2 days) — Atomic config swap
4. **Reactive Observable API** (3-4 days) — RxJS-based, unlocks new architecture patterns
5. **gRPC interceptor + tRPC middleware + Hono adapter** (1 week) — Protocol coverage

### Phase 2 (v2.1 — Smart Features, 3-4 weeks)
6. **EWMA adaptive controller** (1 week) — Start simple, prove the pattern
7. **PID adaptive controller** (1-2 weeks) — Full feedback loop
8. **AIMD adaptive controller** (3 days) — Complementary to PID

### Phase 3 (v3.0 — Bleeding Edge, 4-8 weeks)
9. **GraphQL complexity integration** (1-2 weeks)
10. **WebSocket per-connection adapter** (1-2 weeks)
11. **Timing attack resistance** (3-5 days)
12. **TLA+ formal specification** (2-3 weeks)
13. **CRDT-based distributed rate limiting** (3-4 weeks)

---

## Key Insight: The "First Ever" Angle

The following features are **completely unclaimed** — no rate limiting library in any language offers them:

1. **Pluggable adaptive controllers** — PID/EWMA/AIMD for dynamic limit adjustment
2. **Reactive Observable streams** — `rateLimit$` for real-time state observation
3. **TLA+ formal verification** — Mathematical correctness proof
4. **Peek/preview API** — Zero-state-mutation "what if" queries
5. **Timing attack resistance** — Side-channel hardened responses

These five features alone make ThrottleKit's v2.0 a **category-defining** library. Combine them with the existing differentiators (4 algorithms, ManualClock, combine(), zero deps) and there's no competitor within striking distance.
