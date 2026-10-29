import { haversineM } from "./geo";
import type { LatLon, Region, Segment, SegmentRiding, SegmentSource } from "./types";

/**
 * Which segments the wind view offers, and how its regions are formed and
 * named.
 *
 * The candidates are what the rider actually rides, from three sources:
 * segments starred on Strava, segments with effort history (the tracked set
 * strava_worker keeps), and segments discovered around the rider's position.
 * One segment can come from several; it is listed once and marked with all
 * of them.
 *
 * Pure, so the merging, the recency weighting and the region naming are
 * testable without Strava or S3.
 */

/** An effort counts half as much for every this many days of age. */
export const RECENCY_HALF_LIFE_DAYS = 180;

/**
 * A segment the rider does not ride ranks at this fraction of its score; one
 * ridden RECENT_FOR_FULL_WEIGHT recency-weighted times or more at its full
 * score. The score itself, and the chance it reports, are unchanged.
 */
export const RANK_FLOOR = 0.8;
export const RECENT_FOR_FULL_WEIGHT = 2;

/** Strongest first: a starred segment's Strava detail is the best record of it. */
export const SOURCE_ORDER: readonly SegmentSource[] = ["starred", "tracked", "discovered"];

const DAY_MS = 86_400_000;

/** One effort's weight at its age. */
export function ageWeight(dateIso: string, nowMs: number): number {
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (nowMs - t) / DAY_MS);
  return 0.5 ** (days / RECENCY_HALF_LIFE_DAYS);
}

/** Riding on a segment from the dates of every effort on it. */
export function ridingFromDates(dates: string[], nowMs: number): SegmentRiding {
  let last: string | null = null;
  let recent = 0;
  for (const date of dates) {
    recent += ageWeight(date, nowMs);
    if (!last || date > last) last = date;
  }
  return { attempts: dates.length, last_ridden: last, recent: round3(recent) };
}

/**
 * A usage entry, as strava_worker counts it into segment-usage.json from
 * each ingested activity. It has no line, so it cannot be forecast on its
 * own; it tells the wind view how often and how lately a segment is ridden.
 */
export interface UsageEntry {
  id: number;
  name: string | null;
  start: LatLon | null;
  distance_m: number | null;
  average_grade: number | null;
  count: number;
  last_ridden: string | null;
}

/** segment-usage.json, validated. Malformed entries are dropped. */
export function parseUsage(raw: unknown): Map<number, UsageEntry> {
  const out = new Map<number, UsageEntry>();
  const segments = (raw as { segments?: unknown } | null)?.segments;
  if (!segments || typeof segments !== "object") return out;
  for (const value of Object.values(segments as Record<string, unknown>)) {
    const entry = value as Partial<UsageEntry> | null;
    const id = Number(entry?.id);
    const count = Number(entry?.count);
    if (!entry || !Number.isFinite(id) || !Number.isFinite(count) || count <= 0) continue;
    out.set(id, {
      id,
      name: typeof entry.name === "string" ? entry.name : null,
      start: Array.isArray(entry.start) && entry.start.length >= 2 ? [Number(entry.start[0]), Number(entry.start[1])] : null,
      distance_m: typeof entry.distance_m === "number" ? entry.distance_m : null,
      average_grade: typeof entry.average_grade === "number" ? entry.average_grade : null,
      count,
      last_ridden: typeof entry.last_ridden === "string" ? entry.last_ridden : null,
    });
  }
  return out;
}

/**
 * Riding from a usage count. Usage keeps only the latest date, so every
 * effort is weighted as if it were that recent: an upper bound, which the
 * effort history replaces wherever there is one.
 */
export function ridingFromUsage(entry: UsageEntry, nowMs: number): SegmentRiding {
  const weight = entry.last_ridden ? ageWeight(entry.last_ridden, nowMs) : 0;
  return { attempts: entry.count, last_ridden: entry.last_ridden, recent: round3(entry.count * weight) };
}

/** The fuller of two accounts of the same riding. */
export function mergeRiding(
  a: SegmentRiding | null | undefined,
  b: SegmentRiding | null | undefined,
): SegmentRiding | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const last = !a.last_ridden ? b.last_ridden : !b.last_ridden ? a.last_ridden : a.last_ridden > b.last_ridden ? a.last_ridden : b.last_ridden;
  return { attempts: Math.max(a.attempts, b.attempts), last_ridden: last, recent: Math.max(a.recent, b.recent) };
}

/**
 * Every source's segments as one list: each segment once, with the geometry
 * and figures of its strongest source, gaps filled from the others, and every
 * source it came from. Usage adds riding to whichever candidate it matches.
 */
export function mergeCandidates(
  groups: Partial<Record<SegmentSource, Segment[]>>,
  usage: Map<number, UsageEntry> = new Map(),
  nowMs = Date.now(),
): Segment[] {
  const byId = new Map<number, Segment>();
  for (const source of SOURCE_ORDER) {
    for (const segment of groups[source] ?? []) {
      if (!segment.points || segment.points.length < 2) continue;
      const held = byId.get(segment.id);
      if (!held) {
        byId.set(segment.id, { ...segment, source, sources: [source] });
        continue;
      }
      if (!held.sources!.includes(source)) held.sources!.push(source);
      held.city ??= segment.city;
      held.state ??= segment.state;
      held.elevation_profile ??= segment.elevation_profile;
      held.record ??= segment.record;
      held.riding = mergeRiding(held.riding, segment.riding);
      // The effort history is kept current by the webhook; a starred segment's
      // PR can be as old as the saved geometry it was read from.
      if (source === "tracked" && segment.pr_elapsed_time) {
        held.pr_elapsed_time = segment.pr_elapsed_time;
        held.pr_date = segment.pr_date;
        held.effort_count_personal = segment.effort_count_personal;
      }
    }
  }
  for (const segment of byId.values()) {
    const used = usage.get(segment.id);
    if (used) segment.riding = mergeRiding(segment.riding, ridingFromUsage(used, nowMs));
  }
  return [...byId.values()];
}

/** How much a segment's riding lifts it in the ranking, from RANK_FLOOR to 1. */
export function rankFactor(riding: SegmentRiding | null | undefined): number {
  const recent = riding?.recent ?? 0;
  return RANK_FLOOR + (1 - RANK_FLOOR) * Math.min(1, recent / RECENT_FOR_FULL_WEIGHT);
}

/** The order the rail lists segments in: the score, weighted toward recent riding. */
export function rankScore(score: number, riding: SegmentRiding | null | undefined): number {
  return score * rankFactor(riding);
}

const mid = (s: Segment): LatLon => s.points[Math.floor(s.points.length / 2)];

/**
 * Group segments into riding regions. A starred list spans continents, so an
 * averaged centre is meaningless; cluster first and treat each as a region.
 */
export function clusterRegions(segments: Segment[], radiusKm = 80): Segment[][] {
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

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/**
 * Strava spells the same state both ways ("California" and "CA"), which split
 * one town's votes in two. US states become their postal codes; anything else
 * is kept as written.
 */
export function normaliseState(state: string | null | undefined): string | null {
  const trimmed = state?.trim();
  if (!trimmed) return null;
  return US_STATES[trimmed.toLowerCase()] ?? trimmed;
}

/** Below this, a segment's riding barely counts toward naming its region. */
const UNRIDDEN_VOTE = 0.05;

/**
 * A region is named after where the rider rides most. Each segment votes for
 * its town with its recency-weighted riding, so a climb ridden every week
 * outvotes a handful of starred segments never ridden. With no riding at
 * all, the most common town wins, as before.
 */
export function regionName(cluster: Segment[]): string {
  const votes = new Map<string, number>();
  for (const s of cluster) {
    if (!s.city) continue;
    const state = normaliseState(s.state);
    const key = state ? `${s.city.trim()}, ${state}` : s.city.trim();
    votes.set(key, (votes.get(key) ?? 0) + UNRIDDEN_VOTE + (s.riding?.recent ?? 0));
  }
  if (votes.size === 0) return "Unnamed region";
  return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Regions from the candidates, each segment given its region's id. Ordered by
 * recency-weighted riding, so the first region is where the rider rides now,
 * not the one with the most segments in it.
 */
export function buildRegions(segments: Segment[]): Region[] {
  const clusters = clusterRegions(segments).map((cluster) => ({
    cluster,
    recent: cluster.reduce((sum, s) => sum + (s.riding?.recent ?? 0), 0),
  }));
  clusters.sort((a, b) => b.recent - a.recent || b.cluster.length - a.cluster.length);
  return clusters.map(({ cluster, recent }, index) => {
    const id = `r${index}`;
    const mids = cluster.map(mid);
    for (const seg of cluster) seg.region_id = id;
    const count = (source: SegmentSource) => cluster.filter((s) => (s.sources ?? [s.source]).includes(source)).length;
    return {
      id,
      name: regionName(cluster),
      lat: mids.reduce((s, m) => s + m[0], 0) / mids.length,
      lon: mids.reduce((s, m) => s + m[1], 0) / mids.length,
      starred_count: count("starred"),
      tracked_count: count("tracked"),
      discovered_count: count("discovered"),
      segment_count: cluster.length,
      recent: round3(recent),
    };
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
