import { formatCalendarDate } from "@/lib/training/activity-types";

/** 1st, 2nd, 3rd, 4th… 11th, 12th, 13th, 21st. */
export function ordinal(rank: number): string {
  const tens = rank % 100;
  if (tens >= 11 && tens <= 13) return `${rank}th`;
  return `${rank}${["th", "st", "nd", "rd"][rank % 10] ?? "th"}`;
}

/** "Jun 2022", or "Jun 3, 2022" in full. */
export function rideDate(date: string, long = false): string {
  return formatCalendarDate(
    date,
    long
      ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", year: "numeric" },
  );
}

/** Time-axis labels by scale: years, then months, then days. */
export const DATE_AXIS_LABELS = {
  year: "{yyyy}",
  month: "{MMM}",
  day: "{MMM} {d}",
  hour: "{MMM} {d}",
  minute: "{MMM} {d}",
  second: "{MMM} {d}",
  millisecond: "{MMM} {d}",
};

const DURATION_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/**
 * A duration axis on whole, readable steps (30 s, 1 min, 5 min…) rather than
 * ECharts' decimal ones, which land on times like 11:40 and 13:20.
 */
export function durationAxis(values: number[], minStep = 5, ticks = 5) {
  if (!values.length) return {};
  const low = Math.min(...values);
  const high = Math.max(...values);
  const step =
    DURATION_STEPS.find((candidate) => candidate >= minStep && (high - low) / candidate <= ticks) ??
    DURATION_STEPS[DURATION_STEPS.length - 1];
  const min = Math.floor(low / step) * step;
  const max = Math.max(Math.ceil(high / step) * step, min + step);
  return { min, max, interval: step };
}
