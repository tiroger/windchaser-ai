import assert from "node:assert/strict";
import { test } from "vitest";

import { angleDelta, bearingDeg, haversineM, toSections } from "./geo";
import {
  DEFAULT_RIDER,
  airDensity,
  calibratedPower,
  normalCdf,
  riderFor,
  sectionSpeed,
  sectionsFor,
  windAtRiderHeight,
} from "./physics";
import type { Rider, RiderModel, Segment } from "./types";

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

test("elevation profile drives per-section gradient", () => {
  // A 1 km segment climbing 50 m in its second half only.
  const points: Array<[number, number]> = Array.from({ length: 100 }, (_, i) => [
    41.0 + i * 0.00009,
    -73.9,
  ]);
  const flat = toSections(points, 0, null);
  const profiled = toSections(points, 0, {
    distance_m: [0, 500, 1000],
    altitude_m: [0, 0, 50],
  });

  assert.ok(flat.every((s) => s.grade === 0), "no profile means flat");
  const first = profiled[0].grade;
  const last = profiled[profiled.length - 1].grade;
  assert.ok(Math.abs(first) < 0.01, `first half should be flat, got ${first}`);
  assert.ok(last > 0.05, `second half should climb, got ${last}`);
});

test("calibrated power from history overrides the PR fallback", () => {
  const base = {
    id: 515151,
    name: "Fitted fixture",
    source: "starred" as const,
    distance_m: 2000,
    average_grade: 0,
    maximum_grade: 0,
    elevation_high: 10,
    elevation_low: 10,
    total_elevation_gain: 0,
    climb_category: 0,
    city: null,
    state: null,
    effort_count: null,
    athlete_count: null,
    star_count: null,
    pr_elapsed_time: 300,
    pr_date: null,
    effort_count_personal: null,
    points: Array.from({ length: 60 }, (_, i) => [41 + i * 0.0003, -73.9]) as Array<
      [number, number]
    >,
    region_id: "r0",
    cell_id: "41.00,-73.90",
  };

  const fromPr = calibratedPower({ ...base, id: 515151 });
  const fitted = calibratedPower({ ...base, id: 515152, calibrated_power_w: 190 });
  assert.equal(fitted, 190, "an explicit fit must win");
  assert.notEqual(fromPr, 190, "the PR fallback should differ from the fit");
});

// Fitted values from scripts/build_calibration.py, rounded. Used as a shape
// rather than as ground truth: what is asserted below is the behaviour these
// numbers must produce, not the numbers themselves.
const RIDER_MODEL: RiderModel = {
  cp_w: 132.7,
  w_prime_j: 12543,
  grade_w: 1176.3,
  mass_kg: 75.9,
  cda: 0.2587,
};

test("the rider model supplies power for a segment with no history", () => {
  const base = {
    name: "Unridden",
    source: "discovered" as const,
    distance_m: 3000,
    average_grade: 0,
    maximum_grade: 0,
    elevation_high: 10,
    elevation_low: 10,
    total_elevation_gain: 0,
    climb_category: 0,
    city: null,
    state: null,
    effort_count: null,
    athlete_count: null,
    star_count: null,
    pr_elapsed_time: null,
    pr_date: null,
    effort_count_personal: null,
    points: Array.from({ length: 60 }, (_, i) => [41 + i * 0.0003, -73.9]) as Array<
      [number, number]
    >,
    region_id: "r0",
    cell_id: "41.00,-73.90",
  };

  // No record and no fit. Without a rider model there is nothing to go on and
  // the generic rider's power is returned unchanged.
  const generic = calibratedPower({ ...base, id: 606001 } as Segment);
  assert.equal(generic, DEFAULT_RIDER.power_w, "no evidence means no calibration");

  const modelled = calibratedPower({
    ...base,
    id: 606002,
    rider_model: RIDER_MODEL,
  } as Segment);
  assert.notEqual(modelled, DEFAULT_RIDER.power_w, "the model must be used");

  // The fixed point has to land between critical power and what the curve
  // allows over a short effort; outside that range it has not converged.
  assert.ok(
    modelled > RIDER_MODEL.cp_w && modelled < RIDER_MODEL.cp_w + 200,
    `power ${modelled} outside the curve's plausible range`,
  );
});

test("the rider curve gives a climb more power than a flat", () => {
  const shared = {
    name: "Shaped",
    source: "discovered" as const,
    distance_m: 3000,
    maximum_grade: 0,
    elevation_low: 10,
    total_elevation_gain: 0,
    climb_category: 0,
    city: null,
    state: null,
    effort_count: null,
    athlete_count: null,
    star_count: null,
    pr_elapsed_time: null,
    pr_date: null,
    effort_count_personal: null,
    points: Array.from({ length: 60 }, (_, i) => [41 + i * 0.0003, -73.9]) as Array<
      [number, number]
    >,
    region_id: "r0",
    cell_id: "41.00,-73.90",
    rider_model: RIDER_MODEL,
  };

  const flat = calibratedPower({
    ...shared,
    id: 606003,
    average_grade: 0,
    elevation_high: 10,
  } as Segment);
  const climb = calibratedPower({
    ...shared,
    id: 606004,
    average_grade: 6,
    elevation_high: 190,
  } as Segment);

  // The gradient term is behavioural: this rider holds more on a climb than on
  // a flat of the same duration, and the curve has to reproduce that or it
  // cannot transfer between the two.
  assert.ok(
    climb > flat + 20,
    `climb ${climb.toFixed(0)} W should exceed flat ${flat.toFixed(0)} W`,
  );
});

test("fitted mass and frontal area replace the generic assumptions", () => {
  const segment = { id: 606005, rider_model: RIDER_MODEL } as Segment;
  const fitted = riderFor(segment);
  assert.equal(fitted.mass_kg, RIDER_MODEL.mass_kg);
  assert.equal(fitted.cda, RIDER_MODEL.cda);
  // Everything not fitted must survive untouched.
  assert.equal(fitted.crr, DEFAULT_RIDER.crr);
  assert.equal(fitted.drivetrain_efficiency, DEFAULT_RIDER.drivetrain_efficiency);

  const bare = riderFor({ id: 606006 } as Segment);
  assert.equal(bare.mass_kg, DEFAULT_RIDER.mass_kg, "no model means no change");
});
