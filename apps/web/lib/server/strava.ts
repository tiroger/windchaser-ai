import "server-only";

import { haversineM } from "../geo";
import type { LatLon, Segment } from "../types";
import { stravaConfig } from "./env";

const API = "https://www.strava.com/api/v3";

/**
 * Distinguishable so callers can tell "this one segment is unreadable" from
 * "Strava has stopped answering". Swallowing the second as if it were the first
 * returns a nearly empty list while still reporting it as live data.
 */
/**
 * Strava reports quota on every response as "fifteenMinute,daily" pairs. Section
 * 5 of the project plan asks for rate-limit accounting, not just backoff, and
 * the difference matters: backoff handles being refused, accounting stops us
 * spending the day's budget on work nobody asked for.
 *
 * A full starred refresh costs one call per segment, so a couple of refreshes
 * plus effort history can exhaust a thousand reads in an afternoon. When that
 * happens the app has no live data until midnight UTC.
 */
export interface RateLimitState {
  shortTermUsed: number;
  shortTermLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  observedAt: string;
}

let rateLimit: RateLimitState | null = null;

function recordRateLimit(headers: Headers): void {
  const usage = headers.get("x-readratelimit-usage");
  const limit = headers.get("x-readratelimit-limit");
  if (!usage || !limit) return;
  const [su, du] = usage.split(",").map((n) => Number(n.trim()));
  const [sl, dl] = limit.split(",").map((n) => Number(n.trim()));
  if ([su, du, sl, dl].some((n) => !Number.isFinite(n))) return;
  rateLimit = {
    shortTermUsed: su,
    shortTermLimit: sl,
    dailyUsed: du,
    dailyLimit: dl,
    observedAt: new Date().toISOString(),
  };
}

export function rateLimitState(): RateLimitState | null {
  return rateLimit;
}

/**
 * Fraction of the daily quota beyond which optional work stops. Starred
 * segments are what the rider came for; discovering new ones nearby is a bonus
 * and is the first thing to give up.
 */
const DISCOVERY_BUDGET_CEILING = 0.8;

export function discoveryAffordable(): boolean {
  if (!rateLimit) return true;
  return rateLimit.dailyUsed / rateLimit.dailyLimit < DISCOVERY_BUDGET_CEILING;
}

export class StravaRateLimitError extends Error {
  constructor() {
    super("Strava rate limit reached. Try again in a few minutes.");
    this.name = "StravaRateLimitError";
  }
}
const TOKEN_URL = "https://www.strava.com/oauth/token";

interface TokenState {
  token: string;
  expiresAt: number;
}
let tokenState: TokenState | null = null;

export async function accessToken(): Promise<string> {
  if (tokenState && Date.now() < tokenState.expiresAt - 60_000) {
    return tokenState.token;
  }
  const config = await stravaConfig();
  if (!config) {
    throw new Error("No Strava credentials available from env or Secrets Manager.");
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  if (!res.ok) {
    throw new Error(`Strava token refresh failed with ${res.status}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    expires_at: number;
  };
  tokenState = { token: json.access_token, expiresAt: json.expires_at * 1000 };
  return tokenState.token;
}

async function api<T>(path: string): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  // Recorded from every response, including refusals, since a 429 still reports
  // where the quota stands.
  recordRateLimit(res.headers);
  if (res.status === 429) {
    throw new StravaRateLimitError();
  }
  if (!res.ok) {
    throw new Error(`Strava ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}

/** Google encoded polyline decoder. */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

function simplify(points: LatLon[], max = 240): LatLon[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: LatLon[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out[out.length - 1] = points[points.length - 1];
  return out;
}

interface StravaSegmentDetail {
  id: number;
  name: string;
  distance: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  total_elevation_gain: number;
  climb_category: number;
  city: string | null;
  state: string | null;
  effort_count: number | null;
  athlete_count: number | null;
  star_count: number | null;
  map?: { polyline?: string; summary_polyline?: string };
  athlete_segment_stats?: {
    pr_elapsed_time?: number | null;
    elapsed_time?: number | null;
    pr_date?: string | null;
    effort_count?: number | null;
  };
}

function normalize(
  detail: StravaSegmentDetail,
  source: "starred" | "discovered",
): Segment | null {
  const line = detail.map?.polyline || detail.map?.summary_polyline;
  if (!line) return null;
  const points = simplify(decodePolyline(line));
  if (points.length < 2) return null;
  const stats = detail.athlete_segment_stats ?? {};

  return {
    id: detail.id,
    name: detail.name ?? "Unnamed segment",
    source,
    distance_m: detail.distance,
    average_grade: detail.average_grade,
    maximum_grade: detail.maximum_grade,
    elevation_high: detail.elevation_high,
    elevation_low: detail.elevation_low,
    total_elevation_gain: detail.total_elevation_gain,
    climb_category: detail.climb_category,
    city: detail.city,
    state: detail.state,
    effort_count: detail.effort_count,
    athlete_count: detail.athlete_count,
    star_count: detail.star_count,
    pr_elapsed_time: stats.pr_elapsed_time ?? stats.elapsed_time ?? null,
    pr_date: stats.pr_date ?? null,
    effort_count_personal: stats.effort_count ?? null,
    points,
    region_id: "",
    cell_id: "",
  };
}

export async function fetchAthlete() {
  return api<{
    firstname: string | null;
    lastname: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    weight: number | null;
    ftp: number | null;
  }>("/athlete");
}

/**
 * A partial result is worse than no result: it looks like the rider suddenly
 * has one starred segment rather than like a failed fetch, and it poisons the
 * cache with that for an hour. So a rate limit propagates, and losing most of
 * the list is treated as failure even if every individual error looked benign.
 */
const MAX_TOLERATED_DETAIL_FAILURE = 0.25;

export async function fetchStarredSegments(
  known?: Map<number, Segment>,
): Promise<Segment[]> {
  const out: Segment[] = [];
  let attempted = 0;
  let failed = 0;
  let reused = 0;

  for (let page = 1; page <= 5; page++) {
    const batch = await api<Array<{ id: number }>>(
      `/segments/starred?per_page=100&page=${page}`,
    );
    if (batch.length === 0) break;
    for (const summary of batch) {
      // Geometry does not change. A segment's polyline, distance and gradient
      // are the same today as yesterday, and re-fetching all of them cost one
      // Strava read each: twenty-seven per cold container against a thousand a
      // day, which this runtime exhausts in a few dozen cold starts. The list
      // above is still fetched live, so starring or unstarring is picked up
      // immediately; only the shape of a segment is remembered.
      const cached = known?.get(summary.id);
      if (cached) {
        out.push({ ...cached, source: "starred" });
        reused++;
        continue;
      }
      attempted++;
      try {
        const detail = await api<StravaSegmentDetail>(`/segments/${summary.id}`);
        const record = normalize(detail, "starred");
        if (record) out.push(record);
      } catch (error) {
        // Strava having stopped answering is not one bad segment.
        if (error instanceof StravaRateLimitError) throw error;
        failed++;
      }
    }
    if (batch.length < 100) break;
  }

  if (reused > 0) {
    console.log(
      `[strava] ${reused} starred segments served from stored geometry, ` +
        `${attempted} fetched`,
    );
  }

  if (attempted > 0 && failed / attempted > MAX_TOLERATED_DETAIL_FAILURE) {
    throw new Error(
      `Strava returned ${failed} of ${attempted} segment details as errors; ` +
        "treating the fetch as failed rather than serving a partial list.",
    );
  }
  return out;
}

export async function exploreSegments(
  lat: number,
  lon: number,
  radiusKm: number,
  limit: number,
  skip: Set<number>,
): Promise<Segment[]> {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  if (!discoveryAffordable()) {
    throw new Error(
      "Skipping discovery to preserve the remaining daily Strava quota for " +
        "starred segments.",
    );
  }
  const bounds = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].join(",");
  const payload = await api<{ segments: Array<{ id: number }> }>(
    `/segments/explore?bounds=${bounds}&activity_type=riding`,
  );

  const out: Segment[] = [];
  for (const summary of payload.segments ?? []) {
    if (out.length >= limit) break;
    if (skip.has(summary.id)) continue;
    try {
      const detail = await api<StravaSegmentDetail>(`/segments/${summary.id}`);
      const record = normalize(detail, "discovered");
      if (record) out.push(record);
    } catch (error) {
      if (error instanceof StravaRateLimitError) throw error;
      // One unreadable discovered segment is genuinely skippable.
    }
  }
  return out;
}

/**
 * Group segments into riding regions. A starred list spans continents, so an
 * averaged centre is meaningless; cluster first and treat each as a region.
 */
export function clusterRegions(
  segments: Segment[],
  radiusKm = 80,
): Segment[][] {
  const mid = (s: Segment): LatLon => s.points[Math.floor(s.points.length / 2)];
  const clusters: Segment[][] = [];

  for (const seg of segments) {
    const found = clusters.find((c) =>
      c.some((other) => haversineM(mid(seg), mid(other)) < radiusKm * 1000),
    );
    if (found) found.push(seg);
    else clusters.push([seg]);
  }

  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const near = clusters[i].some((a) =>
          clusters[j].some((b) => haversineM(mid(a), mid(b)) < radiusKm * 1000),
        );
        if (near) {
          clusters[i] = clusters[i].concat(clusters.splice(j, 1)[0]);
          merged = true;
          break outer;
        }
      }
    }
  }
  return clusters.sort((a, b) => b.length - a.length);
}

export function regionName(cluster: Segment[]): string {
  const counts = new Map<string, number>();
  for (const s of cluster) {
    if (!s.city) continue;
    const key = s.state ? `${s.city}, ${s.state}` : s.city;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return "Unnamed region";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
