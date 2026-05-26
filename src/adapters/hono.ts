import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

/**
 * Minimal Hono-compatible context type.
 * Users pass real Hono Context objects — we only read `req.raw` headers.
 */
export interface HonoContext {
  req: { raw: Request; header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
  json: (data: unknown, status?: number) => Response;
  status: (code: number) => void;
  [key: string]: unknown;
}

export interface HonoAdapterOptions {
  /**
   * Custom key extractor. Default extracts client IP from request headers.
   */
  keyExtractor?: (c: HonoContext) => string;

  /**
   * Fail strategy when store operations throw.
   * - `'open'` (default): allow the request, log a warning
   * - `'closed'`: return 503 Service Unavailable
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
  cost?: (c: HonoContext) => number;

  /**
   * Callback invoked when a request is rate-limited (before sending response).
   */
  onLimited?: (c: HonoContext, result: RateLimitResult) => void;

  /**
   * Custom handler to replace the default 429 JSON response.
   * If provided, the returned Response is used instead of calling c.json().
   */
  handler?: (c: HonoContext, result: RateLimitResult) => Response;
}

export function honoRateLimit(
  limiter: Limiter,
  options?: HonoAdapterOptions,
): (c: HonoContext, next: () => Promise<void>) => Promise<Response | void> {
  const opts = options ?? {};

  const keyExtractor = opts.keyExtractor ?? ((c: HonoContext) => {
    // Convert Web Headers to a Record<string, string | string[] | undefined>
    const headers: Record<string, string | string[] | undefined> = {};
    if (c.req?.raw?.headers) {
      for (const [k, v] of c.req.raw.headers.entries()) {
        headers[k.toLowerCase()] = v;
      }
    }
    return clientIp(headers, {
      ...(opts.trustProxy !== undefined && { trustProxy: opts.trustProxy }),
      ...(opts.ipv6Prefix !== undefined && { ipv6Prefix: opts.ipv6Prefix }),
    });
  });

  const failStrategy = opts.failStrategy ?? 'open';
  const costFn = opts.cost ?? ((_c: HonoContext) => 1);
  const emit = opts.emit;

  return async (c, next) => {
    try {
      const key = keyExtractor(c);
      const cost = costFn(c);
      const result = await limiter.check(key, cost);

      // Build and set rate-limit headers
      const headers = buildRateLimitHeaders(result, {
        ...(emit !== undefined && { emit }),
        now: Date.now(),
      });
      for (const [name, value] of Object.entries(headers)) {
        c.header(name, value);
      }

      if (!result.allowed) {
        opts.onLimited?.(c, result);
        if (opts.handler) {
          return opts.handler(c, result);
        }
        return c.json({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs }, 429);
      }

      await next();
      return;
    } catch (err) {
      if (failStrategy === 'closed') {
        return c.json({ error: 'Service Unavailable' }, 503);
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      await next();
      return;
    }
  };
}
