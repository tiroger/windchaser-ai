/**
 * Route of the day: every saved route ranked by what the forecast does to it
 * on a given day, so the rider can pick which one to ride.
 *
 * Pure and shared. The server runs it over every route and the browser only
 * renders the result, but the words and the scoring live here so they can be
 * tested without a forecast.
 *
 * The model is the ride planner's (lib/training/route-forecast.ts) unchanged:
 * same sections, same forecast cells, same default power, so a route the
 * ranking says saves 9 minutes opens in the planner saying the same thing.
 */

import { haversineM } from "@/lib/geo";
import { DEFAULT_RIDER, sectionSpeed } from "@/lib/physics";
import type { Rider } from "@/lib/types";

import { decodePolyline } from "./polyline";
import {
  MAX_CELLS,
  RHO_REFERENCE,
  WET_PRECIP_PCT,
  assignCells,
  cellCentre,
  predictRide,
  sampleCells,
  windPhrase,
  type CellSeries,
  type RouteSection,
  type SectionGeometry,
  type sunTimes,
} from "./route-forecast";

type Sun = ReturnType<typeof sunTimes>;

// ----------------------------------------------------------------- days --

export const RANKING_DAYS = ["today", "tomorrow", "weekend"] as const;
export type RankingDay = (typeof RANKING_DAYS)[number];

export const DAY_LABELS: Record<RankingDay, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  weekend: "Weekend",
};

/** "YYYY-MM-DD" plus whole days, on the calendar rather than the clock. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 for Sunday through 6 for Saturday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The calendar dates a day choice covers. The weekend is the coming Saturday
 * and Sunday; on a Saturday it is today and tomorrow, and on a Sunday only
 * what is left of today.
 */
export function rankingDates(day: RankingDay, today: string): string[] {
  if (day === "today") return [today];
  if (day === "tomorrow") return [addDays(today, 1)];
  const weekday = weekdayOf(today);
  if (weekday === 0) return [today];
  if (weekday === 6) return [today, addDays(today, 1)];
  const saturday = addDays(today, 6 - weekday);
  return [saturday, addDays(saturday, 1)];
}

/**
 * Start hours worth considering: on the chosen dates, not yet over, and
 * starting in daylight. Whether the ride also finishes in daylight is left
 * to the score, so a long route late in the day still ranks, with its
 * darkness counted against it.
 */
export function candidateHours(
  hours: string[],
  epochs: number[],
  dates: string[],
  from: number,
  sunOf: (date: string) => Sun | undefined,
): number[] {
  const wanted = new Set(dates);
  const out: number[] = [];
  for (let i = Math.max(0, from); i < hours.length; i++) {
    const date = hours[i].slice(0, 10);
    if (!wanted.has(date)) continue;
    const sun = sunOf(date);
    if (!sun) continue;
    if ("polar" in sun) {
      if (sun.polar === "day") out.push(i);
      continue;
    }
    if (epochs[i] >= sun.sunrise && epochs[i] < sun.sunset) out.push(i);
  }
  return out;
}

/** Share of a ride, 0 to 1, that falls outside sunrise to sunset. */
export function darkShare(start: number, duration: number, sun: Sun | undefined): number {
  if (!sun || duration <= 0) return 0;
  if ("polar" in sun) return sun.polar === "day" ? 0 : 1;
  const end = start + duration;
  const lit = Math.max(0, Math.min(end, sun.sunset) - Math.max(start, sun.sunrise));
  return Math.min(1, Math.max(0, 1 - lit / duration));
}

// -------------------------------------------------------------- scoring --

/**
 * How a window is scored, in points where one point is one percent of the
 * ride's calm-air time.
 *
 *   score = time saved against calm air, in %
 *         - rain:        0.15 a point for every % of rain chance above 20%,
 *                        taking the wettest hour of the ride (60% costs 6,
 *                        a certain downpour 12)
 *         - darkness:    2 for any of the ride after sunset, plus 8 times the
 *                        share of it in the dark (all of it costs 10)
 *         - cold:        0.25 a point per °C below 5 °C at the coldest hour
 *         - heat:        0.4 a point per °C above 30 °C at the hottest hour
 *
 * Wind alone rarely moves a loop by more than a few percent, so on most days
 * the penalties decide between a dry route and a wet one, and the wind
 * decides between dry ones. That is the order a rider would choose in.
 */
export const SCORING = {
  RAIN_FREE_PCT: 20,
  RAIN_POINTS_PER_PCT: 0.15,
  DARK_POINTS: 2,
  DARK_POINTS_PER_SHARE: 8,
  COLD_BELOW_C: 5,
  COLD_POINTS_PER_C: 0.25,
  HEAT_ABOVE_C: 30,
  HEAT_POINTS_PER_C: 0.4,
} as const;

export type RideConditions = {
  /** Positive when the wind makes the ride faster than calm air. */
  saved_pct: number;
  /** Highest rain chance, %, over the hours of the ride. */
  rain_pct: number;
  /** Share of the ride outside daylight, 0 to 1. */
  dark_share: number;
  min_temp_c: number;
  max_temp_c: number;
};

export type Penalties = { rain: number; dark: number; temperature: number };

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function scoreRide(c: RideConditions): { score: number; penalties: Penalties } {
  const s = SCORING;
  const rain = Math.max(0, c.rain_pct - s.RAIN_FREE_PCT) * s.RAIN_POINTS_PER_PCT;
  const dark = c.dark_share > 0.001 ? s.DARK_POINTS + s.DARK_POINTS_PER_SHARE * c.dark_share : 0;
  const temperature =
    Math.max(0, s.COLD_BELOW_C - c.min_temp_c) * s.COLD_POINTS_PER_C +
    Math.max(0, c.max_temp_c - s.HEAT_ABOVE_C) * s.HEAT_POINTS_PER_C;
  return {
    score: round(c.saved_pct - rain - dark - temperature, 2),
    penalties: { rain: round(rain, 2), dark: round(dark, 2), temperature: round(temperature, 2) },
  };
}

// -------------------------------------------------------------- windows --

/** Route-mean weather per forecast hour. */
export type RouteWeather = { temperature_c: number[]; precip_prob: number[] };

export type RouteModel = {
  sections: SectionGeometry[];
  assignment: number[];
  cells: CellSeries[];
  weather: RouteWeather;
  rider: Rider;
};

export type DayWindow = {
  hour: number;
  time_s: number;
  calm_s: number;
  saved_s: number;
  saved_pct: number;
  score: number;
  penalties: Penalties;
  dark_share: number;
  rain_max_pct: number;
  temp_min_c: number;
  temp_max_c: number;
};

/** Forecast hour indices a ride from `hour` lasting `seconds` spends time in. */
function rideHours(hour: number, seconds: number, length: number): number[] {
  const last = Math.min(length - 1, hour + Math.max(0, Math.ceil(seconds / 3600) - 1));
  const out: number[] = [];
  for (let i = hour; i <= last; i++) out.push(i);
  return out;
}

/**
 * The best start among `candidates` by score, earliest on a tie. A start
 * whose ride stays under the planner's wet threshold always beats one that
 * does not, as the planner prefers dry windows: no tailwind is worth a
 * likely soaking. Null when no start lets the ride finish inside the forecast.
 */
export function bestDayWindow(
  model: RouteModel,
  candidates: number[],
  epochs: number[],
  sunAt: (hour: number) => Sun | undefined,
): DayWindow | null {
  let best: DayWindow | null = null;
  for (const hour of candidates) {
    const ride = predictRide(model.sections, model.assignment, model.cells, hour, model.rider);
    if (!ride || ride.calm_s <= 0) continue;
    const span = rideHours(hour, ride.time_s, model.weather.precip_prob.length);
    const rain = Math.max(0, ...span.map((i) => model.weather.precip_prob[i] ?? 0));
    const temps = span.map((i) => model.weather.temperature_c[i] ?? 15);
    const dark = darkShare(epochs[hour], ride.time_s, sunAt(hour));
    const saved = ride.calm_s - ride.time_s;
    const savedPct = (saved / ride.calm_s) * 100;
    const scored = scoreRide({
      saved_pct: savedPct,
      rain_pct: rain,
      dark_share: dark,
      min_temp_c: Math.min(...temps),
      max_temp_c: Math.max(...temps),
    });
    const dry = rain < WET_PRECIP_PCT;
    const bestDry = best !== null && best.rain_max_pct < WET_PRECIP_PCT;
    if (best && ((bestDry && !dry) || (bestDry === dry && scored.score <= best.score))) continue;
    best = {
      hour,
      time_s: Math.round(ride.time_s),
      calm_s: Math.round(ride.calm_s),
      saved_s: Math.round(saved),
      saved_pct: round(savedPct, 2),
      score: scored.score,
      penalties: scored.penalties,
      dark_share: round(dark, 3),
      rain_max_pct: rain,
      temp_min_c: round(Math.min(...temps), 1),
      temp_max_c: round(Math.max(...temps), 1),
    };
  }
  return best;
}

// ----------------------------------------------------------------- wind --

/** Wind components smaller than this read as neither help nor hindrance (matches the planner). */
export const NOTICEABLE_MS = 0.75;
const CLIMB_GRADE = 0.03;

/** Shares of the distance, 0 to 1, ridden with a noticeable tailwind and headwind. */
export function windShares(sections: SectionGeometry[], tail: number[]): { tail: number; head: number } {
  const total = sections.reduce((d, s) => d + s.length_m, 0);
  if (!total) return { tail: 0, head: 0 };
  let withTail = 0;
  let withHead = 0;
  sections.forEach((s, i) => {
    if ((tail[i] ?? 0) >= NOTICEABLE_MS) withTail += s.length_m;
    else if ((tail[i] ?? 0) <= -NOTICEABLE_MS) withHead += s.length_m;
  });
  return { tail: round(withTail / total, 3), head: round(withHead / total, 3) };
}

const PART_WORDS: Record<string, string> = {
  "climb-out": "the climbs going out",
  "climb-back": "the climb back",
  "flat-out": "the flat going out",
  "flat-back": "the flat run home",
  "descent-out": "the descents going out",
  "descent-back": "the descents coming back",
};

/**
 * Where the wind does most of its work, as a phrase: "tailwind on the climb
 * back". Each section's gain is its own time against calm air, so a tailwind
 * on a slow climb counts for what it is worth in minutes, not in mph. Falls
 * back to the planner's whole-route phrase when no one part dominates.
 */
export function gainPhrase(
  sections: SectionGeometry[],
  tail: number[],
  rider: Rider = { ...DEFAULT_RIDER, power_w: 175 },
): string {
  const total = sections.reduce((d, s) => d + s.length_m, 0);
  if (!total || tail.length !== sections.length) return "";
  const parts = new Map<string, number>();
  let net = 0;
  sections.forEach((s, i) => {
    const calm = s.length_m / sectionSpeed(rider, 0, s.grade, RHO_REFERENCE);
    const windy = s.length_m / sectionSpeed(rider, -tail[i], s.grade, RHO_REFERENCE);
    const gain = calm - windy;
    net += gain;
    const terrain = s.grade >= CLIMB_GRADE ? "climb" : s.grade <= -CLIMB_GRADE ? "descent" : "flat";
    const half = s.start_m + s.length_m / 2 < total / 2 ? "out" : "back";
    const key = `${terrain}-${half}`;
    parts.set(key, (parts.get(key) ?? 0) + gain);
  });
  const whole = windPhrase(sections, tail);
  if (Math.abs(net) < 30) return whole;
  const sign = Math.sign(net);
  const [key, gain] = [...parts.entries()].sort((a, b) => sign * (b[1] - a[1]))[0];
  // One part has to carry most of the effect to be named on its own.
  if (sign * gain < 0.5 * Math.abs(net)) return whole;
  return `${sign > 0 ? "tailwind" : "headwind"} on ${PART_WORDS[key]}`;
}

/** "Saves 9 min with tailwind on the climb back", or the honest version of it. */
export function savingHeadline(savedS: number, phrase: string): string {
  const minutes = Math.round(Math.abs(savedS) / 60);
  if (minutes === 0) return phrase ? `Same as calm air, ${phrase}` : "Same as calm air";
  const verb = savedS > 0 ? "Saves" : "Costs";
  if (!phrase) return `${verb} ${minutes} min against calm air`;
  // "with tailwind on the climb back", but "Saves 3 min, mostly crosswind".
  const joiner = /^(mostly )?(tailwind|headwind)/.test(phrase) ? " with " : ", ";
  return `${verb} ${minutes} min${joiner}${phrase}`;
}

/** Below this, every route is "within a couple of minutes of calm". */
export const LIGHT_WIND_SPREAD_S = 150;

/**
 * Honest copy for a day the wind barely matters: when no ranked route is
 * more than a couple of minutes either side of calm air, say so rather than
 * presenting a 40-second difference as a recommendation.
 */
export function lightWinds(routes: Array<{ saved_s: number }>): {
  light: boolean;
  spread_s: number;
  message: string | null;
} {
  if (!routes.length) return { light: false, spread_s: 0, message: null };
  const spread = Math.max(...routes.map((r) => Math.abs(r.saved_s)));
  if (spread >= LIGHT_WIND_SPREAD_S) return { light: false, spread_s: spread, message: null };
  const minutes = Math.max(1, Math.ceil(spread / 60));
  return {
    light: true,
    spread_s: spread,
    message: `Light winds: every route within ${minutes} min of calm.`,
  };
}

// --------------------------------------------------------------- ranking --

/** Score first, then the larger saving, then the name, so the order is stable. */
export function compareRanked(
  a: { score: number; saved_s: number; name: string },
  b: { score: number; saved_s: number; name: string },
): number {
  return b.score - a.score || b.saved_s - a.saved_s || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------- cells --

const cellKey = (cell: [number, number]) => `${cell[0].toFixed(2)},${cell[1].toFixed(2)}`;

/** At most this many forecast cells for one ranking of every route. */
export const RANKING_CELL_CAP = 80;

/**
 * One set of forecast cells for many routes. Each route asks for the cells
 * the planner would (`candidates`); shared cells are asked for once. Past
 * `cap`, every route first keeps its most shared cell, so none is left
 * without a forecast of its own area, then the most shared of the rest fill
 * what room is left. Deterministic, so a cached ranking and a fresh one
 * agree.
 */
export function planCells(
  candidates: Array<Array<[number, number]>>,
  cap = RANKING_CELL_CAP,
): { cells: Array<[number, number]>; requested: number; dropped: number } {
  const uses = new Map<string, { cell: [number, number]; count: number }>();
  for (const list of candidates) {
    for (const cell of list) {
      const key = cellKey(cell);
      const entry = uses.get(key);
      if (entry) entry.count++;
      else uses.set(key, { cell, count: 1 });
    }
  }
  const ranked = [...uses.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  if (ranked.length <= cap) {
    return { cells: ranked.map(([, e]) => e.cell), requested: ranked.length, dropped: 0 };
  }
  const order = new Map(ranked.map(([key], index) => [key, index]));
  const chosen = new Set<string>();
  const anchors = candidates
    .filter((list) => list.length)
    .map((list) => list.map(cellKey).sort((a, b) => order.get(a)! - order.get(b)!)[0]);
  for (const key of [...new Set(anchors)].sort((a, b) => order.get(a)! - order.get(b)!)) {
    if (chosen.size >= cap) break;
    chosen.add(key);
  }
  for (const [key] of ranked) {
    if (chosen.size >= cap) break;
    chosen.add(key);
  }
  return {
    cells: ranked.filter(([key]) => chosen.has(key)).map(([, e]) => e.cell),
    requested: ranked.length,
    dropped: ranked.length - chosen.size,
  };
}

/**
 * The cells a route's summary track passes through, sampled as the planner
 * samples its sections. The saved-routes list carries the track, so the
 * forecast can be asked for while the detailed profiles are still loading;
 * the two agree on all but the odd cell at a boundary, and routeCells covers
 * those with the nearest that arrived.
 */
export function polylineCells(polyline: string | null, maxCells = MAX_CELLS): Array<[number, number]> {
  if (!polyline) return [];
  const points = decodePolyline(polyline);
  if (points.length < 2) return [];
  const sections: RouteSection[] = [];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const length = haversineM(points[i - 1], points[i]);
    sections.push({ start_m: travelled, length_m: length, bearing_deg: 0, grade: 0, at: points[i], visible: false });
    travelled += length;
  }
  return sampleCells(sections, maxCells).cells;
}

/** Farther than this from every forecast that arrived, a route is not ranked. */
export const MAX_CELL_DISTANCE_M = 30_000;

/**
 * Which of the available cells serve a route, and which serves each section.
 * The route's own cells come first, exactly as the planner would use them;
 * a section whose own cell is missing (capped, or failed) falls to the
 * nearest cell that did arrive. Null when nothing arrived near the route.
 */
export function routeCells(
  sections: RouteSection[],
  own: Array<[number, number]>,
  available: Map<string, number>,
  availableCells: Array<[number, number]>,
): { cells: number[]; assignment: number[]; missing: number } | null {
  if (!sections.length || !availableCells.length) return null;
  const present = own.filter((c) => available.has(cellKey(c)));
  const missing = own.length - present.length;
  let pool = present;
  if (missing) {
    // Covers the gaps with the nearest arrived cells around the route.
    const extra = new Map<string, [number, number]>();
    for (const s of sections) {
      const ownCell = cellCentre(s.at[0], s.at[1]);
      if (available.has(cellKey(ownCell))) continue;
      let best: [number, number] | null = null;
      let distance = Infinity;
      for (const cell of availableCells) {
        const d = haversineM(s.at, cell);
        if (d < distance) {
          distance = d;
          best = cell;
        }
      }
      if (best && distance <= MAX_CELL_DISTANCE_M) extra.set(cellKey(best), best);
    }
    pool = [...present, ...extra.values()];
  }
  if (!pool.length) return null;
  const local = assignCells(sections, pool);
  return { cells: pool.map((c) => available.get(cellKey(c))!), assignment: local, missing };
}

// --------------------------------------------------------------- sketch --

/**
 * A route's shape for a thumbnail: section midpoints projected into a box
 * 100 units across, with the tailwind each meets. Built only from sections
 * wholly outside the privacy radius; hidden ones are null, which breaks the
 * line. Relative units only, so no coordinate leaves the server.
 */
export type Sketch = {
  width: number;
  height: number;
  points: Array<[number, number] | null>;
  /** Tailwind component per point, m/s, one decimal. */
  tail: number[];
};

export function sketchOf(sections: RouteSection[], tail: number[]): Sketch | null {
  const shown = sections.filter((s) => s.visible);
  if (shown.length < 2) return null;
  const lats = shown.map((s) => s.at[0]);
  const lons = shown.map((s) => s.at[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const spanX = (maxLon - minLon) * k;
  const spanY = maxLat - minLat;
  const span = Math.max(spanX, spanY) || 1;
  const scale = 100 / span;
  return {
    width: round(Math.max(1, spanX * scale), 1),
    height: round(Math.max(1, spanY * scale), 1),
    points: sections.map((s) =>
      s.visible ? [round((s.at[1] - minLon) * k * scale, 1), round((maxLat - s.at[0]) * scale, 1)] : null,
    ),
    tail: sections.map((_, i) => round(tail[i] ?? 0, 1)),
  };
}

// ------------------------------------------------------------- response --

export type RankingSport = "ride" | "road" | "gravel" | "mtb" | "all";
export const RANKING_SPORTS: RankingSport[] = ["ride", "road", "gravel", "mtb", "all"];

/** Whether a route belongs to a sport choice. Runs and hikes only under "all". */
export function sportMatches(
  route: { type: "ride" | "run" | "other"; sub_type: string | null },
  sport: RankingSport,
): boolean {
  if (sport === "all") return true;
  if (route.type !== "ride") return false;
  if (sport === "road") return route.sub_type === "road" || route.sub_type === null;
  if (sport === "gravel") return route.sub_type === "mixed" || route.sub_type === "cx";
  if (sport === "mtb") return route.sub_type === "mtb" || route.sub_type === "trail";
  return true;
}

export type RankedRoute = {
  id: string;
  name: string;
  type: "ride" | "run" | "other";
  sub_type: string | null;
  starred: boolean;
  distance_mi: number;
  elevation_ft: number;
  /** Local wall-clock start, "YYYY-MM-DDTHH:mm", as the planner's ?start= takes it. */
  start: string;
  start_label: string;
  start_epoch: number;
  finish_epoch: number;
  sunset_epoch: number | null;
  before_sunset: boolean;
  /** The zone `start` is a wall-clock time in. */
  timezone: string;
  watts: number;
  time_s: number;
  calm_s: number;
  saved_s: number;
  saved_pct: number;
  tail_share: number;
  head_share: number;
  phrase: string;
  headline: string;
  temp_c: number;
  precip_pct: number;
  rain_max_pct: number;
  score: number;
  penalties: Penalties;
  /** Some of this route's forecast cells failed; its nearest neighbours stood in. */
  degraded: boolean;
  /** Only on the top three of a response. */
  sketch?: Sketch | null;
};

export type RouteRanking = {
  day: RankingDay;
  dates: string[];
  today: string;
  timezone: string;
  issued_at: string;
  generated_at: string;
  filters: { sport: RankingSport; min_miles: number | null; max_miles: number | null };
  routes: RankedRoute[];
  /** Routes that could not be ranked for this day, and why. */
  unranked: Array<{ id: string; name: string; reason: string }>;
  summary: { light: boolean; spread_s: number; message: string | null };
  forecast: {
    cells: number;
    requested_cells: number;
    capped_cells: number;
    failed_cells: number;
    degraded_routes: number;
    /** HTTP requests to Open-Meteo when this ranking was computed. */
    requests: number;
    /** Cells already in the 30-minute forecast cache then. */
    cached_cells: number;
  };
  /** Where the time went when it was computed. */
  timings_ms: { sections_and_forecast: number; top_up: number; model: number };
};
