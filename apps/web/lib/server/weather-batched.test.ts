import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

/** Batched forecasts: dedupe, even batches, per-batch failure and the shared cache. */

function payload(lat: number, lon: number) {
  return {
    latitude: lat,
    longitude: lon,
    timezone: "UTC",
    utc_offset_seconds: 0,
    hourly: {
      time: ["2026-10-28T00:00"],
      temperature_2m: [10],
      relative_humidity_2m: [50],
      surface_pressure: [1010],
      precipitation: [0],
      precipitation_probability: [0],
      wind_speed_10m: [3],
      wind_direction_10m: [270],
      wind_gusts_10m: [5],
    },
  };
}

let requests: string[][] = [];
let failing: (keys: string[]) => number | null = () => null;

beforeEach(() => {
  requests = [];
  failing = () => null;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      const lats = url.searchParams.get("latitude")!.split(",").map(Number);
      const lons = url.searchParams.get("longitude")!.split(",").map(Number);
      const keys = lats.map((lat, i) => `${lat.toFixed(2)},${lons[i].toFixed(2)}`);
      requests.push(keys);
      const status = failing(keys);
      if (status) return new Response("no", { status });
      const body = lats.map((lat, i) => payload(lat, lons[i]));
      return new Response(JSON.stringify(body.length === 1 ? body[0] : body));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const grid = (n: number) => Array.from({ length: n }, (_, i): [number, number] => [37 + i / 10, -122]);

async function load() {
  vi.resetModules();
  return import("./weather");
}

test("asks for each distinct cell once, in even batches", async () => {
  const { fetchCellsBatched } = await load();
  const cells = [...grid(9), ...grid(9)];
  const result = await fetchCellsBatched(cells, 4);
  assert.equal(Object.keys(result.cells).length, 9);
  assert.equal(result.requests, 3);
  assert.deepEqual(requests.map((r) => r.length), [3, 3, 3]);
  assert.equal(new Set(requests.flat()).size, 9);
  assert.equal(result.cells["37.00,-122.00"].wind_from_deg[0], 270);
});

test("a cell cached by either path is not asked for again", async () => {
  const { fetchCellsBatched, fetchCell } = await load();
  await fetchCell([36, -122]);
  const first = await fetchCellsBatched([[36, -122], ...grid(3)]);
  assert.equal(first.cachedCount, 1);
  assert.equal(first.requests, 1);
  const second = await fetchCellsBatched(grid(3));
  assert.equal(second.cachedCount, 3);
  assert.equal(second.requests, 0);
});

test("an outage fails only its own batch, after retrying it", async () => {
  const { fetchCellsBatched } = await load();
  failing = (keys) => (keys.includes("37.00,-122.00") ? 503 : null);
  const run = fetchCellsBatched(grid(6), 3);
  await vi.runAllTimersAsync();
  const result = await run;
  assert.deepEqual(result.failed.sort(), ["37.00,-122.00", "37.10,-122.00", "37.20,-122.00"]);
  assert.equal(Object.keys(result.cells).length, 3);
  assert.equal(result.requests, 3 + 1, "three tries for the failing batch, one for the other");
});

test("a rejected batch is split to find the bad location", async () => {
  const { fetchCellsBatched } = await load();
  failing = (keys) => (keys.includes("37.30,-122.00") ? 400 : null);
  const result = await fetchCellsBatched(grid(4), 4);
  assert.deepEqual(result.failed, ["37.30,-122.00"]);
  assert.equal(Object.keys(result.cells).length, 3);
});
