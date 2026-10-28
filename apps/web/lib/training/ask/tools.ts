import type Anthropic from "@anthropic-ai/sdk";

import {
  calendarDate,
  formatHours,
  getActivityKind,
  isDistanceSport,
  metricsFor,
  type Activity,
  type Gear,
  type MetricKey,
  type SportFilter,
  type SportKind,
} from "@/lib/training/activity-types";
import { bikeRecords, scheduleStatus } from "@/lib/training/maintenance";
import {
  buildPerformanceModel,
  fitnessSeries,
  meanMaximalPower,
  powerEntries,
  rideMetrics,
  type FitnessPoint,
  type PerformanceModel,
} from "@/lib/training/metrics/performance";
import {
  defaultGoal,
  goalProgress,
  progression,
  yearPosition,
} from "@/lib/training/metrics/progression";

import {
  addDays,
  dayNumber,
  fromDayNumber,
  lastDayOfMonth,
  MONTH_NAMES,
  shiftYears,
  weekStart,
} from "./dates";
import type { AskData, EffortsData, SegmentEffort, ToolOutcome } from "./types";
import { isCalendarDate, validate, type JsonSchema } from "./validate";

/**
 * The Ask page's tools: typed, validated reads over the rider's own data.
 *
 * Every figure comes from the same functions the Training pages use (the
 * progression and goal maths, the performance model, the service schedules),
 * so an answer agrees with what the rider sees elsewhere. Results are compact
 * JSON shaped for the model to read, never raw objects, and never carry
 * coordinates: activities return their summary, segments their name and
 * length, and no polyline, stream or latlng leaves this file.
 */

// ------------------------------------------------------------ helpers --

const SPORTS = ["All", "Ride", "Run", "Pickleball", "Walk", "Swim", "Training", "Other"] as const;
const DATE: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "YYYY-MM-DD",
};

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Drops null and undefined fields so results stay compact. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null && field !== undefined),
  ) as Partial<T>;
}

function inRange(activity: Activity, from: string | undefined, to: string | undefined): boolean {
  const day = activity.date.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

function matchesSport(activity: Activity, sport: SportFilter | undefined): boolean {
  return !sport || sport === "All" || getActivityKind(activity.type) === sport;
}

function clock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${seconds / 60}min`;
  return `${seconds / 3600}h`;
}

class ToolInputError extends Error {}

function requireDateOrder(from: string | undefined, to: string | undefined) {
  for (const [label, value] of [["from", from], ["to", to]] as const) {
    if (value !== undefined && !isCalendarDate(value)) {
      throw new ToolInputError(`${label} is not a real calendar date: ${value}`);
    }
  }
  if (from && to && from > to) throw new ToolInputError("from must not be after to");
}

function gearLookup(data: AskData): Map<string, Gear> {
  return new Map(data.gear.map((gear) => [gear.id, gear]));
}

function matchesGear(gear: Gear, query: string): boolean {
  const haystack = `${gear.name} ${gear.brand} ${gear.model} ${gear.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** One activity as the model sees it: summary fields only, no route. */
function activityRow(activity: Activity, gear: Map<string, Gear>) {
  const distance = isDistanceSport(getActivityKind(activity.type));
  return compact({
    id: activity.id,
    date: activity.date.slice(0, 16).replace("T", " "),
    name: activity.name,
    type: activity.type,
    distance_mi: distance ? round(activity.distance, 1) : null,
    time: formatHours(activity.moving_time),
    elevation_ft: distance ? round(activity.total_elevation_gain) : null,
    avg_speed_mph: distance && activity.average_speed ? round(activity.average_speed, 1) : null,
    avg_hr: activity.average_heartrate ? round(activity.average_heartrate) : null,
    avg_watts: activity.average_watts ? round(activity.average_watts) : null,
    weighted_watts: activity.weighted_average_watts ? round(activity.weighted_average_watts) : null,
    kj: activity.kilojoules ? round(activity.kilojoules) : null,
    kudos: activity.kudos_count || null,
    gear: activity.gear_id ? (gear.get(activity.gear_id)?.name ?? activity.gear_id) : null,
  });
}

type Totals = {
  sessions: number;
  distance_mi: number;
  time_h: number;
  time: string;
  elevation_ft: number;
  kudos: number;
  kj: number;
};

function totalsOf(activities: Activity[]): Totals {
  let distance = 0;
  let time = 0;
  let elevation = 0;
  let kudos = 0;
  let kj = 0;
  for (const activity of activities) {
    distance += activity.distance;
    time += activity.moving_time;
    elevation += activity.total_elevation_gain;
    kudos += activity.kudos_count;
    kj += activity.kilojoules ?? 0;
  }
  return {
    sessions: activities.length,
    distance_mi: round(distance, 1),
    time_h: round(time, 2),
    time: formatHours(time),
    elevation_ft: round(elevation),
    kudos,
    kj: round(kj),
  };
}

// The performance model is the heaviest computation here; one question may
// call the performance and activity tools several times against the same data.
const models = new WeakMap<AskData, { model: PerformanceModel; fitness: FitnessPoint[] }>();

function performanceModel(data: AskData) {
  let entry = models.get(data);
  if (!entry) {
    const today = calendarDate(data.today)!;
    const model = buildPerformanceModel(
      data.activities,
      data.streamsIndex,
      data.settings.athlete,
      today,
    );
    entry = { model, fitness: fitnessSeries(data.activities, model.loads, today) };
    models.set(data, entry);
  }
  return entry;
}

// -------------------------------------------------- search_activities --

type SearchInput = {
  sport?: SportFilter;
  type?: string;
  from?: string;
  to?: string;
  name_contains?: string;
  gear?: string;
  sort_by?: "date" | "distance" | "time" | "elevation" | "power" | "kudos";
  order?: "desc" | "asc";
  limit?: number;
};

const searchSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sport: {
      type: "string",
      enum: SPORTS,
      description:
        "Sport family. Ride includes virtual, gravel, mountain and e-bike rides; Walk includes hikes; Training is gym work, yoga, HIIT and similar.",
    },
    type: {
      type: "string",
      maxLength: 40,
      description: "Exact Strava sport_type, e.g. VirtualRide, GravelRide, Pickleball. Narrower than sport.",
    },
    from: { ...DATE, description: "First day to include, YYYY-MM-DD." },
    to: { ...DATE, description: "Last day to include, YYYY-MM-DD." },
    name_contains: { type: "string", minLength: 1, maxLength: 80, description: "Case-insensitive text in the activity name." },
    gear: {
      type: "string",
      minLength: 1,
      maxLength: 60,
      description: "Bike or shoe nickname, brand, model or Strava gear id, e.g. TCR or b8099416.",
    },
    sort_by: {
      type: "string",
      enum: ["date", "distance", "time", "elevation", "power", "kudos"],
      description: "date (default), distance, moving time, elevation gain, power (weighted average watts) or kudos.",
    },
    order: { type: "string", enum: ["desc", "asc"], description: "desc (default) or asc." },
    limit: { type: "integer", minimum: 1, maximum: 25, description: "Rows to return, 1 to 25 (default 10)." },
  },
};

function searchActivities(input: SearchInput, data: AskData): ToolOutcome {
  requireDateOrder(input.from, input.to);
  const gear = gearLookup(data);
  const gearIds = input.gear
    ? new Set(data.gear.filter((item) => matchesGear(item, input.gear!)).map((item) => item.id))
    : null;
  if (gearIds && gearIds.size === 0) {
    return {
      ok: true,
      summary: `No gear matches "${input.gear}"`,
      result: {
        matched: 0,
        note: `No bike or shoe matches "${input.gear}".`,
        known_gear: data.gear.map((item) => `${item.name} (${[item.brand, item.model].filter(Boolean).join(" ") || item.kind})`),
      },
    };
  }
  const needle = input.name_contains?.toLowerCase();
  const type = input.type?.toLowerCase();
  const matched = data.activities.filter(
    (activity) =>
      matchesSport(activity, input.sport) &&
      (!type || activity.type.toLowerCase() === type) &&
      inRange(activity, input.from, input.to) &&
      (!needle || activity.name.toLowerCase().includes(needle)) &&
      (!gearIds || (activity.gear_id !== null && gearIds.has(activity.gear_id))),
  );

  const sortBy = input.sort_by ?? "date";
  const power = (activity: Activity) => activity.weighted_average_watts ?? activity.average_watts;
  const key: Record<NonNullable<SearchInput["sort_by"]>, (activity: Activity) => number | string | null> = {
    date: (activity) => activity.date,
    distance: (activity) => activity.distance,
    time: (activity) => activity.moving_time,
    elevation: (activity) => activity.total_elevation_gain,
    power,
    kudos: (activity) => activity.kudos_count,
  };
  const value = key[sortBy];
  const direction = input.order === "asc" ? 1 : -1;
  const sorted = matched
    .filter((activity) => value(activity) !== null)
    .sort((a, b) => {
      const left = value(a)!;
      const right = value(b)!;
      return (left < right ? -1 : left > right ? 1 : 0) * direction;
    });
  const limit = input.limit ?? 10;
  const rows = sorted.slice(0, limit).map((activity) => activityRow(activity, gear));
  return {
    ok: true,
    summary: `${matched.length} matched, ${rows.length} returned (by ${sortBy})`,
    result: compact({
      matched: matched.length,
      returned: rows.length,
      sorted_by: `${sortBy} ${input.order ?? "desc"}`,
      skipped_without_power: sortBy === "power" ? matched.length - sorted.length : null,
      totals_of_matched: totalsOf(matched),
      activities: rows,
    }),
  };
}

// ------------------------------------------------------------- totals --

type TotalsInput = {
  period: "year" | "month" | "week" | "custom";
  year?: number;
  month?: number;
  week_of?: string;
  from?: string;
  to?: string;
  sport?: SportFilter;
  group_by_sport?: boolean;
  by_month?: boolean;
  compare_years?: boolean;
};

const totalsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["period"],
  properties: {
    period: {
      type: "string",
      enum: ["year", "month", "week", "custom"],
      description: "year (calendar year), month, week (Monday to Sunday) or custom (from/to).",
    },
    year: { type: "integer", minimum: 2000, maximum: 2100, description: "For year and month periods; defaults to the current year." },
    month: { type: "integer", minimum: 1, maximum: 12, description: "For the month period, 1 to 12." },
    week_of: { ...DATE, description: "For the week period: any day in the week; defaults to today." },
    from: { ...DATE, description: "For the custom period: first day, YYYY-MM-DD." },
    to: { ...DATE, description: "For the custom period: last day, YYYY-MM-DD." },
    sport: { type: "string", enum: SPORTS, description: "Restrict to one sport family (default All)." },
    group_by_sport: { type: "boolean", description: "Also break the totals down by sport (default true)." },
    by_month: {
      type: "boolean",
      description: "Also return one row per calendar month in the period, e.g. to find the biggest month of a year in one call.",
    },
    compare_years: {
      type: "boolean",
      description:
        "Also total the same calendar window in every year with data, with each year's full-window figures and, while the requested window is still in progress, its figures through the same day; plus the best year for each metric.",
    },
  },
};

type Period = { label: string; from: string; to: string; inProgress: boolean };

function resolvePeriod(input: TotalsInput, today: string): Period {
  const year = input.year ?? Number(today.slice(0, 4));
  let period: Omit<Period, "inProgress">;
  switch (input.period) {
    case "year":
      period = { label: String(year), from: `${year}-01-01`, to: `${year}-12-31` };
      break;
    case "month": {
      if (!input.month) throw new ToolInputError("month (1-12) is required for the month period");
      const start = `${year}-${String(input.month).padStart(2, "0")}-01`;
      period = { label: `${MONTH_NAMES[input.month - 1]} ${year}`, from: start, to: lastDayOfMonth(year, input.month) };
      break;
    }
    case "week": {
      const anchor = input.week_of ?? today;
      if (!isCalendarDate(anchor)) throw new ToolInputError(`week_of is not a real date: ${anchor}`);
      const start = weekStart(anchor);
      period = { label: `Week of ${start}`, from: start, to: addDays(start, 6) };
      break;
    }
    case "custom":
      if (!input.from || !input.to) throw new ToolInputError("from and to are required for the custom period");
      requireDateOrder(input.from, input.to);
      if (dayNumber(input.to) - dayNumber(input.from) > 366 * 30) {
        throw new ToolInputError("custom periods are limited to 30 years");
      }
      period = { label: `${input.from} to ${input.to}`, from: input.from, to: input.to };
      break;
  }
  if (period.from > today) throw new ToolInputError(`${period.label} has not started yet (today is ${today})`);
  return { ...period, inProgress: period.to >= today };
}

function bySport(activities: Activity[]) {
  const groups = new Map<SportKind, Activity[]>();
  for (const activity of activities) {
    const kind = getActivityKind(activity.type);
    groups.set(kind, [...(groups.get(kind) ?? []), activity]);
  }
  return [...groups.entries()]
    .map(([sport, items]) => {
      const totals = totalsOf(items);
      return compact({
        sport,
        sessions: totals.sessions,
        distance_mi: isDistanceSport(sport) ? totals.distance_mi : null,
        time_h: totals.time_h,
        time: totals.time,
        elevation_ft: isDistanceSport(sport) ? totals.elevation_ft : null,
      });
    })
    .sort((a, b) => (b.time_h ?? 0) - (a.time_h ?? 0));
}

const COMPARED: Array<keyof Totals> = ["distance_mi", "time_h", "elevation_ft", "sessions", "kj"];

function bestYears(rows: Array<{ year: number; totals: Totals }>) {
  return Object.fromEntries(
    COMPARED.map((metric) => {
      const top = rows.reduce<{ year: number; value: number } | null>((best, row) => {
        const value = row.totals[metric] as number;
        return !best || value > best.value ? { year: row.year, value } : best;
      }, null);
      return [metric, top];
    }),
  );
}

function slim(totals: Totals, distanceSport: boolean) {
  return compact({
    sessions: totals.sessions,
    distance_mi: distanceSport ? totals.distance_mi : null,
    time_h: totals.time_h,
    elevation_ft: distanceSport ? totals.elevation_ft : null,
    kj: totals.kj || null,
  });
}

function totals(input: TotalsInput, data: AskData): ToolOutcome {
  const period = resolvePeriod(input, data.today);
  const distanceSport = isDistanceSport(input.sport ?? "All");
  const pool = data.activities.filter((activity) => matchesSport(activity, input.sport));
  const inWindow = (from: string, to: string) => pool.filter((activity) => inRange(activity, from, to));
  const selected = inWindow(period.from, period.to);
  const result: Record<string, unknown> = {
    period: compact({
      label: period.label,
      from: period.from,
      to: period.to,
      in_progress: period.inProgress || null,
      through: period.inProgress ? data.today : null,
    }),
    sport: input.sport ?? "All",
    totals: distanceSport
      ? totalsOf(selected)
      : { ...slim(totalsOf(selected), false), time: totalsOf(selected).time, kudos: totalsOf(selected).kudos },
  };
  if (distanceSport && selected.some((activity) => activity.kilojoules === null)) {
    result.kj_note = `kJ is recorded only on rides with power (${selected.filter((activity) => activity.kilojoules !== null).length} of ${selected.length} here).`;
  }
  if (input.group_by_sport !== false && (input.sport ?? "All") === "All") {
    result.by_sport = bySport(selected);
  }

  if (input.by_month) {
    const months = new Map<string, Activity[]>();
    for (const activity of selected) {
      const key = activity.date.slice(0, 7);
      months.set(key, [...(months.get(key) ?? []), activity]);
    }
    if (months.size > 36) throw new ToolInputError("by_month is limited to periods of three years or less");
    result.by_month = [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, items]) => ({ month, ...slim(totalsOf(items), distanceSport) }));
  }

  if (input.compare_years) {
    const startYear = Number(period.from.slice(0, 4));
    const firstYear = pool.reduce((min, activity) => Math.min(min, Number(activity.date.slice(0, 4))), startYear);
    const currentYear = Number(data.today.slice(0, 4));
    const cutoff = period.inProgress ? data.today : period.to;
    const rows: Array<{ year: number; from: string; to: string; totals: Totals; toDate: Totals | null }> = [];
    for (let shift = firstYear - startYear; startYear + shift <= currentYear; shift++) {
      const from = shiftYears(period.from, shift);
      if (from > data.today) break;
      const to = shiftYears(period.to, shift);
      rows.push({
        year: startYear + shift,
        from,
        to,
        totals: totalsOf(inWindow(from, to)),
        toDate: period.inProgress ? totalsOf(inWindow(from, shiftYears(cutoff, shift))) : null,
      });
    }
    const withData = rows.filter((row) => row.totals.sessions > 0);
    result.comparison = compact({
      note: period.inProgress
        ? `The requested window is in progress; to_date covers each year's window through the same day (${data.today.slice(5)}).`
        : null,
      // Newest first, without the fields the headline totals already explain.
      by_year: rows
        .slice()
        .reverse()
        .map((row) =>
          compact({
            year: row.year,
            full: slim(row.totals, distanceSport),
            to_date:
              row.toDate && row.toDate.sessions !== row.totals.sessions
                ? slim(row.toDate, distanceSport)
                : null,
          }),
        ),
      best_full: bestYears(withData),
      best_to_date: period.inProgress
        ? bestYears(withData.map((row) => ({ year: row.year, totals: row.toDate! })))
        : null,
    });
  }

  const summary = `${period.label}: ${selected.length} sessions${input.compare_years ? ", compared across years" : ""}`;
  return { ok: true, summary, result };
}

// ------------------------------------------------------- goals_status --

type GoalsInput = { sport?: SportFilter };

const goalsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sport: { type: "string", enum: SPORTS, description: "One sport family; omit for every sport with a goal." },
  },
};

function goalsStatus(input: GoalsInput, data: AskData): ToolOutcome {
  const today = calendarDate(data.today)!;
  const stored = data.settings.goals;
  const thisYear = new Set(
    data.activities
      .filter((activity) => activity.date.startsWith(String(today.year)))
      .map((activity) => getActivityKind(activity.type)),
  );
  const sports: SportFilter[] = input.sport
    ? [input.sport]
    : [
        ...new Set<SportFilter>([
          "All",
          ...Object.keys(stored).map((key) => key.split(":")[0] as SportFilter),
          ...[...thisYear].filter((kind) => kind === "Ride" || kind === "Run"),
        ]),
      ];

  const rows = sports.flatMap((sport) => {
    const activities = data.activities.filter((activity) => matchesSport(activity, sport));
    // The same two metrics the Overview's goals card shows for each sport.
    return metricsFor(sport)
      .slice(0, 2)
      .map((metric: MetricKey) => {
        const result = progression(activities, metric, today);
        const lastYear = result.series.find((entry) => entry.year === today.year - 1)?.total;
        const saved = stored[`${sport}:${metric}`];
        const goal = saved ?? defaultGoal(lastYear, metric);
        const actual = result.current?.total ?? 0;
        const unit = metric === "distance" ? "mi" : metric === "elevation" ? "ft" : metric === "time" ? "h" : "sessions";
        const digits = metric === "time" || metric === "distance" ? 1 : 0;
        if (!goal) {
          return { sport, metric, unit, goal: null, actual: round(actual, digits), note: "No goal set and no previous year to base one on." };
        }
        const progress = goalProgress(goal, actual, result.todayPosition);
        return {
          sport,
          metric,
          unit,
          goal: round(goal, digits),
          goal_source: saved ? "set by the rider" : "default: last year + 10%",
          actual: round(actual, digits),
          even_pace_today: round(progress.expected, digits),
          ahead_by: round(progress.delta, digits),
          status: actual >= goal ? "reached" : progress.delta >= 0 ? "ahead of pace" : "behind pace",
          needed_per_week: round(progress.neededPerWeek, digits),
          projected_year_end: round(progress.projected, digits),
          last_year_total: lastYear === undefined ? null : round(lastYear, digits),
          best_year: result.best ? { year: result.best.year, total: round(result.best.total, digits) } : null,
        };
      });
  });

  return {
    ok: true,
    summary: `${rows.length} goals for ${today.year}`,
    result: {
      year: today.year,
      today: data.today,
      day_of_year: yearPosition(today),
      goals: rows,
    },
  };
}

// ------------------------------------------------------- performance --

type PerformanceInput = {
  window?: "last28" | "last90" | "year" | "all_time" | "custom";
  from?: string;
  to?: string;
  on_date?: string;
  ftp_history_from?: string;
  ftp_history_to?: string;
};

const performanceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    window: {
      type: "string",
      enum: ["last28", "last90", "year", "all_time", "custom"],
      description: "Window for the power curve: last 28 or 90 days, this calendar year, all time, or custom from/to (default last90).",
    },
    from: { ...DATE, description: "Custom power-curve window start." },
    to: { ...DATE, description: "Custom power-curve window end." },
    on_date: { ...DATE, description: "Also report fitness, fatigue and form on this date." },
    ftp_history_from: { ...DATE, description: "Start of the FTP history to return (default 1 January this year)." },
    ftp_history_to: { ...DATE, description: "End of the FTP history to return (default today)." },
  },
};

const CURVE_KEYS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];

function fitnessAt(points: FitnessPoint[], date: string) {
  const point = points.find((entry) => entry.date === date);
  return point
    ? { date, fitness: round(point.fitness, 1), fatigue: round(point.fatigue, 1), form: round(point.form, 1) }
    : null;
}

function performance(input: PerformanceInput, data: AskData): ToolOutcome {
  requireDateOrder(input.from, input.to);
  requireDateOrder(input.ftp_history_from, input.ftp_history_to);
  if (input.on_date && !isCalendarDate(input.on_date)) throw new ToolInputError("on_date is not a real date");
  const { model, fitness } = performanceModel(data);
  const todayDay = dayNumber(data.today);
  const year = data.today.slice(0, 4);

  const window = input.window ?? (input.from || input.to ? "custom" : "last90");
  const range: Record<string, [number, number]> = {
    last28: [todayDay - 27, todayDay],
    last90: [todayDay - 89, todayDay],
    year: [dayNumber(`${year}-01-01`), todayDay],
    all_time: [-Infinity, todayDay],
    custom: [input.from ? dayNumber(input.from) : -Infinity, input.to ? dayNumber(input.to) : todayDay],
  };
  const [fromDay, toDay] = range[window];
  const curve = meanMaximalPower(powerEntries(data.streamsIndex), fromDay, toDay, CURVE_KEYS);

  const historyFrom = input.ftp_history_from ?? `${year}-01-01`;
  const historyTo = input.ftp_history_to ?? data.today;
  const history = model.ftpHistory.filter((point) => point.date >= historyFrom && point.date <= historyTo);
  // Weekly estimates are more than the model needs; the last one in each month
  // shows the trend, and the extremes are kept separately.
  const monthly = [...new Map(history.map((point) => [point.date.slice(0, 7), point])).values()];
  const extreme = (pick: (a: number, b: number) => boolean) =>
    history.reduce<(typeof history)[number] | null>((best, point) => (!best || pick(point.ftp, best.ftp) ? point : best), null);

  const ftp = model.ftp;
  const weight = data.settings.athlete.weightKg;
  const result = compact({
    today: data.today,
    ftp: ftp
      ? compact({
          watts: ftp.ftp,
          source: ftp.source === "override" ? "set by the rider" : "estimated from the last 90 days of power",
          critical_power: ftp.source === "estimate" ? ftp.cp : null,
          w_prime_joules: ftp.source === "estimate" ? ftp.wPrime : null,
          best_20min_watts: ftp.source === "estimate" ? ftp.best20 : null,
          watts_per_kg: weight ? round(ftp.ftp / weight, 2) : null,
        })
      : { note: "Not enough recent power data to estimate FTP." },
    ftp_history: {
      from: historyFrom,
      to: historyTo,
      method: "weekly estimate from each trailing 90 days; last estimate of each month shown",
      monthly: monthly.map((point) => ({ date: point.date, ftp: point.ftp })),
      first: history[0] ?? null,
      latest: history[history.length - 1] ?? null,
      highest: extreme((a, b) => a > b),
      lowest: extreme((a, b) => a < b),
    },
    power_curve: {
      window,
      from: Number.isFinite(fromDay) ? fromDayNumber(fromDay) : "all time",
      to: fromDayNumber(toDay),
      best_efforts: curve.map((point) =>
        compact({
          duration: durationLabel(point.duration),
          watts: point.watts,
          watts_per_kg: weight ? round(point.watts / weight, 2) : null,
          date: point.date,
          activity_id: point.activityId,
        }),
      ),
    },
    training_load: compact({
      method: "fitness = 42-day load average (CTL), fatigue = 7-day (ATL), form = fitness - fatigue (TSB)",
      today: fitnessAt(fitness, data.today),
      four_weeks_ago: fitnessAt(fitness, addDays(data.today, -28)),
      on_date: input.on_date
        ? (fitnessAt(fitness, input.on_date) ?? { date: input.on_date, note: "Outside the load history." })
        : null,
    }),
    heart_rate: {
      resting: model.heartRate.restingHr,
      max: model.heartRate.maxHr,
      max_source: model.heartRate.maxHrSource,
    },
  });
  return {
    ok: true,
    summary: `FTP ${ftp ? `${ftp.ftp} W` : "unknown"}, ${curve.length} curve points (${window}), ${monthly.length} FTP months`,
    result,
  };
}

// ----------------------------------------------- gear_and_maintenance --

type GearInput = {
  bike?: string;
  include_retired?: boolean;
  include_shoes?: boolean;
  part?: string;
  log_limit?: number;
};

const gearSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    bike: {
      type: "string",
      minLength: 1,
      maxLength: 60,
      description: "Nickname, brand, model or gear id to narrow to one bike, e.g. TCR or Storck.",
    },
    include_retired: { type: "boolean", description: "Include retired bikes (default false)." },
    include_shoes: { type: "boolean", description: "Include running shoes (default false)." },
    part: {
      type: "string",
      minLength: 1,
      maxLength: 40,
      description: "Filter the maintenance log by part or service text, e.g. chain, wax, tires.",
    },
    log_limit: { type: "integer", minimum: 1, maximum: 50, description: "Maintenance records to return, newest first (default 20)." },
  },
};

function gearAndMaintenance(input: GearInput, data: AskData): ToolOutcome {
  const year = data.today.slice(0, 4);
  // A named bike is found whatever its kind or state; the full list follows the flags.
  const chosen = input.bike
    ? data.gear.filter((gear) => matchesGear(gear, input.bike!))
    : data.gear.filter(
        (gear) =>
          (input.include_shoes || gear.kind === "bike") && (input.include_retired || !gear.retired),
      );

  const usage = new Map<string, { miles: number; sessions: number; last: string }>();
  for (const activity of data.activities) {
    if (!activity.gear_id) continue;
    const entry = usage.get(activity.gear_id) ?? { miles: 0, sessions: 0, last: "" };
    if (activity.date.startsWith(year)) {
      entry.miles += activity.distance;
      entry.sessions += 1;
    }
    if (activity.date > entry.last) entry.last = activity.date;
    usage.set(activity.gear_id, entry);
  }

  const bikes = chosen.map((gear) => {
    const used = usage.get(gear.id);
    return compact({
      id: gear.id,
      name: gear.name,
      brand_model: [gear.brand.trim(), gear.model.trim()].filter(Boolean).join(" ") || null,
      kind: gear.kind,
      retired: gear.retired || null,
      lifetime_mi: round(gear.distance, 1),
      [`miles_${year}`]: round(used?.miles ?? 0, 1),
      [`activities_${year}`]: used?.sessions ?? 0,
      last_used: used?.last ? used.last.slice(0, 10) : null,
    });
  });

  const part = input.part?.toLowerCase();
  const records = (input.bike ? chosen.flatMap((gear) => bikeRecords(data.maintenance, gear)) : data.maintenance)
    .filter((record) => !part || `${record.part} ${record.service}`.toLowerCase().includes(part))
    .sort((a, b) => b.date.localeCompare(a.date) || b.mileage - a.mileage);
  const bikeOf = (record: (typeof records)[number]) =>
    data.gear.find((gear) => (record.bikeId ? gear.id === record.bikeId : gear.name === record.bike));
  const log = records.slice(0, input.log_limit ?? 20).map((record) => {
    const bike = bikeOf(record);
    return compact({
      date: record.date,
      bike: bike?.name ?? record.bike,
      part: record.part,
      service: record.service,
      bike_miles_at_service: round(record.mileage),
      miles_since: bike ? round(bike.distance - record.mileage) : null,
    });
  });

  const schedules = chosen
    .filter((gear) => gear.kind === "bike" && !gear.retired)
    .flatMap((gear) =>
      scheduleStatus(data.maintenance, gear, data.today).map((status) => ({
        bike: gear.name,
        service: status.schedule.label,
        last_done: status.last.date,
        due: status.dueLabel,
        remaining: `${round(status.remaining)} ${status.unit}`,
        overdue: status.remaining < 0,
      })),
    );

  const notes: string[] = [];
  if (input.bike && chosen.length === 0) {
    notes.push(`No bike matches "${input.bike}". Known: ${data.gear.filter((gear) => gear.kind === "bike").map((gear) => `${gear.name} (${[gear.brand.trim(), gear.model.trim()].filter(Boolean).join(" ") || "no model"})`).join("; ")}.`);
  }
  if (data.maintenance.length === 0) notes.push("The maintenance log is empty: no services have been recorded.");
  else if (records.length === 0) notes.push("No maintenance records match this bike and part filter.");

  return {
    ok: true,
    summary: `${bikes.length} gear, ${records.length} maintenance records, ${schedules.length} schedules`,
    result: compact({
      today: data.today,
      gear: bikes,
      maintenance: { matched: records.length, returned: log.length, records: log },
      schedules,
      notes: notes.length ? notes : null,
    }),
  };
}

// --------------------------------------------------- segment_efforts --

type SegmentInput = {
  segment?: string;
  activity_id?: string;
  sort?: "fastest" | "recent";
  limit?: number;
};

const segmentSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    segment: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "Segment name text or Strava segment id. Omit both this and activity_id to list every tracked segment.",
    },
    activity_id: { type: "string", pattern: "^\\d{1,20}$", description: "Strava activity id: list the efforts recorded on that activity." },
    sort: { type: "string", enum: ["fastest", "recent"], description: "Order of efforts: fastest (default) or most recent." },
    limit: { type: "integer", minimum: 1, maximum: 25, description: "Efforts per segment, 1 to 25 (default 10)." },
  },
};

/**
 * Efforts carry a UTC start and activities a wall-clock one, with no activity
 * id between them. The forecast cell's longitude gives the likely UTC offset
 * (plus one for summer time), and the effort must fall inside the ride. It is
 * a best match, labelled as such, not a stored link.
 */
const ridesByDay = new WeakMap<Activity[], Map<string, Activity[]>>();

function ridesOn(activities: Activity[], day: string): Activity[] {
  let index = ridesByDay.get(activities);
  if (!index) {
    index = new Map();
    for (const activity of activities) {
      if (getActivityKind(activity.type) !== "Ride") continue;
      const key = activity.date.slice(0, 10);
      index.set(key, [...(index.get(key) ?? []), activity]);
    }
    ridesByDay.set(activities, index);
  }
  return index.get(day) ?? [];
}

export function matchEffortActivity(effort: SegmentEffort, activities: Activity[]): Activity | null {
  const start = Date.parse(effort.start_date);
  const longitude = Number(effort.cell_id?.split(",")[1]);
  if (!Number.isFinite(start)) return null;
  const guess = Number.isFinite(longitude) ? Math.round(longitude / 15) : 0;
  const day = effort.start_date.slice(0, 10);
  const nearby = [-1, 0, 1].flatMap((shift) => ridesOn(activities, addDays(day, shift)));
  for (const offset of [guess, guess + 1, guess + 2, guess - 1]) {
    let best: { activity: Activity; into: number } | null = null;
    for (const activity of nearby) {
      const localStart = Date.parse(`${activity.date.length > 10 ? activity.date : `${activity.date}T00:00:00`}Z`);
      const into = start - (localStart - offset * 3_600_000);
      const span = activity.moving_time * 3_600_000 * 1.6 + 30 * 60_000;
      if (into >= 0 && into <= span && (!best || into < best.into)) best = { activity, into };
    }
    if (best) return best.activity;
  }
  return null;
}

function effortRow(effort: SegmentEffort, rank: number, activity: Activity | null) {
  return compact({
    rank,
    date: effort.start_date.slice(0, 10),
    time: clock(effort.elapsed_time_s),
    elapsed_s: effort.elapsed_time_s,
    avg_watts: effort.average_watts ? round(effort.average_watts) : null,
    power_meter: effort.average_watts ? effort.device_watts : null,
    avg_hr: effort.average_heartrate ? round(effort.average_heartrate) : null,
    wind_ms: effort.weather?.wind_speed_ms ?? null,
    wind_from_deg: effort.weather?.wind_from_deg ?? null,
    temp_c: effort.weather?.temperature_c ?? null,
    activity_id: activity?.id ?? null,
    activity_name: activity?.name ?? null,
  });
}

async function segmentEfforts(input: SegmentInput, data: AskData): Promise<ToolOutcome> {
  const store: EffortsData = await data.efforts();
  const segments = Object.values(store.segments);
  const bySegment = new Map<number, SegmentEffort[]>();
  for (const effort of store.efforts) {
    bySegment.set(effort.segment_id, [...(bySegment.get(effort.segment_id) ?? []), effort]);
  }
  // Rank among the rider's own efforts: 1 is the fastest on record.
  const ranked = new Map<SegmentEffort, number>();
  for (const efforts of bySegment.values()) {
    [...efforts]
      .sort((a, b) => a.elapsed_time_s - b.elapsed_time_s)
      .forEach((effort, index) => ranked.set(effort, index + 1));
  }
  const describe = (segment: (typeof segments)[number]) =>
    compact({
      id: segment.id,
      name: segment.name.trim() || `Segment ${segment.id}`,
      distance_mi: round(segment.distance_m / 1609.344, 2),
      average_grade_pct: segment.average_grade,
      attempts: bySegment.get(segment.id)?.length ?? 0,
      strava_pr: segment.pr_elapsed_time ? clock(segment.pr_elapsed_time) : null,
    });
  const asOf = store.generated_at?.slice(0, 10) ?? null;

  if (input.activity_id) {
    const activity = data.activities.find((item) => item.id === input.activity_id);
    if (!activity) throw new ToolInputError(`No activity with id ${input.activity_id}`);
    const efforts = store.efforts.filter(
      (effort) => matchEffortActivity(effort, data.activities) === activity,
    );
    return {
      ok: true,
      summary: `${efforts.length} efforts on activity ${activity.id}`,
      result: compact({
        efforts_data_as_of: asOf,
        activity: { id: activity.id, name: activity.name, date: activity.date.slice(0, 10) },
        matching: "efforts are matched to the activity by start time",
        efforts: efforts.map((effort) => {
          const segment = store.segments[String(effort.segment_id)];
          const rank = ranked.get(effort)!;
          return compact({
            segment: segment ? describe(segment) : { id: effort.segment_id },
            ...effortRow(effort, rank, null),
            is_personal_best: rank === 1,
            of_attempts: bySegment.get(effort.segment_id)?.length ?? 1,
          });
        }),
        note: efforts.length ? null : "No tracked segment efforts on this activity (or it is newer than the efforts sync).",
      }),
    };
  }

  if (!input.segment) {
    const list = segments
      .map(describe)
      .sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));
    return {
      ok: true,
      summary: `${list.length} tracked segments`,
      result: { efforts_data_as_of: asOf, segments: list },
    };
  }

  const query = input.segment.toLowerCase().trim();
  const matched = segments.filter(
    (segment) => String(segment.id) === query || segment.name.toLowerCase().includes(query),
  );
  if (!matched.length) {
    return {
      ok: true,
      summary: `No segment matches "${input.segment}"`,
      result: {
        efforts_data_as_of: asOf,
        note: `No tracked segment matches "${input.segment}".`,
        known_segments: segments.map((segment) => segment.name.trim() || String(segment.id)),
      },
    };
  }
  const limit = input.limit ?? 10;
  const result = matched.slice(0, 5).map((segment) => {
    const efforts = [...(bySegment.get(segment.id) ?? [])].sort((a, b) =>
      input.sort === "recent" ? b.start_date.localeCompare(a.start_date) : a.elapsed_time_s - b.elapsed_time_s,
    );
    const best = efforts.reduce<SegmentEffort | null>((top, effort) => (!top || effort.elapsed_time_s < top.elapsed_time_s ? effort : top), null);
    return compact({
      ...describe(segment),
      personal_best: best ? effortRow(best, 1, matchEffortActivity(best, data.activities)) : null,
      efforts: efforts.slice(0, limit).map((effort) => effortRow(effort, ranked.get(effort)!, matchEffortActivity(effort, data.activities))),
    });
  });
  return {
    ok: true,
    summary: `${matched.length} segment${matched.length === 1 ? "" : "s"} matched`,
    result: compact({
      efforts_data_as_of: asOf,
      ranks: "rank 1 is the fastest of the rider's own recorded efforts",
      more_matches: matched.length > 5 ? matched.length - 5 : null,
      segments: result,
    }),
  };
}

// --------------------------------------------------- activity_detail --

type DetailInput = { activity_id: string };

const detailSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["activity_id"],
  properties: {
    activity_id: { type: "string", pattern: "^\\d{1,20}$", description: "Strava activity id, as returned by search_activities." },
  },
};

function activityDetail(input: DetailInput, data: AskData): ToolOutcome {
  const activity = data.activities.find((item) => item.id === input.activity_id);
  if (!activity) throw new ToolInputError(`No activity with id ${input.activity_id}`);
  const { model } = performanceModel(data);
  const load = model.loads[activity.id];
  const entry = data.streamsIndex[activity.id];
  const ftpUsed =
    load?.source === "power" && load.intensity && entry?.normalized_power
      ? round(entry.normalized_power / load.intensity)
      : null;
  const metrics = entry ? rideMetrics(entry, ftpUsed, model.heartRate) : null;
  const bests = entry?.power_bests
    ? CURVE_KEYS.flatMap((duration) =>
        entry.power_bests?.[String(duration)] ? [{ duration: durationLabel(duration), watts: entry.power_bests[String(duration)] }] : [],
      )
    : null;

  return {
    ok: true,
    summary: `${activity.name} (${activity.date.slice(0, 10)})`,
    result: compact({
      ...activityRow(activity, gearLookup(data)),
      sport: getActivityKind(activity.type),
      max_hr: activity.max_heartrate,
      max_watts: activity.max_watts,
      suffer_score: activity.suffer_score,
      has_route_map: activity.hasRoute,
      link: `/training/activities/${activity.id}`,
      training_load: load
        ? compact({ tss: round(load.tss), intensity_factor: load.intensity ? round(load.intensity, 2) : null, source: load.source, ftp_used: ftpUsed })
        : null,
      analysis: entry
        ? compact({
            normalized_power: entry.normalized_power ? round(entry.normalized_power) : null,
            variability_index: metrics?.variabilityIndex ? round(metrics.variabilityIndex, 2) : null,
            efficiency_factor: metrics?.efficiencyFactor ? round(metrics.efficiencyFactor, 2) : null,
            aerobic_decoupling_pct: metrics?.decoupling !== null && metrics?.decoupling !== undefined ? round(metrics.decoupling, 1) : null,
            trimp: metrics?.trimp ? round(metrics.trimp) : null,
            first_half: entry.first_half,
            second_half: entry.second_half,
            power_bests: bests,
          })
        : { note: "No stream analysis for this activity (streams are fetched for recent rides only)." },
    }),
  };
}

// ---------------------------------------------------------- registry --

type ToolSpec = {
  name: string;
  description: string;
  schema: JsonSchema;
  run: (input: never, data: AskData) => ToolOutcome | Promise<ToolOutcome>;
};

/**
 * Fixed order: the tool list is the very start of the cached prompt prefix,
 * so it must serialize identically on every request.
 */
const TOOLS: ToolSpec[] = [
  {
    name: "search_activities",
    description:
      "Find individual activities by sport, date range, name text or gear, sorted by date, distance, moving time, elevation, power or kudos. Call this for questions about specific sessions: the longest or hardest ride, the last time something happened, what was done on a date, top-N lists. Returns at most 25 rows plus totals over everything matched; use totals for period sums.",
    schema: searchSchema,
    run: searchActivities,
  },
  {
    name: "totals",
    description:
      "Sum sessions, distance, moving time, elevation, kudos and kJ for a year, month, week or custom range, optionally by sport, and optionally compared with the same window in every other year (including like-for-like through-the-same-day figures for a window still in progress). Call this for how much / how many questions and for comparing periods or years.",
    schema: totalsSchema,
    run: totals,
  },
  {
    name: "goals_status",
    description:
      "This year's goals (set by the rider, or last year + 10% by default) with progress, even-pace position, what is needed per week and the year-end projection. Call this for questions about goals, targets or being on track.",
    schema: goalsSchema,
    run: goalsStatus,
  },
  {
    name: "performance",
    description:
      "Current FTP and its history, best power at key durations (5s to 2h) for a window, and fitness, fatigue and form today, four weeks ago and on a given date. Call this for questions about FTP, power, watts per kilo, fitness or freshness.",
    schema: performanceSchema,
    run: performance,
  },
  {
    name: "gear_and_maintenance",
    description:
      "Bikes (and optionally shoes) with lifetime and this year's miles, the maintenance log (chain lube or wax, tires, parts) with miles since each service, and the next due service schedules. Call this for questions about bikes, mileage, wear, servicing or when something was last done.",
    schema: gearSchema,
    run: gearAndMaintenance,
  },
  {
    name: "segment_efforts",
    description:
      "Strava segment efforts: list tracked segments, a segment's efforts with personal best, ranks among the rider's own efforts and the wind at the time, or the efforts recorded on one activity. Call this for questions about segments, climbs, PRs or KOM attempts.",
    schema: segmentSchema,
    run: segmentEfforts,
  },
  {
    name: "activity_detail",
    description:
      "One activity's full summary plus its analysis: training load, intensity, normalized power, variability, efficiency, aerobic decoupling, heart-rate halves and power bests. Call this after finding an activity id when the question is about how a particular session went.",
    schema: detailSchema,
    run: activityDetail,
  },
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const TOOL_DEFINITIONS: Anthropic.Tool[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: { ...tool.schema, type: "object" } as Anthropic.Tool.InputSchema,
}));

/** Validates and runs one tool call. Failures come back as messages, never throws. */
export async function runTool(name: string, input: unknown, data: AskData): Promise<ToolOutcome> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}.` };
  const parsed = validate<never>(tool.schema, input);
  if (!parsed.ok) return { ok: false, error: `Invalid arguments: ${parsed.error}` };
  try {
    return await tool.run(parsed.value, data);
  } catch (error) {
    if (error instanceof ToolInputError) return { ok: false, error: error.message };
    console.error(`[ask] tool ${name} failed`, error);
    return { ok: false, error: `${name} failed while reading the data.` };
  }
}
