import type { HeaderEmitOptions, RateLimitResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildHeadersOptions {
  /** Header emit mode (default: legacy|draft) */
  emit?: HeaderEmitOptions;
  /** Injected timestamp (epoch ms) for deterministic output */
  now?: number;
}

// ---------------------------------------------------------------------------
// Build headers
// ---------------------------------------------------------------------------

/**
 * Build rate-limit response headers from a rate-limit decision.
 *
 * Supports three emit modes (can be combined):
 * - `draft`: IETF draft `RateLimit-*` headers (default: true)
 * - `structured`: RFC 9651 `RateLimit` structured header (default: false)
 * - `legacy`: `X-RateLimit-*` headers (default: true)
 *
 * Also includes `Retry-After` on denial (delta-seconds, min 1).
 *
 * @param decision - The rate-limit result
 * @param opts - Build options
 * @returns A record of header name → header value
 */
export function buildRateLimitHeaders(
  decision: RateLimitResult,
  opts?: BuildHeadersOptions,
): Record<string, string> {
  const emit = opts?.emit ?? {};

  const draft = emit.draft !== false; // default true
  const structured = emit.structured === true; // default false
  const legacy = emit.legacy !== false; // default true

  const headers: Record<string, string> = {};

  // Draft headers (RateLimit-*)
  if (draft) {
    headers['RateLimit-Limit'] = decision.limit.toString();
    headers['RateLimit-Remaining'] = decision.remaining.toString();
    headers['RateLimit-Reset'] = Math.ceil(decision.resetAt / 1000).toString();
  }

  // RFC 9651 structured header
  if (structured) {
    // Format: RateLimit: limit=10, remaining=5, reset=1234567890
    const parts: string[] = [];
    parts.push(`limit=${decision.limit}`);
    parts.push(`remaining=${decision.remaining}`);
    parts.push(`reset=${Math.ceil(decision.resetAt / 1000)}`);
    headers['RateLimit'] = parts.join(', ');
  }

  // Legacy headers (X-RateLimit-*)
  if (legacy) {
    headers['X-RateLimit-Limit'] = decision.limit.toString();
    headers['X-RateLimit-Remaining'] = decision.remaining.toString();
    headers['X-RateLimit-Reset'] = Math.ceil(decision.resetAt / 1000).toString();
  }

  // Retry-After on denial
  if (!decision.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    headers['Retry-After'] = retryAfterSeconds.toString();
  }

  return headers;
}
