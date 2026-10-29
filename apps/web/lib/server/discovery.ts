import "server-only";

import type { LatLon, Segment } from "../types";
import { describeStravaFailure, exploreSegments, StravaApiError } from "./strava";
import { cellId, cellOf } from "./weather";

/**
 * Segments discovered around where the rider is.
 *
 * Discovery searches the rider's own position when the browser gives one,
 * and a region's centre only when it does not: the centre of a region that
 * spans the Bay Area is somewhere in the water off Brisbane, twenty
 * kilometres from the roads the rider is standing on.
 *
 * It is a bonus over the starred and tracked segments, so it fails on its
 * own, and visibly. Each failure is logged with the error's class, Strava's
 * HTTP status and Strava's own message (never a token, never the precise
 * position: the 0.1° forecast cell stands in). Strava refusing the endpoint
 * outright (401 or 403) will not change by asking again a second later, so
 * discovery then stands down for REFUSED_BACKOFF_MS instead of spending a
 * read on every request.
 */

export const EXPLORE_RADIUS_KM = 12;
export const EXPLORE_LIMIT = 8;
const EXPLORED_TTL_MS = 6 * 60 * 60 * 1000;
export const REFUSED_BACKOFF_MS = 6 * 60 * 60 * 1000;

export class DiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryUnavailableError";
  }
}

type Explore = typeof exploreSegments;

const explored = new Map<string, { segments: Segment[]; fetchedAt: number }>();
let refused: { until: number; reason: string } | null = null;

/** For tests: forget cached discoveries and any refusal. */
export function resetDiscovery(): void {
  explored.clear();
  refused = null;
}

/** A failure as the rider sees it in the page's notice. */
export function discoveryNotice(error: unknown): string {
  if (error instanceof DiscoveryUnavailableError) return error.message;
  if (error instanceof StravaApiError) {
    return `Nearby segment discovery is unavailable: Strava refused the request (${error.status}${
      error.stravaMessage ? `, “${error.stravaMessage}”` : ""
    }).`;
  }
  return "Nearby segment discovery was unavailable this time.";
}

/**
 * Up to EXPLORE_LIMIT segments within EXPLORE_RADIUS_KM of `at`, skipping
 * those already known. Cached per forecast cell for six hours.
 */
export async function discoverNear(
  at: LatLon,
  skip: Set<number>,
  options: { explore?: Explore; now?: () => number } = {},
): Promise<Segment[]> {
  const explore = options.explore ?? exploreSegments;
  const now = options.now ?? Date.now;
  const cell = cellId(cellOf(at[0], at[1]));

  const hit = explored.get(cell);
  if (hit && now() - hit.fetchedAt < EXPLORED_TTL_MS) {
    return hit.segments.filter((s) => !skip.has(s.id));
  }
  if (refused && now() < refused.until) {
    throw new DiscoveryUnavailableError(refused.reason);
  }

  try {
    const found = await explore(at[0], at[1], EXPLORE_RADIUS_KM, EXPLORE_LIMIT, skip);
    explored.set(cell, { segments: found, fetchedAt: now() });
    return found;
  } catch (error) {
    console.error(`[discovery] near cell ${cell} failed: ${describeStravaFailure(error)}`);
    if (error instanceof StravaApiError && (error.status === 401 || error.status === 403)) {
      refused = { until: now() + REFUSED_BACKOFF_MS, reason: discoveryNotice(error) };
    }
    throw error;
  }
}
