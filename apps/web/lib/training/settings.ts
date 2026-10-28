import type { AthleteSettings } from "@/lib/training/metrics/performance";

/** Owner-editable settings, stored beside the maintenance log. */
export type Settings = {
  /** Annual goals keyed "<sport filter>:<metric>", e.g. "Ride:distance". */
  goals: Record<string, number>;
  athlete: AthleteSettings;
};

export const DEFAULT_SETTINGS: Settings = {
  goals: {},
  athlete: { weightKg: null, restingHr: 49, maxHr: null, ftpOverride: null },
};

const GOAL_KEY = /^(All|Ride|Run|Pickleball|Walk|Swim|Training|Other):(distance|elevation|time|sessions)$/;

function boundedNumber(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/** Validates a full settings document; returns null when anything is out of range. */
export function parseSettings(input: unknown): Settings | null {
  if (typeof input !== "object" || input === null) return null;
  const { goals, athlete } = input as Record<string, unknown>;
  if (typeof goals !== "object" || goals === null || typeof athlete !== "object" || athlete === null) {
    return null;
  }
  const parsedGoals: Record<string, number> = {};
  for (const [key, value] of Object.entries(goals)) {
    const amount = boundedNumber(value, 1, 10_000_000);
    if (!GOAL_KEY.test(key) || typeof amount !== "number") return null;
    parsedGoals[key] = amount;
  }
  const raw = athlete as Record<string, unknown>;
  const weightKg = boundedNumber(raw.weightKg, 30, 200);
  const restingHr = boundedNumber(raw.restingHr, 25, 110);
  const maxHr = boundedNumber(raw.maxHr, 120, 230);
  const ftpOverride = boundedNumber(raw.ftpOverride, 50, 600);
  if (weightKg === undefined || typeof restingHr !== "number" || maxHr === undefined || ftpOverride === undefined) {
    return null;
  }
  return { goals: parsedGoals, athlete: { weightKg, restingHr, maxHr, ftpOverride } };
}

/** Reads a stored document, falling back to defaults for anything missing. */
export function settingsOrDefaults(stored: unknown): Settings {
  if (typeof stored !== "object" || stored === null) return DEFAULT_SETTINGS;
  const raw = stored as Partial<Settings>;
  return (
    parseSettings({
      goals: raw.goals ?? {},
      athlete: { ...DEFAULT_SETTINGS.athlete, ...(raw.athlete ?? {}) },
    }) ?? DEFAULT_SETTINGS
  );
}
