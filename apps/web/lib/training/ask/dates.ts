import { calendarDate, isoDate } from "@/lib/training/activity-types";

/**
 * Calendar arithmetic on wall-clock "YYYY-MM-DD" strings. Activity dates are
 * the rider's local time, so nothing here goes through a timezone: every date
 * is treated as a UTC midnight purely to count days.
 */

export const DAY_MS = 86_400_000;

export function dayNumber(iso: string): number {
  const date = calendarDate(iso);
  if (!date) throw new Error(`Not a date: ${iso}`);
  return Date.UTC(date.year, date.month, date.day) / DAY_MS;
}

export function fromDayNumber(day: number): string {
  const date = new Date(day * DAY_MS);
  return isoDate({ year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() });
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(dayNumber(iso) + days);
}

/** The same month and day in another year; February 29 becomes the 28th. */
export function shiftYears(iso: string, years: number): string {
  const date = calendarDate(iso)!;
  const year = date.year + years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = date.month === 1 && date.day === 29 && !leap ? 28 : date.day;
  return isoDate({ year, month: date.month, day });
}

export function lastDayOfMonth(year: number, month: number): string {
  // month is 1-based here; day 0 of the next month is this month's last day.
  const date = new Date(Date.UTC(year, month, 0));
  return isoDate({ year, month: month - 1, day: date.getUTCDate() });
}

/** Monday of the week containing the date. */
export function weekStart(iso: string): string {
  const day = dayNumber(iso);
  // 1970-01-01 was a Thursday, so day 0 has weekday index 3 counting from Monday.
  const weekday = (((day + 3) % 7) + 7) % 7;
  return fromDayNumber(day - weekday);
}

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

export function weekdayName(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    dayNumber(iso) * DAY_MS,
  );
}
