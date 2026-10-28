import {
  calendarDate,
  formatHours,
  formatNumber,
  getActivityKind,
  isDistanceSport,
  isoDate,
  type Activity,
  type CalendarDate,
  type Gear,
  type SportFilter,
  type SportKind,
} from "@/lib/training/activity-types";
import { decodePolyline } from "@/lib/training/polyline";

/**
 * The Year in review's numbers, computed once on the server so the page ships
 * aggregates rather than every activity and route.
 *
 * Every date here is a wall-clock date read from the activity's own string
 * ("YYYY-MM-DDTHH:MM:SS"), never through a timezone, so a 6 am ride is a 6 am
 * ride wherever the page is rendered.
 */

export const EARTH_CIRCUMFERENCE_MI = 24_901;
export const EVEREST_FT = 29_032;
export const DIABLO_FT = 3_849;
/** Weeks in the seasons stream; each bucket is a 52nd of the year (about 7.02 days). */
export const STREAM_WEEKS = 52;
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Stacking order for every per-sport visual, so a sport keeps its place. */
export const KIND_ORDER: SportKind[] = [
  "Ride",
  "Run",
  "Walk",
  "Swim",
  "Pickleball",
  "Training",
  "Other",
];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- dates --

export function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}

/** 0-based day of the year: January 1 is 0, December 31 is 364 or 365. */
export function dayOfYear(date: CalendarDate): number {
  return (Date.UTC(date.year, date.month, date.day) - Date.UTC(date.year, 0, 1)) / DAY_MS;
}

export function dateAtIndex(year: number, index: number): string {
  const date = new Date(Date.UTC(year, 0, 1) + index * DAY_MS);
  return isoDate({ year, month: date.getUTCMonth(), day: date.getUTCDate() });
}

/** Wall-clock start time, or null for an activity stored with a date only. */
export function startClock(date: string): { hour: number; minute: number } | null {
  const match = /T(\d{2}):(\d{2})/.exec(date);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** Monday-first weekday, 0 = Monday. */
export function weekdayIndex(date: CalendarDate): number {
  return (new Date(Date.UTC(date.year, date.month, date.day)).getUTCDay() + 6) % 7;
}

export type ReviewWindow = {
  year: number;
  /** The current year, counted to today rather than to December 31. */
  partial: boolean;
  /** Last counted day, 0-based. */
  lastIndex: number;
  days: number;
  through: string;
};

export function reviewWindow(year: number, today: CalendarDate): ReviewWindow {
  const days = daysInYear(year);
  const partial = year === today.year;
  const lastIndex = partial ? Math.min(dayOfYear(today), days - 1) : days - 1;
  return { year, partial, lastIndex, days, through: dateAtIndex(year, lastIndex) };
}

/**
 * The activities of `year`, and when `cutoff` is given only those on or
 * before that month and day: how last year looked at this point in it.
 */
export function inYear(
  activities: Activity[],
  year: number,
  cutoff?: Pick<CalendarDate, "month" | "day">,
): Activity[] {
  return activities.filter((activity) => {
    const date = calendarDate(activity.date);
    if (!date || date.year !== year) return false;
    if (!cutoff) return true;
    return date.month < cutoff.month || (date.month === cutoff.month && date.day <= cutoff.day);
  });
}

/**
 * The year the page opens on. A review looks back at a finished season, so
 * it is the most recent complete year, until December, when the current
 * year is all but over and becomes the one worth reviewing.
 */
export function defaultReviewYear(years: number[], today: CalendarDate): number | undefined {
  const sorted = [...years].sort((a, b) => b - a);
  if (!sorted.length) return undefined;
  if (today.month === 11 && sorted.includes(today.year)) return today.year;
  return sorted.find((year) => year < today.year) ?? sorted[0];
}

// --------------------------------------------------------------- totals --

export type ReviewTotals = {
  activities: number;
  /** Miles. */
  distance: number;
  hours: number;
  /** Feet. */
  elevation: number;
  activeDays: number;
  kudos: number;
  kilojoules: number;
};

export function reviewTotals(activities: Activity[]): ReviewTotals {
  const days = new Set<string>();
  const totals: ReviewTotals = {
    activities: activities.length,
    distance: 0,
    hours: 0,
    elevation: 0,
    activeDays: 0,
    kudos: 0,
    kilojoules: 0,
  };
  for (const activity of activities) {
    totals.distance += activity.distance;
    totals.hours += activity.moving_time;
    totals.elevation += activity.total_elevation_gain;
    totals.kudos += activity.kudos_count;
    totals.kilojoules += activity.kilojoules ?? 0;
    days.add(activity.date.slice(0, 10));
  }
  totals.activeDays = days.size;
  return totals;
}

export type YearStripEntry = { year: number; activities: number; hours: number; distance: number };

/** Every year with activity, oldest first, for the year picker's histogram. */
export function yearStrip(activities: Activity[]): YearStripEntry[] {
  const years = new Map<number, YearStripEntry>();
  for (const activity of activities) {
    const year = calendarDate(activity.date)?.year;
    if (!year) continue;
    const entry = years.get(year) ?? { year, activities: 0, hours: 0, distance: 0 };
    entry.activities += 1;
    entry.hours += activity.moving_time;
    entry.distance += activity.distance;
    years.set(year, entry);
  }
  return [...years.values()].sort((a, b) => a.year - b.year);
}

/** Per-sport hours and counts, largest first. */
export function sportMix(
  activities: Activity[],
): Array<{ kind: SportKind; count: number; hours: number; distance: number }> {
  const kinds = new Map<SportKind, { count: number; hours: number; distance: number }>();
  for (const activity of activities) {
    const kind = getActivityKind(activity.type);
    const entry = kinds.get(kind) ?? { count: 0, hours: 0, distance: 0 };
    entry.count += 1;
    entry.hours += activity.moving_time;
    entry.distance += activity.distance;
    kinds.set(kind, entry);
  }
  return [...kinds.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => b.hours - a.hours || b.count - a.count);
}

export type MonthlyMetric = "distance" | "hours" | "elevation" | "activities";

function metricOf(activity: Activity, metric: MonthlyMetric): number {
  if (metric === "distance") return activity.distance;
  if (metric === "hours") return activity.moving_time;
  if (metric === "elevation") return activity.total_elevation_gain;
  return 1;
}

export function monthlyTotals(activities: Activity[], metric: MonthlyMetric): number[] {
  const months = new Array<number>(12).fill(0);
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (date) months[date.month] += metricOf(activity, metric);
  }
  return months;
}

/** Index of the largest month, or null when every month is empty. Ties go to the earlier. */
export function busiestMonth(months: number[]): number | null {
  let best: number | null = null;
  months.forEach((value, index) => {
    if (value > 0 && (best === null || value > months[best])) best = index;
  });
  return best;
}

// ----------------------------------------------------------------- ring --

export type RingActivity = {
  id: string;
  name: string;
  kind: SportKind;
  type: string;
  distance: number;
  hours: number;
  elevation: number;
  /** "07:12", or null when the activity has no start time. */
  time: string | null;
};

export type RingDay = {
  index: number;
  date: string;
  hours: number;
  segments: Array<{ kind: SportKind; hours: number }>;
  activities: RingActivity[];
};

/** One entry per active day of `year`, in date order, sports stacked in KIND_ORDER. */
export function ringCalendar(activities: Activity[], year: number): RingDay[] {
  const days = new Map<number, RingDay>();
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!date || date.year !== year) continue;
    const index = dayOfYear(date);
    const day = days.get(index) ?? {
      index,
      date: isoDate(date),
      hours: 0,
      segments: [],
      activities: [],
    };
    const kind = getActivityKind(activity.type);
    const clock = startClock(activity.date);
    day.hours += activity.moving_time;
    const segment = day.segments.find((entry) => entry.kind === kind);
    if (segment) segment.hours += activity.moving_time;
    else day.segments.push({ kind, hours: activity.moving_time });
    day.activities.push({
      id: activity.id,
      name: activity.name,
      kind,
      type: activity.type,
      distance: activity.distance,
      hours: activity.moving_time,
      elevation: activity.total_elevation_gain,
      time: clock
        ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`
        : null,
    });
    days.set(index, day);
  }
  return [...days.values()]
    .sort((a, b) => a.index - b.index)
    .map((day) => ({
      ...day,
      segments: [...day.segments].sort(
        (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
      ),
      activities: [...day.activities].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")),
    }));
}

export type DayRun = {
  length: number;
  startIndex: number;
  endIndex: number;
  start: string;
  end: string;
};

/** The longest run of consecutive active days; the earliest wins a tie. */
export function longestStreak(indices: number[], year: number): DayRun | null {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let start = 0;
  for (let index = 0; index < sorted.length; index++) {
    if (index > 0 && sorted[index] !== sorted[index - 1] + 1) start = index;
    const length = index - start + 1;
    if (!best || length > best[1] - best[0] + 1) best = [sorted[start], sorted[index]];
  }
  if (!best) return null;
  return {
    length: best[1] - best[0] + 1,
    startIndex: best[0],
    endIndex: best[1],
    start: dateAtIndex(year, best[0]),
    end: dateAtIndex(year, best[1]),
  };
}

/** The longest stretch of rest between two active days; null with fewer than two. */
export function longestBreak(indices: number[], year: number): DayRun | null {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  let best: DayRun | null = null;
  for (let index = 1; index < sorted.length; index++) {
    const length = sorted[index] - sorted[index - 1] - 1;
    if (length > 0 && (!best || length > best.length)) {
      best = {
        length,
        startIndex: sorted[index - 1] + 1,
        endIndex: sorted[index] - 1,
        start: dateAtIndex(year, sorted[index - 1] + 1),
        end: dateAtIndex(year, sorted[index] - 1),
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------- clock --

export type ClockData = {
  /** Hours of activity falling in each clock hour, per sport. */
  byKind: Array<{ kind: SportKind; hours: number[] }>;
  total: number[];
  /** Activities starting in each clock hour. */
  starts: number[];
  /** The clock hour holding the most activity, or null with none. */
  peakHour: number | null;
};

/**
 * Where the year's moving time sat on the clock. Each activity's moving time
 * is laid out from its start, so a 7:30 two-hour ride puts half an hour in
 * the 7 o'clock hour, an hour in the 8 and half an hour in the 9.
 */
export function timeOfDay(activities: Activity[]): ClockData {
  const kinds = new Map<SportKind, number[]>();
  const total = new Array<number>(24).fill(0);
  const starts = new Array<number>(24).fill(0);
  for (const activity of activities) {
    const clock = startClock(activity.date);
    if (!clock) continue;
    starts[clock.hour] += 1;
    const kind = getActivityKind(activity.type);
    let hours = kinds.get(kind);
    if (!hours) {
      hours = new Array<number>(24).fill(0);
      kinds.set(kind, hours);
    }
    let remaining = Math.min(Math.max(activity.moving_time, 0), 48);
    let at = clock.hour + clock.minute / 60;
    while (remaining > 1e-9) {
      const slot = Math.floor(at) % 24;
      const chunk = Math.min(remaining, Math.floor(at) + 1 - at);
      hours[slot] += chunk;
      total[slot] += chunk;
      at += chunk;
      remaining -= chunk;
    }
  }
  let peakHour: number | null = null;
  total.forEach((value, hour) => {
    if (value > 0 && (peakHour === null || value > total[peakHour])) peakHour = hour;
  });
  return {
    byKind: KIND_ORDER.filter((kind) => kinds.has(kind)).map((kind) => ({
      kind,
      hours: kinds.get(kind)!,
    })),
    total,
    starts,
    peakHour,
  };
}

export type WeekdayEntry = { day: number; label: string; hours: number; count: number };

export function weekdayRhythm(activities: Activity[]): WeekdayEntry[] {
  const days = WEEKDAY_LABELS.map((label, day) => ({ day, label, hours: 0, count: 0 }));
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!date) continue;
    const entry = days[weekdayIndex(date)];
    entry.hours += activity.moving_time;
    entry.count += 1;
  }
  return days;
}

/** "7 am", "12 pm", "midnight". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

// --------------------------------------------------------------- stream --

export type WeeklyStream = {
  /** Sports by total hours, largest first. */
  series: Array<{ kind: SportKind; values: number[]; total: number }>;
  totals: number[];
  peak: { week: number; hours: number } | null;
};

export function weekBucket(index: number, days: number): number {
  return Math.min(STREAM_WEEKS - 1, Math.floor((index * STREAM_WEEKS) / days));
}

/** Hours per sport in each of the year's 52 weekly buckets. */
export function weeklyStream(activities: Activity[], year: number): WeeklyStream {
  const days = daysInYear(year);
  const kinds = new Map<SportKind, number[]>();
  const totals = new Array<number>(STREAM_WEEKS).fill(0);
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!date || date.year !== year) continue;
    const week = weekBucket(dayOfYear(date), days);
    const kind = getActivityKind(activity.type);
    let values = kinds.get(kind);
    if (!values) {
      values = new Array<number>(STREAM_WEEKS).fill(0);
      kinds.set(kind, values);
    }
    values[week] += activity.moving_time;
    totals[week] += activity.moving_time;
  }
  let peak: WeeklyStream["peak"] = null;
  totals.forEach((hours, week) => {
    if (hours > 0 && (!peak || hours > peak.hours)) peak = { week, hours };
  });
  return {
    series: [...kinds.entries()]
      .map(([kind, values]) => ({ kind, values, total: values.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total),
    totals,
    peak,
  };
}

/**
 * Streamgraph layers around a centred (silhouette) baseline: each layer's
 * lower and upper edge per week, in the order given. The whole stream is
 * symmetric about zero, so the total's shape reads as the season's swell.
 */
export function streamLayers(series: number[][]): Array<{ lower: number[]; upper: number[] }> {
  const weeks = series[0]?.length ?? 0;
  const base = Array.from({ length: weeks }, (_, week) => {
    const total = series.reduce((sum, values) => sum + values[week], 0);
    return -total / 2;
  });
  const running = [...base];
  return series.map((values) => {
    const lower = [...running];
    const upper = values.map((value, week) => running[week] + value);
    upper.forEach((value, week) => (running[week] = value));
    return { lower, upper };
  });
}

/** The week bucket's first day, for labels. */
export function weekStart(year: number, week: number): string {
  const days = daysInYear(year);
  return dateAtIndex(year, Math.ceil((week * days) / STREAM_WEEKS));
}

// ---------------------------------------------------------- comparisons --

export type ComparisonKey = "activities" | "distance" | "hours" | "elevation" | "activeDays";

export type Comparison = {
  key: ComparisonKey;
  label: string;
  unit: string;
  current: number;
  previous: number;
  /** current / previous - 1; null when last year had none. */
  change: number | null;
  currentMonthly: number[];
  previousMonthly: number[];
};

const COMPARISON_LABELS: Record<ComparisonKey, [string, string]> = {
  activities: ["Activities", ""],
  distance: ["Distance", "mi"],
  hours: ["Moving time", "h"],
  elevation: ["Elevation", "ft"],
  activeDays: ["Active days", "days"],
};

function cumulative(values: number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

function monthlyActiveDays(activities: Activity[]): number[] {
  const months = Array.from({ length: 12 }, () => new Set<string>());
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (date) months[date.month].add(activity.date.slice(0, 10));
  }
  return months.map((days) => days.size);
}

/**
 * This year against the last, metric by metric, with month-by-month running
 * totals for each. `months` limits both curves to the months counted so far,
 * so a year in progress is compared with last year at the same point.
 */
export function yearOverYear(
  current: Activity[],
  previous: Activity[],
  keys: ComparisonKey[],
  months = 12,
): Comparison[] {
  const now = reviewTotals(current);
  const then = reviewTotals(previous);
  const monthly = (activities: Activity[], key: ComparisonKey) =>
    cumulative(
      key === "activeDays"
        ? monthlyActiveDays(activities)
        : monthlyTotals(activities, key === "hours" ? "hours" : key),
    ).slice(0, months);
  return keys.map((key) => {
    const [label, unit] = COMPARISON_LABELS[key];
    return {
      key,
      label,
      unit,
      current: now[key],
      previous: then[key],
      change: then[key] > 0 ? now[key] / then[key] - 1 : null,
      currentMonthly: monthly(current, key),
      previousMonthly: monthly(previous, key),
    };
  });
}

// -------------------------------------------------------------- summary --

const SPORT_NOUNS: Record<SportFilter, [string, string]> = {
  All: ["activity", "activities"],
  Ride: ["ride", "rides"],
  Run: ["run", "runs"],
  Walk: ["walk", "walks"],
  Swim: ["swim", "swims"],
  Pickleball: ["session", "sessions"],
  Training: ["session", "sessions"],
  Other: ["activity", "activities"],
};

export function sportNoun(filter: SportFilter, count: number): string {
  return SPORT_NOUNS[filter][count === 1 ? 0 : 1];
}

function roundHours(hours: number): string {
  const rounded = Math.round(hours);
  return rounded === 1 ? "1 hour" : `${formatNumber(rounded)} hours`;
}

export type SummaryInput = {
  year: number;
  filter: SportFilter;
  partial: boolean;
  totals: ReviewTotals;
  previous: ReviewTotals | null;
  busiestMonth: number | null;
};

/**
 * The opening's one sentence, written from the numbers: what was covered,
 * the biggest month, and how it compares with the year before.
 */
export function yearSummary({
  year,
  filter,
  partial,
  totals,
  previous,
  busiestMonth: month,
}: SummaryInput): string {
  if (totals.activities === 0) {
    return partial
      ? `Nothing logged in ${year} yet.`
      : `No ${sportNoun(filter, 2)} were logged in ${year}.`;
  }
  const lead = partial ? `So far in ${year} you've` : `In ${year} you`;
  const count = `${formatNumber(totals.activities)} ${sportNoun(filter, totals.activities)}`;
  const byDistance = isDistanceSport(filter) && totals.distance >= 1;

  let opening: string;
  if (byDistance) {
    opening = `${lead} covered ${formatNumber(totals.distance)} miles across ${count}`;
    opening +=
      totals.elevation >= 1000
        ? ` and climbed ${formatNumber(totals.elevation)} ft`
        : ` in ${roundHours(totals.hours)}`;
  } else {
    const verb = filter === "Pickleball" ? "played" : "logged";
    opening = `${lead} ${verb} ${count} over ${roundHours(totals.hours)}`;
  }

  // Mixed sports compare on time; a single distance sport on miles.
  const onMiles = byDistance && filter !== "All";
  const now = onMiles ? totals.distance : totals.hours;
  const then = previous ? (onMiles ? previous.distance : previous.hours) : 0;
  let comparison: string | null = null;
  if (then > 0) {
    const change = now / then - 1;
    const against = partial ? `this time in ${year - 1}` : `${year - 1}`;
    if (Math.abs(change) < 0.03) {
      comparison = `about the same ${onMiles ? "mileage" : "time"} as ${against}`;
    } else {
      const pct = formatNumber(Math.round(Math.abs(change) * 100));
      const more = change > 0 ? "more" : onMiles ? "fewer" : "less";
      comparison = `${pct}% ${more} ${onMiles ? "miles" : "time on the move"} than ${against}`;
    }
  }

  let sentence = opening;
  if (comparison) sentence += ` — ${comparison}`;
  if (month !== null && totals.activities > 1) {
    sentence += `, with ${MONTH_NAMES[month]} the biggest month`;
  }
  return `${sentence}.`;
}

// --------------------------------------------------------- biggest days --

export type BigDay = {
  key: string;
  label: string;
  display: string;
  value: number;
  activity: {
    id: string;
    name: string;
    date: string;
    type: string;
    kind: SportKind;
    distance: number;
    hours: number;
    elevation: number;
    speed: number;
    watts: number | null;
    heartrate: number | null;
    effort: number | null;
    hasRoute: boolean;
  };
};

function topBy(
  activities: Activity[],
  score: (activity: Activity) => number | null,
): { activity: Activity; value: number } | null {
  let top: { activity: Activity; value: number } | null = null;
  for (const activity of activities) {
    const value = score(activity);
    if (value !== null && value > 0 && (!top || value > top.value)) top = { activity, value };
  }
  return top;
}

function bigDay(
  key: string,
  label: string,
  top: { activity: Activity; value: number } | null,
  display: (value: number) => string,
): BigDay | null {
  if (!top) return null;
  const { activity, value } = top;
  return {
    key,
    label,
    value,
    display: display(value),
    activity: {
      id: activity.id,
      name: activity.name,
      date: activity.date,
      type: activity.type,
      kind: getActivityKind(activity.type),
      distance: activity.distance,
      hours: activity.moving_time,
      elevation: activity.total_elevation_gain,
      speed: activity.average_speed,
      watts: activity.weighted_average_watts ?? activity.average_watts,
      heartrate: activity.average_heartrate,
      effort: activity.suffer_score,
      hasRoute: activity.hasRoute,
    },
  };
}

/**
 * The year's standout days: longest, most climbing, fastest and hardest. One
 * ride can win several; it is shown once, and the next category in the
 * reserve list fills its place, so four cards are four different days.
 */
export function biggestDays(activities: Activity[], filter: SportFilter, count = 4): BigDay[] {
  const candidates: Array<() => BigDay | null> = isDistanceSport(filter)
    ? [
        () =>
          bigDay("longest", "Longest", topBy(activities, (a) => a.distance), (v) =>
            `${formatNumber(v, 1)} mi`,
          ),
        () =>
          bigDay("climbing", "Most climbing", topBy(activities, (a) => a.total_elevation_gain), (v) =>
            `${formatNumber(v)} ft`,
          ),
        () =>
          bigDay(
            "fastest",
            "Fastest",
            topBy(activities, (a) => (a.distance >= 10 ? a.average_speed : null)),
            (v) => `${v.toFixed(1)} mph`,
          ),
        () =>
          bigDay("hardest", "Hardest", topBy(activities, (a) => a.suffer_score), (v) =>
            `${formatNumber(v)} RE`,
          ),
        () => bigDay("time", "Most time", topBy(activities, (a) => a.moving_time), formatHours),
        () =>
          bigDay(
            "power",
            "Strongest",
            topBy(activities, (a) => a.weighted_average_watts),
            (v) => `${formatNumber(v)} W`,
          ),
        () => bigDay("kudos", "Most kudos", topBy(activities, (a) => a.kudos_count), formatNumber),
      ]
    : [
        () => bigDay("longest", "Longest session", topBy(activities, (a) => a.moving_time), formatHours),
        () =>
          bigDay("hardest", "Hardest", topBy(activities, (a) => a.suffer_score), (v) =>
            `${formatNumber(v)} RE`,
          ),
        () =>
          bigDay(
            "heart",
            "Highest heart rate",
            topBy(activities, (a) => a.average_heartrate),
            (v) => `${Math.round(v)} bpm`,
          ),
        () => bigDay("kudos", "Most kudos", topBy(activities, (a) => a.kudos_count), formatNumber),
      ];
  const days: BigDay[] = [];
  const used = new Set<string>();
  for (const candidate of candidates) {
    if (days.length >= count) break;
    const day = candidate();
    if (!day || used.has(day.activity.id)) continue;
    used.add(day.activity.id);
    days.push(day);
  }
  return days;
}

// ----------------------------------------------------------------- gear --

export type GearRace = {
  entries: Array<{ id: string; name: string; detail: string; total: number; cumulative: number[] }>;
};

/** Miles per bike (or shoe) through the year, as running weekly totals. */
export function gearRace(activities: Activity[], gear: Gear[], year: number, limit = 6): GearRace {
  const days = daysInYear(year);
  const weekly = new Map<string, number[]>();
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!activity.gear_id || !date || date.year !== year || activity.distance <= 0) continue;
    let values = weekly.get(activity.gear_id);
    if (!values) {
      values = new Array<number>(STREAM_WEEKS).fill(0);
      weekly.set(activity.gear_id, values);
    }
    values[weekBucket(dayOfYear(date), days)] += activity.distance;
  }
  const entries = [...weekly.entries()]
    .map(([id, values]) => {
      const item = gear.find((entry) => entry.id === id);
      const running = cumulative(values);
      return {
        id,
        name: item?.name ?? "Unnamed gear",
        detail: item ? [item.brand, item.model].filter(Boolean).join(" ").trim() : "",
        total: running[running.length - 1],
        cumulative: running.map((value) => Math.round(value * 10) / 10),
      };
    })
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
  return { entries };
}

// ----------------------------------------------------------- pickleball --

export type CourtChapter = {
  sessions: number;
  hours: number;
  heartrate: number | null;
  months: number[];
  busiestMonth: number | null;
  longest: { id: string; date: string; hours: number } | null;
  /** Every session, for the ball grid. */
  balls: Array<{ id: string; month: number; hours: number; date: string }>;
  previousSessions: number | null;
};

export function courtChapter(
  activities: Activity[],
  previous: Activity[] | null,
): CourtChapter | null {
  const games = activities.filter((activity) => getActivityKind(activity.type) === "Pickleball");
  if (!games.length) return null;
  const months = monthlyTotals(games, "activities");
  const rates = games.flatMap((game) => (game.average_heartrate ? [game.average_heartrate] : []));
  const longest = topBy(games, (game) => game.moving_time);
  return {
    sessions: games.length,
    hours: games.reduce((sum, game) => sum + game.moving_time, 0),
    heartrate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    months,
    busiestMonth: busiestMonth(months),
    longest: longest
      ? { id: longest.activity.id, date: longest.activity.date, hours: longest.value }
      : null,
    balls: games
      .map((game) => ({
        id: game.id,
        month: calendarDate(game.date)?.month ?? 0,
        hours: game.moving_time,
        date: game.date.slice(0, 10),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    previousSessions: previous
      ? previous.filter((activity) => getActivityKind(activity.type) === "Pickleball").length
      : null,
  };
}

// ------------------------------------------------------------- sketches --

type Point = [number, number];

function perpendicular(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / length;
}

/** Ramer–Douglas–Peucker, iterative so a long track cannot overflow the stack. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let index = first + 1; index < last; index++) {
      const distance = perpendicular(points[index], points[first], points[last]);
      if (distance > worst) {
        worst = distance;
        at = index;
      }
    }
    if (at !== -1 && worst > tolerance) {
      keep[at] = 1;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/** Latitude/longitude to a flat plane, longitude scaled by the latitude's cosine. */
function project(points: Point[], latitude: number): Point[] {
  const scale = Math.cos((latitude * Math.PI) / 180);
  return points.map(([lat, lng]) => [lng * scale, -lat]);
}

function pathData(points: Point[]): string {
  return points
    .map(([x, y], index) => `${index ? "L" : "M"}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`)
    .join("");
}

/**
 * A route as a path in a `size` square, centred and scaled to fit. The
 * points are expected to be trimmed already; this only draws them.
 */
export function routeSketch(points: Point[], size = 100, padding = 6): string | null {
  if (points.length < 2) return null;
  const latitude = points.reduce((sum, [lat]) => sum + lat, 0) / points.length;
  const flat = project(points, latitude);
  const xs = flat.map(([x]) => x);
  const ys = flat.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size - padding * 2) / span;
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetY = (size - (maxY - minY) * scale) / 2;
  const placed = flat.map(([x, y]): Point => [
    offsetX + (x - minX) * scale,
    offsetY + (y - minY) * scale,
  ]);
  return pathData(simplify(placed, size / 300));
}

function kilometresBetween([lat1, lng1]: Point, [lat2, lng2]: Point): number {
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dx = (lng2 - lng1) * Math.cos(meanLat) * 111.32;
  const dy = (lat2 - lat1) * 110.57;
  return Math.hypot(dx, dy);
}

export type PlaceSketch = {
  width: number;
  height: number;
  routes: Array<{ id: string; d: string; order: number }>;
  /** Routes ridden away from the home area, left out of the drawing. */
  elsewhere: number;
};

/**
 * The year's routes overlaid in one frame. Riding away from home would shrink
 * the home area to a dot, so the frame holds the busiest area: the routes
 * whose centre lies within `radiusKm` of the most-visited spot. Points arrive
 * trimmed; the output is abstract plane coordinates, not latitude/longitude.
 */
export function placesSketch(
  routes: Array<{ id: string; date: string; points: Point[] }>,
  width = 1000,
  radiusKm = 45,
): PlaceSketch | null {
  const usable = routes.filter((route) => route.points.length >= 2);
  if (!usable.length) return null;
  const centres = usable.map((route) => {
    const [lat, lng] = route.points.reduce(
      ([a, b], [x, y]) => [a + x, b + y],
      [0, 0],
    );
    return [lat / route.points.length, lng / route.points.length] as Point;
  });

  // The busiest quarter-degree cell, then everything near its mean centre.
  const cells = new Map<string, number[]>();
  centres.forEach(([lat, lng], index) => {
    const key = `${Math.floor(lat * 4)}:${Math.floor(lng * 4)}`;
    cells.set(key, [...(cells.get(key) ?? []), index]);
  });
  const busiest = [...cells.values()].sort((a, b) => b.length - a.length)[0];
  const home: Point = [
    busiest.reduce((sum, index) => sum + centres[index][0], 0) / busiest.length,
    busiest.reduce((sum, index) => sum + centres[index][1], 0) / busiest.length,
  ];
  const local = usable
    .map((route, index) => ({ route, centre: centres[index] }))
    .filter(({ centre }) => kilometresBetween(centre, home) <= radiusKm)
    .map(({ route }) => route)
    .sort((a, b) => a.date.localeCompare(b.date));

  const flat = local.map((route) => project(route.points, home[0]));
  const all = flat.flat();
  const xs = all.map(([x]) => x);
  const ys = all.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1e-6;
  const spanY = Math.max(...ys) - minY || 1e-6;
  // Keep the frame between a wide and a tall card so a coastal strip or a
  // single out-and-back still draws at a sensible size.
  const aspect = Math.min(1.25, Math.max(0.5, spanY / spanX));
  const height = Math.round(width * aspect);
  const padding = width * 0.04;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  return {
    width,
    height,
    routes: flat.map((points, order) => ({
      id: local[order].id,
      order,
      d: pathData(
        simplify(
          points.map(([x, y]): Point => [offsetX + (x - minX) * scale, offsetY + (y - minY) * scale]),
          width / 900,
        ),
      ),
    })),
    elsewhere: usable.length - local.length,
  };
}

// -------------------------------------------------------------- the page --

export type PublicRoute = { id: string; type: string; date: string; polyline: string };

export type YearReviewData = {
  year: number;
  filter: SportFilter;
  window: ReviewWindow;
  years: YearStripEntry[];
  totals: ReviewTotals;
  previous: ReviewTotals | null;
  summary: string;
  mix: Array<{ kind: SportKind; count: number; hours: number; distance: number }>;
  monthly: { hours: number[]; distance: number[] };
  busiestMonth: number | null;
  ring: RingDay[];
  streak: DayRun | null;
  rest: DayRun | null;
  clock: ClockData;
  weekdays: WeekdayEntry[];
  stream: WeeklyStream;
  bigDays: Array<BigDay & { sketch: string | null }>;
  places: PlaceSketch | null;
  gear: GearRace;
  court: CourtChapter | null;
  comparisons: Comparison[];
};

const VIRTUAL = /virtual/i;

/**
 * Everything the page draws for one year and sport. `activities` are already
 * filtered to the sport; `routes` are public (privacy-trimmed) polylines.
 */
export function buildYearReview({
  activities,
  gear,
  routes,
  filter,
  year,
  today,
}: {
  activities: Activity[];
  gear: Gear[];
  routes: PublicRoute[];
  filter: SportFilter;
  year: number;
  today: CalendarDate;
}): YearReviewData {
  const window = reviewWindow(year, today);
  const current = inYear(activities, year);
  const cutoff = window.partial ? { month: today.month, day: today.day } : undefined;
  const before = inYear(activities, year - 1, cutoff);
  const hadBefore = inYear(activities, year - 1).length > 0;
  const totals = reviewTotals(current);
  const previous = hadBefore ? reviewTotals(before) : null;
  const distanceSport = isDistanceSport(filter);
  const monthly = {
    hours: monthlyTotals(current, "hours"),
    distance: monthlyTotals(current, "distance"),
  };
  const month = busiestMonth(
    distanceSport && filter !== "All" ? monthly.distance : monthly.hours,
  );
  const ring = ringCalendar(current, year);
  const indices = ring.map((day) => day.index);

  const routeById = new Map(routes.map((route) => [route.id, route]));
  const bigDays = biggestDays(current, filter).map((day) => {
    const route = routeById.get(day.activity.id);
    return { ...day, sketch: route ? routeSketch(decodePolyline(route.polyline)) : null };
  });

  const ids = new Set(current.map((activity) => activity.id));
  const outdoor = routes.filter((route) => ids.has(route.id) && !VIRTUAL.test(route.type));
  const places = placesSketch(
    outdoor.map((route) => ({ id: route.id, date: route.date, points: decodePolyline(route.polyline) })),
  );

  const keys: ComparisonKey[] = distanceSport
    ? ["distance", "hours", "elevation", "activities", "activeDays"]
    : ["hours", "activities", "activeDays"];

  return {
    year,
    filter,
    window,
    years: yearStrip(activities),
    totals,
    previous,
    summary: yearSummary({
      year,
      filter,
      partial: window.partial,
      totals,
      previous,
      busiestMonth: month,
    }),
    mix: sportMix(current),
    monthly,
    busiestMonth: month,
    ring,
    streak: longestStreak(indices, year),
    rest: longestBreak(indices, year),
    clock: timeOfDay(current),
    weekdays: weekdayRhythm(current),
    stream: weeklyStream(current, year),
    bigDays,
    places,
    gear: gearRace(current, gear, year),
    court: filter === "All" || filter === "Pickleball" ? courtChapter(current, hadBefore ? before : null) : null,
    comparisons: hadBefore
      ? yearOverYear(current, before, keys, window.partial ? today.month + 1 : 12)
      : [],
  };
}
