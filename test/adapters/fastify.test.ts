import { describe, it, expect, vi } from 'vitest';
import { fastifyRateLimit } from '../../src/adapters/fastify.js';
import type { FastifyRequest, FastifyReply } from '../../src/adapters/fastify.js';
import { rateLimit } from '../../src/core/limiter.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFastifyReqReply(headersInit: Record<string, string> = {}) {
  const setHeaders = new Map<string, string>();
  const req = {
    ip: '127.0.0.1',
    headers: { ...headersInit },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as FastifyRequest;
  const reply = {
    header: vi.fn(function (this: Record<string, unknown>, name: string, value: string) {
      setHeaders.set(name, value);
      return this;
    }),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply;
  return { req, reply, setHeaders };
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

describe('fastifyRateLimit', () => {
  it('sets RateLimit-* headers on allowed request', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const hook = fastifyRateLimit(limiter);
    const { req, reply } = createMockFastifyReqReply();

    await hook(req, reply);

    expect(reply.header).toHaveBeenCalledWith('RateLimit-Limit', '5');
    expect(reply.header).toHaveBeenCalledWith('RateLimit-Remaining', '4');
    expect(reply.header).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    expect(reply.header).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });

  it('returns 429 JSON when rate limited', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const hook = fastifyRateLimit(limiter);
    const { req, reply } = createMockFastifyReqReply();

    // First request consumes the only permit
    await hook(req, reply);

    // Reset mocks for second call
    vi.clearAllMocks();

    // Second request should be blocked
    await hook(req, reply);

    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  it('calls custom keyExtractor', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const keyExtractor = vi.fn((req: FastifyRequest) => req.customKey as string);
    const hook = fastifyRateLimit(limiter, { keyExtractor });

    const { req, reply } = createMockFastifyReqReply();
    req.customKey = 'custom-user';

    await hook(req, reply);

    expect(keyExtractor).toHaveBeenCalledWith(req);
    // Allow means we just return without error
  });

  it('calls custom cost function', async () => {
    const { limiter } = createTestLimiter(10, 1000);
    const cost = vi.fn((_req: FastifyRequest) => 3);
    const hook = fastifyRateLimit(limiter, { cost });

    const { req, reply } = createMockFastifyReqReply();

    await hook(req, reply);

    expect(cost).toHaveBeenCalledWith(req);
    // With cost=3, remaining should be 7 instead of 9
    expect(reply.header).toHaveBeenCalledWith('RateLimit-Remaining', '7');
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
    const hook = fastifyRateLimit(limiter);
    const { req, reply } = createMockFastifyReqReply();

    // Store throws, but fail-open should allow the request (no response sent)
    await hook(req, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
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
    const hook = fastifyRateLimit(limiter, { failStrategy: 'closed' });
    const { req, reply } = createMockFastifyReqReply();

    // Store throws, fail-closed should return 503
    await hook(req, reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Service Unavailable' });
  });

  it('calls onLimited callback when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const onLimited = vi.fn();
    const hook = fastifyRateLimit(limiter, { onLimited });
    const { req, reply } = createMockFastifyReqReply();

    // Consume the permit
    await hook(req, reply);

    // This should block and fire onLimited
    await hook(req, reply);

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(req, reply, expect.objectContaining({
      allowed: false,
      limit: 1,
      remaining: 0,
    }));
  });

  it('uses custom handler to replace default 429 response', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const handler = vi.fn((_req: FastifyRequest, reply: FastifyReply, _result: unknown) => {
      reply.status(429).send({ custom: 'blocked' });
    });
    const hook = fastifyRateLimit(limiter, { handler });
    const { req, reply } = createMockFastifyReqReply();

    // Consume the permit
    await hook(req, reply);
    vi.clearAllMocks();

    // This should block and use custom handler
    await hook(req, reply);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ custom: 'blocked' });
  });
});
