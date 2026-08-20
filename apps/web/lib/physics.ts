/**
 * Opportunity algorithm, implementing section 9 of docs/PROJECT_PLAN.md.
 *
 * The governing rule: anything that changes predicted time enters the physics
 * model; anything that changes whether the rider wants to go stays a score
 * modifier. Aggregate in time, never in wind.
 */

import { angleDelta, toRad, toSections } from "./geo";
import type {
  Evaluation,
  ForecastCell,
  GateFailure,
  Rider,
  SectionResult,
  Segment,
} from "./types";

const G = 9.80665;
const R_DRY = 287.058;
const R_VAPOUR = 461.495;

export const DEFAULT_RIDER: Rider = {
  power_w: 250,
  mass_kg: 80,
  cda: 0.32,
  crr: 0.005,
  drivetrain_efficiency: 0.97,
};

/** Score weights. Section 9 keeps these as versioned configuration. */
export const WEIGHTS = {
  beat: 0.7,
  margin: 0.3,
  precip: 0.25,
  gust: 0.2,
  comfort: 0.15,
  version: "2026-08-19.1",
};

export const GATES = {
  max_gust_ms: 17,
  max_sustained_ms: 13,
  max_precip_mm: 4,
  min_temp_c: -8,
  max_temp_c: 38,
};

/** Margin normaliser: a 5% improvement on target counts as a full margin score. */
const MARGIN_SCALE = 0.05;

/**
 * Air density from temperature, pressure and humidity. Temperature reaches the
 * prediction through this term rather than as an additive score component.
 */
export function airDensity(
  tempC: number,
  pressureHpa: number,
  humidityPct: number,
): number {
  const T = tempC + 273.15;
  const saturation = 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const pv = (humidityPct / 100) * saturation;
  const pd = pressureHpa * 100 - pv;
  return pd / (R_DRY * T) + pv / (R_VAPOUR * T);
}

/**
 * Scale a 10 m forecast wind down to rider height with a logarithmic profile.
 * Open terrain roughness; a rider sits near 1.5 m, not 10 m.
 */
export function windAtRiderHeight(v10: number, roughness = 0.05): number {
  const factor = Math.log(1.5 / roughness) / Math.log(10 / roughness);
  return v10 * factor;
}

/**
 * Ground speed at constant power. Monotonic in v, so bisection is stable and
 * needs no closed-form cubic. `v_air * |v_air|` preserves sign, so a tailwind
 * stronger than ground speed pushes rather than drags.
 */
export function sectionSpeed(
  rider: Rider,
  headwindMs: number,
  grade: number,
  rho: number,
): number {
  const theta = Math.atan(grade);
  const roll = rider.crr * rider.mass_kg * G * Math.cos(theta);
  const grav = rider.mass_kg * G * Math.sin(theta);

  let lo = 0.05;
  let hi = 32;
  for (let i = 0; i < 26; i++) {
    const v = (lo + hi) / 2;
    const va = v + headwindMs;
    const drag = 0.5 * rho * rider.cda * va * Math.abs(va);
    const required = (v * (drag + roll + grav)) / rider.drivetrain_efficiency;
    if (required < rider.power_w) lo = v;
    else hi = v;
  }
  return (lo + hi) / 2;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export interface HourWeather {
  wind_speed_ms: number;
  wind_from_deg: number;
  gust_ms: number;
  temperature_c: number;
  humidity_pct: number;
  pressure_hpa: number;
  precip_mm: number;
  precip_prob: number;
}

export function hourFromCell(cell: ForecastCell, index: number): HourWeather {
  return {
    wind_speed_ms: cell.wind_speed_ms[index] ?? 0,
    wind_from_deg: cell.wind_from_deg[index] ?? 0,
    gust_ms: cell.gust_ms[index] ?? 0,
    temperature_c: cell.temperature_c[index] ?? 15,
    humidity_pct: cell.humidity_pct[index] ?? 60,
    pressure_hpa: cell.pressure_hpa[index] ?? 1013,
    precip_mm: cell.precip_mm[index] ?? 0,
    precip_prob: cell.precip_prob[index] ?? 0,
  };
}

/** Sum of per-section times. Never a mean tailwind converted once. */
function ridePolyline(
  sections: ReturnType<typeof toSections>,
  rider: Rider,
  grade: number,
  rho: number,
  windTo: number,
  windSpeed: number,
): { time_s: number; results: SectionResult[]; tailSum: number; crossSum: number; dist: number } {
  const results: SectionResult[] = [];
  let time = 0;
  let tailSum = 0;
  let crossSum = 0;
  let dist = 0;

  for (const s of sections) {
    const delta = toRad(angleDelta(windTo, s.bearing_deg));
    const tail = windSpeed * Math.cos(delta);
    const cross = Math.abs(windSpeed * Math.sin(delta));
    const speed = sectionSpeed(rider, -tail, grade, rho);
    const t = s.distance_m / speed;

    results.push({
      offset_m: dist,
      distance_m: s.distance_m,
      bearing_deg: s.bearing_deg,
      tailwind_ms: tail,
      crosswind_ms: cross,
      speed_ms: speed,
      time_s: t,
    });

    time += t;
    tailSum += tail * s.distance_m;
    crossSum += cross * s.distance_m;
    dist += s.distance_m;
  }

  return { time_s: time, results, tailSum, crossSum, dist };
}

/** Section geometry is fixed per segment; cache it rather than recomputing. */
const sectionCache = new Map<number, ReturnType<typeof toSections>>();

export function sectionsFor(segment: Segment) {
  let cached = sectionCache.get(segment.id);
  if (!cached) {
    cached = toSections(segment.points);
    sectionCache.set(segment.id, cached);
  }
  return cached;
}

/** ISA reference density, used as the neutral baseline for calibration. */
const RHO_REFERENCE = 1.225;

const powerCache = new Map<number, number>();

/**
 * Fit sustainable power to the rider's own PR on this segment, per section 9
 * ("baseline physics model calibrated against historical efforts").
 *
 * Without this the model compares the rider against a generic 250 W athlete,
 * and every probability collapses to 0% or 100%. Calibrating makes the still-air
 * prediction equal the PR by construction, so the wind term is what actually
 * moves the estimate and the probability becomes meaningful.
 *
 * The conditions during the PR are unknown, so still air at reference density is
 * the neutral baseline. That folds any wind help the rider had that day into the
 * fitted power, which is a known bias and a reason to prefer many efforts over
 * one once effort history is available.
 */
export function calibratedPower(
  segment: Segment,
  rider: Rider = DEFAULT_RIDER,
): number {
  const pr = segment.pr_elapsed_time;
  if (!pr || pr <= 0) return rider.power_w;

  const cached = powerCache.get(segment.id);
  if (cached !== undefined) return cached;

  const sections = sectionsFor(segment);
  if (sections.length === 0) return rider.power_w;
  const grade = (segment.average_grade ?? 0) / 100;

  const timeAt = (power: number) =>
    sections.reduce(
      (acc, s) =>
        acc +
        s.distance_m /
          sectionSpeed({ ...rider, power_w: power }, 0, grade, RHO_REFERENCE),
      0,
    );

  // Time decreases monotonically with power.
  let lo = 40;
  let hi = 900;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (timeAt(mid) > pr) lo = mid;
    else hi = mid;
  }
  const fitted = (lo + hi) / 2;
  powerCache.set(segment.id, fitted);
  return fitted;
}

export function evaluate(
  segment: Segment,
  cell: ForecastCell,
  hourIndex: number,
  baseRider: Rider = DEFAULT_RIDER,
): Evaluation {
  const rider: Rider = {
    ...baseRider,
    power_w: calibratedPower(segment, baseRider),
  };
  const w = hourFromCell(cell, hourIndex);
  const rho = airDensity(w.temperature_c, w.pressure_hpa, w.humidity_pct);
  const grade = (segment.average_grade ?? 0) / 100;
  const sections = sectionsFor(segment);

  // Meteorological convention: reported direction is where wind comes from.
  const windTo = (w.wind_from_deg + 180) % 360;
  const windSpeed = windAtRiderHeight(w.wind_speed_ms);

  const ride = ridePolyline(sections, rider, grade, rho, windTo, windSpeed);
  const still = ridePolyline(sections, rider, grade, rho, windTo, 0);

  const effectiveTailwind = ride.dist > 0 ? ride.tailSum / ride.dist : 0;
  const meanCrosswind = ride.dist > 0 ? ride.crossSum / ride.dist : 0;

  // Uncertainty: forecast spread proxied by gust headroom, plus a model
  // residual and rider effort variance. Widening this is the only channel
  // through which confidence affects the score.
  const gustHeadroom = Math.max(0, w.gust_ms - w.wind_speed_ms);
  const windSigma = windAtRiderHeight(gustHeadroom * 0.5 + w.wind_speed_ms * 0.12);
  const high = ridePolyline(sections, rider, grade, rho, windTo, windSpeed + windSigma);
  const low = ridePolyline(
    sections,
    rider,
    grade,
    rho,
    windTo,
    Math.max(0, windSpeed - windSigma),
  );
  const windTimeSigma = Math.abs(high.time_s - low.time_s) / 2;
  // Priors, not measurements. Calibrating to a single PR assumes the rider
  // reproduces their best-ever effort on demand, which is optimistic, and one
  // effort per segment cannot estimate day-to-day variance at all. These stand
  // in until real effort history is available; see section 9, prediction
  // evolution. Effort variability dominates: riders vary several percent
  // between attempts.
  const modelSigma = ride.time_s * 0.03;
  const effortSigma = ride.time_s * 0.05;
  const sigma = Math.sqrt(
    windTimeSigma ** 2 + modelSigma ** 2 + effortSigma ** 2,
  );

  const target = segment.pr_elapsed_time;
  const pBeat =
    target && sigma > 0 ? normalCdf((target - ride.time_s) / sigma) : null;
  const margin = target
    ? clamp01((target - ride.time_s) / (target * MARGIN_SCALE))
    : 0;

  const gates: GateFailure[] = [];
  if (w.gust_ms > GATES.max_gust_ms)
    gates.push({ gate: "gust", detail: `Gusts ${w.gust_ms.toFixed(0)} m/s` });
  if (w.wind_speed_ms > GATES.max_sustained_ms)
    gates.push({ gate: "wind", detail: `Sustained ${w.wind_speed_ms.toFixed(0)} m/s` });
  if (w.precip_mm > GATES.max_precip_mm)
    gates.push({ gate: "precipitation", detail: `${w.precip_mm.toFixed(1)} mm/h` });
  if (w.temperature_c < GATES.min_temp_c || w.temperature_c > GATES.max_temp_c)
    gates.push({ gate: "temperature", detail: `${w.temperature_c.toFixed(0)}°C` });

  const precipPenalty = clamp01(w.precip_mm / GATES.max_precip_mm) * 0.6 +
    clamp01(w.precip_prob / 100) * 0.4;
  const gustPenalty = clamp01(gustHeadroom / 10);
  const comfortPenalty =
    clamp01(Math.abs(w.temperature_c - 18) / 22) * 0.7 +
    clamp01(meanCrosswind / 12) * 0.3;

  let score =
    WEIGHTS.beat * (pBeat ?? 0) +
    WEIGHTS.margin * margin -
    WEIGHTS.precip * precipPenalty -
    WEIGHTS.gust * gustPenalty -
    WEIGHTS.comfort * comfortPenalty;

  if (gates.length > 0) score = 0;

  return {
    segment_id: segment.id,
    hour_index: hourIndex,
    calibrated_power_w: rider.power_w,
    predicted_time_s: ride.time_s,
    still_air_time_s: still.time_s,
    delta_vs_still_air_s: ride.time_s - still.time_s,
    effective_tailwind_ms: effectiveTailwind,
    mean_crosswind_ms: meanCrosswind,
    sigma_s: sigma,
    p_beat: pBeat,
    margin,
    score: clamp01(score),
    gates,
    sections: ride.results,
    weather: {
      wind_speed_ms: w.wind_speed_ms,
      wind_from_deg: w.wind_from_deg,
      gust_ms: w.gust_ms,
      temperature_c: w.temperature_c,
      precip_mm: w.precip_mm,
      precip_prob: w.precip_prob,
      air_density: rho,
    },
  };
}

/** Score breakdown for the detail panel, in display order. */
export function breakdown(ev: Evaluation) {
  const gustHeadroom = Math.max(0, ev.weather.gust_ms - ev.weather.wind_speed_ms);
  return [
    {
      key: "beat",
      label: "Chance of beating PR",
      contribution: WEIGHTS.beat * (ev.p_beat ?? 0),
      raw: ev.p_beat,
      positive: true,
    },
    {
      key: "margin",
      label: "Margin under target",
      contribution: WEIGHTS.margin * ev.margin,
      raw: ev.margin,
      positive: true,
    },
    {
      key: "precip",
      label: "Precipitation",
      contribution:
        -WEIGHTS.precip *
        (Math.min(1, ev.weather.precip_mm / GATES.max_precip_mm) * 0.6 +
          Math.min(1, ev.weather.precip_prob / 100) * 0.4),
      raw: ev.weather.precip_prob / 100,
      positive: false,
    },
    {
      key: "gust",
      label: "Gust spread",
      contribution: -WEIGHTS.gust * Math.min(1, gustHeadroom / 10),
      raw: gustHeadroom,
      positive: false,
    },
    {
      key: "comfort",
      label: "Comfort",
      contribution:
        -WEIGHTS.comfort *
        (Math.min(1, Math.abs(ev.weather.temperature_c - 18) / 22) * 0.7 +
          Math.min(1, ev.mean_crosswind_ms / 12) * 0.3),
      raw: ev.weather.temperature_c,
      positive: false,
    },
  ];
}
