/**
 * Multi-limit composition with combine().
 *
 * Enforces two independent rate limits on the same route:
 *   1. 10 requests per second (burst control)
 *   2. 1000 requests per hour (fair use)
 *
 * combine() short-circuits: if either limiter blocks, the request is rejected
 * immediately and the composite result reflects the blocking limiter's state.
 *
 * Run:
 *   npx tsx examples/express-multi-limit.ts
 *
 * Test:
 *   curl http://localhost:3000/api
 *   for i in $(seq 1 11); do curl -s http://localhost:3000/api | head -c 60; echo; done
 */

import express from 'express';
import { rateLimit, combine } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';

const app = express();

// Burst control: 10 requests per second
const perSecond = rateLimit({
  strategy: 'fixed-window',
  limit: 10,
  windowMs: 1000,
});

// Fair-use ceiling: 1000 requests per hour
const perHour = rateLimit({
  strategy: 'fixed-window',
  limit: 1000,
  windowMs: 3_600_000,
});

// Combine both — the request must pass BOTH limiters to be allowed
const combined = combine(perSecond, perHour);

app.use('/api', expressAdapter(combined));

app.get('/api', (_req, res) => {
  res.json({ ok: true });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`Multi-limit example running on http://localhost:${PORT}`);
});
