import {
  closestHours,
  rideable,
  selectChances,
  type Chance,
  type ChanceTarget,
  type HourCandidate,
} from "@/lib/training/pr-chances";
import { daylightFlag, sunTimes } from "@/lib/training/route-forecast";
import { localToEpoch } from "@/lib/time";
import type { Evaluation, ForecastCell, Segment } from "@/lib/types";

/**
 * "Best chances this week", from the very evaluations the wind view ranks
 * with.
 *
 * The rail and the chances are two readings of one matrix: every segment,
 * every forecast hour, through evaluate() in lib/physics.ts. The target is
 * the one evaluate() measures against (best moving time where the history
 * has it, else Strava's PR), so a chance's probability is the evaluation's
 * own p_beat. Only the choice of hours differs: the chances name daylight
 * hours, not wet and not gated, within reach of the record
 * (lib/training/pr-chances.ts); the rail takes each segment's best score
 * among the same rideable hours.
 */

/** A chance with the segment it is on and the forecast hour it falls in. */
export type WindChance = Chance & { segment: Segment; hourIndex: number };

export type WeekChances = {
  /** Within reach of the record, best first. */
  chances: WindChance[];
  /** Each segment's best rideable hour when it is not within reach, closest first. */
  closest: WindChance[];
  /** Segments whose record was not a real attempt, each with its best hour. */
  soft: WindChance[];
};

/** At most this many near misses are listed. */
export const MAX_CLOSEST = 5;

/** The record evaluate() compares against, as the chances must too. */
export function targetSeconds(segment: Segment): number | null {
  return segment.best_moving_time_s ?? segment.pr_elapsed_time ?? null;
}

/**
 * Hour candidates for every segment and hour, with the facts rideable()
 * needs: the instant, daylight for the whole effort, gates and rain.
 */
export function hourCandidates(
  segments: Segment[],
  matrix: Map<number, Evaluation[]>,
  cellFor: (cellId: string) => ForecastCell | null,
): { candidates: HourCandidate[]; hours: Map<string, number> } {
  const candidates: HourCandidate[] = [];
  const hours = new Map<string, number>();
  for (const segment of segments) {
    const series = matrix.get(segment.id);
    const cell = cellFor(segment.cell_id);
    if (!series || !cell) continue;
    const middle = segment.points[Math.floor(segment.points.length / 2)];
    const sun = new Map<string, ReturnType<typeof sunTimes>>();
    series.forEach((ev, hour) => {
      const time = cell.time[hour];
      if (!time) return;
      const epoch = localToEpoch(time, cell.timezone || "UTC", cell.utc_offset_seconds ?? 0);
      const date = time.slice(0, 10);
      if (!sun.has(date)) sun.set(date, sunTimes(date, middle[0], middle[1]));
      hours.set(`${segment.id}|${time}`, hour);
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
  }
  return { candidates, hours };
}

/** The forecast hours a segment can actually be ridden in, as indices. */
export function rideableHours(
  segment: Segment,
  matrix: Map<number, Evaluation[]>,
  cellFor: (cellId: string) => ForecastCell | null,
  nowMs: number,
): number[] {
  const { candidates, hours } = hourCandidates([segment], matrix, cellFor);
  return candidates
    .filter((c) => rideable(c, nowMs / 1000))
    .map((c) => hours.get(`${c.segmentId}|${c.time}`)!);
}

/** The week's chances, near misses and soft records for these segments. */
export function weekChances(
  segments: Segment[],
  matrix: Map<number, Evaluation[]>,
  cellFor: (cellId: string) => ForecastCell | null,
  nowMs: number,
): WeekChances {
  const { candidates, hours } = hourCandidates(segments, matrix, cellFor);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const targets: ChanceTarget[] = [];
  for (const segment of segments) {
    const target = targetSeconds(segment);
    if (target) targets.push({ segmentId: segment.id, prSeconds: target, soft: Boolean(segment.record?.soft) });
  }
  const soft = new Set(targets.filter((t) => t.soft).map((t) => t.segmentId));
  const nowEpoch = nowMs / 1000;
  const wrap = (chance: Chance): WindChance => ({
    ...chance,
    segment: byId.get(chance.segmentId)!,
    hourIndex: hours.get(`${chance.segmentId}|${chance.time}`) ?? 0,
  });

  const chances = selectChances(candidates, targets, nowEpoch);
  const within = new Set(chances.map((c) => c.segmentId));
  const best = closestHours(candidates, targets, nowEpoch);
  return {
    chances: chances.map(wrap),
    closest: best
      .filter((c) => !within.has(c.segmentId) && !soft.has(c.segmentId))
      .slice(0, MAX_CLOSEST)
      .map(wrap),
    soft: best.filter((c) => soft.has(c.segmentId)).map(wrap),
  };
}
