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

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  utc_offset_seconds?: number;
  hourly: Record<string, (number | null)[]> & { time: string[] };
}

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

  // Open-Meteo rate-limits bursts, so back off rather than giving up on the
  // first 429. Worth retrying: a stale forecast is the thing users notice.
  let payload: OpenMeteoResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${OPEN_METEO}?${query}`, { cache: "no-store" });
    if (res.ok) {
      payload = await res.json();
      break;
    }
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Open-Meteo ${res.status} for cell ${id}`);
    }
    if (attempt === 2) throw new Error(`Open-Meteo ${res.status} for cell ${id}`);
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  if (!payload) throw new Error(`Open-Meteo gave no payload for cell ${id}`);
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

/** Concurrent requests to the forecast provider. Deliberately modest. */
const CONCURRENCY = 4;

export interface CellsResult {
  cells: Record<string, ForecastCell>;
  liveCount: number;
  savedCount: number;
  failed: string[];
}

/**
 * Fetch one forecast per grid cell, throttled, with per-cell fallback.
 *
 * A single unavailable cell must not cost every other cell its live forecast,
 * so each one falls back independently to whatever the saved bundle holds.
 */
export async function fetchCells(
  cells: Array<[number, number]>,
  fallback: Record<string, ForecastCell> = {},
): Promise<CellsResult> {
  const unique = new Map<string, [number, number]>();
  for (const c of cells) unique.set(cellId(c), c);
  const queue = [...unique.values()];

  const out: Record<string, ForecastCell> = {};
  const failed: string[] = [];
  let liveCount = 0;
  let savedCount = 0;

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const cell = queue[cursor++];
      const id = cellId(cell);
      try {
        out[id] = await fetchCell(cell);
        liveCount++;
      } catch {
        if (fallback[id]) {
          out[id] = fallback[id];
          savedCount++;
        } else {
          failed.push(id);
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
  return { cells: out, liveCount, savedCount, failed };
}
