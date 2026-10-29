import "server-only";

import { calibrationTable } from "@/lib/server/calibration";
import { localToEpoch, plannerSections, round, series, type CellWeather } from "@/lib/server/route-forecast";
import { cellId, fetchCellsBatched } from "@/lib/server/weather";
import {
  loadPerformance,
  loadSavedRouteProfile,
  loadSavedRoutesStored,
  loadSettingsValue,
} from "@/lib/training/data";
import type { SavedRoute } from "@/lib/training/metrics/route-profile";
import {
  defaultPower,
  nowIndex,
  plannerRider,
  predictRide,
  sampleCells,
  sunTimes,
  windowLabel,
  type RouteSection,
} from "@/lib/training/route-forecast";
import {
  RANKING_CELL_CAP,
  bestDayWindow,
  candidateHours,
  compareRanked,
  gainPhrase,
  lightWinds,
  planCells,
  rankingDates,
  routeCells,
  savingHeadline,
  sketchOf,
  sportMatches,
  windShares,
  type RankedRoute,
  type RankingDay,
  type RankingSport,
  type RouteRanking,
  type Sketch,
} from "@/lib/training/route-ranking";

/**
 * Route of the day on the server: every saved route with a profile, ranked by
 * what the forecast does to it on the chosen day.
 *
 * Three caches keep it cheap. Sections are built from the 141 profiles once
 * per version of the saved-routes list (its ETag changes whenever a route or
 * its profile does). The forecast is one set of 0.1° cells shared by every
 * route, capped, and fetched in batches through lib/server/weather.ts, whose
 * 30-minute cell cache the planner shares. And each day's whole ranking is
 * kept for 30 minutes, so the overview card and the routes list cost a
 * lookup after the first.
 */

/** Profiles read from S3 at once while preparing sections. */
const PROFILE_CONCURRENCY = 16;
/** How long a computed ranking is served without recomputing. */
export const RANKING_TTL_MS = 30 * 60 * 1000;
/** A local snapshot has no ETag, so its sections are rebuilt this often instead. */
const LOCAL_SECTIONS_TTL_MS = 10 * 60 * 1000;
/** Sketches are attached to this many routes at the top of a response. */
const SKETCHES = 3;

type Prepared = {
  route: SavedRoute;
  sections: RouteSection[];
  /** The forecast cells the planner would ask for on this route. */
  own: Array<[number, number]>;
  centre: [number, number];
};

type PreparedSet = { routes: Prepared[]; missing: Array<{ id: string; name: string; reason: string }> };

let preparedCache: { etag: string; at: number; value: Promise<PreparedSet> } | null = null;

/** Exposed for tests: how many times sections were built from profiles. */
export const stats = { prepares: 0, rankings: 0 };

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

async function prepare(routes: SavedRoute[]): Promise<PreparedSet> {
  stats.prepares++;
  const missing: PreparedSet["missing"] = [];
  const built = await mapLimit(routes, PROFILE_CONCURRENCY, async (route) => {
    if (!route.profile_updated_at) {
      missing.push({ id: route.id, name: route.name, reason: "Profile not synced yet" });
      return null;
    }
    const raw = await loadSavedRouteProfile(route.id).catch(() => null);
    if (!raw?.distance?.length || !raw.latlng?.length) {
      missing.push({ id: route.id, name: route.name, reason: "Profile not synced yet" });
      return null;
    }
    const sections = plannerSections(raw);
    if (!sections.length) {
      missing.push({ id: route.id, name: route.name, reason: "Too short to plan" });
      return null;
    }
    return {
      route,
      sections,
      own: sampleCells(sections).cells,
      centre: sections[Math.floor(sections.length / 2)].at,
    } satisfies Prepared;
  });
  return { routes: built.filter((p): p is Prepared => p !== null), missing };
}

/** Sections for every route, rebuilt only when the saved-routes list changes. */
async function preparedRoutes(etag: string, routes: SavedRoute[], nowMs: number): Promise<PreparedSet> {
  const fresh =
    preparedCache &&
    preparedCache.etag === etag &&
    (etag !== "local" || nowMs - preparedCache.at < LOCAL_SECTIONS_TTL_MS);
  if (!fresh) {
    const value = prepare(routes);
    preparedCache = { etag, at: nowMs, value };
    // A failed build is not kept, so the next request tries again.
    value.catch(() => {
      if (preparedCache?.value === value) preparedCache = null;
    });
  }
  return preparedCache!.value;
}

/** The ranking of every route for one day, before any filter. */
type FullRanking = Omit<RouteRanking, "routes" | "summary" | "filters"> & {
  routes: Array<RankedRoute & { sketchData: Sketch | null }>;
};

const rankingCache = new Map<string, { at: number; value: Promise<FullRanking> }>();

const localDateFormats = new Map<string, Intl.DateTimeFormat>();
function localDate(epochMs: number, timeZone: string): string {
  let format = localDateFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    localDateFormats.set(timeZone, format);
  }
  return format.format(epochMs);
}

/** A forecast grid on one set of local hours: every cell in a time zone shares it. */
type Clock = { hours: string[]; epochs: number[]; timezone: string; today: string; from: number };

async function computeRanking(day: RankingDay, nowMs: number): Promise<FullRanking> {
  stats.rankings++;
  const t0 = performance.now();
  const [stored, calibration, settings] = await Promise.all([
    loadSavedRoutesStored(),
    calibrationTable(),
    loadSettingsValue(),
  ]);
  const { routes: prepared, missing } = await preparedRoutes(stored.etag, stored.value, nowMs);
  const t1 = performance.now();

  // One forecast for every route: shared cells once, capped.
  const plan = planCells(prepared.map((p) => p.own), RANKING_CELL_CAP);
  const fetched = await fetchCellsBatched(plan.cells);
  const failed = new Set(fetched.failed);
  const arrived = plan.cells.filter((c) => fetched.cells[cellId(c)]);
  if (!arrived.length) throw new Error("Forecast unavailable");
  const t2 = performance.now();

  // Each cell's forecast comes in its own zone's wall-clock hours. Routes far
  // from home (a trip to Nevada, a ride in New York) keep their own clock.
  const clocks = new Map<string, Clock>();
  const clockOf = (forecast: (typeof fetched.cells)[string]): Clock => {
    const timezone = forecast.timezone || "UTC";
    const key = `${timezone}|${forecast.time[0]}|${forecast.time.length}`;
    let clock = clocks.get(key);
    if (!clock) {
      const epochs = forecast.time.map((h) => localToEpoch(h, timezone, forecast.utc_offset_seconds));
      clock = {
        hours: forecast.time,
        epochs,
        timezone,
        today: localDate(nowMs, timezone),
        from: nowIndex(epochs, nowMs / 1000),
      };
      clocks.set(key, clock);
    }
    return clock;
  };
  const forecasts = arrived.map((c) => fetched.cells[cellId(c)]);
  const cellClocks = forecasts.map(clockOf);
  const weatherByCell: CellWeather[] = forecasts.map((f, i) => series(f, cellClocks[i].hours));
  const index = new Map(arrived.map((c, i) => [cellId(c), i]));
  // The most shared cell is home; its zone names the day for the response.
  const home = cellClocks[0];

  const model = calibration.rider;
  const { rider: base } = plannerRider(model, settings.athlete.weightKg);
  let ftp = settings.athlete.ftpOverride;
  if (!model && !ftp) ftp = (await loadPerformance().catch(() => null))?.ftp?.ftp ?? null;

  const ranked: FullRanking["routes"] = [];
  const unranked = [...missing];
  for (const p of prepared) {
    const local = routeCells(p.sections, p.own, index, arrived);
    if (!local) {
      unranked.push({ id: p.route.id, name: p.route.name, reason: "No forecast near this route" });
      continue;
    }
    // The route's first cell sets its clock; a neighbour from another zone
    // (only ever a stand-in for a failed cell) is re-read onto it.
    const clock = cellClocks[local.cells[0]];
    const { hours, epochs } = clock;
    const cells = local.cells.map((i) =>
      cellClocks[i] === clock ? weatherByCell[i] : series(forecasts[i], hours),
    );
    const winds = cells.map(({ speed, from: dir, rho }) => ({ speed, from: dir, rho }));
    const mean = (pick: (c: CellWeather) => number[], i: number) =>
      cells.reduce((sum, c) => sum + pick(c)[i], 0) / cells.length;
    const weather = {
      temperature_c: hours.map((_, i) => round(mean((c) => c.temp, i), 1)),
      precip_prob: hours.map((_, i) => Math.round(mean((c) => c.precip, i))),
    };
    const power = defaultPower(p.sections, base, model, ftp);
    const rider = { ...base, power_w: power.watts };
    const dates = rankingDates(day, clock.today);
    const sun = new Map(dates.map((date) => [date, sunTimes(date, p.centre[0], p.centre[1])]));
    const candidates = candidateHours(hours, epochs, dates, clock.from, (date) => sun.get(date));
    const window = bestDayWindow(
      { sections: p.sections, assignment: local.assignment, cells: winds, weather, rider },
      candidates,
      epochs,
      (hour) => sun.get(hours[hour].slice(0, 10)),
    );
    if (!window) {
      unranked.push({
        id: p.route.id,
        name: p.route.name,
        reason: candidates.length ? "Runs past the end of the forecast" : "No daylight left to start in",
      });
      continue;
    }
    const tail = predictRide(p.sections, local.assignment, winds, window.hour, rider, true)?.tail ?? [];
    const shares = windShares(p.sections, tail);
    const phrase = gainPhrase(p.sections, tail, rider);
    const daySun = sun.get(hours[window.hour].slice(0, 10));
    const sunset = daySun && !("polar" in daySun) ? daySun.sunset : null;
    ranked.push({
      id: p.route.id,
      name: p.route.name,
      type: p.route.type,
      sub_type: p.route.sub_type,
      starred: p.route.starred,
      distance_mi: round(p.route.distance, 1),
      elevation_ft: Math.round(p.route.elevation_gain),
      start: hours[window.hour],
      start_label: windowLabel(hours[window.hour], clock.today),
      start_epoch: epochs[window.hour],
      finish_epoch: epochs[window.hour] + window.time_s,
      sunset_epoch: sunset,
      before_sunset: window.dark_share === 0,
      timezone: clock.timezone,
      watts: power.watts,
      time_s: window.time_s,
      calm_s: window.calm_s,
      saved_s: window.saved_s,
      saved_pct: window.saved_pct,
      tail_share: shares.tail,
      head_share: shares.head,
      phrase,
      headline: savingHeadline(window.saved_s, phrase),
      temp_c: weather.temperature_c[window.hour],
      precip_pct: weather.precip_prob[window.hour],
      rain_max_pct: window.rain_max_pct,
      score: window.score,
      penalties: window.penalties,
      degraded: p.own.some((c) => failed.has(cellId(c))),
      sketchData: sketchOf(p.sections, tail),
    });
  }
  ranked.sort(compareRanked);

  const t3 = performance.now();

  return {
    day,
    dates: rankingDates(day, home.today),
    today: home.today,
    timezone: home.timezone,
    issued_at: forecasts[0].issued_at,
    generated_at: new Date(nowMs).toISOString(),
    unranked,
    forecast: {
      cells: arrived.length,
      requested_cells: plan.requested,
      capped_cells: plan.dropped,
      failed_cells: fetched.failed.length,
      degraded_routes: ranked.filter((r) => r.degraded).length,
      requests: fetched.requests,
      cached_cells: fetched.cachedCount,
    },
    timings_ms: {
      sections: Math.round(t1 - t0),
      forecast: Math.round(t2 - t1),
      model: Math.round(t3 - t2),
    },
    routes: ranked,
  };
}

/**
 * The whole ranking for a day, cached for 30 minutes. The key carries the
 * clock hour too, so "today" never offers a start that has already passed by
 * more than the hour under way.
 */
function fullRanking(day: RankingDay, nowMs: number): { value: Promise<FullRanking>; cached: boolean } {
  const key = `${day}|${Math.floor(nowMs / 3_600_000)}`;
  for (const [k, entry] of rankingCache) {
    if (nowMs - entry.at >= RANKING_TTL_MS) rankingCache.delete(k);
  }
  const hit = rankingCache.get(key);
  if (hit) return { value: hit.value, cached: true };
  const value = computeRanking(day, nowMs);
  rankingCache.set(key, { at: nowMs, value });
  value.catch(() => {
    if (rankingCache.get(key)?.value === value) rankingCache.delete(key);
  });
  return { value, cached: false };
}

export type RankingOptions = {
  day: RankingDay;
  sport?: RankingSport;
  minMiles?: number | null;
  maxMiles?: number | null;
  nowMs?: number;
};

/** The ranking for a day, filtered, with sketches on the top three. */
export async function routeRanking(options: RankingOptions): Promise<{ ranking: RouteRanking; cached: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const sport = options.sport ?? "ride";
  const min = options.minMiles ?? null;
  const max = options.maxMiles ?? null;
  const { value, cached } = fullRanking(options.day, nowMs);
  const full = await value;
  const routes = full.routes
    .filter(
      (r) =>
        sportMatches(r, sport) && (min === null || r.distance_mi >= min) && (max === null || r.distance_mi <= max),
    )
    .map(({ sketchData, ...r }, i) => (i < SKETCHES ? { ...r, sketch: sketchData } : r));
  return {
    cached,
    ranking: {
      ...full,
      filters: { sport, min_miles: min, max_miles: max },
      routes,
      summary: lightWinds(routes),
    },
  };
}

/** For tests: forget every cached ranking and prepared section. */
export function resetRankingCaches(): void {
  rankingCache.clear();
  preparedCache = null;
  stats.prepares = 0;
  stats.rankings = 0;
}
