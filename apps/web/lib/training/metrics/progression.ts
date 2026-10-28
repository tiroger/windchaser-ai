import {
  calendarDate,
  metricValue,
  type Activity,
  type CalendarDate,
  type MetricKey,
} from "@/lib/training/activity-types";

const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
export const DAYS_PER_YEAR = 365;

/**
 * Position of a date on a shared 365-day axis, 1-based. February 29 shares
 * February 28's slot so the same calendar day lines up across leap years.
 */
export function yearPosition({ month, day }: Pick<CalendarDate, "month" | "day">): number {
  const clampedDay = month === 1 ? Math.min(day, 28) : day;
  return MONTH_START[month] + clampedDay;
}

export const MONTH_TICKS = MONTH_START.map((start) => start + 1);

export type YearSeries = {
  year: number;
  /** Cumulative total for each day position 1..365 (index 0 is day 1). */
  cumulative: number[];
  total: number;
  /** Last day position plotted: today's for the current year, else 365. */
  lastPosition: number;
};

export type Progression = {
  series: YearSeries[];
  current: YearSeries | undefined;
  todayPosition: number;
  /** Current year's monthly totals, January first. */
  currentMonthly: number[];
  /** Full-year projection at the current year's average daily rate. */
  onPace: number | null;
  /** Last year's cumulative total on the same day. */
  lastYearToDate: number | null;
  best: { year: number; total: number } | null;
};

export function progression(
  activities: Activity[],
  metric: MetricKey,
  today: CalendarDate,
): Progression {
  const daily = new Map<number, number[]>();
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!date) continue;
    let days = daily.get(date.year);
    if (!days) {
      days = new Array<number>(DAYS_PER_YEAR).fill(0);
      daily.set(date.year, days);
    }
    days[yearPosition(date) - 1] += metricValue(activity, metric);
  }

  const todayPosition = yearPosition(today);
  const series: YearSeries[] = [...daily.keys()]
    .filter((year) => year <= today.year)
    .sort((a, b) => a - b)
    .map((year) => {
      const days = daily.get(year)!;
      const lastPosition = year === today.year ? todayPosition : DAYS_PER_YEAR;
      const cumulative: number[] = [];
      let running = 0;
      for (let index = 0; index < lastPosition; index++) {
        running += days[index];
        cumulative.push(running);
      }
      return { year, cumulative, total: running, lastPosition };
    });

  const current = series.find((entry) => entry.year === today.year);
  const lastYear = series.find((entry) => entry.year === today.year - 1);
  const completed = series.filter((entry) => entry.year < today.year);
  const best = completed.reduce<YearSeries | undefined>(
    (top, entry) => (!top || entry.total > top.total ? entry : top),
    undefined,
  );

  const currentMonthly = new Array<number>(12).fill(0);
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (date?.year === today.year) currentMonthly[date.month] += metricValue(activity, metric);
  }

  return {
    series,
    current,
    todayPosition,
    currentMonthly,
    onPace: current ? (current.total / todayPosition) * DAYS_PER_YEAR : null,
    lastYearToDate: lastYear ? lastYear.cumulative[todayPosition - 1] ?? lastYear.total : null,
    best: best ? { year: best.year, total: best.total } : null,
  };
}

export type GoalProgress = {
  goal: number;
  actual: number;
  /** Where an even pace towards the goal would be today. */
  expected: number;
  /** Positive when ahead of that pace. */
  delta: number;
  /** What is still needed per remaining week; zero once the goal is met. */
  neededPerWeek: number;
  projected: number;
};

export function goalProgress(
  goal: number,
  actual: number,
  todayPosition: number,
): GoalProgress {
  const expected = (goal * todayPosition) / DAYS_PER_YEAR;
  const weeksLeft = Math.max((DAYS_PER_YEAR - todayPosition) / 7, 1 / 7);
  return {
    goal,
    actual,
    expected,
    delta: actual - expected,
    neededPerWeek: Math.max(goal - actual, 0) / weeksLeft,
    projected: (actual / todayPosition) * DAYS_PER_YEAR,
  };
}

/** Last year's total plus ten percent, rounded to a figure worth writing down. */
export function defaultGoal(lastYearTotal: number | undefined, metric: MetricKey): number | null {
  if (!lastYearTotal || lastYearTotal <= 0) return null;
  const target = lastYearTotal * 1.1;
  const step = metric === "elevation" ? 1000 : metric === "distance" ? 50 : 10;
  return Math.max(step, Math.round(target / step) * step);
}
