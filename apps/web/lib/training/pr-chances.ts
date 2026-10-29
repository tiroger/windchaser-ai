import { normalCdf } from "@/lib/physics";

/**
 * PR chances: the daylight hours of the coming week when the wind view's own
 * prediction for a segment, at the rider's current ability, comes within
 * reach of their record on it.
 *
 * Nothing here predicts anything. Each hour's time comes from evaluate() in
 * lib/physics.ts, exactly as the wind view computes it; this module only
 * decides which of those hours are worth naming, and in what order.
 */

/** Within this fraction of the PR counts as within reach... */
export const REACH_FRACTION = 0.02;
/** ...or within this many seconds, so a short segment is not held to a fraction of a second. */
export const REACH_MIN_SECONDS = 3;
/** Rain chance at or above which an hour is not offered. Matches the planner's WET_PRECIP_PCT. */
export const WET_PRECIP_PCT = 60;
/** At most this many chances are listed, and at most this many per segment. */
export const MAX_CHANCES = 12;
export const MAX_PER_SEGMENT = 2;
/**
 * A record set below this fraction of the power the model says the rider holds
 * there was not an attempt, so beating it is not a chance, just a hard ride.
 * The same fraction calibration uses to tell attempts from riding through.
 */
export const SOFT_POWER_FRACTION = 0.85;
/** A record whose elapsed time is more than this fraction stopped was not ridden through. */
export const SOFT_STOP_FRACTION = 0.05;

/**
 * Model error when a segment has too few attempts to measure its own, as a
 * fraction of the predicted time. From the held-out backtests: a fit across a
 * segment's own attempts misses by about 5% (scripts/evaluate_calibration.py),
 * the rider-level model on a segment it never saw by 8.7%
 * (scripts/evaluate_rider_model.py).
 */
export const FALLBACK_ERROR = { "segment-fit": 0.05, "rider-model": 0.087 } as const;

export type PowerSource = keyof typeof FALLBACK_ERROR;

/** Whether a predicted time is close enough to a PR to name the hour. */
export function withinReach(predictedSeconds: number, prSeconds: number): boolean {
  return predictedSeconds - prSeconds <= Math.max(REACH_MIN_SECONDS, REACH_FRACTION * prSeconds);
}

/** One forecast hour on one segment, as evaluate() saw it. */
export type HourCandidate = {
  segmentId: number;
  /** Forecast wall-clock hour, "YYYY-MM-DDTHH:MM", in the forecast's time zone. */
  time: string;
  /** Epoch seconds at the start of that hour. */
  epoch: number;
  predictedSeconds: number;
  sigmaSeconds: number;
  /** Net tailwind at rider height, m/s. */
  tailwindMs: number;
  /** The 10 m wind, as forecast. */
  windSpeedMs: number;
  windFromDeg: number;
  /** 2 when the whole effort is between sunrise and sunset. */
  daylight: 0 | 1 | 2;
  /** A safety gate failed: gusts, sustained wind, heavy rain or temperature. */
  gated: boolean;
  precipProb: number;
};

/** The record a segment's candidates are measured against. */
export type ChanceTarget = {
  segmentId: number;
  prSeconds: number;
  /** Set when the record was not a real attempt; see isSoftRecord. */
  soft?: boolean;
};

/**
 * Whether a record is soft: ridden easily, or with a stop in it. Judged from
 * the record's own implied power against what the model says the rider can
 * hold on that segment now, and from its stopped time. Never from the time
 * itself, which would make every slow record look beatable by definition.
 */
export function isSoftRecord(record: {
  elapsedSeconds: number;
  movingSeconds: number | null;
  impliedWatts: number | null;
  abilityWatts: number;
}): boolean {
  const moving = record.movingSeconds ?? record.elapsedSeconds;
  if ((record.elapsedSeconds - moving) / record.elapsedSeconds > SOFT_STOP_FRACTION) return true;
  return record.impliedWatts !== null && record.impliedWatts < SOFT_POWER_FRACTION * record.abilityWatts;
}

export type Chance = HourCandidate & {
  /** Predicted minus PR; negative beats it. */
  gapSeconds: number;
  /** Probability of beating the PR under the model's uncertainty. */
  pBeat: number;
};

/** Hours worth riding at all: daylight throughout, no failed gate, not wet, not past. */
export function rideable(candidate: HourCandidate, nowEpoch: number): boolean {
  return (
    candidate.epoch + 3600 > nowEpoch &&
    candidate.daylight === 2 &&
    !candidate.gated &&
    candidate.precipProb < WET_PRECIP_PCT
  );
}

function scored(candidate: HourCandidate, pr: number): Chance {
  const gap = candidate.predictedSeconds - pr;
  return {
    ...candidate,
    gapSeconds: gap,
    pBeat: candidate.sigmaSeconds > 0 ? normalCdf(-gap / candidate.sigmaSeconds) : gap < 0 ? 1 : 0,
  };
}

/** Closest to the PR first, as a fraction of it so long and short segments compare; then likelier; then sooner. */
function byPromise(prs: Map<number, number>) {
  return (a: Chance, b: Chance) =>
    a.gapSeconds / prs.get(a.segmentId)! - b.gapSeconds / prs.get(b.segmentId)! ||
    b.pBeat - a.pBeat ||
    a.epoch - b.epoch;
}

/**
 * The hours to name, best first.
 *
 * Rideable hours within reach of the PR; for each segment, only the best hour
 * of each day, so one windy afternoon does not fill the list with the same
 * segment at 1, 2 and 3 PM.
 */
export function selectChances(
  candidates: HourCandidate[],
  targets: ChanceTarget[],
  nowEpoch: number,
  limit = MAX_CHANCES,
  perSegment = MAX_PER_SEGMENT,
): Chance[] {
  const prs = new Map(targets.filter((t) => !t.soft).map((t) => [t.segmentId, t.prSeconds]));
  const best = new Map<string, Chance>();
  for (const candidate of candidates) {
    const pr = prs.get(candidate.segmentId);
    if (!pr || !rideable(candidate, nowEpoch)) continue;
    if (!withinReach(candidate.predictedSeconds, pr)) continue;
    const chance = scored(candidate, pr);
    const key = `${candidate.segmentId}|${candidate.time.slice(0, 10)}`;
    const held = best.get(key);
    if (!held || byPromise(prs)(chance, held) < 0) best.set(key, chance);
  }
  const counts = new Map<number, number>();
  return [...best.values()]
    .sort(byPromise(prs))
    .filter((chance) => {
      const count = (counts.get(chance.segmentId) ?? 0) + 1;
      counts.set(chance.segmentId, count);
      return count <= perSegment;
    })
    .slice(0, limit);
}

/**
 * Each segment's single best rideable hour of the week, within reach or not,
 * closest first: what to show when nothing is within reach, and the honest
 * answer to "how far off am I?". Soft records are measured like any other;
 * the caller decides whether to list them.
 */
export function closestHours(
  candidates: HourCandidate[],
  targets: ChanceTarget[],
  nowEpoch: number,
): Chance[] {
  const prs = new Map(targets.map((t) => [t.segmentId, t.prSeconds]));
  const best = new Map<number, Chance>();
  for (const candidate of candidates) {
    const pr = prs.get(candidate.segmentId);
    if (!pr || !rideable(candidate, nowEpoch)) continue;
    const chance = scored(candidate, pr);
    const held = best.get(candidate.segmentId);
    if (!held || byPromise(prs)(chance, held) < 0) best.set(candidate.segmentId, chance);
  }
  return [...best.values()].sort(byPromise(prs));
}
