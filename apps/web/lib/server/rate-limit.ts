/**
 * A sliding-window limit held in memory.
 *
 * A guard per compute instance, not a distributed quota: each instance counts
 * separately and a cold start resets it. It caps runaway clients and loops on
 * routes that spend money or accept guesses; limits that must hold across
 * instances and real client addresses belong in the WAF.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit if the key is under its limit. */
  take(key: string): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => time > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) this.prune(now);
    return { ok: true, remaining: this.limit - recent.length };
  }

  private prune(now: number) {
    for (const [key, times] of this.hits) {
      if (!times.some((time) => time > now - this.windowMs)) this.hits.delete(key);
    }
  }
}
