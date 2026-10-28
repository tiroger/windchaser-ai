import "server-only";

import { timingSafeEqual } from "node:crypto";

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

/**
 * Whether a state-changing request came from this site's own pages.
 *
 * Browsers send Sec-Fetch-Site, which pages cannot set, so it is trusted
 * first. The request URL is not a usable comparison: behind Amplify's CDN it
 * carries an internal host, so matching Origin against it rejected every
 * genuine request. Without the header, Origin is compared with the host the
 * client actually addressed, as forwarded by the proxy.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  const host = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host
  ).split(",")[0].trim();
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
