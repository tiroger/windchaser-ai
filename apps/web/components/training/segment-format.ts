import type { StillAirReason } from "@/lib/training/still-air";

export const MPH_PER_MS = 2.23694;

/** Below this net wind (m/s at rider height) a ride is called calm. */
const CALM_MS = 0.45;

/** "6 mph headwind", "3 mph tailwind" or "calm": the net wind along the segment. */
export function netWind(tailwindMs: number | null): string | null {
  if (tailwindMs === null) return null;
  if (Math.abs(tailwindMs) < CALM_MS) return "calm";
  const mph = Math.max(1, Math.round(Math.abs(tailwindMs) * MPH_PER_MS));
  return `${mph} mph ${tailwindMs > 0 ? "tailwind" : "headwind"}`;
}

/** Why an effort has no still-air time, in a few words. */
export const REASON_TEXT: Record<StillAirReason, string> = {
  "no-weather": "still air pending: weather data lags about a week",
  "too-short": "too short to adjust for wind",
  "not-steady": "no steady effort fits this time",
  "no-geometry": "no segment line to adjust with",
};

export type TimeMode = "recorded" | "still";

export const MODE_LABELS: Record<TimeMode, string> = {
  recorded: "Recorded",
  still: "Still air",
};

/** Footnote explaining still-air time, shared by the activity and segments pages. */
export const STILL_AIR_NOTE =
  "Still air is the time the same steady effort would take with no wind at standard air density: " +
  "the power that reproduces your recorded time in that hour's reanalysis wind, ridden again in calm air " +
  "through the wind view's physics. Net wind is along the segment at rider height. " +
  "Strava's times and PRs are unchanged.";

/** Shown where the power-meter check found still air tracking power worse than raw time. */
export const ROUGH_NOTE =
  "On this segment, still-air times line up with your power meter less well than raw times do " +
  "(likely shelter the hourly wind data cannot see), so treat them as rough.";
