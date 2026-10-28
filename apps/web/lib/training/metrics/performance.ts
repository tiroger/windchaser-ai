import {
  calendarDate,
  getActivityKind,
  isoDate,
  type Activity,
  type CalendarDate,
} from "@/lib/training/activity-types";

// ---------------------------------------------------------------- data --

export type HalfSummary = { watts: number | null; heartrate: number | null };

export type StreamSummary = {
  power_bests: Record<string, number> | null;
  normalized_power: number | null;
  average_watts: number | null;
  max_watts: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  moving_seconds: number | null;
  first_half: HalfSummary | null;
  second_half: HalfSummary | null;
};

/** One entry per activity whose streams the worker has fetched. */
export type StreamsIndexEntry = StreamSummary & {
  date: string;
  sport_type: string;
  has_streams: boolean;
};

export type StreamsIndex = Record<string, StreamsIndexEntry>;

/** Downsampled for display; a null is a reading Strava did not record. */
export type StreamSamples = Partial<
  Record<"time" | "distance" | "altitude" | "watts" | "heartrate" | "cadence" | "velocity", Array<number | null>>
> & {
  /** Hidden (null) within the privacy distance of either end. */
  latlng?: Array<[number, number] | null>;
};

export type ActivityStream = {
  id: string;
  start_date_local: string;
  sport_type: string;
  samples: StreamSamples;
  summary: StreamSummary;
};

export type AthleteSettings = {
  weightKg: number | null;
  restingHr: number;
  maxHr: number | null;
  ftpOverride: number | null;
};

// -------------------------------------------------------- power curve --

export const CURVE_DURATIONS = [
  1, 5, 15, 30, 60, 120, 180, 300, 480, 600, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400,
];
/** The five points of the profile: sprint, anaerobic, VO2max, threshold, endurance. */
export const PROFILE_DURATIONS = [15, 60, 300, 1200, 3600];

export type CurvePoint = { duration: number; watts: number; activityId: string; date: string };

export type PowerEntry = { id: string; day: number; date: string; bests: Record<string, number> };

const DAY_MS = 86_400_000;
const dayNumber = (date: CalendarDate) => Date.UTC(date.year, date.month, date.day) / DAY_MS;

export function powerEntries(index: StreamsIndex): PowerEntry[] {
  return Object.entries(index)
    .flatMap(([id, entry]) => {
      const date = calendarDate(entry.date);
      if (
        !date ||
        !entry.power_bests ||
        !Object.keys(entry.power_bests).length ||
        getActivityKind(entry.sport_type) !== "Ride"
      ) {
        return [];
      }
      return [{ id, day: dayNumber(date), date: isoDate(date), bests: entry.power_bests }];
    })
    .sort((a, b) => a.day - b.day);
}

/** Best power at each duration across the activities in [fromDay, toDay]. */
export function meanMaximalPower(
  entries: PowerEntry[],
  fromDay: number,
  toDay: number,
  durations = CURVE_DURATIONS,
): CurvePoint[] {
  const best = new Map<number, CurvePoint>();
  for (const entry of entries) {
    if (entry.day < fromDay || entry.day > toDay) continue;
    for (const duration of durations) {
      const watts = entry.bests[String(duration)];
      if (!watts) continue;
      const current = best.get(duration);
      if (!current || watts > current.watts) {
        best.set(duration, { duration, watts, activityId: entry.id, date: entry.date });
      }
    }
  }
  return durations.flatMap((duration) => (best.has(duration) ? [best.get(duration)!] : []));
}

// ------------------------------------------------------------- FTP --

export type FtpEstimate = {
  ftp: number;
  cp: number | null;
  wPrime: number | null;
  best20: number | null;
};

/**
 * Critical power from the linear work-time model, W = CP * t + W', fitted to
 * mean-maximal efforts between three and twenty minutes.
 */
export function fitCriticalPower(curve: CurvePoint[]): { cp: number; wPrime: number } | null {
  const points = curve.filter((point) => point.duration >= 180 && point.duration <= 1200);
  if (points.length < 3 || !points.some((point) => point.duration >= 600)) return null;
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.duration, 0) / n;
  const meanW = points.reduce((sum, p) => sum + p.watts * p.duration, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    covariance += (point.duration - meanT) * (point.watts * point.duration - meanW);
    variance += (point.duration - meanT) ** 2;
  }
  const cp = covariance / variance;
  const wPrime = meanW - cp * meanT;
  // Efforts that were not all-out produce physiologically impossible fits.
  if (!(cp > 50) || !(wPrime > 2000) || wPrime > 60000) return null;
  return { cp, wPrime };
}

/**
 * FTP is the lower of critical power and 95% of the best 20-minute power.
 * Short all-out efforts push CP above threshold, and a 20-minute best that was
 * not a full effort pulls the 95% rule below it; the lower figure is the safer
 * basis for training load, which over-rewards an inflated FTP.
 */
export function estimateFtp(curve: CurvePoint[]): FtpEstimate | null {
  const fit = fitCriticalPower(curve);
  const best20 = curve.find((point) => point.duration === 1200)?.watts ?? null;
  const candidates = [fit?.cp, best20 ? best20 * 0.95 : undefined].filter(
    (value): value is number => typeof value === "number",
  );
  if (!candidates.length) return null;
  return {
    ftp: Math.round(Math.min(...candidates)),
    cp: fit ? Math.round(fit.cp) : null,
    wPrime: fit ? Math.round(fit.wPrime) : null,
    best20,
  };
}

export const FTP_WINDOW_DAYS = 90;

/** Weekly FTP estimates, each from the trailing 90 days of efforts. */
export function ftpHistory(index: StreamsIndex, today: CalendarDate): Array<{ date: string; ftp: number }> {
  const entries = powerEntries(index);
  if (!entries.length) return [];
  const history: Array<{ date: string; ftp: number }> = [];
  const end = dayNumber(today);
  for (let day = entries[0].day + 6; day <= end + 6; day += 7) {
    const at = Math.min(day, end);
    const estimate = estimateFtp(
      meanMaximalPower(entries, at - FTP_WINDOW_DAYS + 1, at, [180, 300, 480, 600, 1200]),
    );
    if (estimate) {
      history.push({ date: new Date(at * DAY_MS).toISOString().slice(0, 10), ftp: estimate.ftp });
    }
  }
  return history;
}

export function ftpOn(history: Array<{ date: string; ftp: number }>, date: string): number | null {
  let value: number | null = null;
  for (const point of history) {
    if (point.date > date) break;
    value = point.ftp;
  }
  // Before the first estimate, the earliest one is the best available guess.
  return value ?? history[0]?.ftp ?? null;
}

// ------------------------------------------------------------- load --

export type LoadSource = "power" | "heart rate" | "estimate";
export type ActivityLoad = { tss: number; intensity: number | null; source: LoadSource };

/** Banister TRIMP: minutes x HR-reserve fraction x 0.64 e^(1.92 x fraction). */
export function trimp(minutes: number, averageHr: number, restingHr: number, maxHr: number): number {
  const reserve = Math.min(Math.max((averageHr - restingHr) / (maxHr - restingHr), 0), 1);
  return minutes * reserve * 0.64 * Math.exp(1.92 * reserve);
}

export function powerTss(seconds: number, normalizedPower: number, ftp: number): number {
  const intensity = normalizedPower / ftp;
  return ((seconds * normalizedPower * intensity) / (ftp * 3600)) * 100;
}

/** An hour at threshold is 100 TSS; threshold heart rate sits near 85% of reserve. */
const DEFAULT_TRIMP_SCALE = 100 / trimp(60, 0.85, 0, 1);
/** Without power or heart rate, assume a steady endurance effort. */
const ESTIMATED_INTENSITY = 0.6;

export type HeartRateSettings = { restingHr: number; maxHr: number };

export type PerformanceModel = {
  ftp: (FtpEstimate & { source: "estimate" }) | { ftp: number; source: "override" } | null;
  ftpHistory: Array<{ date: string; ftp: number }>;
  heartRate: HeartRateSettings & { maxHrSource: "settings" | "observed" | "default" };
  trimpScale: number;
  loads: Record<string, ActivityLoad>;
};

export function buildPerformanceModel(
  activities: Activity[],
  index: StreamsIndex,
  settings: AthleteSettings,
  today: CalendarDate,
): PerformanceModel {
  const history = ftpHistory(index, today);
  const todayDay = dayNumber(today);
  const recent = meanMaximalPower(powerEntries(index), todayDay - FTP_WINDOW_DAYS + 1, todayDay);
  const estimate = estimateFtp(recent);
  const ftp = settings.ftpOverride
    ? { ftp: settings.ftpOverride, source: "override" as const }
    : estimate
      ? { ...estimate, source: "estimate" as const }
      : null;

  // A chest strap or wrist sensor occasionally spikes; the 99th percentile of
  // per-activity maxima ignores those while still reaching genuine all-out days.
  const maxima = activities
    .flatMap((activity) => (activity.max_heartrate && activity.max_heartrate < 230 ? [activity.max_heartrate] : []))
    .sort((a, b) => a - b);
  const observedMax = maxima.length ? maxima[Math.min(maxima.length - 1, Math.floor(maxima.length * 0.99))] : 0;
  const maxHr = settings.maxHr ?? (observedMax > 120 ? observedMax : 190);
  const heartRate = {
    restingHr: settings.restingHr,
    maxHr,
    maxHrSource: settings.maxHr ? ("settings" as const) : observedMax > 120 ? ("observed" as const) : ("default" as const),
  };

  // An override describes current fitness, so it scores the recent window only.
  const overrideFrom = isoDate(calendarFromDay(todayDay - FTP_WINDOW_DAYS + 1));
  const ftpFor = (date: string) =>
    settings.ftpOverride && date >= overrideFrom ? settings.ftpOverride : ftpOn(history, date);

  const powerLoads = new Map<string, ActivityLoad>();
  const ratios: number[] = [];
  for (const activity of activities) {
    const entry = index[activity.id];
    const date = activity.date.slice(0, 10);
    const threshold = ftpFor(date);
    if (!entry?.normalized_power || !entry.moving_seconds || !threshold) continue;
    const tss = powerTss(entry.moving_seconds, entry.normalized_power, threshold);
    powerLoads.set(activity.id, { tss, intensity: entry.normalized_power / threshold, source: "power" });
    const hr = entry.average_heartrate ?? activity.average_heartrate;
    if (hr) {
      const t = trimp(entry.moving_seconds / 60, hr, heartRate.restingHr, heartRate.maxHr);
      if (t > 0) ratios.push(tss / t);
    }
  }
  // Calibrate heart-rate load to this athlete's own power-based load when
  // there are enough rides with both; otherwise use the textbook scale.
  ratios.sort((a, b) => a - b);
  const trimpScale = ratios.length >= 10 ? ratios[Math.floor(ratios.length / 2)] : DEFAULT_TRIMP_SCALE;

  const loads: Record<string, ActivityLoad> = {};
  for (const activity of activities) {
    const power = powerLoads.get(activity.id);
    if (power) {
      loads[activity.id] = power;
      continue;
    }
    if (activity.moving_time <= 0) continue;
    if (activity.average_heartrate) {
      const t = trimp(activity.moving_time * 60, activity.average_heartrate, heartRate.restingHr, heartRate.maxHr);
      loads[activity.id] = { tss: t * trimpScale, intensity: null, source: "heart rate" };
    } else {
      loads[activity.id] = {
        tss: activity.moving_time * ESTIMATED_INTENSITY ** 2 * 100,
        intensity: null,
        source: "estimate",
      };
    }
  }

  return { ftp, ftpHistory: history, heartRate, trimpScale, loads };
}

function calendarFromDay(day: number): CalendarDate {
  const date = new Date(day * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

export type FitnessPoint = { date: string; load: number; fitness: number; fatigue: number; form: number };

/**
 * Fitness (CTL) and fatigue (ATL) are 42- and 7-day exponentially weighted
 * averages of daily load; form (TSB) is yesterday's fitness minus fatigue.
 */
export function fitnessSeries(
  activities: Activity[],
  loads: Record<string, ActivityLoad>,
  today: CalendarDate,
): FitnessPoint[] {
  const daily = new Map<number, number>();
  let first = Infinity;
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    const load = loads[activity.id];
    if (!date || !load) continue;
    const day = dayNumber(date);
    first = Math.min(first, day);
    daily.set(day, (daily.get(day) ?? 0) + load.tss);
  }
  if (!Number.isFinite(first)) return [];
  const points: FitnessPoint[] = [];
  let fitness = 0;
  let fatigue = 0;
  for (let day = first; day <= dayNumber(today); day++) {
    const load = daily.get(day) ?? 0;
    const form = fitness - fatigue;
    fitness += (load - fitness) / 42;
    fatigue += (load - fatigue) / 7;
    points.push({ date: isoDate(calendarFromDay(day)), load, fitness, fatigue, form });
  }
  return points;
}

// ------------------------------------------------------------ zones --

export const POWER_ZONES = [
  { name: "Active recovery", upTo: 0.55 },
  { name: "Endurance", upTo: 0.75 },
  { name: "Tempo", upTo: 0.9 },
  { name: "Threshold", upTo: 1.05 },
  { name: "VO2max", upTo: 1.2 },
  { name: "Anaerobic", upTo: 1.5 },
  { name: "Neuromuscular", upTo: Infinity },
];

export const HEART_RATE_ZONES = [
  { name: "Recovery", upTo: 0.6 },
  { name: "Endurance", upTo: 0.7 },
  { name: "Tempo", upTo: 0.8 },
  { name: "Threshold", upTo: 0.9 },
  { name: "Maximum", upTo: Infinity },
];

/**
 * Seconds in each zone from downsampled samples, weighting every sample by
 * the time until the next one. Gaps over a minute are pauses and count as zero.
 */
export function timeInZones(
  time: Array<number | null>,
  values: Array<number | null>,
  reference: number,
  zones: Array<{ upTo: number }>,
): number[] {
  const seconds = zones.map(() => 0);
  for (let index = 0; index < values.length - 1; index++) {
    const start = time[index];
    const end = time[index + 1];
    const value = values[index];
    if (start === null || end === null || value === null) continue;
    const step = end - start;
    if (!(step > 0) || step > 60) continue;
    const ratio = value / reference;
    const zone = zones.findIndex((candidate) => ratio <= candidate.upTo);
    seconds[zone === -1 ? zones.length - 1 : zone] += step;
  }
  return seconds;
}

export type RideMetrics = {
  intensity: number | null;
  tss: number | null;
  variabilityIndex: number | null;
  efficiencyFactor: number | null;
  /** Percent drop in power per heartbeat from the first half to the second. */
  decoupling: number | null;
  trimp: number | null;
};

export function rideMetrics(
  summary: StreamSummary,
  ftp: number | null,
  heartRate: HeartRateSettings,
): RideMetrics {
  const np = summary.normalized_power;
  const seconds = summary.moving_seconds;
  const first = summary.first_half;
  const second = summary.second_half;
  const ratio = (half: HalfSummary | null) =>
    half?.watts && half.heartrate ? half.watts / half.heartrate : null;
  const firstRatio = ratio(first);
  const secondRatio = ratio(second);
  return {
    intensity: np && ftp ? np / ftp : null,
    tss: np && ftp && seconds ? powerTss(seconds, np, ftp) : null,
    variabilityIndex: np && summary.average_watts ? np / summary.average_watts : null,
    efficiencyFactor: np && summary.average_heartrate ? np / summary.average_heartrate : null,
    decoupling:
      firstRatio && secondRatio ? ((firstRatio - secondRatio) / firstRatio) * 100 : null,
    trimp:
      seconds && summary.average_heartrate
        ? trimp(seconds / 60, summary.average_heartrate, heartRate.restingHr, heartRate.maxHr)
        : null,
  };
}

// ----------------------------------------------------- summary payload --

export type PerformanceSummary = {
  ftp: PerformanceModel["ftp"];
  ftpHistory: Array<{ date: string; ftp: number }>;
  heartRate: PerformanceModel["heartRate"];
  weightKg: number | null;
  curves: Record<"last28" | "last90" | "year" | "allTime", CurvePoint[]>;
  profile: { durations: number[]; recent: Array<number | null>; previous: Array<number | null> };
  fitness: FitnessPoint[];
  loads: Record<string, ActivityLoad>;
  coverage: { activities: number; withStreams: number; withPower: number };
};

export function performanceSummary(
  activities: Activity[],
  index: StreamsIndex,
  settings: AthleteSettings,
  today: CalendarDate,
): PerformanceSummary {
  const model = buildPerformanceModel(activities, index, settings, today);
  const entries = powerEntries(index);
  const todayDay = dayNumber(today);
  const yearStart = Date.UTC(today.year, 0, 1) / DAY_MS;
  const curves = {
    last28: meanMaximalPower(entries, todayDay - 27, todayDay),
    last90: meanMaximalPower(entries, todayDay - 89, todayDay),
    year: meanMaximalPower(entries, yearStart, todayDay),
    allTime: meanMaximalPower(entries, -Infinity, todayDay),
  };
  const recent = meanMaximalPower(entries, todayDay - 27, todayDay, PROFILE_DURATIONS);
  const previous = meanMaximalPower(entries, todayDay - 111, todayDay - 28, PROFILE_DURATIONS);
  const pick = (curve: CurvePoint[]) =>
    PROFILE_DURATIONS.map((duration) => curve.find((p) => p.duration === duration)?.watts ?? null);
  const fitness = fitnessSeries(activities, model.loads, today);
  const indexValues = Object.values(index);
  return {
    ftp: model.ftp,
    ftpHistory: model.ftpHistory,
    heartRate: model.heartRate,
    weightKg: settings.weightKg,
    curves,
    profile: { durations: PROFILE_DURATIONS, recent: pick(recent), previous: pick(previous) },
    fitness: fitness.slice(-365),
    loads: model.loads,
    coverage: {
      activities: activities.length,
      withStreams: indexValues.filter((entry) => entry.has_streams).length,
      withPower: entries.length,
    },
  };
}
