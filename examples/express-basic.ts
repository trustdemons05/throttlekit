/**
 * Basic Express middleware setup.
 *
 * Protects the /api route with a rate limiter using the Sliding Window Counter
 * algorithm (100 requests per 60 seconds).
 *
 * Run:
 *   npx tsx examples/express-basic.ts
 *
 * Test:
 *   curl http://localhost:3000/api
 *   for i in $(seq 1 101); do curl -s http://localhost:3000/api | head -c 40; echo; done
 */

import express from 'express';
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const app = express();

// Allow 100 requests per minute per IP
const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  windowMs: 60_000,
});

// Apply to all /api routes
app.use('/api', expressAdapter(limiter));

app.get('/api', (_req, res) => {
  res.json({ ok: true });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`Basic example running on http://localhost:${PORT}`);
});
