import type { Limiter, RateLimitResult } from '../core/types.js';

export interface FetchAdapterOptions {
  keyExtractor?: (req: Request) => string;
  fetch?: typeof globalThis.fetch;
  failStrategy?: 'open' | 'closed';
  onLimited?: (req: Request, result: RateLimitResult) => void;
}

export function fetchAdapter(
  limiter: Limiter,
  options: FetchAdapterOptions = {}
): (request: Request) => Promise<Response> {
  const keyExtractor = options.keyExtractor ?? ((req: Request) => req.headers.get('x-forwarded-for') ?? 'unknown');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const failStrategy = options.failStrategy ?? 'open';

  return async (request: Request) => {
    try {
      const key = keyExtractor(request);
      const result = await limiter.check(key, 1);

      if (!result.allowed) {
        options.onLimited?.(request, result);
        return new Response(
          JSON.stringify({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs }),
          {
            status: 429,
            headers: {
              'RateLimit-Limit': result.limit.toString(),
              'RateLimit-Remaining': '0',
              'RateLimit-Reset': Math.ceil(result.resetAt / 1000).toString(),
              'Retry-After': Math.ceil(result.retryAfterMs / 1000).toString(),
              'Content-Type': 'application/json',
            },
          }
        );
      }

      // Proceed with actual fetch
      const response = await fetchFn(request);

      // Inject rate-limit headers into response
      const newHeaders = new Headers(response.headers);
      newHeaders.set('RateLimit-Limit', result.limit.toString());
      newHeaders.set('RateLimit-Remaining', result.remaining.toString());
      newHeaders.set('RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (err) {
      if (failStrategy === 'closed') {
        return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      return fetchFn(request);
    }
  };
}
