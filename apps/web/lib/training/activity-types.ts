export type Activity = {
  id: string;
  name: string;
  /** Strava sport_type, e.g. "Ride", "VirtualRide", "Pickleball". */
  type: string;
  /** Wall-clock start, "YYYY-MM-DDTHH:MM:SS" (or "YYYY-MM-DD"). */
  date: string;
  /** Miles. */
  distance: number;
  /** Hours. */
  moving_time: number;
  /** Feet. */
  total_elevation_gain: number;
  /** Miles per hour. */
  average_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_watts: number | null;
  weighted_average_watts: number | null;
  max_watts: number | null;
  kilojoules: number | null;
  suffer_score: number | null;
  kudos_count: number;
  gear_id: string | null;
  hasRoute: boolean;
};

export type Gear = {
  id: string;
  name: string;
  brand: string;
  model: string;
  /** Lifetime miles, as Strava reports them. */
  distance: number;
  retired: boolean;
  kind: "bike" | "shoe";
};

/** Kept for the maintenance log, which only concerns bikes. */
export type Bike = Gear;

export type MaintenanceRecord = {
  id: string;
  /** Absent on records logged before bikes were stored by ID. */
  bikeId?: string;
  bike: string;
  part: string;
  service: string;
  date: string;
  /** The bike's lifetime miles when the service was logged. */
  mileage: number;
};

export type SportKind =
  | "Ride"
  | "Run"
  | "Pickleball"
  | "Walk"
  | "Swim"
  | "Training"
  | "Other";

export type SportFilter = "All" | SportKind;

export type MetricKey = "distance" | "elevation" | "time" | "sessions";

const TRAINING = [
  "workout",
  "highintensityintervaltraining",
  "weighttraining",
  "yoga",
  "elliptical",
  "crossfit",
  "pilates",
  "stairstepper",
  "rowing",
  "virtualrow",
];

export function getActivityKind(type: string): SportKind {
  const normalized = type.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("pickleball")) return "Pickleball";
  if (
    normalized.includes("ride") ||
    normalized.includes("cycling") ||
    normalized.includes("bike") ||
    normalized === "handcycle" ||
    normalized === "velomobile"
  ) {
    return "Ride";
  }
  if (normalized.includes("run")) return "Run";
  if (normalized.includes("walk") || normalized.includes("hike")) return "Walk";
  if (normalized.includes("swim")) return "Swim";
  if (TRAINING.includes(normalized)) return "Training";
  return "Other";
}

export const SPORT_LABELS: Record<SportFilter, string> = {
  All: "All activities",
  Ride: "Rides",
  Run: "Runs",
  Pickleball: "Pickleball",
  Walk: "Walks & hikes",
  Swim: "Swims",
  Training: "Training",
  Other: "Other",
};

const TYPE_LABELS: Record<string, string> = {
  HighIntensityIntervalTraining: "HIIT",
  EBikeRide: "E-bike ride",
  EMountainBikeRide: "E-mountain bike ride",
  StandUpPaddling: "Stand-up paddling",
};

/** "VirtualRide" → "Virtual ride"; a few Strava names get their usual short form. */
export function sportLabel(type: string): string {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DISTANCE_SPORTS: SportKind[] = ["Ride", "Run", "Walk", "Swim"];

export function isDistanceSport(filter: SportFilter): boolean {
  return filter === "All" || DISTANCE_SPORTS.includes(filter);
}

/** The metrics worth comparing for a sport; pickleball and training have no distance. */
export function metricsFor(filter: SportFilter): MetricKey[] {
  if (filter === "Swim") return ["distance", "time", "sessions"];
  if (isDistanceSport(filter)) return ["distance", "elevation", "time", "sessions"];
  return ["time", "sessions"];
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  distance: "Distance",
  elevation: "Elevation",
  time: "Active time",
  sessions: "Sessions",
};

export const METRIC_UNITS: Record<MetricKey, string> = {
  distance: "mi",
  elevation: "ft",
  time: "h",
  sessions: "",
};

export function metricValue(activity: Activity, metric: MetricKey): number {
  if (metric === "distance") return activity.distance;
  if (metric === "elevation") return activity.total_elevation_gain;
  if (metric === "time") return activity.moving_time;
  return 1;
}

export function matchesFilter(activity: Activity, filter: SportFilter): boolean {
  return filter === "All" || getActivityKind(activity.type) === filter;
}

export type CalendarDate = { year: number; month: number; day: number };

// Activity and maintenance dates are wall-clock dates ("YYYY-MM-DD..."), so
// they are read from the string rather than through the viewer's timezone.
export function calendarDate(date: string): CalendarDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
}

export function formatCalendarDate(
  date: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const parts = calendarDate(date);
  if (!parts) return "—";
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
    Date.UTC(parts.year, parts.month, parts.day),
  );
}

export function localIsoDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isoDate({ year, month, day }: CalendarDate): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function activityYear(activity: Activity): number | undefined {
  return calendarDate(activity.date)?.year;
}

export function activityMonth(activity: Activity): number | undefined {
  return calendarDate(activity.date)?.month;
}

export function activityDay(activity: Activity): number | undefined {
  return calendarDate(activity.date)?.day;
}

export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatHours(hours: number): string {
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${formatNumber(h)}h ${m}m` : `${m}m`;
}

export function formatMetric(value: number, metric: MetricKey): string {
  if (metric === "time") return formatHours(value);
  if (metric === "sessions") return formatNumber(value);
  return `${formatNumber(value, metric === "distance" && value < 100 ? 1 : 0)} ${METRIC_UNITS[metric]}`;
}
