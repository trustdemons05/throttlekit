/**
 * Full stack integration tests for ThrottleKit.
 *
 * Covers the complete pipeline from Limiter through Store, including:
 *   - Limiter + MemoryStore: check, peek, reset
 *   - combine() with real Limiters
 *   - Express adapter with real Limiter
 *   - Fetch adapter with real Limiter
 */

import { describe, it, expect, vi } from 'vitest';
import { rateLimit, LimiterImpl } from '../src/core/limiter.js';
import { combine } from '../src/core/combine.js';
import { expressAdapter } from '../src/adapters/express.js';
import { fetchAdapter } from '../src/adapters/fetch.js';
import { ManualClock } from '../src/core/clock.js';
import { MemoryStore } from '../src/stores/memory-store.js';

// ---------------------------------------------------------------------------
// Limiter + MemoryStore full integration
// ---------------------------------------------------------------------------

describe('Limiter + MemoryStore integration', () => {
  it('check → allow then block within window', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 3,
      windowMs: 1000,
      clock,
      store,
    });

    // First 3: allowed
    expect((await limiter.check('key')).allowed).toBe(true);
    expect((await limiter.check('key')).allowed).toBe(true);
    expect((await limiter.check('key')).allowed).toBe(true);

    // 4th: blocked
    const blocked = await limiter.check('key');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);

    // After window reset, should allow again
    clock.advanceBy(1001);
    const afterReset = await limiter.check('key');
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(2);
  });

  it('peek returns current state without consuming', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    }) as LimiterImpl;

    // Make one request
    await limiter.check('peek-key');
    const remainingAfterCheck = (await limiter.peek('peek-key')).remaining;

    // Peek again — should be identical (non-mutating)
    const peekAgain = await limiter.peek('peek-key');
    expect(peekAgain.remaining).toBe(remainingAfterCheck);

    // Make another request — remaining should decrease by 1
    await limiter.check('peek-key');
    const afterSecondCheck = await limiter.peek('peek-key');
    expect(afterSecondCheck.remaining).toBe(remainingAfterCheck - 1);
  });

  it('reset clears rate-limit state', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 1,
      windowMs: 1000,
      clock,
      store,
    }) as LimiterImpl;

    // Use the only permit
    await limiter.check('reset-key');
    expect((await limiter.check('reset-key')).allowed).toBe(false);

    // Reset
    await limiter.reset('reset-key');

    // Should be allowed again
    const afterReset = await limiter.check('reset-key');
    expect(afterReset.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// combine() with real Limiters
// ---------------------------------------------------------------------------

describe('combine() integration', () => {
  it('10/sec + 1000/hour combined limits', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const storeA = new MemoryStore({ clock });
    const storeB = new MemoryStore({ clock });

    const perSecond = rateLimit({
      strategy: 'fixed-window',
      limit: 10,
      windowMs: 1000,
      clock,
      store: storeA,
    });

    const perHour = rateLimit({
      strategy: 'fixed-window',
      limit: 1000,
      windowMs: 3_600_000,
      clock,
      store: storeB,
    });

    const combined = combine(perSecond, perHour);

    // First request: both pass → composite includes both limits
    const r1 = await combined.check('user');
    expect(r1.allowed).toBe(true);
    // remaining = min(9, 999) = 9
    expect(r1.remaining).toBe(9);

    // Exhaust the per-second limiter (10 total calls)
    for (let i = 0; i < 9; i++) {
      await combined.check('user');
    }

    // 11th request should be blocked by the per-second limiter
    const blocked = await combined.check('user');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // After one second, the per-second window resets
    clock.advanceBy(1001);
    const afterReset = await combined.check('user');
    expect(afterReset.allowed).toBe(true);
    // per-second: remaining = 9, per-hour: remaining = 999 - 10 = 989
    // Actually per-hour: we used 11 requests (10 before + 1 now after reset)
    // 1000 - 11 = 989. So min(9, 989) = 9
    expect(afterReset.remaining).toBe(9);
  });

  it('blocks when any limiter blocks (token-bucket + fixed-window)', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const storeA = new MemoryStore({ clock });
    const storeB = new MemoryStore({ clock });

    const tokenBucket = rateLimit({
      strategy: 'token-bucket',
      capacity: 3,
      refillRate: 1, // 1 token/sec
      clock,
      store: storeA,
    });

    const fixedWindow = rateLimit({
      strategy: 'fixed-window',
      limit: 10,
      windowMs: 1000,
      clock,
      store: storeB,
    });

    const combined = combine(tokenBucket, fixedWindow);

    // Exhaust token bucket (3 tokens)
    expect((await combined.check('multi-key')).allowed).toBe(true);
    expect((await combined.check('multi-key')).allowed).toBe(true);
    expect((await combined.check('multi-key')).allowed).toBe(true);

    // Both limiters would block, but token-bucket blocks first (short-circuit)
    const blocked = await combined.check('multi-key');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Express adapter with real Limiter
// ---------------------------------------------------------------------------

describe('Express adapter integration', () => {
  function createMockReqRes() {
    const req = { ip: '10.0.0.1', headers: {} } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as any;
    const next = vi.fn();
    return { req, res, next };
  }

  it('allows requests within limit, blocks beyond', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 2,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = expressAdapter(limiter);

    const { req, res, next } = createMockReqRes();

    // First request — allowed
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Second request — allowed
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // Third request — blocked
    vi.clearAllMocks();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
    // next should NOT have been called again
    expect(next).not.toHaveBeenCalled();
  });

  it('sets standard rate-limit headers on every response', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    await middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '5');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '4');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Fetch adapter with real Limiter
// ---------------------------------------------------------------------------

describe('Fetch adapter integration', () => {
  it('returns 429 when rate limited and passes through on success', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 1,
      windowMs: 1000,
      clock,
      store,
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });

    // First request — passes through to fetch
    const res1 = await adaptedFetch(request);
    expect(res1.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second request — rate limited
    const res2 = await adaptedFetch(request);
    expect(res2.status).toBe(429);
    const body = await res2.json();
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
    // fetch should NOT have been called again
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('injects RateLimit headers into upstream response', async () => {
    const clock = new ManualClock(1_000_000_000_000);
    const store = new MemoryStore({ clock });
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 10,
      windowMs: 1000,
      clock,
      store,
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"data":"ok"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api');

    const response = await adaptedFetch(request);

    expect(response.headers.get('RateLimit-Limit')).toBe('10');
    expect(response.headers.get('RateLimit-Remaining')).toBe('9');
    expect(response.headers.get('RateLimit-Reset')).toBeTruthy();
    // Original body should be preserved
    expect(await response.json()).toEqual({ data: 'ok' });
  });

  it('supports fail-open and fail-closed strategies', async () => {
    const throwingStore: any = {
      apply: () => Promise.reject(new Error('Store failure')),
    };

    const clock = new ManualClock(1_000_000_000_000);
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store: throwingStore,
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 }),
    );

    // fail-open (default): should fall through to fetch
    const adaptedOpen = fetchAdapter(limiter, { fetch: mockFetch });
    const resOpen = await adaptedOpen(new Request('http://example.com/api'));
    expect(resOpen.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // fail-closed: should return 503
    vi.clearAllMocks();
    const adaptedClosed = fetchAdapter(limiter, {
      fetch: mockFetch,
      failStrategy: 'closed',
    });
    const resClosed = await adaptedClosed(new Request('http://example.com/api'));
    expect(resClosed.status).toBe(503);
    const body = await resClosed.json();
    expect(body).toEqual({ error: 'Service Unavailable' });
  });
});
