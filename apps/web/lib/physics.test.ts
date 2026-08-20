import assert from "node:assert/strict";
import { test } from "vitest";

import { angleDelta, bearingDeg, haversineM, toSections } from "./geo";
import {
  DEFAULT_RIDER,
  airDensity,
  calibratedPower,
  normalCdf,
  sectionSpeed,
  sectionsFor,
  windAtRiderHeight,
} from "./physics";
import type { Rider } from "./types";

// Matches the reference parameters recorded in section 9 of the project plan.
const FIXTURE_RIDER: Rider = {
  power_w: 250,
  mass_kg: 80,
  cda: 0.32,
  crr: 0.005,
  drivetrain_efficiency: 1.0,
};
const RHO = 1.225;

/** Sum of per-section times, the aggregation section 9 mandates. */
function rideTime(legs: Array<[number, number]>): number {
  return legs.reduce(
    (t, [dist, tail]) => t + dist / sectionSpeed(FIXTURE_RIDER, -tail, 0, RHO),
    0,
  );
}

function meanTailwind(legs: Array<[number, number]>): number {
  const dist = legs.reduce((d, [l]) => d + l, 0);
  return legs.reduce((s, [l, tw]) => s + tw * l, 0) / dist;
}

test("golden fixtures from PROJECT_PLAN section 9", () => {
  const cases: Array<[string, Array<[number, number]>, number]> = [
    ["calm", [[5000, 0], [5000, 0]], 16.29],
    ["8 m/s out-and-back", [[5000, 8], [5000, -8]], 19.29],
    ["12 m/s out-and-back", [[5000, 12], [5000, -12]], 23.31],
    ["8 m/s four-sided loop", [[2500, 8], [2500, 0], [2500, -8], [2500, 0]], 17.79],
    ["8 m/s point-to-point tailwind", [[10000, 8]], 10.55],
  ];

  for (const [name, legs, expectedMin] of cases) {
    const minutes = rideTime(legs) / 60;
    assert.ok(
      Math.abs(minutes - expectedMin) < 0.01,
      `${name}: expected ${expectedMin} min, got ${minutes.toFixed(2)}`,
    );
  }
});

test("mean tailwind is blind to cases the time model separates", () => {
  const blind: Array<Array<[number, number]>> = [
    [[5000, 0], [5000, 0]],
    [[5000, 8], [5000, -8]],
    [[5000, 12], [5000, -12]],
    [[2500, 8], [2500, 0], [2500, -8], [2500, 0]],
  ];
  for (const legs of blind) {
    assert.ok(Math.abs(meanTailwind(legs)) < 1e-9, "mean tailwind should be zero");
  }
  const times = blind.map(rideTime);
  // Identical score input, materially different reality.
  assert.ok(Math.max(...times) - Math.min(...times) > 400);
});

test("headwind costs more than an equal tailwind returns", () => {
  const calm = rideTime([[10000, 0]]);
  const tail = rideTime([[10000, 6]]);
  const head = rideTime([[10000, -6]]);
  assert.ok(head - calm > calm - tail, "drag asymmetry must hold");
});

test("tailwind stronger than ground speed still pushes", () => {
  const fast = sectionSpeed(FIXTURE_RIDER, -25, 0, RHO);
  const slow = sectionSpeed(FIXTURE_RIDER, -5, 0, RHO);
  assert.ok(fast > slow, "sign preservation on v_air failed");
});

test("gradient sign behaves", () => {
  const flat = sectionSpeed(FIXTURE_RIDER, 0, 0, RHO);
  const climb = sectionSpeed(FIXTURE_RIDER, 0, 0.08, RHO);
  const descent = sectionSpeed(FIXTURE_RIDER, 0, -0.08, RHO);
  assert.ok(climb < flat && flat < descent);
});

test("air density responds to temperature and humidity", () => {
  const cold = airDensity(0, 1013, 50);
  const hot = airDensity(35, 1013, 50);
  assert.ok(cold > hot, "cold air must be denser");
  assert.ok(Math.abs(airDensity(15, 1013, 0) - 1.225) < 0.02, "near ISA at 15C");
});

test("wind height correction reduces 10 m wind", () => {
  const v = windAtRiderHeight(10);
  assert.ok(v > 6 && v < 7.5, `expected ~6.4 m/s, got ${v.toFixed(2)}`);
});

test("bearing and wraparound", () => {
  assert.ok(Math.abs(bearingDeg([0, 0], [1, 0]) - 0) < 0.01, "north");
  assert.ok(Math.abs(bearingDeg([0, 0], [0, 1]) - 90) < 0.01, "east");
  assert.equal(angleDelta(10, 350), 20);
  assert.equal(angleDelta(350, 10), -20);
});

test("haversine matches known distances", () => {
  // One degree of latitude on a sphere is exactly R * 1 degree in radians.
  const oneDegree = haversineM([0, 0], [1, 0]);
  assert.ok(Math.abs(oneDegree - 111195) < 5, `got ${oneDegree.toFixed(0)} m`);

  // One degree of longitude shrinks by cos(latitude).
  const lat = 40.9897;
  const expected = 111195 * Math.cos((lat * Math.PI) / 180);
  const measured = haversineM([lat, -73.8984], [lat, -72.8984]);
  assert.ok(
    Math.abs(measured - expected) / expected < 0.001,
    `got ${measured.toFixed(0)} m, expected ~${expected.toFixed(0)} m`,
  );
});

test("sections cover the full polyline", () => {
  const pts: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [
    40 + i * 0.0001,
    -73,
  ]);
  const sections = toSections(pts);
  const total = sections.reduce((s, x) => s + x.distance_m, 0);
  const direct = haversineM(pts[0], pts[pts.length - 1]);
  assert.ok(Math.abs(total - direct) / direct < 0.01, "section lengths must sum");
});

test("normal cdf", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test("power calibration reproduces the rider's PR in still air", () => {
  const points: Array<[number, number]> = Array.from({ length: 120 }, (_, i) => [
    41.0 + i * 0.00018,
    -73.9,
  ]);
  const segment = {
    id: 424242,
    name: "Calibration fixture",
    source: "starred" as const,
    distance_m: 2400,
    average_grade: 4.2,
    maximum_grade: 8,
    elevation_high: 200,
    elevation_low: 100,
    total_elevation_gain: 100,
    climb_category: 1,
    city: null,
    state: null,
    effort_count: null,
    athlete_count: null,
    star_count: null,
    pr_elapsed_time: 600,
    pr_date: null,
    effort_count_personal: null,
    points,
    region_id: "r0",
    cell_id: "41.00,-73.90",
  };

  const power = calibratedPower(segment);
  assert.ok(power > 40 && power < 900, `implausible fitted power ${power}`);

  // Re-ride the segment in still air at the fitted power: it must land on the PR.
  const sections = sectionsFor(segment);
  const rider = { ...DEFAULT_RIDER, power_w: power };
  const stillAir = sections.reduce(
    (t, s) => t + s.distance_m / sectionSpeed(rider, 0, 4.2 / 100, 1.225),
    0,
  );
  assert.ok(
    Math.abs(stillAir - 600) < 1,
    `still-air time ${stillAir.toFixed(1)}s should match the 600s PR`,
  );
});
