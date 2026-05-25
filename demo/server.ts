import express from 'express';
import { rateLimit, combine } from '../src/core/index.js';
import { expressAdapter } from '../src/adapters/express.js';

const app = express();

const fastLimiter = rateLimit({
  strategy: 'token-bucket',
  capacity: 10,
  refillRate: 1,
});

const slowLimiter = rateLimit({
  strategy: 'fixed-window',
  limit: 5,
  windowMs: 60_000,
});

app.use('/api/fast', expressAdapter(fastLimiter));
app.use('/api/slow', expressAdapter(slowLimiter));

app.get('/api/fast', (req, res) => res.json({ ok: true, route: 'fast' }));
app.get('/api/slow', (req, res) => res.json({ ok: true, route: 'slow' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ThrottleKit demo on http://localhost:${PORT}`));
