/** A saved Strava route as the worker stores it. */
export type SavedRoute = {
  id: string;
  name: string;
  description: string;
  type: "ride" | "run" | "other";
  sub_type: "road" | "mtb" | "cx" | "trail" | "mixed" | null;
  /** Miles. */
  distance: number;
  /** Feet. */
  elevation_gain: number;
  /** Seconds, as Strava estimates it. */
  estimated_moving_time: number | null;
  starred: boolean;
  created_at: string;
  updated_at: string;
  /** When the stored elevation profile was taken; null while it is still syncing. */
  profile_updated_at: string | null;
  polyline: string | null;
};

/** Point-by-point profile; latlng is null where the route is hidden near home. */
export type RouteProfile = {
  id: string;
  updated_at: string;
  distance: number[];
  altitude: number[];
  latlng: Array<[number, number] | null>;
};

const FEET_PER_MILE = 5280;

/**
 * Grade in percent at every point, measured across a window of distance
 * rather than between neighbouring points, which turns GPS altitude noise
 * into absurd spikes on short segments.
 */
/**
 * The distance to measure grade over for a given track. Saved-route profiles
 * are downsampled to a few thousand points, so on a long route neighbours sit
 * more than a tenth of a mile apart and a single altitude glitch would read as
 * a wall. Four samples' worth, and never less than a tenth of a mile.
 */
export function gradeWindow(distance: number[]): number {
  const steps = distance.slice(1).map((miles, index) => miles - distance[index]).filter((step) => step > 0);
  if (!steps.length) return 0.1;
  steps.sort((a, b) => a - b);
  return Math.max(0.1, steps[Math.floor(steps.length / 2)] * 4);
}

export function smoothedGrades(distance: number[], altitude: number[], windowMiles = 0.1): number[] {
  const half = windowMiles / 2;
  const grades: number[] = [];
  let back = 0;
  let ahead = 0;
  for (let index = 0; index < distance.length; index++) {
    while (back < index && distance[index] - distance[back] > half) back++;
    while (ahead < distance.length - 1 && distance[ahead] - distance[index] < half) ahead++;
    const run = (distance[ahead] - distance[back]) * FEET_PER_MILE;
    grades.push(run > 0 ? ((altitude[ahead] - altitude[back]) / run) * 100 : 0);
  }
  return grades;
}

/**
 * VeloViewer-style gradient colours: blues downhill, green flat, yellow to deep
 * red uphill. `color` is the canonical hue, drawn as-is on the dark theme.
 *
 * The light theme keeps every hue and only moves lightness: the pale cyan,
 * lime and yellow bands sit near white and vanish as a thin line on a light
 * basemap, so they are taken darker until they hold roughly 2.5:1 against it.
 * The deepest bands do the opposite on dark, where #9b1b4f all but disappears.
 */
export const GRADE_SCALE: Array<{ upTo: number; color: string; light: string; dark: string; label: string }> = [
  { upTo: -8, color: "#1f4fd1", dark: "#3563e6", light: "#1f4fd1", label: "< -8%" },
  { upTo: -4, color: "#2f8fe0", dark: "#2f8fe0", light: "#2479c4", label: "-8 to -4%" },
  { upTo: -1, color: "#4fd2e8", dark: "#4fd2e8", light: "#1a9fb8", label: "-4 to -1%" },
  { upTo: 1, color: "#47c46b", dark: "#47c46b", light: "#2c9e50", label: "-1 to 1%" },
  { upTo: 3, color: "#a7d64a", dark: "#a7d64a", light: "#7ca82a", label: "1 to 3%" },
  { upTo: 5, color: "#f2e14a", dark: "#f2e14a", light: "#b89a0c", label: "3 to 5%" },
  { upTo: 8, color: "#f7a43a", dark: "#f7a43a", light: "#e0861a", label: "5 to 8%" },
  { upTo: 12, color: "#ee4b2b", dark: "#ee4b2b", light: "#d63a1c", label: "8 to 12%" },
  { upTo: Infinity, color: "#9b1b4f", dark: "#c22a68", light: "#9b1b4f", label: "> 12%" },
];

export type GradeTheme = "light" | "dark";

/** The band a grade falls in. */
export function gradeBand(grade: number) {
  return GRADE_SCALE.find((band) => grade <= band.upTo) ?? GRADE_SCALE[GRADE_SCALE.length - 1];
}

/** Canonical colour for a grade, or the variant tuned for one theme's surfaces. */
export function gradeColor(grade: number, theme?: GradeTheme): string {
  const band = gradeBand(grade);
  return theme ? band[theme] : band.color;
}

export type Climb = {
  startIndex: number;
  endIndex: number;
  /** Miles from the start of the route. */
  start: number;
  length: number;
  gain: number;
  averageGrade: number;
  maxGrade: number;
  category: "HC" | "1" | "2" | "3" | "4" | null;
};

/** Strava's categories by length in metres times average grade in percent. */
function climbCategory(lengthMiles: number, grade: number): Climb["category"] {
  const score = lengthMiles * 1609.34 * grade;
  if (score >= 80000) return "HC";
  if (score >= 64000) return "1";
  if (score >= 32000) return "2";
  if (score >= 16000) return "3";
  if (score >= 8000) return "4";
  return null;
}

/**
 * Sustained climbs: from a low point to the next summit, tolerating short dips
 * of up to 15% of the climb so far (at least 40 ft), kept when they gain at
 * least 150 ft at an average of 3% or more.
 */
export function findClimbs(
  distance: number[],
  altitude: number[],
  grades: number[],
  minLength = 0,
): Climb[] {
  const climbs: Climb[] = [];
  let low = 0;
  let peak = 0;
  const close = () => {
    const gain = altitude[peak] - altitude[low];
    const length = distance[peak] - distance[low];
    // A climb shorter than the window grades are measured over is below the
    // track's resolution: usually an altitude glitch, often at the very end.
    if (gain >= 150 && length > 0 && length >= minLength) {
      const averageGrade = (gain / (length * FEET_PER_MILE)) * 100;
      if (averageGrade >= 3) {
        climbs.push({
          startIndex: low,
          endIndex: peak,
          start: distance[low],
          length,
          gain,
          averageGrade,
          maxGrade: Math.max(averageGrade, ...grades.slice(low, peak + 1)),
          category: climbCategory(length, averageGrade),
        });
      }
    }
  };
  for (let index = 1; index < altitude.length; index++) {
    if (altitude[index] > altitude[peak]) {
      peak = index;
      continue;
    }
    const climbed = altitude[peak] - altitude[low];
    if (altitude[peak] - altitude[index] > Math.max(40, climbed * 0.15)) {
      close();
      low = index;
      peak = index;
    } else if (altitude[index] <= altitude[low] && peak === low) {
      low = index;
      peak = index;
    }
  }
  close();
  return climbs;
}

export type RangeSummary = { distance: number; gain: number; loss: number; grade: number };

/** What VeloViewer shows for a dragged selection: length, climbing and net grade. */
export function summarizeRange(distance: number[], altitude: number[], from: number, to: number): RangeSummary {
  const [a, b] = from <= to ? [from, to] : [to, from];
  let gain = 0;
  let loss = 0;
  for (let index = a + 1; index <= b; index++) {
    const change = altitude[index] - altitude[index - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  const length = distance[b] - distance[a];
  return {
    distance: length,
    gain,
    loss,
    grade: length > 0 ? ((altitude[b] - altitude[a]) / (length * FEET_PER_MILE)) * 100 : 0,
  };
}
