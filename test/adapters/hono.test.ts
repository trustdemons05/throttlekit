import { describe, it, expect, vi } from 'vitest';
import { honoRateLimit } from '../../src/adapters/hono.js';
import type { HonoContext } from '../../src/adapters/hono.js';
import { rateLimit } from '../../src/core/limiter.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHonoContext(headersInit: Record<string, string> = {}) {
  const rawHeaders = new Map<string, string>(Object.entries(headersInit));
  const setHeaders = new Map<string, string>();

  const c = {
    req: {
      raw: {
        headers: {
          get(name: string) { return rawHeaders.get(name.toLowerCase()) ?? null; },
          entries() { return rawHeaders.entries(); },
        } as unknown as Headers,
      },
    },
    header: vi.fn((name: string, value: string) => {
      setHeaders.set(name, value);
    }),
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), { status: status ?? 200 });
    }),
    status: vi.fn(),
  } as unknown as HonoContext;

  const next = vi.fn().mockResolvedValue(undefined);

  return { c, next, setHeaders };
}

function createTestLimiter(limit: number = 5, windowMs: number = 1000) {
  const clock = new ManualClock(1000000);
  const store = new MemoryStore({ clock });
  const limiter = rateLimit({
    strategy: 'fixed-window',
    limit,
    windowMs,
    clock,
    store,
  });
  return { limiter, clock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('honoRateLimit', () => {
  it('sets RateLimit-* headers on allowed request', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    await middleware(c, next);

    expect(c.header).toHaveBeenCalledWith('RateLimit-Limit', '5');
    expect(c.header).toHaveBeenCalledWith('RateLimit-Remaining', '4');
    expect(c.header).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    expect(c.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  it('sets Retry-After header on blocked request', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    // First request consumes the only permit
    await middleware(c, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Second request should be blocked
    await middleware(c, next);

    expect(c.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('returns 429 JSON when rate limited', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    // Use up the permit
    await middleware(c, next);

    // Reset mocks for second call
    vi.clearAllMocks();

    // This should be blocked
    const response = await middleware(c, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(429);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  it('calls next() when allowed', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT call next() when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    // Consume the permit
    await middleware(c, next);
    expect(next).toHaveBeenCalledTimes(1);

    // This should be blocked
    await middleware(c, next);

    // next should still only have been called once (from first request)
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses custom keyExtractor', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const keyExtractor = vi.fn((_c: HonoContext) => 'custom-user');
    const middleware = honoRateLimit(limiter, { keyExtractor });

    const { c, next } = createMockHonoContext();
    (c as Record<string, unknown>).customKey = 'custom-user';

    await middleware(c, next);

    expect(keyExtractor).toHaveBeenCalledWith(c);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls custom cost function', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const cost = vi.fn((_c: HonoContext) => 5);
    const middleware = honoRateLimit(limiter, { cost });
    const { c, next } = createMockHonoContext();

    await middleware(c, next);

    expect(cost).toHaveBeenCalledWith(c);
    // Cost 5 with limit 5 means 0 remaining
    expect(c.header).toHaveBeenCalledWith('RateLimit-Remaining', '0');
  });

  it('calls onLimited callback when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const onLimited = vi.fn();
    const middleware = honoRateLimit(limiter, { onLimited });
    const { c, next } = createMockHonoContext();

    // Consume the permit
    await middleware(c, next);

    // This should block and fire onLimited
    await middleware(c, next);

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(c, expect.objectContaining({
      allowed: false,
      limit: 1,
      remaining: 0,
    }));
  });

  it('uses custom handler to replace default 429 response', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const handler = vi.fn((_c: HonoContext, _result: unknown) => {
      return new Response(JSON.stringify({ custom: 'blocked' }), { status: 429 });
    });
    const middleware = honoRateLimit(limiter, { handler });
    const { c, next } = createMockHonoContext();

    // Consume the permit
    await middleware(c, next);
    vi.clearAllMocks();

    // This should block and use custom handler
    const response = await middleware(c, next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(429);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toEqual({ custom: 'blocked' });
  });

  it('allows request on store error with fail-open (default)', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = honoRateLimit(limiter);
    const { c, next } = createMockHonoContext();

    // Store throws, but fail-open should allow the request
    await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 503 on store error with fail-closed', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = honoRateLimit(limiter, { failStrategy: 'closed' });
    const { c, next } = createMockHonoContext();

    // Store throws, fail-closed should return 503
    const response = await middleware(c, next);

    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(503);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'Service Unavailable' });
    expect(next).not.toHaveBeenCalled();
  });
});
