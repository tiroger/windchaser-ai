import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

import type { SavedRoute } from "@/lib/training/metrics/route-profile";

/**
 * The ranking end to end against stand-ins for S3 and Open-Meteo: how many
 * forecast requests a cold ranking makes, what is cached, and what happens
 * when part of the forecast does not arrive.
 */

const MILE = 1609.344;

/** A straight out-and-back of `km` heading north from (lat, lon), as the sync stores a profile. */
function profile(id: string, km: number, lat: number, lon: number) {
  const distance: number[] = [];
  const altitude: number[] = [];
  const latlng: Array<[number, number]> = [];
  const n = 200;
  for (let i = 0; i < n; i++) {
    const out = i < n / 2 ? i : n - 1 - i;
    const m = (km * 1000 * out) / (n - 2);
    distance.push((km * 1000 * i) / (n - 1) / MILE);
    altitude.push(0);
    latlng.push([lat + m / 111_195, lon]);
  }
  return { id, updated_at: "2026-10-01", distance, altitude, latlng };
}

function route(id: string, name: string, miles: number, type: SavedRoute["type"] = "ride"): SavedRoute {
  return {
    id,
    name,
    description: "",
    type,
    sub_type: "road",
    distance: miles,
    elevation_gain: 0,
    estimated_moving_time: null,
    starred: false,
    created_at: "",
    updated_at: "",
    profile_updated_at: "2026-10-01",
    polyline: null,
  };
}

// Three Bay Area routes sharing cells, and one ride far away.
const PROFILES: Record<string, ReturnType<typeof profile>> = {
  "1": profile("1", 40, 37.8, -122.27),
  "2": profile("2", 30, 37.8, -122.27),
  "3": profile("3", 20, 37.81, -122.25),
  "4": profile("4", 30, 36.1, -115.1),
  "5": profile("5", 10, 37.8, -122.27),
};
let ROUTES: SavedRoute[] = [];
let etag = "v1";
const profileReads = { count: 0 };

vi.mock("@/lib/training/data", () => ({
  loadSavedRoutesStored: async () => ({ etag, value: ROUTES }),
  loadSavedRouteProfile: async (id: string) => {
    profileReads.count++;
    return PROFILES[id] ?? null;
  },
  loadSettingsValue: async () => ({ goals: {}, athlete: { weightKg: 70, restingHr: null, maxHr: null, ftpOverride: 250 } }),
  loadPerformance: async () => null,
}));

vi.mock("@/lib/server/calibration", () => ({ calibrationTable: async () => ({ rider: null }) }));

/** Open-Meteo stand-in: a steady southerly everywhere, dry and mild, in Pacific time. */
function hourly(lat: number) {
  const time: string[] = [];
  const start = Date.parse("2026-10-28T00:00:00Z");
  for (let h = 0; h < 168; h++) time.push(new Date(start + h * 3_600_000).toISOString().slice(0, 16));
  const n = time.length;
  return {
    latitude: lat,
    longitude: 0,
    timezone: "America/Los_Angeles",
    utc_offset_seconds: -25200,
    hourly: {
      time,
      temperature_2m: Array(n).fill(16),
      relative_humidity_2m: Array(n).fill(60),
      surface_pressure: Array(n).fill(1013),
      precipitation: Array(n).fill(0),
      precipitation_probability: Array(n).fill(lat > 37 ? 0 : 0),
      wind_speed_10m: Array(n).fill(5),
      wind_direction_10m: Array(n).fill(180),
      wind_gusts_10m: Array(n).fill(8),
    },
  };
}

const calls: string[][] = [];
let failCell: string | null = null;

function fakeFetch(input: string | URL) {
  const url = new URL(String(input));
  const lats = url.searchParams.get("latitude")!.split(",");
  const lons = url.searchParams.get("longitude")!.split(",");
  const keys = lats.map((lat, i) => `${Number(lat).toFixed(2)},${Number(lons[i]).toFixed(2)}`);
  calls.push(keys);
  if (failCell && keys.includes(failCell)) {
    return Promise.resolve(new Response("bad location", { status: 400 }));
  }
  const body = lats.length === 1 ? hourly(Number(lats[0])) : lats.map((lat) => hourly(Number(lat)));
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

// 2 PM on Wednesday 28 October 2026, Pacific daylight time.
const NOW = Date.parse("2026-10-28T21:00:00Z");

async function load() {
  vi.resetModules();
  return import("./route-ranking");
}

beforeEach(() => {
  ROUTES = ["1", "2", "3", "4"].map((id, i) => route(id, `Route ${id}`, [25, 19, 12, 19][i]));
  ROUTES.push(route("5", "Run 5", 6, "run"));
  etag = "v1";
  profileReads.count = 0;
  calls.length = 0;
  failCell = null;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("route ranking", () => {
  test("ranks every ride with a profile, in a few batched forecast requests", async () => {
    const { routeRanking, stats } = await load();
    const { ranking, cached } = await routeRanking({ day: "today", nowMs: NOW });
    assert.equal(cached, false);
    assert.deepEqual(ranking.routes.map((r) => r.id).sort(), ["1", "2", "3", "4"], "the run is left out");
    // The Bay Area routes share cells: every distinct cell asked for once.
    const asked = calls.flat();
    assert.equal(new Set(asked).size, asked.length, "no cell asked for twice");
    assert.equal(ranking.forecast.cells, asked.length);
    assert.equal(ranking.forecast.requests, calls.length);
    assert.ok(calls.length <= 2, `${calls.length} requests`);
    assert.equal(stats.prepares, 1);
    // Ordered by score, sketches only on the top three.
    for (let i = 1; i < ranking.routes.length; i++) {
      assert.ok(ranking.routes[i - 1].score >= ranking.routes[i].score);
    }
    assert.ok(ranking.routes.slice(0, 3).every((r) => "sketch" in r));
    assert.ok(!("sketch" in ranking.routes[3]));
    // Today's remaining daylight: starts from 2 PM, before sunset.
    for (const r of ranking.routes) {
      assert.ok(r.start >= "2026-10-28T14:00" && r.start < "2026-10-28T18:30", r.start);
    }
    assert.equal(ranking.today, "2026-10-28");
    assert.ok(!JSON.stringify(ranking).match(/37\\.8\\d*,/), "no coordinates in the response");
  });

  test("the run is ranked only when asked for", async () => {
    const { routeRanking } = await load();
    const { ranking } = await routeRanking({ day: "tomorrow", sport: "all", nowMs: NOW });
    assert.ok(ranking.routes.some((r) => r.id === "5"));
  });

  test("filters by distance after the cached ranking", async () => {
    const { routeRanking, stats } = await load();
    const short = await routeRanking({ day: "tomorrow", maxMiles: 15, nowMs: NOW });
    assert.deepEqual(short.ranking.routes.map((r) => r.id), ["3"]);
    const long = await routeRanking({ day: "tomorrow", minMiles: 20, nowMs: NOW });
    assert.deepEqual(long.ranking.routes.map((r) => r.id), ["1"]);
    assert.equal(long.cached, true);
    assert.equal(stats.rankings, 1);
  });

  test("is cached for 30 minutes, and sections until the routes change", async () => {
    const { routeRanking, stats, RANKING_TTL_MS } = await load();
    await routeRanking({ day: "tomorrow", nowMs: NOW });
    const requests = calls.length;
    const reads = profileReads.count;

    const again = await routeRanking({ day: "tomorrow", nowMs: NOW + 60_000 });
    assert.equal(again.cached, true);
    assert.equal(calls.length, requests, "no forecast request");
    assert.equal(stats.rankings, 1);

    // Another day reuses the sections and the cached forecast cells.
    const weekend = await routeRanking({ day: "weekend", nowMs: NOW + 60_000 });
    assert.equal(weekend.cached, false);
    assert.equal(calls.length, requests, "forecast cells come from the 30-minute cache");
    assert.equal(weekend.ranking.forecast.requests, 0);
    assert.equal(profileReads.count, reads, "sections are not rebuilt");
    assert.equal(stats.prepares, 1);

    // Past the TTL the ranking is computed again; the sections still are not.
    const later = await routeRanking({ day: "tomorrow", nowMs: NOW + RANKING_TTL_MS + 1 });
    assert.equal(later.cached, false);
    assert.equal(stats.prepares, 1);

    // A new saved-routes version rebuilds them.
    etag = "v2";
    await routeRanking({ day: "tomorrow", nowMs: NOW + 2 * RANKING_TTL_MS + 2 });
    assert.equal(stats.prepares, 2);
  });

  test("concurrent requests share one computation", async () => {
    const { routeRanking, stats } = await load();
    const [a, b] = await Promise.all([
      routeRanking({ day: "tomorrow", nowMs: NOW }),
      routeRanking({ day: "tomorrow", nowMs: NOW }),
    ]);
    assert.equal(stats.rankings, 1);
    assert.deepEqual(a.ranking.routes, b.ranking.routes);
  });

  test("a failed cell degrades only the routes that needed it", async () => {
    failCell = "36.10,-115.10";
    const { routeRanking } = await load();
    const run = routeRanking({ day: "tomorrow", nowMs: NOW });
    await vi.runAllTimersAsync();
    const { ranking } = await run;
    assert.ok(ranking.forecast.failed_cells >= 1);
    // The far route's own cell is in a failed batch only if batched with it;
    // either way every Bay Area route still ranks.
    const ids = ranking.routes.map((r) => r.id);
    for (const id of ["1", "2", "3"]) assert.ok(ids.includes(id), `route ${id} ranked`);
    const far = ranking.unranked.find((r) => r.id === "4");
    const farRanked = ranking.routes.find((r) => r.id === "4");
    assert.ok(far?.reason === "No forecast near this route" || farRanked?.degraded);
    assert.equal(
      ranking.forecast.degraded_routes,
      ranking.routes.filter((r) => r.degraded).length,
    );
  });

  test("ranks with what arrived when one Bay Area cell fails", async () => {
    // Route 1 runs 20 km north, through cells no other route uses.
    failCell = "38.00,-122.30";
    const { routeRanking } = await load();
    const run = routeRanking({ day: "tomorrow", nowMs: NOW });
    await vi.runAllTimersAsync();
    const { ranking } = await run;
    const one = ranking.routes.find((r) => r.id === "1");
    assert.ok(one, "still ranked");
    assert.equal(one.degraded, true);
  });

  test("an unavailable forecast is an error, not an empty ranking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { routeRanking } = await load();
    const run = routeRanking({ day: "tomorrow", nowMs: NOW });
    const settled = run.catch((error: Error) => error);
    await vi.runAllTimersAsync();
    const error = await settled;
    assert.ok(error instanceof Error && error.message === "Forecast unavailable");
  });
});
