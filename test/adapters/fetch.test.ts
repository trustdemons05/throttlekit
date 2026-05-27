import { describe, it, expect, vi } from 'vitest';
import { fetchAdapter } from '../../src/adapters/fetch.js';
import { fixedWindow } from '../../src/core/factories.js';
import { ManualClock } from '../../src/core/clock.js';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { createFailingStore } from '../helpers/mock-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

describe('fetchAdapter', () => {
  it('returns 200 Response with RateLimit headers when allowed', async () => {
    const { limiter } = createTestLimiter(5, 1000);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    const response = await adaptedFetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('RateLimit-Limit')).toBe('5');
    expect(response.headers.get('RateLimit-Remaining')).toBe('4');
    expect(response.headers.get('RateLimit-Reset')).toBeTruthy();
  });

  it('returns 429 Response when rate limited', async () => {
    const { limiter } = createTestLimiter(1, 1000);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api');

    // First request succeeds
    const res1 = await adaptedFetch(request);
    expect(res1.status).toBe(200);

    // Second request should be rate limited
    const res2 = await adaptedFetch(request);
    expect(res2.status).toBe(429);

    const body = await res2.json();
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfterMs: expect.any(Number),
    });
  });

  it('preserves original Response body on success', async () => {
    const { limiter } = createTestLimiter(5, 1000);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"data":"hello"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api');

    const response = await adaptedFetch(request);
    const body = await response.json();

    expect(body).toEqual({ data: 'hello' });
  });

  it('uses custom keyExtractor with fetch Request', async () => {
    const { limiter } = createTestLimiter(1, 1000);

    const keyExtractor = vi.fn((req: Request) => {
      return req.headers.get('x-api-key') ?? 'unknown';
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch, keyExtractor });
    const request = new Request('http://example.com/api', {
      headers: { 'x-api-key': 'user-456' },
    });

    await adaptedFetch(request);

    expect(keyExtractor).toHaveBeenCalledWith(request);
  });

  it('uses custom fetch function', async () => {
    const { limiter } = createTestLimiter(5, 1000);

    const customFetch = vi.fn().mockResolvedValue(
      new Response('custom', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: customFetch });
    const request = new Request('http://example.com/api');

    await adaptedFetch(request);

    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(customFetch).toHaveBeenCalledWith(request);
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

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch });
    const request = new Request('http://example.com/api');

    const response = await adaptedFetch(request);

    // fail-open: falls through to underlying fetch
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, {
      fetch: mockFetch,
      failStrategy: 'closed',
    });
    const request = new Request('http://example.com/api');

    const response = await adaptedFetch(request);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: 'Service Unavailable' });
    // The underlying fetch should NOT be called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('calls onLimited callback when blocked', async () => {
    const { limiter } = createTestLimiter(1, 1000);

    const onLimited = vi.fn();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('OK', { status: 200 })
    );

    const adaptedFetch = fetchAdapter(limiter, { fetch: mockFetch, onLimited });
    const request = new Request('http://example.com/api');

    // First request succeeds
    await adaptedFetch(request);

    // Second request should be blocked
    await adaptedFetch(request);

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(request, expect.objectContaining({
      allowed: false,
      limit: 1,
      remaining: 0,
    }));
  });
});
