import "server-only";

import { airDensity, calibratedPower, evaluate, sectionsFor } from "@/lib/physics";
import { haversineM } from "@/lib/geo";
import { applyCalibration } from "@/lib/server/calibration";
import { localToEpoch } from "@/lib/server/route-forecast";
import { cellId, cellOf, fetchCells } from "@/lib/server/weather";
import { segmentIndex, type SegmentCache } from "@/lib/training/loops-data";
import {
  chooseSegments,
  closestHours,
  FALLBACK_ERROR,
  HOME_RADIUS_KM,
  isSoftRecord,
  selectChances,
  ttlCache,
  type Chance,
  type HourCandidate,
  type PowerSource,
} from "@/lib/training/pr-chances";
import { daylightFlag, sunTimes } from "@/lib/training/route-forecast";
import type { StillAirCheck } from "@/lib/training/segments";
import { sectionTailwinds, timeAtPower } from "@/lib/training/still-air";
import type { LatLon, Segment } from "@/lib/types";

/**
 * PR chances and still-air leaderboards for the Segments page.
 *
 * Only names, times, dates and activity IDs leave this module. Segment lines
 * are needed to forecast and to adjust for wind, and stay here.
 */

/** A chance or near miss, as the page shows it. */
export type ChanceView = {
  segmentId: number;
  name: string;
  distanceM: number | null;
  averageGrade: number | null;
  /** Forecast wall-clock hour in `timezone`, "YYYY-MM-DDTHH:MM". */
  time: string;
  predictedSeconds: number;
  prSeconds: number;
  gapSeconds: number;
  pBeat: number;
  tailwindMs: number;
  windSpeedMs: number;
  windFromDeg: number;
  /** Typical miss of the model on this segment, seconds. */
  errorSeconds: number;
  /** "attempts" when measured on this segment's own hard efforts; else the backtest's figure. */
  errorSource: "attempts" | "backtest";
  powerSource: PowerSource;
  watts: number;
  prDate: string;
  prActivityId: string | null;
  bestStillAirSeconds: number | null;
  /** The record was ridden easily or with a stop; see isSoftRecord. */
  softRecord: boolean;
};

export type PrChancesData = {
  generatedAt: string;
  timezone: string;
  /** Within reach of the PR, best first. */
  chances: ChanceView[];
  /** Each forecast segment's best hour when it is not within reach, closest first. */
  closest: ChanceView[];
  /** Segments whose record was not a real attempt, each with its best hour. */
  soft: ChanceView[];
  forecastSegments: number;
  cells: number;
  failedCells: number;
  /** Segments near home left out by the caps. */
  skipped: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

type SegmentFacts = {
  id: number;
  name: string;
  distanceM: number | null;
  averageGrade: number | null;
  mid: LatLon;
  lastRidden: string;
  pr: {
    seconds: number;
    movingSeconds: number | null;
    impliedWatts: number | null;
    date: string;
    activityId: string | null;
  };
  bestStillAirSeconds: number | null;
  efforts: number[];
};

/** Per segment with history: its record, best still-air time and effort indices. */
function segmentFacts(index: SegmentCache): SegmentFacts[] {
  const { history, links, dates, stillAir } = index;
  const bySegment = new Map<number, number[]>();
  history.efforts.forEach((effort, i) => {
    const list = bySegment.get(effort.segment_id) ?? [];
    list.push(i);
    bySegment.set(effort.segment_id, list);
  });
  const facts: SegmentFacts[] = [];
  for (const [id, efforts] of bySegment) {
    const segment = history.segments[String(id)];
    const points = segment?.points;
    if (!segment || !points || points.length < 2) continue;
    let pr = efforts[0];
    let last = efforts[0];
    let bestStill: number | null = null;
    for (const i of efforts) {
      const e = history.efforts[i];
      const p = history.efforts[pr];
      if (e.elapsed_time_s < p.elapsed_time_s || (e.elapsed_time_s === p.elapsed_time_s && e.start_date < p.start_date)) {
        pr = i;
      }
      if (e.start_date > history.efforts[last].start_date) last = i;
      const result = stillAir.results[i];
      if (result?.kind === "adjusted" && (bestStill === null || result.stillAirSeconds < bestStill)) {
        bestStill = result.stillAirSeconds;
      }
    }
    const prActivity = links.get(pr) ?? null;
    facts.push({
      id,
      name: segment.name,
      distanceM: segment.distance_m ?? null,
      averageGrade: segment.average_grade ?? null,
      mid: points[Math.floor(points.length / 2)],
      lastRidden: history.efforts[last].start_date,
      pr: {
        seconds: history.efforts[pr].elapsed_time_s,
        movingSeconds: history.efforts[pr].moving_time_s ?? null,
        impliedWatts: (() => {
          const result = stillAir.results[pr];
          return result?.kind === "adjusted" ? result.impliedWatts : null;
        })(),
        date: ((prActivity && dates.get(prActivity)) || history.efforts[pr].start_date).slice(0, 10),
        activityId: prActivity,
      },
      bestStillAirSeconds: bestStill === null ? null : round1(bestStill),
      efforts,
    });
  }
  return facts;
}

/** The wind view's Segment, built from the effort history's copy of it. */
function asSegment(facts: SegmentFacts, index: SegmentCache): Segment {
  const stored = index.history.segments[String(facts.id)];
  return {
    id: facts.id,
    name: facts.name,
    source: "starred",
    distance_m: facts.distanceM ?? 0,
    average_grade: facts.averageGrade ?? 0,
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
    pr_elapsed_time: facts.pr.seconds,
    pr_date: facts.pr.date,
    effort_count_personal: facts.efforts.length,
    points: stored?.points ?? [],
    region_id: "",
    cell_id: cellId(cellOf(facts.mid[0], facts.mid[1])),
    elevation_profile: stored?.elevation_profile ?? null,
  };
}

/** Fewest hard efforts on a segment before its own error replaces the backtest's. */
const MIN_ERROR_ATTEMPTS = 3;

/**
 * How far the model typically misses on this segment: its prediction for each
 * of the rider's hard efforts here, in that effort's recorded weather, against
 * the moving time actually ridden. Hard efforts are chosen by measured power,
 * never by time, as calibration chooses them. Where there are too few, the
 * held-out backtest's figure for the kind of fit in use.
 */
function modelError(
  segment: Segment,
  facts: SegmentFacts,
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
  return { seconds: FALLBACK_ERROR[source] * facts.pr.seconds, source: "backtest" };
}

const cache = ttlCache<PrChancesData>(30 * 60 * 1000);

/**
 * PR chances for the coming week, cached for as long as the forecast cells
 * are (30 minutes) and recomputed early when the effort history changes.
 */
export async function loadPrChances(): Promise<PrChancesData> {
  const index = await segmentIndex();
  return cache.get(index.key, () => computePrChances(index));
}

async function computePrChances(index: SegmentCache, nowMs = Date.now()): Promise<PrChancesData> {
  const facts = segmentFacts(index);
  const cellKey = (point: LatLon) => cellId(cellOf(point[0], point[1]));
  const { chosen, cells, skipped } = chooseSegments(facts, cellKey);

  const segments = chosen.map((f) => asSegment(f, index));
  await applyCalibration(segments);

  const fetched = await fetchCells(
    cells.map((id) => id.split(",").map(Number) as [number, number]),
  );

  const candidates: HourCandidate[] = [];
  const soft = new Set<number>();
  const meta = new Map<number, Omit<ChanceView, keyof HourCandidateView>>();
  let timezone = "UTC";
  const nowEpoch = nowMs / 1000;

  segments.forEach((segment, k) => {
    const f = chosen[k];
    const cell = fetched.cells[segment.cell_id];
    if (!cell) return;
    timezone = cell.timezone || timezone;
    const source: PowerSource = segment.calibrated_power_w ? "segment-fit" : "rider-model";
    const watts = calibratedPower(segment);
    const error = modelError(segment, f, index, watts, source);
    const isSoft = isSoftRecord({
      elapsedSeconds: f.pr.seconds,
      movingSeconds: f.pr.movingSeconds,
      impliedWatts: f.pr.impliedWatts,
      abilityWatts: watts,
    });
    if (isSoft) soft.add(segment.id);
    meta.set(segment.id, {
      softRecord: isSoft,
      segmentId: segment.id,
      name: f.name,
      distanceM: f.distanceM,
      averageGrade: f.averageGrade,
      prSeconds: f.pr.seconds,
      errorSeconds: Math.round(error.seconds),
      errorSource: error.source,
      powerSource: source,
      watts: Math.round(watts),
      prDate: f.pr.date,
      prActivityId: f.pr.activityId,
      bestStillAirSeconds: f.bestStillAirSeconds,
    });

    const sun = new Map<string, ReturnType<typeof sunTimes>>();
    cell.time.forEach((time, hour) => {
      const epoch = localToEpoch(time, cell.timezone || "UTC", cell.utc_offset_seconds);
      if (epoch + 3600 <= nowEpoch) return;
      const date = time.slice(0, 10);
      if (!sun.has(date)) sun.set(date, sunTimes(date, f.mid[0], f.mid[1]));
      const ev = evaluate(segment, cell, hour);
      candidates.push({
        segmentId: segment.id,
        time,
        epoch,
        predictedSeconds: ev.predicted_time_s,
        sigmaSeconds: ev.sigma_s,
        tailwindMs: ev.effective_tailwind_ms,
        windSpeedMs: ev.weather.wind_speed_ms,
        windFromDeg: ev.weather.wind_from_deg,
        daylight: daylightFlag(epoch, ev.predicted_time_s, sun.get(date)!),
        gated: ev.gates.length > 0,
        precipProb: cell.precip_prob[hour] ?? 0,
      });
    });
  });

  const targets = chosen.map((f) => ({ segmentId: f.id, prSeconds: f.pr.seconds, soft: soft.has(f.id) }));
  const view = (chance: Chance): ChanceView => ({
    ...meta.get(chance.segmentId)!,
    time: chance.time,
    predictedSeconds: round1(chance.predictedSeconds),
    gapSeconds: round1(chance.gapSeconds),
    pBeat: Math.round(chance.pBeat * 100) / 100,
    tailwindMs: round1(chance.tailwindMs),
    windSpeedMs: round1(chance.windSpeedMs),
    windFromDeg: Math.round(chance.windFromDeg),
  });

  const chances = selectChances(candidates, targets, nowEpoch);
  const within = new Set(chances.map((c) => c.segmentId));
  const best = closestHours(candidates, targets, nowEpoch);
  const closest = best.filter((c) => !within.has(c.segmentId) && !soft.has(c.segmentId)).slice(0, 6);
  const softBest = best.filter((c) => soft.has(c.segmentId));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    timezone,
    chances: chances.map(view),
    closest: closest.map(view),
    soft: softBest.map(view),
    forecastSegments: meta.size,
    cells: cells.length,
    failedCells: fetched.failed.length,
    skipped,
  };
}

type HourCandidateView = Pick<
  ChanceView,
  "time" | "predictedSeconds" | "gapSeconds" | "pBeat" | "tailwindMs" | "windSpeedMs" | "windFromDeg"
>;

// ------------------------------------------------------- leaderboards --

export type LeaderEntry = {
  date: string;
  activityId: string | null;
  elapsedSeconds: number;
  stillAirSeconds: number | null;
  tailwindMs: number | null;
};

export type Leaderboard = {
  segmentId: number;
  name: string;
  distanceM: number | null;
  averageGrade: number | null;
  efforts: number;
  /** Efforts with a still-air time. */
  adjusted: number;
  lastRidden: string;
  /** Within HOME_RADIUS_KM of where the rider last rode a tracked segment. */
  nearHome: boolean;
  check: StillAirCheck;
  /** Fastest first, by recorded time and by still-air time. */
  recorded: LeaderEntry[];
  stillAir: LeaderEntry[];
};

/** Segments need this many efforts to have a leaderboard worth showing. */
const MIN_LEADERBOARD_EFFORTS = 3;
const LEADERBOARD_SIZE = 5;

/** Fastest efforts on every segment ridden often enough, recorded and in still air. */
export async function loadLeaderboards(): Promise<Leaderboard[]> {
  const index = await segmentIndex();
  const { history, links, dates, stillAir } = index;
  const boards: Leaderboard[] = [];
  const facts = segmentFacts(index);
  const latest = facts.reduce<SegmentFacts | null>(
    (best, f) => (!best || f.lastRidden > best.lastRidden ? f : best),
    null,
  );
  for (const f of facts) {
    if (f.efforts.length < MIN_LEADERBOARD_EFFORTS) continue;
    const entries = f.efforts.map((i) => {
      const e = history.efforts[i];
      const r = stillAir.results[i];
      const activity = links.get(i) ?? null;
      return {
        date: ((activity && dates.get(activity)) || e.start_date).slice(0, 10),
        activityId: activity,
        elapsedSeconds: e.elapsed_time_s,
        stillAirSeconds: r?.kind === "adjusted" ? round1(r.stillAirSeconds) : null,
        tailwindMs: r?.kind === "adjusted" ? round1(r.tailwindMs) : null,
      };
    });
    const recorded = [...entries].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds || a.date.localeCompare(b.date));
    const still = entries
      .filter((e) => e.stillAirSeconds !== null)
      .sort((a, b) => a.stillAirSeconds! - b.stillAirSeconds! || a.date.localeCompare(b.date));
    boards.push({
      segmentId: f.id,
      name: f.name,
      distanceM: f.distanceM,
      averageGrade: f.averageGrade,
      efforts: f.efforts.length,
      adjusted: still.length,
      lastRidden: f.lastRidden.slice(0, 10),
      nearHome: !!latest && haversineM(latest.mid, f.mid) <= HOME_RADIUS_KM * 1000,
      check: stillAir.checks.get(f.id) ?? "unchecked",
      recorded: recorded.slice(0, LEADERBOARD_SIZE),
      stillAir: still.slice(0, LEADERBOARD_SIZE),
    });
  }
  return boards.sort((a, b) => b.lastRidden.localeCompare(a.lastRidden));
}
