import { describe, it, expect, vi } from 'vitest';
import { koaRateLimit } from '../../src/adapters/koa.js';
import type { KoaContext } from '../../src/adapters/koa.js';
import { rateLimit } from '../../src/core/limiter.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockKoaContext(headersInit: Record<string, string> = {}) {
  const setHeaders = new Map<string, string>();
  const ctx = {
    ip: '127.0.0.1',
    request: { ip: '127.0.0.1', headers: { ...headersInit } },
    set: vi.fn((name: string, value: string) => {
      setHeaders.set(name, value);
    }),
    status: 200,
    body: undefined,
  } as unknown as KoaContext;
  const next = vi.fn().mockResolvedValue(undefined);
  return { ctx, next, setHeaders };
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

describe('koaRateLimit', () => {
  it('sets RateLimit-* headers on allowed request', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const middleware = koaRateLimit(limiter);
    const { ctx, next } = createMockKoaContext();

    await middleware(ctx, next);

    expect(ctx.set).toHaveBeenCalledWith('RateLimit-Limit', '5');
    expect(ctx.set).toHaveBeenCalledWith('RateLimit-Remaining', '4');
    expect(ctx.set).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
    expect(ctx.set).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
    expect(ctx.set).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    expect(ctx.set).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  it('returns 429 body when rate limited', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = koaRateLimit(limiter);
    const { ctx, next } = createMockKoaContext();

    // First request consumes the only permit
    await middleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Second request should be blocked
    await middleware(ctx, next);

    expect(ctx.status).toBe(429);
    expect(ctx.body).toEqual({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  it('calls custom keyExtractor', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const keyExtractor = vi.fn((ctx: KoaContext) => ctx['customKey'] as string);
    const middleware = koaRateLimit(limiter, { keyExtractor });

    const { ctx, next } = createMockKoaContext();
    (ctx as Record<string, unknown>).customKey = 'custom-user';

    await middleware(ctx, next);

    expect(keyExtractor).toHaveBeenCalledWith(ctx);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls custom cost function', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const cost = vi.fn((_ctx: KoaContext) => 2);
    const middleware = koaRateLimit(limiter, { cost });

    const { ctx, next } = createMockKoaContext();

    await middleware(ctx, next);

    expect(cost).toHaveBeenCalledWith(ctx);
    expect(next).toHaveBeenCalledTimes(1);
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
    const middleware = koaRateLimit(limiter);
    const { ctx, next } = createMockKoaContext();

    // Store throws, but fail-open should allow the request
    await middleware(ctx, next);

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
    const middleware = koaRateLimit(limiter, { failStrategy: 'closed' });
    const { ctx, next } = createMockKoaContext();

    // Store throws, fail-closed should return 503
    await middleware(ctx, next);

    expect(ctx.status).toBe(503);
    expect(ctx.body).toEqual({ error: 'Service Unavailable' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls onLimited callback when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const onLimited = vi.fn();
    const middleware = koaRateLimit(limiter, { onLimited });
    const { ctx, next } = createMockKoaContext();

    // Consume the permit
    await middleware(ctx, next);

    // This should block and fire onLimited
    await middleware(ctx, next);

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(ctx, expect.objectContaining({
      allowed: false,
      limit: 1,
      remaining: 0,
    }));
  });

  it('uses custom handler to replace default 429 response', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const handler = vi.fn((_ctx: KoaContext, _result: any) => {
      _ctx.status = 429;
      _ctx.body = { custom: 'blocked' };
    });
    const middleware = koaRateLimit(limiter, { handler });
    const { ctx, next } = createMockKoaContext();

    // Consume the permit
    await middleware(ctx, next);

    // This should block and use custom handler
    await middleware(ctx, next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(ctx.status).toBe(429);
    expect(ctx.body).toEqual({ custom: 'blocked' });
  });
});
