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
  const forecast = forecastFrom(id, payload);
  cache.set(id, { cell: forecast, fetchedAt: Date.now() });
  return forecast;
}

function forecastFrom(id: string, payload: OpenMeteoResponse): ForecastCell {
  const h = payload.hourly;
  return {
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

// ------------------------------------------------------------- batched --

/** Cells per request when asking for many at once. Open-Meteo takes a list. */
export const BATCH_CELLS = 25;
/** Batched requests in flight at once. */
const BATCH_CONCURRENCY = 4;

export interface BatchedCellsResult {
  cells: Record<string, ForecastCell>;
  failed: string[];
  /** Cells served from the 30-minute cache without a request. */
  cachedCount: number;
  /** HTTP requests made to Open-Meteo. */
  requests: number;
}

/**
 * Many cells for the price of a few requests: the same forecast and the same
 * cache as fetchCell, but cells not cached are asked for up to BATCH_CELLS at
 * a time, as Open-Meteo's comma-separated locations. A batch that fails after
 * its retries marks only its own cells failed; the rest still arrive.
 */
export async function fetchCellsBatched(
  cells: Array<[number, number]>,
  batchSize = BATCH_CELLS,
): Promise<BatchedCellsResult> {
  const unique = new Map<string, [number, number]>();
  for (const c of cells) unique.set(cellId(c), c);

  const out: Record<string, ForecastCell> = {};
  const missing: Array<[number, number]> = [];
  let cachedCount = 0;
  for (const [id, cell] of unique) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
      out[id] = hit.cell;
      cachedCount++;
    } else {
      missing.push(cell);
    }
  }

  // Evenly sized, so 80 cells go as four requests of 20 rather than 25, 25, 25 and 5.
  const batches: Array<Array<[number, number]>> = [];
  const size = Math.ceil(missing.length / Math.max(1, Math.ceil(missing.length / batchSize)));
  for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));
  const failed: string[] = [];
  let requests = 0;

  // A rejected request (a 4xx other than 429) may be one bad location
  // spoiling the rest, so it is split in half and retried; a rate limit or an
  // outage is not, since more requests would only make it worse.
  const fetchBatch = async (batch: Array<[number, number]>): Promise<void> => {
    const query = new URLSearchParams({
      latitude: batch.map((c) => c[0].toFixed(4)).join(","),
      longitude: batch.map((c) => c[1].toFixed(4)).join(","),
      hourly: HOURLY,
      wind_speed_unit: "ms",
      forecast_days: "7",
      timezone: "auto",
    });
    let payloads: OpenMeteoResponse[] | null = null;
    let rejected = false;
    for (let attempt = 0; attempt < 3 && !payloads && !rejected; attempt++) {
      requests++;
      try {
        const res = await fetch(`${OPEN_METEO}?${query}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as OpenMeteoResponse | OpenMeteoResponse[];
          // One location comes back as an object, several as an array in order.
          payloads = Array.isArray(body) ? body : [body];
          break;
        }
        rejected = res.status !== 429 && res.status < 500;
      } catch {
        // Network failure: retried like a 5xx.
      }
      if (!payloads && !rejected && attempt < 2) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    if (!payloads && rejected && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, half));
      await fetchBatch(batch.slice(half));
      return;
    }
    batch.forEach((cell, index) => {
      const id = cellId(cell);
      const payload = payloads?.[index];
      if (!payload?.hourly?.time) {
        failed.push(id);
        return;
      }
      const forecast = forecastFrom(id, payload);
      cache.set(id, { cell: forecast, fetchedAt: Date.now() });
      out[id] = forecast;
    });
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) await fetchBatch(batches[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker));
  return { cells: out, failed, cachedCount, requests };
}
