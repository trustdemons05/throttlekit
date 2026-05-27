import { describe, it, expect, vi } from 'vitest';
import { expressAdapter } from '../../src/adapters/express.js';
import { fixedWindow } from '../../src/core/factories.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReqRes() {
  const req = { ip: '127.0.0.1', headers: {} } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    end: vi.fn(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

function createTestLimiter(limit: number = 5, windowMs: number = 1000) {
  const clock = new ManualClock(1000000);
  const store = new MemoryStore({ clock });
  const limiter = fixedWindow({
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

describe('expressAdapter', () => {
  it('sets RateLimit-* headers on allowed request', async () => {
    const { limiter } = createTestLimiter(5, 1000);
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

  it('sets Retry-After header on blocked request', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    // First request consumes the only permit
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Second request should be blocked
    await middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('returns 429 JSON when rate limited', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    // Use up the permit
    await middleware(req, res, next);

    // Reset mocks for second call
    vi.clearAllMocks();

    // This should be blocked
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  it('calls next() when allowed', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT call next() when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    // Consume the permit
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // This should be blocked
    await middleware(req, res, next);

    // next should still only have been called once (from first request)
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses custom keyExtractor', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const keyExtractor = vi.fn((req: any) => req.customKey);
    const middleware = expressAdapter(limiter, { keyExtractor });

    const { req, res, next } = createMockReqRes();
    req.customKey = 'custom-user';

    await middleware(req, res, next);

    expect(keyExtractor).toHaveBeenCalledWith(req);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls onLimited callback when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const onLimited = vi.fn();
    const middleware = expressAdapter(limiter, { onLimited });
    const { req, res, next } = createMockReqRes();

    // Consume the permit
    await middleware(req, res, next);

    // This should block and fire onLimited
    await middleware(req, res, next);

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(req, res, expect.objectContaining({
      allowed: false,
      limit: 1,
      remaining: 0,
    }));
  });

  it('uses custom handler to replace default 429 response', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const handler = vi.fn((_req: any, res: any, _result: any) => {
      res.status(429).json({ custom: 'blocked' });
    });
    const middleware = expressAdapter(limiter, { handler });
    const { req, res, next } = createMockReqRes();

    // Consume the permit
    await middleware(req, res, next);
    vi.clearAllMocks();

    // This should block and use custom handler
    await middleware(req, res, next);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ custom: 'blocked' });
  });

  it('allows request on store error with fail-open (default)', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = fixedWindow({
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = expressAdapter(limiter);
    const { req, res, next } = createMockReqRes();

    // Store throws, but fail-open should allow the request
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 503 on store error with fail-closed', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = fixedWindow({
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const middleware = expressAdapter(limiter, { failStrategy: 'closed' });
    const { req, res, next } = createMockReqRes();

    // Store throws, fail-closed should return 503
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'Service Unavailable' });
    expect(next).not.toHaveBeenCalled();
  });
});
