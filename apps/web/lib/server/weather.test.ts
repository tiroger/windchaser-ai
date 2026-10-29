import { afterEach, expect, test, vi } from "vitest";

import { cellId, cellOf, fetchCells } from "./weather";

afterEach(() => vi.unstubAllGlobals());

const payload = (lat: number, lon: number) => ({
  latitude: lat,
  longitude: lon,
  timezone: "America/Los_Angeles",
  utc_offset_seconds: -25200,
  hourly: {
    time: ["2026-10-29T09:00"],
    temperature_2m: [15],
    relative_humidity_2m: [60],
    surface_pressure: [1013],
    precipitation: [0],
    precipitation_probability: [0],
    wind_speed_10m: [5],
    wind_direction_10m: [270],
    wind_gusts_10m: [8],
  },
});

test("segments sharing a 0.1° cell share one forecast request, and a repeat is served from cache", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    const query = new URL(url).searchParams;
    return new Response(JSON.stringify(payload(Number(query.get("latitude")), Number(query.get("longitude")))));
  });
  vi.stubGlobal("fetch", fetchMock);

  // Hawk Hill and McCullough Road sit in the same cell; Twin Peaks does not.
  const mids: Array<[number, number]> = [
    [37.832, -122.497],
    [37.826, -122.512],
    [37.754, -122.447],
  ];
  const cells = mids.map(([lat, lon]) => cellOf(lat, lon));
  expect(new Set(cells.map(cellId)).size).toBe(2);

  const first = await fetchCells(cells);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(first.liveCount).toBe(2);
  expect(Object.keys(first.cells).sort()).toEqual(["37.80,-122.50", "37.80,-122.40"].sort());

  const second = await fetchCells(cells);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(second.cells["37.80,-122.50"]).toBe(first.cells["37.80,-122.50"]);
});
