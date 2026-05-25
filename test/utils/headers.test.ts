import { describe, it, expect } from 'vitest';
import { buildRateLimitHeaders } from '../../src/utils/headers.js';

describe('buildRateLimitHeaders', () => {
  const allowedResult = {
    allowed: true,
    limit: 10,
    remaining: 7,
    resetAt: 1_000_000_000,
    retryAfterMs: 0,
  };

  const deniedResult = {
    allowed: false,
    limit: 10,
    remaining: 0,
    resetAt: 1_000_100_000,
    retryAfterMs: 100_000, // 100s
  };

  it('emits draft headers by default', () => {
    const headers = buildRateLimitHeaders(allowedResult, { now: 0 });
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['RateLimit-Remaining']).toBe('7');
    expect(headers['RateLimit-Reset']).toBe(Math.ceil(1_000_000_000 / 1000).toString());
  });

  it('emits legacy headers by default', () => {
    const headers = buildRateLimitHeaders(allowedResult, { now: 0 });
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('7');
    expect(headers['X-RateLimit-Reset']).toBe(Math.ceil(1_000_000_000 / 1000).toString());
  });

  it('does NOT emit structured header by default', () => {
    const headers = buildRateLimitHeaders(allowedResult, { now: 0 });
    expect(headers['RateLimit']).toBeUndefined();
  });

  it('emits structured header when requested', () => {
    const headers = buildRateLimitHeaders(allowedResult, {
      now: 0,
      emit: { structured: true },
    });
    expect(headers['RateLimit']).toBe('limit=10, remaining=7, reset=1000000');
  });

  it('can disable draft headers', () => {
    const headers = buildRateLimitHeaders(allowedResult, {
      now: 0,
      emit: { draft: false },
    });
    expect(headers['RateLimit-Limit']).toBeUndefined();
    expect(headers['X-RateLimit-Limit']).toBe('10');
  });

  it('can disable legacy headers', () => {
    const headers = buildRateLimitHeaders(allowedResult, {
      now: 0,
      emit: { legacy: false },
    });
    expect(headers['X-RateLimit-Limit']).toBeUndefined();
    expect(headers['RateLimit-Limit']).toBe('10');
  });

  it('sets Retry-After on denial (delta-seconds, min 1)', () => {
    const headers = buildRateLimitHeaders(deniedResult, { now: 0 });
    expect(headers['Retry-After']).toBe('100');
  });

  it('Retry-After is at least 1 second', () => {
    const result = {
      ...deniedResult,
      retryAfterMs: 100, // 0.1 seconds
    };
    const headers = buildRateLimitHeaders(result, { now: 0 });
    expect(headers['Retry-After']).toBe('1');
  });

  it('does NOT set Retry-After when allowed', () => {
    const headers = buildRateLimitHeaders(allowedResult, { now: 0 });
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('uses custom now for deterministic output', () => {
    const headers = buildRateLimitHeaders(allowedResult, { now: 12345 });
    expect(headers['RateLimit-Reset']).toBe(Math.ceil(1_000_000_000 / 1000).toString());
  });

  it('emits only structured when both draft and legacy disabled', () => {
    const headers = buildRateLimitHeaders(allowedResult, {
      now: 0,
      emit: { draft: false, legacy: false, structured: true },
    });
    expect(Object.keys(headers)).toEqual(['RateLimit']);
    expect(headers['RateLimit']).toBe('limit=10, remaining=7, reset=1000000');
  });
});
