import { describe, it, expect, vi } from 'vitest';
import { nextRateLimit } from '../../src/adapters/next.js';
import { rateLimit } from '../../src/core/limiter.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(headersInit: Record<string, string> = {}): Request {
  const headers = new Map<string, string>(
    Object.entries(headersInit).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    headers: {
      get(name: string): string | null {
        return headers.get(name.toLowerCase()) ?? null;
      },
      forEach(cb: (value: string, key: string) => void): void {
        headers.forEach((value, key) => cb(value, key));
      },
      entries(): IterableIterator<[string, string]> {
        return headers.entries();
      },
      has(name: string): boolean {
        return headers.has(name.toLowerCase());
      },
    },
  } as unknown as Request;
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

describe('nextRateLimit', () => {
  it('returns limited=false and headers on allowed request', async () => {
    const { limiter } = createTestLimiter(5, 1000);
    const check = nextRateLimit(limiter);
    const req = createMockRequest({ 'x-forwarded-for': '127.0.0.1' });

    const result = await check(req);

    expect(result.limited).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.headers['RateLimit-Limit']).toBe('5');
    expect(result.headers['RateLimit-Remaining']).toBe('4');
    expect(result.headers['RateLimit-Reset']).toBeTruthy();
    expect(result.headers['X-RateLimit-Limit']).toBe('5');
    expect(result.headers['X-RateLimit-Remaining']).toBe('4');
    expect(result.headers['X-RateLimit-Reset']).toBeTruthy();
  });

  it('returns limited=true and 429 Response on denied request', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const check = nextRateLimit(limiter);
    const req = createMockRequest({ 'x-forwarded-for': '127.0.0.1' });

    // First request uses up the only permit
    const first = await check(req);
    expect(first.limited).toBe(false);

    // Second request should be denied
    const second = await check(req);
    expect(second.limited).toBe(true);
    expect(second.response).toBeInstanceOf(Response);
    expect(second.response!.status).toBe(429);

    const body = await second.response!.json();
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });

    // Headers should include Retry-After on denial
    expect(second.headers['Retry-After']).toBeTruthy();
  });

  it('calls custom keyExtractor', async () => {
    const { limiter } = createTestLimiter(1, 1000);
    const keyExtractor = vi.fn((req: Request) => {
      return req.headers.get('x-api-key') ?? 'unknown';
    });
    const check = nextRateLimit(limiter, { keyExtractor });
    const req = createMockRequest({ 'x-api-key': 'user-456' });

    await check(req);

    expect(keyExtractor).toHaveBeenCalledTimes(1);
    expect(keyExtractor).toHaveBeenCalledWith(req);
  });

  it('calls custom cost function', async () => {
    const { limiter, clock } = createTestLimiter(5, 1000);
    const cost = vi.fn((_req: Request) => 3);
    const check = nextRateLimit(limiter, { cost });
    const req = createMockRequest({ 'x-forwarded-for': '127.0.0.1' });

    const result = await check(req);

    expect(cost).toHaveBeenCalledTimes(1);
    expect(cost).toHaveBeenCalledWith(req);
    // With cost=3 out of limit=5, remaining should be 2
    expect(result.headers['RateLimit-Remaining']).toBe('2');
  });

  it('fail-open returns limited=false on store error (default)', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const check = nextRateLimit(limiter);
    const req = createMockRequest();

    const result = await check(req);

    // fail-open: allow the request with empty headers
    expect(result.limited).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.headers).toEqual({});
  });

  it('fail-closed returns limited=true and 503 Response on store error', async () => {
    const store = createFailingStore();
    const clock = new ManualClock(1000000);
    const limiter = rateLimit({
      strategy: 'fixed-window',
      limit: 5,
      windowMs: 1000,
      clock,
      store,
    });
    const check = nextRateLimit(limiter, { failStrategy: 'closed' });
    const req = createMockRequest();

    const result = await check(req);

    expect(result.limited).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response!.status).toBe(503);

    const body = await result.response!.json();
    expect(body).toEqual({ error: 'Service Unavailable' });

    expect(result.headers).toEqual({});
  });
});
