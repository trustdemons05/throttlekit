/**
 * Express middleware with a custom key extractor.
 *
 * Uses the `x-api-key` header to identify clients instead of the default IP.
 * Falls back to IP if the header is missing.
 *
 * Run:
 *   npx tsx examples/express-custom-key.ts
 *
 * Test:
 *   curl -H "x-api-key: alice" http://localhost:3000/api
 *   curl -H "x-api-key: bob"   http://localhost:3000/api
 */

import express from 'express';
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const app = express();

// Token Bucket: each API key gets 10 tokens, refills 1 token/second
const limiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 10,
  refillRate: 1,
});

app.use(
  '/api',
  expressAdapter(limiter, {
    // Extract the API key from the request header
    keyExtractor: (req) =>
      (req.headers['x-api-key'] as string | undefined) ?? req.ip ?? 'unknown',
  }),
);

app.get('/api', (_req, res) => {
  res.json({ ok: true });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`Custom-key example running on http://localhost:${PORT}`);
});
