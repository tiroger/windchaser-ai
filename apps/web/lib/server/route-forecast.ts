import "server-only";

import { airDensity } from "@/lib/physics";
import { calibrationTable } from "@/lib/server/calibration";
import { fetchCells } from "@/lib/server/weather";
import { loadPerformance, loadSavedRouteProfile, loadSavedRoutes, loadSettingsValue } from "@/lib/training/data";
import { hideRouteEnds } from "@/lib/training/polyline";
import {
  assignCells,
  bestWindows,
  buildSections,
  calmRideTime,
  daylightFlags,
  defaultPower,
  describeWindow,
  forecastDays,
  nowIndex,
  plannerRider,
  predictWeek,
  sampleCells,
  sectionTailwinds,
  sunTimes,
  windPhrase,
  type CellSeries,
  type RawProfile,
  type RouteForecast,
  type RouteSection,
} from "@/lib/training/route-forecast";
import type { ForecastCell } from "@/lib/types";

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds a zone is ahead of UTC at an instant. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(epochMs).map((p) => [p.type, p.value]));
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch seconds for a forecast's wall-clock time. The provider's single UTC
 * offset is only right until the next daylight-saving change, which a
 * seven-day forecast crosses twice a year.
 */
export function localToEpoch(local: string, timeZone: string, fallbackOffsetS: number): number {
  const wall = Date.parse(`${local}:00Z`);
  try {
    const first = wall - zoneOffsetMs(wall, timeZone);
    return Math.round((wall - zoneOffsetMs(first, timeZone)) / 1000);
  } catch {
    return Math.round(wall / 1000) - fallbackOffsetS;
  }
}

export const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * A route's sections exactly as the planner publishes them. Rounded once,
 * here: the browser recomputes from these same numbers when the power or the
 * hour changes, and the route ranking must get the same answer as both.
 */
export function plannerSections(raw: RawProfile): RouteSection[] {
  const visible = hideRouteEnds(raw.latlng).map(Boolean);
  return buildSections(raw, visible).map((s) => ({
    ...s,
    start_m: Math.round(s.start_m),
    length_m: round(s.length_m, 1),
    bearing_deg: Math.round(s.bearing_deg),
    grade: round(s.grade, 4),
  }));
}

export type CellWeather = CellSeries & { temp: number[]; precip: number[]; gust: number[] };

/** A cell's forecast on the reference cell's hours, reduced to what the planner needs. */
export function series(cell: ForecastCell, hours: string[]): CellWeather {
  const index = new Map(cell.time.map((t, i) => [t, i]));
  const at = (values: (number | null)[], i: number | undefined, fallback: number) =>
    i === undefined ? fallback : (values[i] ?? fallback);
  const out = { speed: [] as number[], from: [] as number[], rho: [] as number[], temp: [] as number[], precip: [] as number[], gust: [] as number[] };
  for (const hour of hours) {
    const i = index.get(hour);
    const temp = at(cell.temperature_c, i, 15);
    out.speed.push(round(at(cell.wind_speed_ms, i, 0), 1));
    out.from.push(Math.round(at(cell.wind_from_deg, i, 0)));
    out.rho.push(round(airDensity(temp, at(cell.pressure_hpa, i, 1013), at(cell.humidity_pct, i, 60)), 3));
    out.temp.push(temp);
    out.precip.push(at(cell.precip_prob, i, 0));
    out.gust.push(at(cell.gust_ms, i, 0));
  }
  return out;
}

const mean = (rows: number[][], i: number) => rows.reduce((sum, row) => sum + row[i], 0) / rows.length;

/**
 * Everything the ride planner shows for one saved route: a predicted moving
 * time for every hour of the coming week at the given power, the windows
 * worth riding, and the wind each section meets in the chosen one.
 */
export async function routeForecast(
  id: string,
  options: { watts?: number | null; hour?: number | null; nowMs?: number } = {},
): Promise<RouteForecast> {
  const [routes, raw, calibration, settings] = await Promise.all([
    loadSavedRoutes(),
    loadSavedRouteProfile(id),
    calibrationTable(),
    loadSettingsValue(),
  ]);
  const route = routes.find((r) => r.id === id);
  if (!route) throw new PlannerError("Unknown route", 404);
  if (route.type === "run") throw new PlannerError("The planner models rides only", 422);
  if (!raw?.distance?.length || !raw.latlng?.length) {
    throw new PlannerError("Route profile not synced yet", 404);
  }

  const sections = plannerSections(raw);
  if (!sections.length) throw new PlannerError("Route profile is too short to plan", 422);

  const sampled = sampleCells(sections);
  const fetched = await fetchCells(sampled.cells);
  const available = sampled.cells.flatMap((cell) => {
    const forecast = fetched.cells[`${cell[0].toFixed(2)},${cell[1].toFixed(2)}`];
    return forecast ? [{ cell, forecast }] : [];
  });
  if (!available.length) throw new PlannerError("Forecast unavailable", 503);
  // A cell that failed is covered by its nearest neighbour that did not.
  const assignment = assignCells(sections, available.map((a) => a.cell));

  const reference = available[0].forecast;
  const hours = reference.time;
  const timezone = reference.timezone || "UTC";
  const epochs = hours.map((h) => localToEpoch(h, timezone, reference.utc_offset_seconds));
  const full = available.map((a) => series(a.forecast, hours));
  const cells: CellSeries[] = full.map(({ speed, from, rho }) => ({ speed, from, rho }));

  const model = calibration.rider;
  const { rider: base, massSource } = plannerRider(model, settings.athlete.weightKg);
  let ftp = settings.athlete.ftpOverride;
  if (!model && !ftp) {
    ftp = (await loadPerformance().catch(() => null))?.ftp?.ftp ?? null;
  }
  const fallback = defaultPower(sections, base, model, ftp);
  const watts = options.watts ?? fallback.watts;
  const rider = { ...base, power_w: watts };

  const { times, calm } = predictWeek(sections, assignment, cells, rider, hours.length);

  // Daylight at the route's middle; the coordinates stay here.
  const centre = sections[Math.floor(sections.length / 2)].at;
  const days = forecastDays(hours);
  const sun = new Map(days.map((date) => [date, sunTimes(date, centre[0], centre[1])]));
  const daylight = daylightFlags(hours, epochs, times, sun);

  const weather = {
    temperature_c: hours.map((_, i) => round(mean(full.map((f) => f.temp), i), 1)),
    precip_prob: hours.map((_, i) => Math.round(mean(full.map((f) => f.precip), i))),
    gust_ms: hours.map((_, i) => round(mean(full.map((f) => f.gust), i), 1)),
  };

  const from = nowIndex(epochs, (options.nowMs ?? Date.now()) / 1000);
  const dayOf = hours.map((h) => h.slice(0, 10));
  const best = bestWindows(times, calm, { from, days: dayOf, daylight, precip: weather.precip_prob }).map(
    (window) => {
      const tail = sectionTailwinds(sections, assignment, cells, window.hour, rider) ?? [];
      return { ...window, summary: describeWindow(window, hours[window.hour], windPhrase(sections, tail)) };
    },
  );

  const asked = options.hour;
  const selectedHour =
    asked !== null && asked !== undefined && asked >= 0 && asked < hours.length ? asked : (best[0]?.hour ?? null);
  const selectedTail =
    selectedHour === null ? null : sectionTailwinds(sections, assignment, cells, selectedHour, rider);

  return {
    id,
    name: route.name,
    timezone,
    issued_at: reference.issued_at,
    hours,
    epochs,
    rider: {
      mass_kg: round(base.mass_kg, 1),
      mass_source: massSource,
      cda: base.cda,
      crr: base.crr,
      drivetrain_efficiency: base.drivetrain_efficiency,
    },
    power: { watts, requested: options.watts != null, default: fallback },
    distance_m: Math.round(sections.reduce((d, s) => d + s.length_m, 0)),
    climbing_m: Math.round(sections.reduce((c, s) => c + Math.max(0, s.grade * s.length_m), 0)),
    calm_s: Math.round(calmRideTime(sections, rider)),
    sections: sections.map((s, i) => ({
      start_m: s.start_m,
      length_m: s.length_m,
      bearing_deg: s.bearing_deg,
      grade: s.grade,
      cell: assignment[i],
      mid: s.visible ? [round(s.at[0], 4), round(s.at[1], 4)] : null,
    })),
    cells,
    weather,
    days: days.map((date) => {
      const s = sun.get(date)!;
      return "polar" in s
        ? { date, sunrise: null, sunset: null }
        : { date, sunrise: s.sunrise, sunset: s.sunset };
    }),
    daylight,
    times,
    calm,
    best,
    selected:
      selectedHour === null || !selectedTail
        ? null
        : { hour: selectedHour, tail: selectedTail.map((t) => round(t, 1)) },
  };
}
