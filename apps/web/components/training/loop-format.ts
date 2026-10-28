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
