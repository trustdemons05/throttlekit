/**
 * Redis-backed rate-limiting for horizontal scaling.
 *
 * Uses RedisStore to share rate-limit state across multiple server instances.
 * Requires the optional `ioredis` peer dependency.
 *
 * Install:
 *   npm install ioredis
 *
 * Run:
 *   # Make sure Redis is running on localhost:6379
 *   npx tsx examples/redis-scale-out.ts
 *
 * Test:
 *   curl http://localhost:3000/api
 *   for i in $(seq 1 11); do curl -s http://localhost:3000/api | head -c 60; echo; done
 */

import express from 'express';
import Redis from 'ioredis';
import { rateLimit } from 'throttlekit';
import { expressAdapter } from 'throttlekit/express';
import { createRedisStore } from 'throttlekit/redis';

// ── Redis client ───────────────────────────────────────────────────────────
const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

// ── Redis-backed store ─────────────────────────────────────────────────────
const store = createRedisStore({
  client: redis,
  // Optional: key prefix to avoid collisions with other apps
  prefix: 'throttlekit:',
});

// ── Rate limiter ───────────────────────────────────────────────────────────
const limiter = rateLimit({
  strategy: 'sliding-window-counter',
  limit: 100,
  windowMs: 60_000,
  store, // Shared Redis store — state is consistent across all instances
});

// ── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use('/api', expressAdapter(limiter));

app.get('/api', (_req, res) => {
  res.json({ ok: true });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`Redis-backed example running on http://localhost:${PORT}`);
});
