/**
 * Token bucket per key, in memory per replica (no Redis in the MVP). Front Door serves most
 * traffic from cache and has its own WAF rate-limit rule; this protects the database from
 * cache-busting clients.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly opts: { capacity: number; refillPerSecond: number }) {}

  /** Takes one token. Returns 0 if allowed, otherwise the seconds to wait. */
  take(id: string, now = Date.now()): number {
    const b = this.buckets.get(id) ?? { tokens: this.opts.capacity, at: now };
    b.tokens = Math.min(this.opts.capacity, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSecond);
    b.at = now;
    if (this.buckets.size > 50_000) this.buckets.clear();
    this.buckets.set(id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return (1 - b.tokens) / this.opts.refillPerSecond;
  }
}
