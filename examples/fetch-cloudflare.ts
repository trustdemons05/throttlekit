/**
 * Fetch adapter for Cloudflare Workers / edge runtime.
 *
 * Wraps an upstream API with rate-limiting. When the limit is exceeded a 429
 * response is returned directly WITHOUT forwarding the request to the origin.
 * When the request is allowed, the upstream response is enriched with
 * RateLimit-* headers.
 *
 * Deploy on Cloudflare Workers:
 *   npx wrangler deploy examples/fetch-cloudflare.ts
 *
 * Or run locally with Node:
 *   npx tsx examples/fetch-cloudflare.ts
 */

import { rateLimit } from 'throttlekit';
import { fetchAdapter } from 'throttlekit/fetch';

// Allow 50 requests per minute per client IP
const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 50,
  windowMs: 60_000,
});

// Create the rate-limited fetch wrapper
const apiFetch = fetchAdapter(limiter);

/**
 * Cloudflare Workers fetch handler (also works with any Web-standard runtime).
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Only rate-limit /api/* routes
    if (url.pathname.startsWith('/api/')) {
      return apiFetch(request);
    }

    // Static assets / other routes pass through without rate-limiting
    return new Response('Not found', { status: 404 });
  },
};

// ─── Self-contained dev server (Node.js only) ──────────────────────────────
// Remove this block when deploying to Cloudflare Workers.
const isNode =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.node != null;

if (isNode) {
  const { createServer } = await import('node:http');

  const server = createServer(async (req, res) => {
    // Convert Node IncomingMessage to Web Request
    const protocol = 'http';
    const host = req.headers.host ?? 'localhost';
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const webReq = new Request(`${protocol}://${host}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).reduce(
        (acc, [key, val]) => {
          if (val) acc[key] = Array.isArray(val) ? val.join(', ') : val;
          return acc;
        },
        {} as Record<string, string>,
      ),
      body: body ?? undefined,
    });

    const webRes = await (this as any).fetch(webReq);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
    res.end(await webRes.text());
  });

  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  server.listen(PORT, () => {
    console.log(`Cloudflare-style example running on http://localhost:${PORT}`);
  });
}
