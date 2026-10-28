/**
 * The wind-aware ride planner for saved routes: when to ride a route, and how
 * long it should take, hour by hour through the forecast.
 *
 * Pure and shared. The server runs it over the whole week to answer
 * /api/training/route-forecast, and the browser runs the same functions again
 * when the power slider moves or another hour is picked, so the two can never
 * disagree about what a window is worth.
 *
 * The physics is lib/physics.ts unchanged: constant power, one section at a
 * time on its own bearing and gradient, times summed and never averaged as
 * wind. What this adds is a ride long enough for the weather to change under
 * it: each section meets the forecast for the moment the rider reaches it.
 */

import { formatHours } from "@/lib/training/activity-types";
import { angleDelta, bearingDeg, haversineM, toRad } from "@/lib/geo";
import { DEFAULT_RIDER, sectionSpeed, windAtRiderHeight } from "@/lib/physics";
import type { Rider, RiderModel } from "@/lib/types";

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

/** Air density the calm-air reference and the default power are taken in. */
export const RHO_REFERENCE = 1.225;

/** At most this many sections, however long the route. */
export const MAX_SECTIONS = 300;
/** Never shorter than this, so a short route is not split below GPS noise. */
export const MIN_SECTION_M = 150;
/** Forecast requests per route, each one 0.1° grid cell. */
export const MAX_CELLS = 8;
/** Matches lib/server/weather.ts. */
export const CELL_DEG = 0.1;
/** Bike, bottles and kit, added to the athlete's weight when it is set. */
export const BIKE_MASS_KG = 9;
/** Share of FTP used as the endurance default when there is no rider model. */
export const ENDURANCE_FTP_SHARE = 0.7;
/** Default when nothing is known about the rider at all. */
export const GENERIC_ENDURANCE_W = 175;
/** Rain chance above which a dry window is preferred, when one exists. */
export const WET_PRECIP_PCT = 60;

// ------------------------------------------------------------- sections --

export type RawProfile = {
  /** Miles from the start. */
  distance: number[];
  /** Feet. */
  altitude: number[];
  latlng: Array<[number, number] | null>;
};

/** One stretch of the route, short enough that its bearing holds. */
export type SectionGeometry = {
  /** Metres from the start to the beginning of this section. */
  start_m: number;
  length_m: number;
  bearing_deg: number;
  /** Rise over run. */
  grade: number;
};

/** A section as the server builds it, with its location. */
export type RouteSection = SectionGeometry & {
  /** A point on the section, used to pick its forecast cell. Never published. */
  at: [number, number];
  /** Whether every point of it lies outside the privacy radius. */
  visible: boolean;
};

/**
 * Splits the profile into at most `maxSections` sections by merging points.
 * Lengths come from the profile's own distance (Strava's, along the road),
 * bearings from each section's end points.
 */
export function buildSections(
  profile: RawProfile,
  visible: boolean[] = [],
  maxSections = MAX_SECTIONS,
): RouteSection[] {
  const n = Math.min(profile.distance.length, profile.altitude.length, profile.latlng.length);
  const points: Array<{ d: number; alt: number; at: [number, number]; visible: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const at = profile.latlng[i];
    const d = profile.distance[i] * METERS_PER_MILE;
    const alt = profile.altitude[i] * METERS_PER_FOOT;
    if (!at || !Number.isFinite(d) || !Number.isFinite(alt)) continue;
    if (points.length && d < points[points.length - 1].d) continue;
    points.push({ d, alt, at, visible: visible[i] ?? false });
  }
  if (points.length < 2) return [];

  const total = points[points.length - 1].d - points[0].d;
  const target = Math.max(MIN_SECTION_M, total / Math.max(1, maxSections));
  const sections: RouteSection[] = [];
  let start = 0;
  let lastBearing = 0;
  for (let i = 1; i < points.length; i++) {
    const length = points[i].d - points[start].d;
    const last = i === points.length - 1;
    // Within 1% of the target counts, so float rounding never adds a sliver.
    if (length < target * 0.99 && !last) continue;
    if (length <= 0) continue;
    const a = points[start];
    const b = points[i];
    const moved = haversineM(a.at, b.at);
    const bearing = moved > 1 ? bearingDeg(a.at, b.at) : lastBearing;
    lastBearing = bearing;
    let shown = true;
    for (let k = start; k <= i; k++) shown &&= points[k].visible;
    sections.push({
      start_m: a.d - points[0].d,
      length_m: length,
      bearing_deg: bearing,
      // A profile glitch must not become a wall.
      grade: Math.max(-0.25, Math.min(0.25, (b.alt - a.alt) / length)),
      at: points[(start + i) >> 1].at,
      visible: shown,
    });
    start = i;
  }
  // A short tail left over at the end joins the section before it.
  if (sections.length > 1) {
    const tail = sections[sections.length - 1];
    if (tail.length_m < target * 0.25) {
      const prev = sections[sections.length - 2];
      const length = prev.length_m + tail.length_m;
      sections.splice(sections.length - 2, 2, {
        ...prev,
        length_m: length,
        grade: (prev.grade * prev.length_m + tail.grade * tail.length_m) / length,
        visible: prev.visible && tail.visible,
      });
    }
  }
  return sections;
}

// --------------------------------------------------------- forecast cells --

export function cellCentre(lat: number, lon: number): [number, number] {
  return [
    Math.round(lat / CELL_DEG) * CELL_DEG,
    Math.round(lon / CELL_DEG) * CELL_DEG,
  ];
}

const cellKey = (cell: [number, number]) => `${cell[0].toFixed(2)},${cell[1].toFixed(2)}`;

/**
 * The forecast cells to request for a route: every cell it passes through
 * when that is at most `maxCells`, otherwise cells picked at even distances
 * along it. Each section is then served by the nearest chosen cell.
 */
export function sampleCells(
  sections: RouteSection[],
  maxCells = MAX_CELLS,
): { cells: Array<[number, number]>; assignment: number[] } {
  if (!sections.length) return { cells: [], assignment: [] };
  const ordered = new Map<string, [number, number]>();
  for (const s of sections) {
    const cell = cellCentre(s.at[0], s.at[1]);
    ordered.set(cellKey(cell), cell);
  }
  let cells = [...ordered.values()];
  if (cells.length > maxCells) {
    const total = sections[sections.length - 1].start_m + sections[sections.length - 1].length_m;
    const picked = new Map<string, [number, number]>();
    let cursor = 0;
    for (let k = 0; k < maxCells; k++) {
      const at = ((k + 0.5) / maxCells) * total;
      while (cursor < sections.length - 1 && sections[cursor].start_m + sections[cursor].length_m < at) {
        cursor++;
      }
      const s = sections[cursor];
      const cell = cellCentre(s.at[0], s.at[1]);
      picked.set(cellKey(cell), cell);
    }
    cells = [...picked.values()];
  }
  return { cells, assignment: assignCells(sections, cells) };
}

/** Index of the nearest cell centre for every section. */
export function assignCells(sections: RouteSection[], cells: Array<[number, number]>): number[] {
  return sections.map((s) => {
    let best = 0;
    let bestDistance = Infinity;
    cells.forEach((cell, index) => {
      const d = haversineM(s.at, cell);
      if (d < bestDistance) {
        bestDistance = d;
        best = index;
      }
    });
    return best;
  });
}

// ----------------------------------------------------------------- wind --

/** One cell's hourly forecast, reduced to what the physics needs. */
export type CellSeries = {
  /** Wind at 10 m, m/s. */
  speed: number[];
  /** Direction the wind blows from, degrees. */
  from: number[];
  /** Air density, kg/m³. */
  rho: number[];
};

/**
 * Tailwind component, positive behind the rider. Meteorological convention:
 * the forecast gives where the wind comes from, so it travels the other way.
 */
export function tailwindComponent(speed: number, fromDeg: number, bearingDeg: number): number {
  const windTo = (fromDeg + 180) % 360;
  return speed * Math.cos(toRad(angleDelta(windTo, bearingDeg)));
}

/**
 * The weather in one cell at a fractional hour index. Wind is interpolated as
 * a vector, so a backing wind turns through the hour rather than averaging a
 * north and a south into calm. Null past the end of the forecast.
 */
export function weatherAt(
  cell: CellSeries,
  at: number,
): { speed: number; from: number; rho: number } | null {
  const last = cell.speed.length - 1;
  if (at < 0 || at > last || last < 0) return null;
  const i0 = Math.floor(at);
  const i1 = Math.min(last, i0 + 1);
  const t = at - i0;
  if (t === 0 || i0 === i1) {
    return { speed: cell.speed[i0], from: cell.from[i0], rho: cell.rho[i0] };
  }
  const vec = (i: number) => {
    const r = toRad(cell.from[i]);
    return [cell.speed[i] * Math.sin(r), cell.speed[i] * Math.cos(r)];
  };
  const [u0, v0] = vec(i0);
  const [u1, v1] = vec(i1);
  const u = u0 + (u1 - u0) * t;
  const v = v0 + (v1 - v0) * t;
  return {
    speed: Math.hypot(u, v),
    from: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
    rho: cell.rho[i0] + (cell.rho[i1] - cell.rho[i0]) * t,
  };
}

export type RideResult = {
  time_s: number;
  /** The same ride in still air of the same density. */
  calm_s: number;
  /** Tailwind each section meets at rider height, m/s, when asked for. */
  tail?: number[];
};

/**
 * Moving time for a ride starting at forecast hour `start`, each section
 * meeting the weather of the moment the rider reaches it. Null when the ride
 * would outlast the forecast.
 */
export function predictRide(
  sections: SectionGeometry[],
  assignment: number[],
  cells: CellSeries[],
  start: number,
  rider: Rider,
  withTail = false,
): RideResult | null {
  let time = 0;
  let calm = 0;
  const tail: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const cell = cells[assignment[i]];
    if (!cell) return null;
    const w = weatherAt(cell, start + time / 3600);
    if (!w) return null;
    const component = tailwindComponent(windAtRiderHeight(w.speed), w.from, s.bearing_deg);
    time += s.length_m / sectionSpeed(rider, -component, s.grade, w.rho);
    if (withTail) tail.push(component);
    // The calm ride keeps its own clock so its air is that of its own hours.
    const calmWeather = weatherAt(cell, start + calm / 3600) ?? w;
    calm += s.length_m / sectionSpeed(rider, 0, s.grade, calmWeather.rho);
  }
  return withTail ? { time_s: time, calm_s: calm, tail } : { time_s: time, calm_s: calm };
}

/** Still air at reference density: the route's time with no weather at all. */
export function calmRideTime(sections: SectionGeometry[], rider: Rider, rho = RHO_REFERENCE): number {
  return sections.reduce((t, s) => t + s.length_m / sectionSpeed(rider, 0, s.grade, rho), 0);
}

/** Predicted and calm-air time for every start hour; null where the forecast runs out. */
export function predictWeek(
  sections: SectionGeometry[],
  assignment: number[],
  cells: CellSeries[],
  rider: Rider,
  hours: number,
): { times: Array<number | null>; calm: Array<number | null> } {
  const times: Array<number | null> = [];
  const calm: Array<number | null> = [];
  for (let h = 0; h < hours; h++) {
    const ride = predictRide(sections, assignment, cells, h, rider);
    times.push(ride ? Math.round(ride.time_s) : null);
    calm.push(ride ? Math.round(ride.calm_s) : null);
  }
  return { times, calm };
}

// ------------------------------------------------------------ the rider --

export type MassSource = "settings" | "calibration" | "default";

/** The calibrated rider, with the athlete's own weight when they have set it. */
export function plannerRider(
  model: RiderModel | null,
  weightKg: number | null,
): { rider: Rider; massSource: MassSource } {
  const base: Rider = model ? { ...DEFAULT_RIDER, mass_kg: model.mass_kg, cda: model.cda } : DEFAULT_RIDER;
  if (weightKg) return { rider: { ...base, mass_kg: weightKg + BIKE_MASS_KG }, massSource: "settings" };
  return { rider: base, massSource: model ? "calibration" : "default" };
}

export type PowerSource = "rider-model" | "ftp" | "generic";

export type DefaultPower = { watts: number; source: PowerSource; label: string };

/**
 * What to assume the rider holds when they have not said.
 *
 * The fitted rider model first: its critical power plus the share of W′ a ride
 * this long allows, plus its gradient term at this route's mean grade -- the
 * same fixed point lib/physics.ts uses for a segment, run over the whole route.
 * It was fitted against this rider's real efforts, so it predicts how they
 * actually ride, coasting and traffic included. Failing that, 70% of FTP, the
 * middle of the endurance zone. Failing that, a generic endurance figure.
 */
export function defaultPower(
  sections: SectionGeometry[],
  rider: Rider,
  model: RiderModel | null,
  ftp: number | null,
): DefaultPower {
  if (model && sections.length) {
    const total = sections.reduce((d, s) => d + s.length_m, 0);
    const meanGrade = total > 0 ? sections.reduce((g, s) => g + s.grade * s.length_m, 0) / total : 0;
    const grade = Math.min(Math.max(meanGrade, model.grade_min ?? 0), model.grade_max ?? 0);
    const powerAt = (seconds: number) =>
      model.cp_w + (seconds > 0 ? model.w_prime_j / seconds : 0) + model.grade_w * grade;
    const timeAt = (watts: number) => calmRideTime(sections, { ...rider, power_w: watts });
    let seconds = timeAt(powerAt(3600));
    for (let i = 0; i < 12; i++) {
      const next = timeAt(powerAt(seconds));
      const done = Math.abs(next - seconds) < 1;
      seconds = next;
      if (done) break;
    }
    const watts = Math.round(powerAt(seconds));
    return {
      watts,
      source: "rider-model",
      label: `Your fitted rider model for a ride this long (CP ${Math.round(model.cp_w)} W)`,
    };
  }
  if (ftp) {
    return {
      watts: Math.round(ftp * ENDURANCE_FTP_SHARE),
      source: "ftp",
      label: `Endurance pace, ${Math.round(ENDURANCE_FTP_SHARE * 100)}% of your ${Math.round(ftp)} W FTP`,
    };
  }
  return { watts: GENERIC_ENDURANCE_W, source: "generic", label: "A generic endurance pace" };
}

// ------------------------------------------------------------- daylight --

/** Sunrise and sunset (epoch seconds) for a calendar date, by the sunrise equation. */
export function sunTimes(
  date: string,
  lat: number,
  lon: number,
): { sunrise: number; sunset: number } | { polar: "day" | "night" } {
  const [y, m, d] = date.split("-").map(Number);
  const days = Date.UTC(y, m - 1, d) / 86_400_000;
  // Days since J2000.0, then mean solar noon at this longitude.
  const n = days - 10957;
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const Mr = toRad(M);
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lambda = toRad((M + C + 180 + 102.9372) % 360);
  const transit = 2451545 + jStar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambda);
  const sinDec = Math.sin(lambda) * Math.sin(toRad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const phi = toRad(lat);
  const cosOmega = (Math.sin(toRad(-0.833)) - Math.sin(phi) * sinDec) / (Math.cos(phi) * cosDec);
  if (cosOmega < -1) return { polar: "day" };
  if (cosOmega > 1) return { polar: "night" };
  const omega = (Math.acos(cosOmega) * 180) / Math.PI;
  const toEpoch = (julian: number) => Math.round((julian - 2440587.5) * 86400);
  return { sunrise: toEpoch(transit - omega / 360), sunset: toEpoch(transit + omega / 360) };
}

export type Daylight = 0 | 1 | 2;

/** 2 when the whole ride is between sunrise and sunset, 1 when part of it is, else 0. */
export function daylightFlag(
  start: number,
  duration: number,
  sun: { sunrise: number; sunset: number } | { polar: "day" | "night" },
): Daylight {
  if ("polar" in sun) return sun.polar === "day" ? 2 : 0;
  const end = start + duration;
  if (start >= sun.sunrise && end <= sun.sunset) return 2;
  return Math.min(end, sun.sunset) > Math.max(start, sun.sunrise) ? 1 : 0;
}

// ------------------------------------------------------------- windows --

export type Window = {
  hour: number;
  time_s: number;
  calm_s: number;
  /** Positive when the wind makes it faster than calm air. */
  saved_s: number;
};

/** The first hour that has not started yet, or that is under way now. */
export function nowIndex(epochs: number[], nowSec: number): number {
  const index = epochs.findIndex((t) => t + 3600 > nowSec);
  return index === -1 ? epochs.length : index;
}

/**
 * The fastest start hour, then the fastest on each other day, up to `count`.
 * Daylight rides are preferred when there are any, and dry ones when the rain
 * leaves a choice: a quick window in the dark or a downpour is not a plan.
 */
export function bestWindows(
  times: Array<number | null>,
  calm: Array<number | null>,
  options: {
    from: number;
    days: string[];
    daylight?: Daylight[];
    precip?: number[];
    count?: number;
  },
): Window[] {
  let candidates = times
    .map((time, hour) => ({ hour, time, calm: calm[hour] }))
    .filter(
      (c): c is { hour: number; time: number; calm: number } =>
        c.hour >= options.from && c.time !== null && c.calm !== null,
    );
  const prefer = (keep: (hour: number) => boolean) => {
    const kept = candidates.filter((c) => keep(c.hour));
    if (kept.length) candidates = kept;
  };
  if (options.daylight) prefer((hour) => options.daylight![hour] === 2);
  if (options.precip) prefer((hour) => (options.precip![hour] ?? 0) < WET_PRECIP_PCT);
  candidates.sort((a, b) => a.time - b.time || a.hour - b.hour);
  const out: Window[] = [];
  const usedDays = new Set<string>();
  for (const c of candidates) {
    const day = options.days[c.hour];
    if (usedDays.has(day)) continue;
    usedDays.add(day);
    out.push({ hour: c.hour, time_s: c.time, calm_s: c.calm, saved_s: c.calm - c.time });
    if (out.length >= (options.count ?? 3)) break;
  }
  return out;
}

// ---------------------------------------------------------------- words --

/** Grade from which a section counts as climbing. */
const CLIMB_GRADE = 0.03;
/** Wind components smaller than this read as neither help nor hindrance. */
const NOTICEABLE_MS = 0.75;

/**
 * Where the wind helps and hurts, in a phrase: out and back, the climbs, or
 * the route as a whole.
 */
export function windPhrase(sections: SectionGeometry[], tail: number[]): string {
  const total = sections.reduce((d, s) => d + s.length_m, 0);
  if (!total || tail.length !== sections.length) return "";
  const mean = (pick: (s: SectionGeometry, i: number) => boolean) => {
    let sum = 0;
    let length = 0;
    sections.forEach((s, i) => {
      if (!pick(s, i)) return;
      sum += tail[i] * s.length_m;
      length += s.length_m;
    });
    return length ? { value: sum / length, share: length / total } : null;
  };
  const share = (pick: (value: number) => boolean) =>
    sections.reduce((d, s, i) => d + (pick(tail[i]) ? s.length_m : 0), 0) / total;

  const strongest = Math.max(...tail.map(Math.abs));
  if (strongest < NOTICEABLE_MS) return "barely any wind on the route";

  const parts: string[] = [];
  const half = total / 2;
  const out = mean((s) => s.start_m + s.length_m / 2 < half);
  const back = mean((s) => s.start_m + s.length_m / 2 >= half);
  if (out && back && out.value <= -NOTICEABLE_MS && back.value >= NOTICEABLE_MS) {
    parts.push("headwind out, tailwind home");
  } else if (out && back && out.value >= NOTICEABLE_MS && back.value <= -NOTICEABLE_MS) {
    parts.push("tailwind out, headwind home");
  } else {
    const tailShare = share((v) => v >= NOTICEABLE_MS);
    const headShare = share((v) => v <= -NOTICEABLE_MS);
    if (tailShare >= 0.5) parts.push("mostly tailwind");
    else if (headShare >= 0.5) parts.push("mostly headwind");
    else if (tailShare + headShare < 0.35) parts.push("mostly crosswind");
    else parts.push(`tailwind for ${Math.round(tailShare * 100)}% of it`);
  }

  const climbs = mean((s) => s.grade >= CLIMB_GRADE);
  if (climbs && climbs.share >= 0.05) {
    if (climbs.value >= NOTICEABLE_MS) parts.push("tailwind on the climbs");
    else if (climbs.value <= -NOTICEABLE_MS) parts.push("headwind on the climbs");
  }
  if (parts.length === 2 && parts[0].startsWith("mostly ") && parts[1].endsWith("on the climbs")) {
    const [lead, climb] = [parts[0].slice(7), parts[1]];
    if (climb.startsWith(lead)) return `mostly ${climb}`;
  }
  return parts.join(", ");
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Saturday 9 AM", from a forecast's local wall-clock time. */
export function windowLabel(localTime: string, today?: string): string {
  const [date, clock] = localTime.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const hour = Number(clock?.slice(0, 2) ?? 0);
  const day = (() => {
    if (today) {
      const diff = Math.round((Date.UTC(y, m - 1, d) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (diff === 0) return "Today";
      if (diff === 1) return "Tomorrow";
    }
    return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  })();
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${day} ${h12} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Saturday 9 AM: 3h 48m, 14 min faster than calm air, mostly tailwind on the climbs". */
export function describeWindow(
  window: Window,
  localTime: string,
  phrase: string,
  today?: string,
): string {
  const minutes = Math.round(Math.abs(window.saved_s) / 60);
  const effect =
    minutes === 0
      ? "about the same as calm air"
      : `${minutes} min ${window.saved_s > 0 ? "faster" : "slower"} than calm air`;
  return [`${windowLabel(localTime, today)}: ${formatHours(window.time_s / 3600)}`, effect, phrase]
    .filter(Boolean)
    .join(", ");
}

/** Every section's tailwind for one start hour, for the map and the summary. */
export function sectionTailwinds(
  sections: SectionGeometry[],
  assignment: number[],
  cells: CellSeries[],
  start: number,
  rider: Rider,
): number[] | null {
  return predictRide(sections, assignment, cells, start, rider, true)?.tail ?? null;
}

// ------------------------------------------------------------ response --

/** A section as published: geometry, its forecast cell, and a point only when it is far from home. */
export type PublicSection = SectionGeometry & {
  cell: number;
  /** Null within the privacy radius of either end. */
  mid: [number, number] | null;
};

export type RouteForecast = {
  id: string;
  name: string;
  /** IANA zone of the forecast; hours are wall-clock times in it. */
  timezone: string;
  issued_at: string;
  /** Local start time of every forecast hour, "YYYY-MM-DDTHH:mm". */
  hours: string[];
  /** The same hours as epoch seconds. */
  epochs: number[];
  rider: {
    mass_kg: number;
    mass_source: MassSource;
    cda: number;
    crr: number;
    drivetrain_efficiency: number;
  };
  power: {
    watts: number;
    /** Whether `watts` was asked for or is the default below. */
    requested: boolean;
    default: DefaultPower;
  };
  distance_m: number;
  climbing_m: number;
  /** Still air at 1.225 kg/m³. */
  calm_s: number;
  sections: PublicSection[];
  /** Hourly wind and air density for each forecast cell, aligned with `hours`. */
  cells: CellSeries[];
  /** Route means per hour, for describing a window. */
  weather: { temperature_c: number[]; precip_prob: number[]; gust_ms: number[] };
  days: Array<{ date: string; sunrise: number | null; sunset: number | null }>;
  daylight: Daylight[];
  /** Predicted moving time per start hour; null where the forecast runs out. */
  times: Array<number | null>;
  /** The same ride in still air of that hour's density. */
  calm: Array<number | null>;
  best: Array<Window & { summary: string }>;
  selected: { hour: number; tail: number[] } | null;
};

/** Days of the forecast in order, from its local times. */
export function forecastDays(hours: string[]): string[] {
  return [...new Set(hours.map((h) => h.slice(0, 10)))];
}

/** Daylight flags for every start hour, given predicted durations. */
export function daylightFlags(
  hours: string[],
  epochs: number[],
  times: Array<number | null>,
  sun: Map<string, ReturnType<typeof sunTimes>>,
): Daylight[] {
  return hours.map((local, i) => {
    const s = sun.get(local.slice(0, 10));
    return s ? daylightFlag(epochs[i], times[i] ?? 3600, s) : 2;
  });
}
