import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

/**
 * Minimal Express-compatible request type.
 * Users pass real express.Request objects — we only read `ip`.
 */
export interface ExpressRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
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

  /**
   * Trust proxy hops for client IP extraction.
   * - `false` (default): use `req.ip` only
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
  cost?: (req: ExpressRequest) => number;
}

export function expressAdapter(
  limiter: Limiter,
  options: ExpressAdapterOptions = {}
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
  const keyExtractor = options.keyExtractor ?? ((req: ExpressRequest) => {
    // Build a headers-like object from the express request for clientIp
    const headers: Record<string, string | string[] | undefined> = {};
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = v as string | string[] | undefined;
      }
    }
    // Prefer req.ip (express sets this based on trust proxy settings)
    // But also pass x-real-ip and remote-address for clientIp fallback
    if (req.ip) {
      headers['x-real-ip'] = req.ip;
    }
    if (req.socket?.remoteAddress) {
      headers['remote-address'] = req.socket.remoteAddress;
    }

    return clientIp(headers, {
      trustProxy: options.trustProxy,
      ipv6Prefix: options.ipv6Prefix,
    });
  });
  const failStrategy = options.failStrategy ?? 'open';
  const costFn = options.cost ?? ((_req: ExpressRequest) => 1);
  const emit = options.emit;

  return async (req, res, next) => {
    try {
      const key = keyExtractor(req);
      const cost = costFn(req);
      const result = await limiter.check(key, cost);

      // Build and set headers using buildRateLimitHeaders
      const headers = buildRateLimitHeaders(result, {
        emit,
        now: Date.now(),
      });
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }

      if (!result.allowed) {
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
