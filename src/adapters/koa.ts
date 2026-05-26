import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

/**
 * Minimal Koa-compatible context type.
 * Users pass real Koa Context objects — we read `ip`, `request`, and call `set`.
 */
export interface KoaContext {
  ip?: string;
  request: { ip?: string; headers: Record<string, string | string[] | undefined> };
  set(name: string, value: string): void;
  status: number;
  body: unknown;
  [key: string]: unknown;
}

export interface KoaAdapterOptions {
  /**
   * Custom key extractor. Default extracts client IP from request headers.
   */
  keyExtractor?: (ctx: KoaContext) => string;

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
  cost?: (ctx: KoaContext) => number;

  /**
   * Callback invoked when a request is rate-limited (before sending response).
   */
  onLimited?: (ctx: KoaContext, result: RateLimitResult) => void;

  /**
   * Custom handler to replace the default 429 JSON response.
   */
  handler?: (ctx: KoaContext, result: RateLimitResult) => void;
}

export function koaRateLimit(
  limiter: Limiter,
  options?: KoaAdapterOptions,
): (ctx: KoaContext, next: () => Promise<void>) => Promise<void> {
  const opts = options ?? {};

  const keyExtractor = opts.keyExtractor ?? ((ctx: KoaContext) => {
    // Build a headers-like object from the Koa context for clientIp
    const headers: Record<string, string | string[] | undefined> = {};
    if (ctx.request?.headers) {
      for (const [k, v] of Object.entries(ctx.request.headers)) {
        headers[k.toLowerCase()] = v as string | string[] | undefined;
      }
    }
    // Prefer ctx.ip (koa sets this based on trust proxy settings)
    if (ctx.ip) {
      headers['x-real-ip'] = ctx.ip;
    } else if (ctx.request?.ip) {
      headers['x-real-ip'] = ctx.request.ip;
    }

    return clientIp(headers, {
      ...(opts.trustProxy !== undefined && { trustProxy: opts.trustProxy }),
      ...(opts.ipv6Prefix !== undefined && { ipv6Prefix: opts.ipv6Prefix }),
    });
  });

  const failStrategy = opts.failStrategy ?? 'open';
  const costFn = opts.cost ?? ((_ctx: KoaContext) => 1);
  const emit = opts.emit;

  return async (ctx, next) => {
    try {
      const key = keyExtractor(ctx);
      const cost = costFn(ctx);
      const result = await limiter.check(key, cost);

      // Build and set rate-limit headers
      const headers = buildRateLimitHeaders(result, {
        ...(emit !== undefined && { emit }),
        now: Date.now(),
      });
      for (const [name, value] of Object.entries(headers)) {
        ctx.set(name, value);
      }

      if (!result.allowed) {
        opts.onLimited?.(ctx, result);
        if (opts.handler) {
          opts.handler(ctx, result);
        } else {
          ctx.status = 429;
          ctx.body = { error: 'Too Many Requests', retryAfterMs: result.retryAfterMs };
        }
        return;
      }

      await next();
    } catch (err) {
      if (failStrategy === 'closed') {
        ctx.status = 503;
        ctx.body = { error: 'Service Unavailable' };
        return;
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      await next();
    }
  };
}
