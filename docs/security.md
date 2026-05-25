# Security

ThrottleKit includes several security-oriented utilities that work out of the box, no configuration required.

## Client IP Resolution

The `clientIp()` function extracts the real client IP from request headers, with configurable trust levels that prevent IP spoofing:

```typescript
import { clientIp } from 'throttlekit';

// Trust nothing — use direct remote address
clientIp(headers); // default

// Trust N hops from rightmost x-forwarded-for
clientIp(headers, { trustProxy: 2 });

// Trust only if remote address matches a CIDR allowlist
clientIp(headers, { trustProxy: ['10.0.0.0/8', '172.16.0.0/12'] });
```

`clientIp` handles IPv4-mapped IPv6 (`::ffff:1.2.3.4`), unwraps them to plain IPv4, and aggregates full IPv6 addresses to a configurable prefix. By default IPv6 is aggregated to /64, which prevents a single client from exhausting an entire /128 subnet while still preserving enough granularity for per-customer rate limits.

The CIDR matching supports both IPv4 and IPv6 allowlists. If the remote address does not match any trusted CIDR, `x-forwarded-for` is ignored and the remote address is used directly.

## HMAC Key Hashing

For shared-key rate limits (e.g., per-API-key), storing raw keys in Redis is a bad practice. Use `hmacKeyer()` or `hashKey()` to derive opaque, deterministic identifiers:

```typescript
import { hmacKeyer, hashKey } from 'throttlekit';

const keyer = hmacKeyer('secret-key');
const safeKey = keyer('raw-api-key-123');

// Or for non-secret contexts:
const hashed = hashKey('raw-api-key-123', 'secret-key');
```

`hmacKeyer` uses HMAC-SHA256 under the hood. The secret should be rotated periodically and should never be committed to version control.

## Fail-Open vs Fail-Closed

Both `expressAdapter` and `fetchAdapter` support a `failStrategy` option that determines what happens when the store throws an error:

- `open` (default): if the store throws, the request is allowed. A warning is logged so operators know the rate limiter is degraded. This is the safe default: a broken rate limiter should not take down your site.
- `closed`: if the store throws, the request is rejected with `503 Service Unavailable`. Use this when you would rather drop traffic than risk a stampede during an outage.

```typescript
import { expressAdapter } from 'throttlekit/express';

app.use('/api', expressAdapter(limiter, { failStrategy: 'closed' }));
```

Choose `closed` for critical infrastructure where overloading downstream services is worse than shedding load. Choose `open` for user-facing endpoints where availability is more important than strict enforcement.
