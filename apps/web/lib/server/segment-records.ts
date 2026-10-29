import "server-only";

import { airDensity, calibratedPower, sectionsFor } from "@/lib/physics";
import { applyCalibration } from "@/lib/server/calibration";
import { cellId, cellOf } from "@/lib/server/weather";
import { ridingFromDates } from "@/lib/segment-candidates";
import { segmentIndex, type SegmentCache } from "@/lib/training/loops-data";
import { FALLBACK_ERROR, isSoftRecord, type PowerSource } from "@/lib/training/pr-chances";
import { effortRank } from "@/lib/training/segments";
import { sectionTailwinds, timeAtPower } from "@/lib/training/still-air";
import type { LatLon, Segment, SegmentRecord, StillAirEntry } from "@/lib/types";

/**
 * The tracked segments, from the effort history strava_worker keeps, as wind
 * view candidates: each with its line, how much and how lately it is ridden,
 * and the rider's record on it -- PR, whether that PR was a real attempt, the
 * still-air best and leaderboard, and how far the model typically misses
 * here.
 *
 * Only what the wind view shows leaves this module: names, times, dates and
 * activity IDs. Efforts, power and weather stay on the server.
 */

/** Still-air entries listed per segment. */
const STILL_AIR_TOP = 5;
/** Fewest hard efforts on a segment before its own error replaces the backtest's. */
const MIN_ERROR_ATTEMPTS = 3;

const round1 = (value: number) => Math.round(value * 10) / 10;

type Facts = {
  id: number;
  efforts: number[];
  /** Index of the PR effort: fastest elapsed, earliest between equals. */
  pr: number;
};

function factsOf(index: SegmentCache): Facts[] {
  const { history } = index;
  const bySegment = new Map<number, number[]>();
  history.efforts.forEach((effort, i) => {
    const list = bySegment.get(effort.segment_id) ?? [];
    list.push(i);
    bySegment.set(effort.segment_id, list);
  });
  const out: Facts[] = [];
  for (const [id, efforts] of bySegment) {
    const points = history.segments[String(id)]?.points;
    if (!points || points.length < 2) continue;
    let pr = efforts[0];
    for (const i of efforts) {
      const e = history.efforts[i];
      const p = history.efforts[pr];
      if (e.elapsed_time_s < p.elapsed_time_s || (e.elapsed_time_s === p.elapsed_time_s && e.start_date < p.start_date)) {
        pr = i;
      }
    }
    out.push({ id, efforts, pr });
  }
  return out;
}

/** Local date of an effort: its activity's, else the UTC date. */
function effortDate(index: SegmentCache, i: number): string {
  const activity = index.links.get(i) ?? null;
  return ((activity && index.dates.get(activity)) || index.history.efforts[i].start_date).slice(0, 10);
}

/**
 * How far the model typically misses on this segment: its prediction for each
 * of the rider's hard efforts here, in that effort's recorded weather, against
 * the moving time actually ridden. Hard efforts are chosen by measured power,
 * never by time, as calibration chooses them. Where there are too few, the
 * held-out backtest's figure for the kind of fit in use.
 */
function modelError(
  segment: Segment,
  facts: Facts,
  index: SegmentCache,
  watts: number,
  source: PowerSource,
): { seconds: number; source: "attempts" | "backtest" } {
  const efforts = facts.efforts.map((i) => index.history.efforts[i]);
  const powered = efforts.filter((e) => e.device_watts && e.average_watts && e.weather);
  const sorted = powered.map((e) => e.average_watts!).sort((a, b) => a - b);
  const reference = sorted[Math.floor(0.9 * (sorted.length - 1))] ?? 0;
  const attempts = powered.filter((e) => e.average_watts! >= 0.85 * reference);
  const sections = sectionsFor(segment);
  const rider = { ...index.rider, power_w: watts };
  if (attempts.length >= MIN_ERROR_ATTEMPTS && sections.length) {
    const misses = attempts.map((e) => {
      const w = e.weather!;
      const rho = airDensity(w.temperature_c ?? 15, w.pressure_hpa ?? 1013, w.humidity_pct ?? 60);
      const tails = sectionTailwinds(sections, w.wind_from_deg ?? 0, w.wind_speed_ms ?? 0);
      const moving = Math.min(e.moving_time_s || e.elapsed_time_s, e.elapsed_time_s);
      return Math.abs(timeAtPower(sections, rider, watts, tails, rho) - moving);
    });
    return { seconds: misses.reduce((a, b) => a + b, 0) / misses.length, source: "attempts" };
  }
  return { seconds: FALLBACK_ERROR[source] * index.history.efforts[facts.pr].elapsed_time_s, source: "backtest" };
}

/** The still-air part of a record: best, the PR's place, and the fastest few. */
function stillAirRecord(index: SegmentCache, facts: Facts): SegmentRecord["still_air"] {
  const adjusted: Array<{ i: number; still: number }> = [];
  for (const i of facts.efforts) {
    const result = index.stillAir.results[i];
    if (result?.kind === "adjusted") adjusted.push({ i, still: round1(result.stillAirSeconds) });
  }
  if (!adjusted.length) return null;
  adjusted.sort((a, b) => a.still - b.still || index.history.efforts[a.i].start_date.localeCompare(index.history.efforts[b.i].start_date));
  const best = adjusted[0];
  const prStill = adjusted.find((entry) => entry.i === facts.pr)?.still ?? null;
  const top: StillAirEntry[] = adjusted.slice(0, STILL_AIR_TOP).map(({ i, still }) => ({
    date: effortDate(index, i),
    activity_id: index.links.get(i) ?? null,
    still_air_s: still,
    elapsed_s: index.history.efforts[i].elapsed_time_s,
  }));
  return {
    best_s: best.still,
    best_date: effortDate(index, best.i),
    best_activity_id: index.links.get(best.i) ?? null,
    count: adjusted.length,
    pr_rank: prStill === null ? null : effortRank(prStill, adjusted.map((entry) => entry.still)),
    check: index.stillAir.checks.get(facts.id) ?? "unchecked",
    top,
  };
}

/** Profile points sent per segment; the raw stream can run to thousands. */
const MAX_PROFILE_POINTS = 300;

function thinProfile(profile: Segment["elevation_profile"]): Segment["elevation_profile"] {
  if (!profile || profile.distance_m.length <= MAX_PROFILE_POINTS) return profile;
  const n = profile.distance_m.length;
  const step = (n - 1) / (MAX_PROFILE_POINTS - 1);
  const picks = Array.from({ length: MAX_PROFILE_POINTS }, (_, k) => Math.round(k * step));
  return {
    distance_m: picks.map((i) => profile.distance_m[i]),
    altitude_m: picks.map((i) => profile.altitude_m[i]),
  };
}

/** Every tracked segment with history, as a candidate carrying its record. */
export async function trackedSegments(nowMs = Date.now()): Promise<Segment[]> {
  const index = await segmentIndex();
  return buildTracked(index, nowMs);
}

async function buildTracked(index: SegmentCache, nowMs: number): Promise<Segment[]> {
  const { history } = index;
  const facts = factsOf(index);
  const segments: Segment[] = facts.map((f) => {
    const stored = history.segments[String(f.id)];
    const points = stored.points as LatLon[];
    const middle = points[Math.floor(points.length / 2)];
    const pr = history.efforts[f.pr];
    const prActivity = index.links.get(f.pr) ?? null;
    return {
      id: f.id,
      name: stored.name,
      source: "tracked",
      distance_m: stored.distance_m ?? 0,
      average_grade: stored.average_grade ?? 0,
      maximum_grade: 0,
      elevation_high: 0,
      elevation_low: 0,
      total_elevation_gain: 0,
      climb_category: 0,
      city: null,
      state: null,
      effort_count: null,
      athlete_count: null,
      star_count: null,
      pr_elapsed_time: pr.elapsed_time_s,
      pr_date: effortDate(index, f.pr),
      effort_count_personal: f.efforts.length,
      points,
      region_id: "",
      cell_id: cellId(cellOf(middle[0], middle[1])),
      elevation_profile: thinProfile(stored.elevation_profile ?? null),
      riding: ridingFromDates(
        f.efforts.map((i) => history.efforts[i].start_date),
        nowMs,
      ),
      record: {
        pr_elapsed_s: pr.elapsed_time_s,
        pr_date: effortDate(index, f.pr),
        pr_activity_id: prActivity,
        soft: false,
        model_error_s: 0,
        model_error_source: "backtest",
        still_air: stillAirRecord(index, f),
      },
    };
  });

  // Soft records and model error are judged at the power the wind view
  // predicts with, so calibration goes on first, exactly as the route will
  // apply it again later.
  await applyCalibration(segments);
  segments.forEach((segment, k) => {
    const f = facts[k];
    const source: PowerSource = segment.calibrated_power_w ? "segment-fit" : "rider-model";
    const watts = calibratedPower(segment);
    const error = modelError(segment, f, index, watts, source);
    const result = index.stillAir.results[f.pr];
    const pr = history.efforts[f.pr];
    segment.record!.soft = isSoftRecord({
      elapsedSeconds: pr.elapsed_time_s,
      movingSeconds: pr.moving_time_s ?? null,
      impliedWatts: result?.kind === "adjusted" ? result.impliedWatts : null,
      abilityWatts: watts,
    });
    segment.record!.model_error_s = Math.round(error.seconds);
    segment.record!.model_error_source = error.source;
  });
  return segments;
}
