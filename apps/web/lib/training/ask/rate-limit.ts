import { RateLimiter } from "@/lib/server/rate-limit";

export { RateLimiter };

const HOUR = 60 * 60 * 1000;

/** 30 questions an hour per owner session. */
export const sessionLimiter = new RateLimiter(30, HOUR);
/** And 60 an hour per instance whatever the session, in case cookies are rotated. */
export const globalLimiter = new RateLimiter(60, HOUR);
