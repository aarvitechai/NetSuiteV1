/**
 * HTTP security middleware: security headers and rate limiting.
 *
 * SECURITY HEADERS: tell browsers to be strict with our responses.
 *   X-Content-Type-Options: nosniff        do not guess content types (prevents some XSS tricks)
 *   X-Frame-Options: DENY                  never render us inside an <iframe> (prevents clickjacking)
 *   Referrer-Policy: no-referrer           do not leak our URLs to other sites
 *   Cache-Control: no-store (API only)     financial data must not sit in shared or browser caches
 *   Strict-Transport-Security (prod only)  browsers must always use HTTPS
 *
 * RATE LIMITING (fixed window per key): stops one client (a buggy integration or an attacker guessing
 * tokens) from exhausting the service, and in turn NetSuite's concurrency limits. Answers 429 with a
 * Retry-After header.
 * In-memory = per instance. With several instances, use a shared store (Redis) or the API gateway's
 * limiter. See docs/architecture/security.md.
 */
import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors';

export function securityHeaders(production: boolean): RequestHandler {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many requests, slow down', 429, true);
  }
}

export interface RateLimitOptions {
  limit: number; // requests per window
  windowMs: number;
  key: (req: Parameters<RequestHandler>[0]) => string;
  now?: () => number;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();
  const now = opts.now ?? Date.now;
  return (req, res, next) => {
    const t = now();
    const k = opts.key(req);
    let w = windows.get(k);
    if (!w || t - w.start >= opts.windowMs) {
      w = { start: t, count: 0 };
      windows.set(k, w);
      // Housekeeping: drop expired windows occasionally, so the map cannot grow forever.
      if (windows.size > 10_000)
        for (const [key, v] of windows) if (t - v.start >= opts.windowMs) windows.delete(key);
    }
    w.count++;
    res.setHeader('RateLimit-Limit', String(opts.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - w.count)));
    if (w.count > opts.limit) {
      const retry = Math.ceil((w.start + opts.windowMs - t) / 1000);
      res.setHeader('Retry-After', String(retry));
      return next(new RateLimitedError(retry));
    }
    next();
  };
}
