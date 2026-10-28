import {
  calendarDate,
  getActivityKind,
  isoDate,
  type Activity,
  type CalendarDate,
} from "@/lib/training/activity-types";

import {
  FOCUS_MODEL,
  LOAD_RATIO,
  LOAD_WINDOWS,
  POWER_MODEL,
  SUMMARY_MODEL,
  VO2MAX_MODEL,
} from "./load-params";
import type { StreamsIndex } from "./performance";

/**
 * Garmin-style exercise load: peak EPOC in ml/kg, the number Garmin calls an
 * activity's "training load", on the same scale for every activity whichever
 * device recorded it. See load-params.ts for how the models were fitted.
 */

// ---------------------------------------------------------------- types --

/** Where a load came from, best first. */
export type ExerciseLoadSource = "garmin" | "detailed" | "summary" | "power";

export const LOAD_SOURCES: ExerciseLoadSource[] = ["garmin", "detailed", "summary", "power"];

export const SOURCE_LABELS: Record<ExerciseLoadSource, string> = {
  garmin: "Garmin",
  detailed: "Second-by-second heart rate",
  summary: "Average and max heart rate",
  power: "Power only",
};

export type FocusCategory = "lowAerobic" | "highAerobic" | "anaerobic";

export const FOCUS_CATEGORIES: FocusCategory[] = ["lowAerobic", "highAerobic", "anaerobic"];

export const FOCUS_LABELS: Record<FocusCategory, string> = {
  lowAerobic: "Low aerobic",
  highAerobic: "High aerobic",
  anaerobic: "Anaerobic",
};

export type ExerciseLoad = { load: number; source: ExerciseLoadSource; focus: FocusCategory };

/**
 * Garmin's own per-activity numbers, keyed by Strava activity id.
 *
 * Nothing fills this yet: it needs the Garmin Personal API key in production.
 * When ingestion exists, pass its result to exerciseLoads() and Garmin's load
 * takes precedence over every estimate, which stays available for comparison.
 */
export type GarminLoads = Record<string, { load: number; focus?: FocusCategory | null }>;

export type HeartRateAnchors = { restingHr: number; maxHr: number };

// ------------------------------------------------------------- models --

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

const reserve = (hr: number, anchors: HeartRateAnchors) =>
  (hr - anchors.restingHr) / (anchors.maxHr - anchors.restingHr);

const isPickleball = (type: string) => getActivityKind(type) === "Pickleball";

/** Load from average and maximum heart rate, moving minutes and sport. */
export function summaryLoad(
  minutes: number,
  averageHr: number,
  maxHr: number | null,
  pickleball: boolean,
  anchors: HeartRateAnchors,
): number {
  const m = SUMMARY_MODEL;
  const x = clamp(reserve(averageHr, anchors), 0, 1.2);
  const xMax = clamp(reserve(maxHr ?? averageHr, anchors), 0, 1.2);
  const logMinutes = Math.log(Math.max(minutes, 1));
  const p = pickleball ? 1 : 0;
  const z =
    m.intercept +
    m.logMinutes * logMinutes +
    m.reserve * x +
    m.maxReserve * xMax +
    m.reserveSquared * x * x +
    m.pickleball * p +
    m.pickleballLogMinutes * p * logMinutes;
  return m.smear * Math.exp(z);
}

/** Load from normalized (or average) power and moving hours, for rides without heart rate. */
export function powerLoad(hours: number, watts: number): number {
  const m = POWER_MODEL;
  const intensity = watts / m.referenceWatts;
  const tss = Math.max(hours * intensity * intensity * 100, 0.1);
  return m.smear * Math.exp(m.intercept) * tss ** m.logTss;
}

/** Garmin's primary-benefit category, predicted from heart rate, duration and sport. */
export function classifyFocus(
  minutes: number,
  averageHr: number | null,
  maxHr: number | null,
  pickleball: boolean,
  anchors: HeartRateAnchors,
  intensity: number | null = null,
): FocusCategory {
  if (averageHr === null) {
    // Power only: intensity factor against the reference threshold.
    if (intensity === null) return "lowAerobic";
    return intensity >= FOCUS_MODEL.powerHighAerobic ? "highAerobic" : "lowAerobic";
  }
  const features = [
    1,
    clamp(reserve(averageHr, anchors), 0, 1.2),
    clamp(reserve(maxHr ?? averageHr, anchors), 0, 1.2),
    Math.log(Math.max(minutes, 1)),
    pickleball ? 1 : 0,
  ];
  let best: FocusCategory = "lowAerobic";
  let bestScore = -Infinity;
  for (const category of FOCUS_CATEGORIES) {
    const weights = FOCUS_MODEL.weights[category];
    const score = weights.reduce((sum, weight, index) => sum + weight * features[index], 0);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

/**
 * One load per activity, from the best source available: Garmin's own number,
 * then the EPOC model on second-by-second heart rate (computed by the sync
 * worker), then the summary model on average and max heart rate, then the
 * power model. Activities with none of these (no heart rate, no power) get no
 * load, as on a Garmin watch.
 */
export function exerciseLoads(
  activities: Activity[],
  index: StreamsIndex,
  anchors: HeartRateAnchors,
  garmin: GarminLoads = {},
): Record<string, ExerciseLoad> {
  const loads: Record<string, ExerciseLoad> = {};
  for (const activity of activities) {
    const minutes = activity.moving_time * 60;
    if (!(minutes > 0)) continue;
    const pickleball = isPickleball(activity.type);
    const entry = index[activity.id];
    const averageHr = entry?.average_heartrate ?? activity.average_heartrate;
    const maxHr = entry?.max_heartrate ?? activity.max_heartrate;
    const watts = entry?.normalized_power ?? activity.weighted_average_watts ?? activity.average_watts;
    const powerIntensity = watts ? watts / POWER_MODEL.referenceWatts : null;
    const focus = () => classifyFocus(minutes, averageHr ?? null, maxHr ?? null, pickleball, anchors, powerIntensity);

    const own = garmin[activity.id];
    if (own && own.load >= 0) {
      loads[activity.id] = { load: own.load, source: "garmin", focus: own.focus ?? focus() };
    } else if (typeof entry?.exercise_load === "number") {
      loads[activity.id] = { load: entry.exercise_load, source: "detailed", focus: focus() };
    } else if (averageHr) {
      loads[activity.id] = {
        load: summaryLoad(minutes, averageHr, maxHr ?? null, pickleball, anchors),
        source: "summary",
        focus: focus(),
      };
    } else if (watts && getActivityKind(activity.type) === "Ride") {
      loads[activity.id] = { load: powerLoad(minutes / 60, watts), source: "power", focus: focus() };
    }
  }
  return loads;
}

// ------------------------------------------------- acute and chronic --

export type LoadPoint = {
  date: string;
  /** That day's summed exercise load. */
  load: number;
  /** Exponentially weighted 7-day load, on a weekly scale. */
  acute: number;
  /** Exponentially weighted 28-day load, on the same weekly scale. */
  chronic: number;
  /** acute / chronic; null until there is a chronic load to compare with. */
  ratio: number | null;
};

const DAY_MS = 86_400_000;
const dayNumber = (date: CalendarDate) => Date.UTC(date.year, date.month, date.day) / DAY_MS;
const fromDay = (day: number): CalendarDate => {
  const date = new Date(day * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
};

function dailyLoads(activities: Activity[], loads: Record<string, ExerciseLoad>) {
  const daily = new Map<number, number>();
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    const load = loads[activity.id];
    if (!date || !load) continue;
    const day = dayNumber(date);
    daily.set(day, (daily.get(day) ?? 0) + load.load);
  }
  return daily;
}

/**
 * Acute and chronic load as Garmin describes them: weighted sums of EPOC with
 * recent days counting more. Each is an exponentially weighted average of
 * daily load (time constants 7 and 28 days) multiplied by seven, so both read
 * as "load per week" and a steady routine gives a ratio of 1.
 */
export function acuteChronicSeries(
  activities: Activity[],
  loads: Record<string, ExerciseLoad>,
  today: CalendarDate,
): LoadPoint[] {
  const daily = dailyLoads(activities, loads);
  if (!daily.size) return [];
  const first = Math.min(...daily.keys());
  const acuteDecay = Math.exp(-1 / LOAD_WINDOWS.acuteDays);
  const chronicDecay = Math.exp(-1 / LOAD_WINDOWS.chronicDays);
  let acute = 0;
  let chronic = 0;
  const points: LoadPoint[] = [];
  for (let day = first; day <= dayNumber(today); day++) {
    const load = daily.get(day) ?? 0;
    acute = acute * acuteDecay + load * (1 - acuteDecay) * 7;
    chronic = chronic * chronicDecay + load * (1 - chronicDecay) * 7;
    const settled = day - first >= LOAD_WINDOWS.chronicDays / 2;
    points.push({
      date: isoDate(fromDay(day)),
      load,
      acute,
      chronic,
      ratio: settled && chronic > 1 ? acute / chronic : null,
    });
  }
  return points;
}

export type RatioStatus = "low" | "optimal" | "high" | "veryHigh";

/** Garmin's bands: below 0.8 low, 0.8–1.4 optimal, 1.5–1.9 high, 2.0 and over very high. */
export function ratioStatus(ratio: number): RatioStatus {
  if (ratio < LOAD_RATIO.optimalFrom) return "low";
  if (ratio < LOAD_RATIO.highFrom) return "optimal";
  if (ratio < LOAD_RATIO.veryHighFrom) return "high";
  return "veryHigh";
}

// ---------------------------------------------------------- load focus --

export type LoadFocus = {
  total: number;
  byCategory: Record<FocusCategory, number>;
  /** The category holding at least FOCUS_MODEL.dominantShare of the load, or "balanced". */
  focus: FocusCategory | "balanced";
};

/** The last four weeks' load split into Garmin's three categories. */
export function loadFocus(
  activities: Activity[],
  loads: Record<string, ExerciseLoad>,
  today: CalendarDate,
  days = LOAD_WINDOWS.focusDays,
): LoadFocus {
  const end = dayNumber(today);
  const byCategory: Record<FocusCategory, number> = { lowAerobic: 0, highAerobic: 0, anaerobic: 0 };
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    const load = loads[activity.id];
    if (!date || !load) continue;
    const day = dayNumber(date);
    if (day > end || day <= end - days) continue;
    byCategory[load.focus] += load.load;
  }
  const total = byCategory.lowAerobic + byCategory.highAerobic + byCategory.anaerobic;
  const top = FOCUS_CATEGORIES.reduce((a, b) => (byCategory[b] > byCategory[a] ? b : a));
  return {
    total,
    byCategory,
    focus: total > 0 && byCategory[top] / total >= FOCUS_MODEL.dominantShare ? top : "balanced",
  };
}

/** How much of the load in a window came from each source. */
export function sourceShares(
  activities: Activity[],
  loads: Record<string, ExerciseLoad>,
  fromDate: string,
  toDate: string,
): Record<ExerciseLoadSource, { activities: number; load: number }> {
  const shares = Object.fromEntries(
    LOAD_SOURCES.map((source) => [source, { activities: 0, load: 0 }]),
  ) as Record<ExerciseLoadSource, { activities: number; load: number }>;
  for (const activity of activities) {
    const date = activity.date.slice(0, 10);
    const load = loads[activity.id];
    if (!load || date < fromDate || date > toDate) continue;
    shares[load.source].activities += 1;
    shares[load.source].load += load.load;
  }
  return shares;
}

// --------------------------------------------------------------- VO2max --

export type Vo2Point = { date: string; value: number; activityId: string };

export type Vo2maxSummary = {
  /** Per-ride estimates from steady heart rate against power. */
  rides: Vo2Point[];
  /** The rolling estimate after each ride, as a watch would report it. */
  trend: Array<{ date: string; value: number }>;
  current: number | null;
  /** From the best 5-minute power in the trailing window: a cross-check, not the estimate. */
  fromBestFiveMinutes: number | null;
  weightKg: number | null;
};

/** ACSM leg-cycling equation: VO2 (ml/kg/min) = 10.8 W/kg + 7. */
export const acsmVo2 = (watts: number, weightKg: number) => (10.8 * watts) / weightKg + 7;

/** Published regression on best 5-minute power: VO2max ≈ 16.6 + 8.87 W/kg. */
export const fiveMinuteVo2 = (watts: number, weightKg: number) => 16.6 + (8.87 * watts) / weightKg;

/**
 * VO2max the way a Garmin watch builds it: each ride with enough steady
 * riding gives an estimate (power at maximum heart rate, extrapolated by the
 * sync worker, through the ACSM equation), and the reported value is the
 * median of the rides in a trailing window, so one odd ride moves it little.
 */
export function vo2maxSummary(index: StreamsIndex, weightKg: number | null, today: CalendarDate): Vo2maxSummary {
  const empty: Vo2maxSummary = { rides: [], trend: [], current: null, fromBestFiveMinutes: null, weightKg };
  if (!weightKg) return empty;
  const rides: Vo2Point[] = Object.entries(index)
    .flatMap(([activityId, entry]) => {
      const date = entry.date?.slice(0, 10);
      const watts = entry.vo2_power?.watts;
      if (!date || !watts || getActivityKind(entry.sport_type) !== "Ride") return [];
      return [{ date, value: acsmVo2(watts, weightKg) + VO2MAX_MODEL.offset, activityId }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const window = VO2MAX_MODEL.windowDays;
  const trend: Array<{ date: string; value: number }> = [];
  for (let index = 0; index < rides.length; index++) {
    const end = calendarDate(rides[index].date)!;
    const from = isoDate(fromDay(dayNumber(end) - window + 1));
    const recent = rides
      .slice(0, index + 1)
      .filter((ride) => ride.date >= from)
      .map((ride) => ride.value)
      .sort((a, b) => a - b);
    if (recent.length < VO2MAX_MODEL.minRides) continue;
    const middle = recent.length / 2;
    const median =
      recent.length % 2 ? recent[Math.floor(middle)] : (recent[middle - 1] + recent[middle]) / 2;
    if (trend.length && trend[trend.length - 1].date === rides[index].date) trend.pop();
    trend.push({ date: rides[index].date, value: median });
  }

  const todayDay = dayNumber(today);
  const fromDate = isoDate(fromDay(todayDay - VO2MAX_MODEL.bestPowerDays + 1));
  let best300 = 0;
  for (const entry of Object.values(index)) {
    const date = entry.date?.slice(0, 10);
    if (!date || date < fromDate || getActivityKind(entry.sport_type) !== "Ride") continue;
    best300 = Math.max(best300, entry.power_bests?.["300"] ?? 0);
  }
  const last = trend[trend.length - 1];
  const stale = last && last.date < isoDate(fromDay(todayDay - VO2MAX_MODEL.staleAfterDays));
  return {
    rides,
    trend,
    current: last && !stale ? last.value : null,
    fromBestFiveMinutes: best300 ? fiveMinuteVo2(best300, weightKg) : null,
    weightKg,
  };
}
