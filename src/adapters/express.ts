import type { Limiter, RateLimitResult } from '../core/types.js';

/**
 * Minimal Express-compatible request type.
 * Users pass real express.Request objects — we only read `ip`.
 */
export interface ExpressRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

/**
 * Minimal Express-compatible response type.
 * We call setHeader, status, and json.
 */
export interface ExpressResponse {
  setHeader(name: string, value: string): void;
  status(code: number): this;
  json(body: unknown): void;
  [key: string]: unknown;
}

/**
 * Express-compatible next function.
 */
export type ExpressNext = (err?: unknown) => void;

export interface ExpressAdapterOptions {
  keyExtractor?: (req: ExpressRequest) => string;
  onLimited?: (req: ExpressRequest, res: ExpressResponse, result: RateLimitResult) => void;
  handler?: (req: ExpressRequest, res: ExpressResponse, result: RateLimitResult) => void;
  failStrategy?: 'open' | 'closed';
}

export function expressAdapter(
  limiter: Limiter,
  options: ExpressAdapterOptions = {}
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
  const keyExtractor = options.keyExtractor ?? ((req: ExpressRequest) => req.ip ?? 'unknown');
  const failStrategy = options.failStrategy ?? 'open';

  return async (req, res, next) => {
    try {
      const key = keyExtractor(req);
      const result = await limiter.check(key, 1);

      // Set RateLimit-* headers
      res.setHeader('RateLimit-Limit', result.limit.toString());
      res.setHeader('RateLimit-Remaining', result.remaining.toString());
      res.setHeader('RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

      // Legacy headers
      res.setHeader('X-RateLimit-Limit', result.limit.toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
        options.onLimited?.(req, res, result);
        if (options.handler) {
          options.handler(req, res, result);
        } else {
          res.status(429).json({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs });
        }
        return; // Do NOT call next()
      }

      next();
    } catch (err) {
      if (failStrategy === 'closed') {
        res.status(503).json({ error: 'Service Unavailable' });
        return;
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      next();
    }
  };
}
