import { angleDelta, toRad, type Section } from "@/lib/geo";
import { airDensity, sectionSpeed, windAtRiderHeight } from "@/lib/physics";
import type { Rider } from "@/lib/types";

/**
 * Still-air time: what an effort would have taken at the same effort in no
 * wind and standard air.
 *
 * Each effort's recorded weather is the hourly reanalysis for when it was
 * ridden. From it the effort's steady power is solved -- the power that, through
 * the wind view's own physics (lib/physics.ts: per-section wind at rider
 * height, density from temperature and pressure, gradient from the profile),
 * reproduces the time actually recorded. That same power is then ridden again
 * in still air at ISA density. The difference is what the weather was worth.
 *
 * Power is the implied power throughout, never the power meter's, so the
 * adjustment depends only on time, geometry and weather, applies to efforts
 * ridden without a meter, and carries the same systematic offsets as the
 * model the wind view predicts with. Where a meter did record the effort, the
 * two are compared as a check on the physics, not mixed.
 */

/** ISA sea-level density, the same neutral baseline calibration uses. */
export const RHO_STANDARD = 1.225;

/**
 * Below this many seconds of moving time the correction is not made.
 *
 * Steady power is a poor description of a sprint, and a one-second timing
 * quantum is already several percent of one. Length alone turned out not to
 * be what breaks the correction, though: on the real history a 41-second
 * segment was among those it helped most. What does break it is shelter, and
 * that is checked per segment against the power meter (see stillAirIndex), so
 * this floor only excludes efforts too short for steady power to mean much.
 */
export const MIN_ADJUST_SECONDS = 30;

/** Bisection bounds for implied power, watts. 0 W is coasting. */
const POWER_LO = 0;
const POWER_HI = 1500;
const POWER_STEPS = 34;

export type EffortWeatherInput = {
  wind_speed_ms?: number | null;
  wind_from_deg?: number | null;
  temperature_c?: number | null;
  pressure_hpa?: number | null;
  humidity_pct?: number | null;
};

/** Tailwind on each section at rider height, m/s; negative is a headwind. */
export function sectionTailwinds(
  sections: Section[],
  windFromDeg: number,
  windSpeed10m: number,
): number[] {
  const windTo = (windFromDeg + 180) % 360;
  const speed = windAtRiderHeight(Math.max(0, windSpeed10m));
  return sections.map((s) => speed * Math.cos(toRad(angleDelta(windTo, s.bearing_deg))));
}

/** Distance-weighted mean tailwind, m/s. Presentational, never a model input. */
export function effectiveTailwind(sections: Section[], tails: number[]): number {
  let total = 0;
  let weighted = 0;
  sections.forEach((s, i) => {
    total += s.distance_m;
    weighted += (tails[i] ?? 0) * s.distance_m;
  });
  return total > 0 ? weighted / total : 0;
}

/** Time to ride the sections at constant power, summed per section. */
export function timeAtPower(
  sections: Section[],
  rider: Rider,
  powerW: number,
  tails: number[] | null,
  rho: number,
): number {
  const r = { ...rider, power_w: powerW };
  let time = 0;
  sections.forEach((s, i) => {
    time += s.distance_m / sectionSpeed(r, -(tails?.[i] ?? 0), s.grade, rho);
  });
  return time;
}

/**
 * The steady power that reproduces `seconds` under the given wind and
 * density, or null when no power in range does: faster than the physics
 * allows at any power, or slower than coasting (braking, a stop that moving
 * time did not catch).
 */
export function impliedPower(
  sections: Section[],
  rider: Rider,
  seconds: number,
  tails: number[] | null,
  rho: number,
): number | null {
  if (!sections.length || !(seconds > 0)) return null;
  if (timeAtPower(sections, rider, POWER_HI, tails, rho) > seconds) return null;
  // At zero power a climb never finishes; a descent finishes at terminal
  // speed. Slower than that means the effort was not steady pedalling.
  if (timeAtPower(sections, rider, POWER_LO, tails, rho) < seconds) return null;
  let lo = POWER_LO;
  let hi = POWER_HI;
  for (let i = 0; i < POWER_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (timeAtPower(sections, rider, mid, tails, rho) > seconds) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type StillAirResult =
  | {
      kind: "adjusted";
      /** Recorded elapsed time moved by what the weather was worth. */
      stillAirSeconds: number;
      /** Implied steady power, watts. */
      impliedWatts: number;
      /** Distance-weighted tailwind at rider height, m/s; negative is a headwind. */
      tailwindMs: number;
      /** Air density on the day, kg/m³. */
      rho: number;
    }
  | { kind: "none"; reason: StillAirReason };

/**
 * Why an effort has no still-air time.
 *
 * - `no-weather`: the reanalysis lags real time by about a week.
 * - `too-short`: under MIN_ADJUST_SECONDS, where steady power does not hold.
 * - `not-steady`: no steady power reproduces the time, typically a descent
 *   ridden slower than coasting.
 * - `no-geometry`: the segment has no usable line.
 */
export type StillAirReason = "no-weather" | "too-short" | "not-steady" | "no-geometry";

/**
 * An effort's still-air time.
 *
 * The solve runs on moving time, which is what steady-power physics models;
 * time spent stopped is weather-independent and carried across unchanged, so
 * the result stays comparable with the elapsed time Strava ranks on.
 */
export function stillAirEffort(
  sections: Section[],
  rider: Rider,
  effort: {
    elapsed_time_s: number;
    moving_time_s?: number | null;
    weather?: EffortWeatherInput | null;
  },
  minSeconds = MIN_ADJUST_SECONDS,
): StillAirResult {
  if (!sections.length) return { kind: "none", reason: "no-geometry" };
  const w = effort.weather;
  if (!w || w.wind_speed_ms === null || w.wind_speed_ms === undefined) {
    return { kind: "none", reason: "no-weather" };
  }
  const moving =
    effort.moving_time_s && effort.moving_time_s > 0
      ? Math.min(effort.moving_time_s, effort.elapsed_time_s)
      : effort.elapsed_time_s;
  if (moving < minSeconds) return { kind: "none", reason: "too-short" };

  const rho = airDensity(w.temperature_c ?? 15, w.pressure_hpa ?? 1013, w.humidity_pct ?? 60);
  const tails = sectionTailwinds(sections, w.wind_from_deg ?? 0, w.wind_speed_ms);
  const watts = impliedPower(sections, rider, moving, tails, rho);
  if (watts === null) return { kind: "none", reason: "not-steady" };

  const still = timeAtPower(sections, rider, watts, null, RHO_STANDARD);
  return {
    kind: "adjusted",
    stillAirSeconds: effort.elapsed_time_s + (still - moving),
    impliedWatts: watts,
    tailwindMs: effectiveTailwind(sections, tails),
    rho,
  };
}
