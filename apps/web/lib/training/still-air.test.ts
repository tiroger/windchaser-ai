import { describe, expect, it } from "vitest";

import { toSections } from "@/lib/geo";
import { airDensity, DEFAULT_RIDER } from "@/lib/physics";

import {
  impliedPower,
  RHO_STANDARD,
  sectionTailwinds,
  stillAirEffort,
  timeAtPower,
} from "./still-air";

// A 2 km road heading due north, climbing 4%, then one heading due east on the flat.
const NORTH = toSections(
  Array.from({ length: 21 }, (_, i) => [37.8 + (i * 0.1) / 111.2, -122.5] as [number, number]),
  4,
);
const EAST = toSections(
  Array.from({ length: 21 }, (_, i) => [37.8, -122.5 + (i * 0.1) / 87.9] as [number, number]),
  0,
);
const RIDER = { ...DEFAULT_RIDER, mass_kg: 79.75, cda: 0.204 };
// ISA sea level: 15 °C, 1013.25 hPa, dry.
const ISA = { temperature_c: 15, pressure_hpa: 1013.25, humidity_pct: 0 };

describe("implied power", () => {
  it("round-trips power → time → power", () => {
    for (const watts of [120, 220, 400]) {
      for (const [from, speed] of [[0, 0], [180, 6], [90, 9]] as const) {
        const tails = sectionTailwinds(NORTH, from, speed);
        const seconds = timeAtPower(NORTH, RIDER, watts, tails, 1.18);
        expect(impliedPower(NORTH, RIDER, seconds, tails, 1.18)).toBeCloseTo(watts, 2);
      }
    }
  });

  it("is null when no steady power could produce the time", () => {
    expect(impliedPower(NORTH, RIDER, 30, null, RHO_STANDARD)).toBeNull();
    // A descent ridden slower than coasting.
    const descent = toSections(
      Array.from({ length: 21 }, (_, i) => [37.8 + (i * 0.1) / 111.2, -122.5] as [number, number]),
      -8,
    );
    expect(impliedPower(descent, RIDER, 3600, null, RHO_STANDARD)).toBeNull();
  });
});

describe("still-air time", () => {
  it("equals the recorded time in calm air at standard density", () => {
    expect(airDensity(15, 1013.25, 0)).toBeCloseTo(RHO_STANDARD, 3);
    const result = stillAirEffort(NORTH, RIDER, {
      elapsed_time_s: 480,
      moving_time_s: 480,
      weather: { ...ISA, wind_speed_ms: 0, wind_from_deg: 270 },
    });
    expect(result.kind).toBe("adjusted");
    if (result.kind === "adjusted") {
      expect(result.stillAirSeconds).toBeCloseTo(480, 1);
      expect(result.tailwindMs).toBeCloseTo(0, 6);
    }
  });

  it("is slower than recorded after a tailwind and faster after a headwind", () => {
    const effort = (from: number) =>
      stillAirEffort(EAST, RIDER, {
        elapsed_time_s: 200,
        weather: { ...ISA, wind_speed_ms: 7, wind_from_deg: from },
      });
    // Riding east: wind from the west pushes, wind from the east holds back.
    const tail = effort(270);
    const head = effort(90);
    expect(tail.kind === "adjusted" && tail.tailwindMs > 0).toBe(true);
    expect(head.kind === "adjusted" && head.tailwindMs < 0).toBe(true);
    if (tail.kind === "adjusted" && head.kind === "adjusted") {
      expect(tail.stillAirSeconds).toBeGreaterThan(200);
      expect(head.stillAirSeconds).toBeLessThan(200);
      // Same time, but the headwind rider was working harder.
      expect(head.impliedWatts).toBeGreaterThan(tail.impliedWatts);
    }
  });

  it("barely moves a crosswind effort", () => {
    const cross = stillAirEffort(EAST, RIDER, {
      elapsed_time_s: 200,
      weather: { ...ISA, wind_speed_ms: 7, wind_from_deg: 0 },
    });
    expect(cross.kind === "adjusted" && Math.abs(cross.stillAirSeconds - 200)).toBeLessThan(1);
  });

  it("carries stopped time across unchanged", () => {
    const weather = { ...ISA, wind_speed_ms: 6, wind_from_deg: 90 };
    const clean = stillAirEffort(EAST, RIDER, { elapsed_time_s: 200, moving_time_s: 200, weather });
    const stopped = stillAirEffort(EAST, RIDER, { elapsed_time_s: 260, moving_time_s: 200, weather });
    expect(clean.kind === "adjusted" && stopped.kind === "adjusted").toBe(true);
    if (clean.kind === "adjusted" && stopped.kind === "adjusted") {
      expect(stopped.stillAirSeconds - clean.stillAirSeconds).toBeCloseTo(60, 6);
    }
  });

  it("says why when there is no still-air time", () => {
    expect(stillAirEffort(EAST, RIDER, { elapsed_time_s: 200, weather: null })).toEqual({
      kind: "none",
      reason: "no-weather",
    });
    expect(
      stillAirEffort(EAST, RIDER, { elapsed_time_s: 20, weather: { ...ISA, wind_speed_ms: 3 } }),
    ).toEqual({ kind: "none", reason: "too-short" });
    expect(stillAirEffort([], RIDER, { elapsed_time_s: 200, weather: { wind_speed_ms: 3 } })).toEqual({
      kind: "none",
      reason: "no-geometry",
    });
  });
});
