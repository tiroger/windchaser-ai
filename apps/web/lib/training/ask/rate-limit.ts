/**
 * A sliding-window limit held in memory.
 *
 * It bounds what one owner session can spend, not a distributed quota: each
 * compute instance counts separately and a cold start resets it. That is the
 * right size for a single-owner page, where the limit is a guard against a
 * stuck client or a runaway loop rather than against a crowd.
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

const HOUR = 60 * 60 * 1000;

/** 30 questions an hour per owner session. */
export const sessionLimiter = new RateLimiter(30, HOUR);
/** And 60 an hour per instance whatever the session, in case cookies are rotated. */
export const globalLimiter = new RateLimiter(60, HOUR);
