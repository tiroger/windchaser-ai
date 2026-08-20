import "server-only";

import type { ForecastCell } from "../types";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

/** Forecast grid cell size in degrees, matching the fixture pipeline. */
export const CELL_DEG = 0.1;

export function cellOf(lat: number, lon: number): [number, number] {
  return [
    Math.round(lat / CELL_DEG) * CELL_DEG,
    Math.round(lon / CELL_DEG) * CELL_DEG,
  ];
}

export function cellId(cell: [number, number]): string {
  return `${cell[0].toFixed(2)},${cell[1].toFixed(2)}`;
}

interface CacheEntry {
  cell: ForecastCell;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 30 * 60 * 1000;

const HOURLY = [
  "temperature_2m",
  "relative_humidity_2m",
  "surface_pressure",
  "precipitation",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
].join(",");

/**
 * One request per grid cell, shared by every segment in it. This is the caching
 * policy from docs/architecture/COST_STRATEGY.md, and the reason forecasts are
 * keyed by cell rather than by segment.
 */
export async function fetchCell(cell: [number, number]): Promise<ForecastCell> {
  const id = cellId(cell);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.cell;

  const query = new URLSearchParams({
    latitude: cell[0].toFixed(4),
    longitude: cell[1].toFixed(4),
    hourly: HOURLY,
    wind_speed_unit: "ms",
    forecast_days: "7",
    timezone: "auto",
  });

  const res = await fetch(`${OPEN_METEO}?${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for cell ${id}`);
  const payload = await res.json();
  const h = payload.hourly;

  const forecast: ForecastCell = {
    cell_id: id,
    latitude: payload.latitude,
    longitude: payload.longitude,
    timezone: payload.timezone,
    utc_offset_seconds: payload.utc_offset_seconds ?? 0,
    issued_at: new Date().toISOString(),
    time: h.time,
    temperature_c: h.temperature_2m,
    humidity_pct: h.relative_humidity_2m,
    pressure_hpa: h.surface_pressure,
    precip_mm: h.precipitation,
    precip_prob: h.precipitation_probability,
    wind_speed_ms: h.wind_speed_10m,
    wind_from_deg: h.wind_direction_10m,
    gust_ms: h.wind_gusts_10m,
  };

  cache.set(id, { cell: forecast, fetchedAt: Date.now() });
  return forecast;
}

export async function fetchCells(
  cells: Array<[number, number]>,
): Promise<Record<string, ForecastCell>> {
  const unique = new Map<string, [number, number]>();
  for (const c of cells) unique.set(cellId(c), c);

  const entries = await Promise.all(
    [...unique.values()].map(async (c) => {
      const forecast = await fetchCell(c);
      return [forecast.cell_id, forecast] as const;
    }),
  );
  return Object.fromEntries(entries);
}
