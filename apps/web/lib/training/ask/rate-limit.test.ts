import { describe, expect, it } from "vitest";

import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows the limit within the window, then refuses with a retry time", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect(limiter.take("a")).toEqual({ ok: true, remaining: 2 });
    now = 10_000;
    limiter.take("a");
    limiter.take("a");
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 50 });
    // Other keys are counted separately.
    expect(limiter.take("b").ok).toBe(true);
  });

  it("slides: the oldest hit expiring frees one slot", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    limiter.take("a");
    now = 30_000;
    limiter.take("a");
    expect(limiter.take("a").ok).toBe(false);
    now = 60_001;
    expect(limiter.take("a")).toEqual({ ok: true, remaining: 0 });
    expect(limiter.take("a").ok).toBe(false);
  });

  it("does not count refused attempts", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    limiter.take("a");
    for (let i = 0; i < 5; i++) limiter.take("a");
    now = 1_001;
    expect(limiter.take("a").ok).toBe(true);
  });
});
