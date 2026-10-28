import type { Gear, MaintenanceRecord } from "@/lib/training/activity-types";
import { activity } from "@/lib/training/test-fixtures";

import type { AskData, EffortsData } from "./types";

/** A small, fully known training history for the Ask tests. Today is 2026-10-15. */
export const TODAY = "2026-10-15";

const gear: Gear[] = [
  { id: "b1", name: "Vader Velo", brand: "Giant", model: "TCR", distance: 7270, retired: false, kind: "bike" },
  { id: "b2", name: "TIE Strider", brand: "Storck", model: "Scenero G2", distance: 8956, retired: false, kind: "bike" },
  { id: "b3", name: "Caadie", brand: "Cannondale", model: "CAAD10", distance: 5736, retired: true, kind: "bike" },
  { id: "g1", name: "Zoom Fly", brand: "Nike", model: "Zoom Fly 5", distance: 120, retired: false, kind: "shoe" },
];

const maintenance: MaintenanceRecord[] = [
  { id: "m1", bikeId: "b1", bike: "Vader Velo", part: "Chain", service: "Hot Wax", date: "2026-08-01", mileage: 7000 },
  { id: "m2", bikeId: "b2", bike: "TIE Strider", part: "Chain", service: "Lube", date: "2026-09-01", mileage: 8800 },
  // Logged before bikes were stored by ID: matched by name.
  { id: "m3", bike: "Vader Velo", part: "Tires", service: "New", date: "2026-01-10", mileage: 6500 },
];

const efforts: EffortsData = {
  generated_at: "2026-10-14T00:00:00Z",
  segments: {
    "229781": { id: 229781, name: "Hawk Hill", distance_m: 2655, average_grade: 6.8, pr_elapsed_time: 600 },
    "4222628": { id: 4222628, name: "Four Horsemen", distance_m: 4700, average_grade: 2.1, pr_elapsed_time: 680 },
  },
  efforts: [
    // During a1: 07:00 local in Pacific daylight time is 14:00 UTC.
    {
      segment_id: 229781,
      start_date: "2026-10-01T14:30:00Z",
      elapsed_time_s: 640,
      moving_time_s: 640,
      distance_m: 2655,
      average_watts: 240,
      device_watts: true,
      average_heartrate: 160,
      cell_id: "37.80,-122.50",
      weather: { wind_speed_ms: 3, wind_from_deg: 270, gust_ms: 6, temperature_c: 15 },
    },
    {
      segment_id: 229781,
      start_date: "2025-10-05T16:00:00Z",
      elapsed_time_s: 600,
      moving_time_s: 600,
      distance_m: 2655,
      average_watts: 255,
      device_watts: true,
      average_heartrate: 165,
      cell_id: "37.80,-122.50",
      weather: null,
    },
    {
      segment_id: 229781,
      start_date: "2024-10-02T16:00:00Z",
      elapsed_time_s: 700,
      moving_time_s: 700,
      distance_m: 2655,
      average_watts: null,
      device_watts: false,
      average_heartrate: null,
      cell_id: "37.80,-122.50",
      weather: null,
    },
  ],
};

export function askData(overrides: Partial<AskData> = {}): AskData {
  return {
    today: TODAY,
    activities: [
      activity({ id: "1001", date: "2026-10-01T07:00:00", name: "Morning ride", distance: 30, moving_time: 2, total_elevation_gain: 1500, gear_id: "b1", kilojoules: 1200, kudos_count: 5, weighted_average_watts: 200, average_watts: 180, average_heartrate: 140, max_heartrate: 175 }),
      activity({ id: "1002", date: "2026-10-10T08:00:00", name: "Long Sunday", distance: 50, moving_time: 3, total_elevation_gain: 3000, gear_id: "b2", kilojoules: 2000, kudos_count: 10, weighted_average_watts: 190 }),
      activity({ id: "1003", date: "2026-09-05T18:00:00", name: "Pickleball", type: "Pickleball", moving_time: 2 }),
      activity({ id: "1004", date: "2026-09-20T18:00:00", name: "Pickleball doubles", type: "Pickleball", moving_time: 1.5 }),
      activity({ id: "1005", date: "2025-10-05T08:30:00", name: "Hawk Hill repeats", distance: 40, moving_time: 2.5, total_elevation_gain: 2000, gear_id: "b1" }),
      activity({ id: "1006", date: "2025-10-20T08:00:00", name: "Late October epic", distance: 60, moving_time: 4, total_elevation_gain: 4000, gear_id: "b2" }),
      activity({ id: "1007", date: "2024-10-02T08:30:00", name: "Short spin", distance: 20, moving_time: 1, total_elevation_gain: 800, gear_id: "b3" }),
      activity({ id: "1008", date: "2026-03-01T09:00:00", name: "Easy run", type: "Run", distance: 5, moving_time: 0.75, gear_id: "g1" }),
      activity({ id: "1009", date: "2025-06-01T07:00:00", name: "Summer century", type: "Ride", distance: 100, moving_time: 6, total_elevation_gain: 5000, gear_id: "b2" }),
      activity({ id: "1010", date: "2026-10-12T17:00:00", name: "Zwift race", type: "VirtualRide", distance: 20, moving_time: 1, total_elevation_gain: 600, kilojoules: 800, weighted_average_watts: 230 }),
    ],
    gear,
    maintenance,
    settings: {
      goals: { "Ride:distance": 4000 },
      athlete: { weightKg: 70, restingHr: 50, maxHr: 190, ftpOverride: null },
    },
    streamsIndex: {
      "1001": {
        date: "2026-10-01T07:00:00Z",
        sport_type: "Ride",
        has_streams: true,
        power_bests: { "5": 800, "60": 400, "180": 300, "300": 280, "480": 265, "600": 260, "1200": 240, "3600": 200 },
        normalized_power: 210,
        average_watts: 180,
        max_watts: 820,
        average_heartrate: 140,
        max_heartrate: 175,
        moving_seconds: 7200,
        first_half: { watts: 185, heartrate: 135 },
        second_half: { watts: 175, heartrate: 145 },
      },
    },
    efforts: async () => efforts,
    ...overrides,
  };
}
