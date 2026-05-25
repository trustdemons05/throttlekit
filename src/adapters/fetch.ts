import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

export interface FetchAdapterOptions {
  keyExtractor?: (req: Request) => string;
  fetch?: typeof globalThis.fetch;
  failStrategy?: 'open' | 'closed';
  onLimited?: (req: Request, result: RateLimitResult) => void;

  /**
   * Trust proxy hops for client IP extraction.
   * - `false` (default): use direct remote address only
   * - `number`: trust N hops from the rightmost IP in `x-forwarded-for`
   * - `string[]`: CIDR allowlist
   */
  trustProxy?: false | number | string[];

  /**
   * Number of bits to keep for IPv6 prefix aggregation (default: 64).
   * Set to 128 to disable aggregation.
   */
  ipv6Prefix?: number;

  /**
   * Header emit mode options.
   */
  emit?: HeaderEmitOptions;
}

export function fetchAdapter(
  limiter: Limiter,
  options: FetchAdapterOptions = {}
): (request: Request) => Promise<Response> {
  const keyExtractor = options.keyExtractor ?? ((req: Request) => {
    // Build headers object from Request for clientIp
    const headers: Record<string, string | string[] | undefined> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // For fetch, we don't have a direct remote address, use x-real-ip or x-forwarded-for
    return clientIp(headers, {
      ...(options.trustProxy !== undefined && { trustProxy: options.trustProxy }),
      ...(options.ipv6Prefix !== undefined && { ipv6Prefix: options.ipv6Prefix }),
    });
  });
  const fetchFn = options.fetch ?? globalThis.fetch;
  const failStrategy = options.failStrategy ?? 'open';
  const emit = options.emit;

  return async (request: Request) => {
    try {
      const key = keyExtractor(request);
      const result = await limiter.check(key, 1);

      // Build rate-limit headers
      const rateLimitHeaders = buildRateLimitHeaders(result, {
        ...(emit !== undefined && { emit }),
        now: Date.now(),
      });

      if (!result.allowed) {
        options.onLimited?.(request, result);
        return new Response(
          JSON.stringify({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs }),
          {
            status: 429,
            headers: {
              ...rateLimitHeaders,
              'Content-Type': 'application/json',
            },
          }
        );
      }

      // Proceed with actual fetch
      const response = await fetchFn(request);

      // Inject rate-limit headers into response
      const newHeaders = new Headers(response.headers);
      for (const [name, value] of Object.entries(rateLimitHeaders)) {
        newHeaders.set(name, value);
      }

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
