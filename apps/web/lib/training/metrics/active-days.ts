import {
  calendarDate,
  getActivityKind,
  isoDate,
  type Activity,
  type CalendarDate,
  type SportKind,
} from "@/lib/training/activity-types";

export type DayTotal = { date: string; count: number; hours: number };

export type ActiveDays = {
  days: DayTotal[];
  activeDays: number;
  /** Days so far in the year: all of it for a past year. */
  daysElapsed: number;
  longestStreak: number;
  /** Consecutive active days ending today or yesterday; zero for past years. */
  currentStreak: number;
  byKind: Array<{ kind: SportKind; count: number; hours: number }>;
};

const DAY_MS = 86_400_000;

function dayNumber(date: CalendarDate): number {
  return Date.UTC(date.year, date.month, date.day) / DAY_MS;
}

export function activeDays(
  activities: Activity[],
  year: number,
  today: CalendarDate,
): ActiveDays {
  const totals = new Map<string, DayTotal>();
  const kinds = new Map<SportKind, { count: number; hours: number }>();
  for (const activity of activities) {
    const date = calendarDate(activity.date);
    if (!date || date.year !== year) continue;
    const key = isoDate(date);
    const day = totals.get(key) ?? { date: key, count: 0, hours: 0 };
    day.count += 1;
    day.hours += activity.moving_time;
    totals.set(key, day);
    const kind = getActivityKind(activity.type);
    const entry = kinds.get(kind) ?? { count: 0, hours: 0 };
    entry.count += 1;
    entry.hours += activity.moving_time;
    kinds.set(kind, entry);
  }

  const numbers = [...totals.keys()]
    .map((key) => dayNumber(calendarDate(key)!))
    .sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let index = 0; index < numbers.length; index++) {
    run = index > 0 && numbers[index] === numbers[index - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  let currentStreak = 0;
  if (year === today.year && numbers.length) {
    const todayNumber = dayNumber(today);
    const last = numbers[numbers.length - 1];
    if (last >= todayNumber - 1) {
      currentStreak = 1;
      for (let index = numbers.length - 1; index > 0; index--) {
        if (numbers[index - 1] !== numbers[index] - 1) break;
        currentStreak += 1;
      }
    }
  }

  const start = Date.UTC(year, 0, 1) / DAY_MS;
  const end = year === today.year ? dayNumber(today) : Date.UTC(year, 11, 31) / DAY_MS;

  return {
    days: [...totals.values()].sort((a, b) => a.date.localeCompare(b.date)),
    activeDays: totals.size,
    daysElapsed: Math.max(0, end - start + 1),
    longestStreak: longest,
    currentStreak,
    byKind: [...kinds.entries()]
      .map(([kind, value]) => ({ kind, ...value }))
      .sort((a, b) => b.count - a.count),
  };
}
