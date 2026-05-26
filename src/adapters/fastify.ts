import type { Limiter, RateLimitResult, HeaderEmitOptions } from '../core/types.js';
import { clientIp } from '../utils/client-ip.js';
import { buildRateLimitHeaders } from '../utils/headers.js';

/**
 * Minimal Fastify-compatible request type.
 * Users pass real Fastify.Request objects — we only read `ip`, `headers`, and `socket`.
 */
export interface FastifyRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  [key: string]: unknown;
}

/**
 * Minimal Fastify-compatible reply type.
 * We call header, status, and send.
 */
export interface FastifyReply {
  header(name: string, value: string): this;
  status(code: number): this;
  send(payload?: unknown): void;
  [key: string]: unknown;
}

export interface FastifyAdapterOptions {
  /**
   * Custom key extractor. Defaults to extracting client IP via clientIp().
   */
  keyExtractor?: (req: FastifyRequest) => string;

  /**
   * Failure strategy when the store throws.
   * - 'open' (default): allow the request and log a warning
   * - 'closed': return 503 Service Unavailable
   */
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
  cost?: (req: FastifyRequest) => number;

  /**
   * Callback fired when a request is rate limited (before handler).
   */
  onLimited?: (req: FastifyRequest, reply: FastifyReply, result: RateLimitResult) => void;

  /**
   * Custom handler to replace the default 429 JSON response.
   * When set, the default error response is not sent.
   */
  handler?: (req: FastifyRequest, reply: FastifyReply, result: RateLimitResult) => void;
}

/**
 * Creates a Fastify `onRequest` hook that enforces rate limits.
 *
 * On allow: the hook returns without sending a response (pass to route handler).
 * On deny: sets 429 status and sends a JSON error body.
 *
 * @example
 * ```typescript
 * import fastify from 'fastify';
 * import { fastifyRateLimit } from 'throttlekit/adapters/fastify';
 *
 * const app = fastify();
 * app.addHook('onRequest', fastifyRateLimit(limiter));
 * ```
 */
export function fastifyRateLimit(
  limiter: Limiter,
  options: FastifyAdapterOptions = {}
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const keyExtractor = options.keyExtractor ?? ((req: FastifyRequest) => {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }
    if (req.ip) {
      headers['x-real-ip'] = req.ip;
    }
    if (req.socket?.remoteAddress) {
      headers['remote-address'] = req.socket.remoteAddress;
    }

    return clientIp(headers, {
      ...(options.trustProxy !== undefined && { trustProxy: options.trustProxy }),
      ...(options.ipv6Prefix !== undefined && { ipv6Prefix: options.ipv6Prefix }),
    });
  });
  const failStrategy = options.failStrategy ?? 'open';
  const costFn = options.cost ?? ((_req: FastifyRequest) => 1);
  const emit = options.emit;

  return async (req, reply) => {
    try {
      const key = keyExtractor(req);
      const cost = costFn(req);
      const result = await limiter.check(key, cost);

      const headers = buildRateLimitHeaders(result, {
        ...(emit !== undefined && { emit }),
        now: Date.now(),
      });
      for (const [name, value] of Object.entries(headers)) {
        reply.header(name, value);
      }

      if (!result.allowed) {
        options.onLimited?.(req, reply, result);
        if (options.handler) {
          options.handler(req, reply, result);
        } else {
          reply.status(429).send({ error: 'Too Many Requests', retryAfterMs: result.retryAfterMs });
        }
        return;
      }

      // Allowed — do nothing, let the request pass through to the route handler
    } catch (err) {
      if (failStrategy === 'closed') {
        reply.status(503).send({ error: 'Service Unavailable' });
        return;
      }
      console.warn('ThrottleKit: store error, allowing request (fail-open):', err);
      // Allow the request to continue
    }
  };
}
