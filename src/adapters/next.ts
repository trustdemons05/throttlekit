import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

/**
 * Options for the Next.js rate-limit adapter.
 */
export interface NextRateLimitOptions {
  /**
   * Custom key extractor. Defaults to client IP via `clientIp()`.
   */
  keyExtractor?: (req: Request) => string;

  /**
   * Fail strategy when the store throws.
   * - `'open'` (default): allow the request and log a warning.
   * - `'closed'`: return a 503 Response.
   */
  failStrategy?: 'open' | 'closed';

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

  /**
   * Custom cost function. Return the cost for a given request.
   * Defaults to 1.
   */
  cost?: (req: Request) => number;
}

/**
 * Result returned by the Next.js rate-limit function.
 */
export interface NextRateLimitResult {
  /** Whether the request was rate-limited. */
  limited: boolean;

  /**
   * A Response to return when limited.
   * - 429 with JSON body on rate-limit hit.
   * - 503 with JSON body on fail-closed store error.
   * - `undefined` when the request is allowed.
   */
  response?: Response;

  /**
   * Rate-limit headers to merge onto the final response.
   * Empty object `{}` on store errors or when allowed with fail-open.
   */
  headers: Record<string, string>;
}

/**
 * Create a Next.js middleware-compatible rate-limit function.
 *
 * Returns a function that accepts a standard Web `Request` (Node 18+ global)
 * and produces a `NextRateLimitResult`. The caller should:
 * 1. Check `result.limited`.
 * 2. If limited, return `result.response`.
 * 3. Otherwise, merge `result.headers` onto the outgoing response.
 *
 * @example
 * ```typescript
 * import { nextRateLimit } from 'throttlekit/adapters/next';
 * import { rateLimit } from 'throttlekit';
 *
 * const limiter = rateLimit({ strategy: 'fixed-window', limit: 10, windowMs: 60000 });
 * const check = nextRateLimit(limiter);
 *
 * export async function middleware(request: Request) {
 *   const result = await check(request);
 *   if (result.limited) return result.response;
 *   const response = NextResponse.next();
 *   for (const [key, value] of Object.entries(result.headers)) {
 *     response.headers.set(key, value);
 *   }
 *   return response;
 * }
 * ```
 */
export function nextRateLimit(
  limiter: Limiter,
  options?: NextRateLimitOptions
): (req: Request) => Promise<NextRateLimitResult> {
  const opts = options ?? {};

  const keyExtractor = opts.keyExtractor ?? ((req: Request) => {
    // Build a headers record from the Web Request Headers for clientIp
    const headers: Record<string, string | string[] | undefined> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Also surface x-real-ip if present
    const realIp = req.headers.get('x-real-ip');
    if (realIp) {
      headers['x-real-ip'] = realIp;
    }

    return clientIp(headers, {
      ...(opts.trustProxy !== undefined && { trustProxy: opts.trustProxy }),
      ...(opts.ipv6Prefix !== undefined && { ipv6Prefix: opts.ipv6Prefix }),
    });
  });

  const failStrategy = opts.failStrategy ?? 'open';
  const costFn = opts.cost ?? ((_req: Request) => 1);
  const emit = opts.emit;

  return async (req: Request): Promise<NextRateLimitResult> => {
    try {
      const key = keyExtractor(req);
      const cost = costFn(req);
      const result = await limiter.check(key, cost);

      const rateLimitHeaders = buildRateLimitHeaders(result, {
        ...(emit !== undefined && { emit }),
        now: Date.now(),
      });

      if (!result.allowed) {
        return {
          limited: true,
          response: new Response(
            JSON.stringify({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs }),
            {
              status: 429,
              headers: {
                ...rateLimitHeaders,
                'Content-Type': 'application/json',
              },
            }
          ),
          headers: rateLimitHeaders,
        };
      }

      return {
        limited: false,
        headers: rateLimitHeaders,
      };
    } catch (err) {
      if (failStrategy === 'closed') {
        return {
          limited: true,
          response: new Response(
            JSON.stringify({ error: 'Service Unavailable' }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }
          ),
          headers: {},
        };
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      return { limited: false, headers: {} };
    }
  };
}
