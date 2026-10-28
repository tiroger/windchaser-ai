import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { haversineM } from "@/lib/geo";
import { DEFAULT_RIDER, sectionSpeed, windAtRiderHeight } from "@/lib/physics";
import type { Rider, RiderModel } from "@/lib/types";

import {
  BIKE_MASS_KG,
  GENERIC_ENDURANCE_W,
  MAX_SECTIONS,
  bestWindows,
  buildSections,
  calmRideTime,
  daylightFlag,
  defaultPower,
  describeWindow,
  nowIndex,
  plannerRider,
  predictRide,
  predictWeek,
  sampleCells,
  sunTimes,
  tailwindComponent,
  weatherAt,
  windPhrase,
  windowLabel,
  type CellSeries,
  type RawProfile,
  type SectionGeometry,
} from "./route-forecast";

const MILE = 1609.344;
const RIDER: Rider = { ...DEFAULT_RIDER, power_w: 200 };

/** A straight route from (lat, lon) heading `bearing` (0 = north, 90 = east), `km` long. */
function straight(km: number, points: number, bearing = 0, rise = 0, lat = 37.8, lon = -122.27): RawProfile {
  const distance: number[] = [];
  const altitude: number[] = [];
  const latlng: Array<[number, number]> = [];
  const dLat = Math.cos((bearing * Math.PI) / 180) / 111_195;
  const dLon = Math.sin((bearing * Math.PI) / 180) / (111_195 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < points; i++) {
    const m = (km * 1000 * i) / (points - 1);
    distance.push(m / MILE);
    altitude.push((rise * m) / 0.3048);
    latlng.push([lat + m * dLat, lon + m * dLon]);
  }
  return { distance, altitude, latlng };
}

/** Out along a bearing and back the same way. */
function outAndBack(km: number, bearing = 0): RawProfile {
  const out = straight(km / 2, 200, bearing);
  const back = [...out.latlng].reverse().slice(1);
  const half = out.distance[out.distance.length - 1];
  return {
    distance: [...out.distance, ...out.distance.slice(1).map((d) => half + d)],
    altitude: [...out.altitude, ...back.map(() => 0)],
    latlng: [...out.latlng, ...back],
  };
}

/** A single cell with the same weather every hour. */
function steady(hours: number, speed: number, from: number, rho = 1.225): CellSeries {
  return {
    speed: Array(hours).fill(speed),
    from: Array(hours).fill(from),
    rho: Array(hours).fill(rho),
  };
}

const visibleAll = (p: RawProfile) => p.latlng.map(() => true);

describe("sections", () => {
  test("cover the route, hold its bearing and read its gradient", () => {
    const sections = buildSections(straight(10, 1001, 0, 0.04), visibleAll(straight(10, 1001)));
    const total = sections.reduce((d, s) => d + s.length_m, 0);
    assert.ok(Math.abs(total - 10_000) < 1, `total ${total}`);
    sections.forEach((s, i) => {
      assert.ok(Math.abs(s.bearing_deg) < 0.5 || Math.abs(s.bearing_deg - 360) < 0.5);
      assert.ok(Math.abs(s.grade - 0.04) < 1e-3);
      // Only the remainder at the end may fall short of the minimum.
      if (i < sections.length - 1) assert.ok(s.length_m >= 150 * 0.99);
    });
    // Contiguous: each starts where the last ended.
    sections.slice(1).forEach((s, i) => {
      assert.ok(Math.abs(s.start_m - (sections[i].start_m + sections[i].length_m)) < 1e-6);
    });
  });

  test("a long route is merged to at most a few hundred sections", () => {
    const profile = straight(250, 2000, 90);
    const sections = buildSections(profile, visibleAll(profile));
    assert.ok(sections.length <= MAX_SECTIONS + 1, `${sections.length} sections`);
    assert.ok(sections.length > 200);
    assert.ok(sections.every((s) => Math.abs(s.bearing_deg - 90) < 1.5));
  });

  test("a section with any hidden point is not visible", () => {
    const profile = straight(5, 501);
    const visible = profile.latlng.map((_, i) => i > 50 && i < 450);
    const sections = buildSections(profile, visible);
    assert.equal(sections[0].visible, false);
    assert.equal(sections[sections.length - 1].visible, false);
    assert.ok(sections.some((s) => s.visible));
  });

  test("a glitch in the profile cannot become a wall", () => {
    const profile = straight(2, 201);
    profile.altitude[100] += 2000;
    const sections = buildSections(profile, visibleAll(profile));
    assert.ok(sections.every((s) => Math.abs(s.grade) <= 0.25));
  });
});

describe("wind component", () => {
  test("follows the meteorological convention", () => {
    // Wind from the south pushes a rider heading north.
    assert.ok(Math.abs(tailwindComponent(5, 180, 0) - 5) < 1e-9);
    assert.ok(Math.abs(tailwindComponent(5, 0, 0) + 5) < 1e-9);
    assert.ok(Math.abs(tailwindComponent(5, 90, 0)) < 1e-9);
    assert.ok(Math.abs(tailwindComponent(4, 225, 45) - 4) < 1e-9);
  });

  test("interpolates direction as a vector", () => {
    const cell: CellSeries = { speed: [5, 5], from: [350, 10], rho: [1.2, 1.22] };
    const mid = weatherAt(cell, 0.5)!;
    assert.ok(mid.from < 1 || mid.from > 359, `from ${mid.from}`);
    assert.ok(Math.abs(mid.rho - 1.21) < 1e-9);
    assert.equal(weatherAt(cell, 1.5), null);
  });
});

describe("forecast cells", () => {
  test("a compact route needs one cell", () => {
    const profile = straight(3, 300);
    const { cells, assignment } = sampleCells(buildSections(profile, visibleAll(profile)));
    assert.equal(cells.length, 1);
    assert.ok(assignment.every((a) => a === 0));
  });

  test("a long route is sampled with a bounded number of spread-out cells", () => {
    const profile = straight(220, 2000, 0, 0, 36);
    const sections = buildSections(profile, visibleAll(profile));
    const { cells, assignment } = sampleCells(sections, 8);
    assert.ok(cells.length <= 8 && cells.length >= 6, `${cells.length} cells`);
    const lats = cells.map((c) => c[0]);
    assert.ok(Math.min(...lats) < 36.3 && Math.max(...lats) > 37.6, "spread along the route");
    // Every section is served by its nearest chosen cell.
    sections.forEach((s, i) => {
      const own = haversineM(s.at, cells[assignment[i]]);
      assert.ok(cells.every((c) => haversineM(s.at, c) >= own - 1e-6));
    });
  });
});

describe("time prediction", () => {
  const route = straight(20, 801, 0);
  const sections = buildSections(route, visibleAll(route));
  const assignment = sections.map(() => 0);

  test("agrees with lib/physics on a straight flat route", () => {
    const ride = predictRide(sections, assignment, [steady(48, 6, 180)], 0, RIDER)!;
    const tail = windAtRiderHeight(6);
    const expected = 20_000 / sectionSpeed(RIDER, -tail, 0, 1.225);
    assert.ok(Math.abs(ride.time_s - expected) < 1, `${ride.time_s} vs ${expected}`);
    const calm = 20_000 / sectionSpeed(RIDER, 0, 0, 1.225);
    assert.ok(Math.abs(ride.calm_s - calm) < 1);
    assert.ok(Math.abs(calmRideTime(sections, RIDER) - calm) < 1);
  });

  test("a tailwind is faster than calm and a headwind slower", () => {
    const tail = predictRide(sections, assignment, [steady(48, 6, 180)], 0, RIDER)!;
    const head = predictRide(sections, assignment, [steady(48, 6, 0)], 0, RIDER)!;
    const cross = predictRide(sections, assignment, [steady(48, 6, 90)], 0, RIDER)!;
    assert.ok(tail.time_s < tail.calm_s);
    assert.ok(head.time_s > head.calm_s);
    assert.ok(Math.abs(cross.time_s - cross.calm_s) < 1);
    // Drag is asymmetric: a headwind costs more than the same tailwind gives.
    assert.ok(head.time_s - head.calm_s > tail.calm_s - tail.time_s);
  });

  test("an out-and-back in steady wind is slower than calm", () => {
    const loop = outAndBack(20, 0);
    const s = buildSections(loop, visibleAll(loop));
    const ride = predictRide(s, s.map(() => 0), [steady(48, 8, 0)], 0, RIDER)!;
    assert.ok(ride.time_s > ride.calm_s + 30);
  });

  test("denser air is slower, and the calm reference uses the same air", () => {
    const thin = predictRide(sections, assignment, [steady(48, 0, 0, 1.1)], 0, RIDER)!;
    const thick = predictRide(sections, assignment, [steady(48, 0, 0, 1.3)], 0, RIDER)!;
    assert.ok(thick.time_s > thin.time_s);
    assert.ok(Math.abs(thin.time_s - thin.calm_s) < 1e-6);
  });

  test("each section meets the weather of the hour it is ridden in", () => {
    // Calm for the first hour, a tailwind after.
    const changing: CellSeries = {
      speed: [0, 0, 8, 8, 8, 8],
      from: [180, 180, 180, 180, 180, 180],
      rho: Array(6).fill(1.225),
    };
    const long = straight(60, 2001, 0);
    const s = buildSections(long, visibleAll(long));
    const a = s.map(() => 0);
    const mixed = predictRide(s, a, [changing], 0, RIDER)!;
    const allCalm = predictRide(s, a, [steady(6, 0, 180)], 0, RIDER)!;
    const allTail = predictRide(s, a, [steady(6, 8, 180)], 0, RIDER)!;
    assert.ok(allTail.time_s < mixed.time_s && mixed.time_s < allCalm.time_s);
  });

  test("a ride that would outlast the forecast has no prediction", () => {
    const week = predictWeek(sections, assignment, [steady(3, 4, 180)], RIDER, 3);
    // About 40 minutes at 200 W: hours 0 and 1 finish, hour 2 cannot.
    assert.ok(week.times[0] !== null && week.times[1] !== null);
    assert.equal(week.times[2], null);
  });

  test("more power is faster", () => {
    const slow = predictRide(sections, assignment, [steady(48, 3, 0)], 0, { ...RIDER, power_w: 150 })!;
    const fast = predictRide(sections, assignment, [steady(48, 3, 0)], 0, { ...RIDER, power_w: 250 })!;
    assert.ok(fast.time_s < slow.time_s);
  });
});

describe("rider and default power", () => {
  const model: RiderModel = {
    cp_w: 180,
    w_prime_j: 15_000,
    grade_w: 1000,
    grade_min: -0.01,
    grade_max: 0.06,
    mass_kg: 74,
    cda: 0.27,
  };
  const route = straight(40, 1001, 0, 0.01);
  const sections = buildSections(route, visibleAll(route));

  test("mass comes from settings plus the bike, else the fitted model", () => {
    assert.equal(plannerRider(model, 68).rider.mass_kg, 68 + BIKE_MASS_KG);
    assert.equal(plannerRider(model, 68).massSource, "settings");
    assert.equal(plannerRider(model, null).rider.mass_kg, 74);
    assert.equal(plannerRider(model, null).rider.cda, 0.27);
    assert.equal(plannerRider(null, null).massSource, "default");
  });

  test("the rider model's power is a fixed point of its own duration", () => {
    const rider = plannerRider(model, null).rider;
    const power = defaultPower(sections, rider, model, 300);
    assert.equal(power.source, "rider-model");
    const seconds = calmRideTime(sections, { ...rider, power_w: power.watts });
    const expected = model.cp_w + model.w_prime_j / seconds + model.grade_w * 0.01;
    assert.ok(Math.abs(power.watts - expected) <= 1, `${power.watts} vs ${expected}`);
  });

  test("falls back to endurance FTP, then a generic figure", () => {
    assert.deepEqual(
      [defaultPower(sections, RIDER, null, 260).watts, defaultPower(sections, RIDER, null, 260).source],
      [182, "ftp"],
    );
    assert.equal(defaultPower(sections, RIDER, null, null).watts, GENERIC_ENDURANCE_W);
  });
});

describe("daylight", () => {
  test("sunrise and sunset in San Francisco at midsummer", () => {
    const sun = sunTimes("2026-06-21", 37.77, -122.42);
    assert.ok("sunrise" in sun);
    // 5:48 AM and 8:35 PM PDT.
    const sunrise = Date.parse("2026-06-21T12:48:00Z") / 1000;
    const sunset = Date.parse("2026-06-22T03:35:00Z") / 1000;
    assert.ok(Math.abs(sun.sunrise - sunrise) < 300, `sunrise off by ${sun.sunrise - sunrise}s`);
    assert.ok(Math.abs(sun.sunset - sunset) < 300, `sunset off by ${sun.sunset - sunset}s`);
  });

  test("polar day and night", () => {
    assert.deepEqual(sunTimes("2026-06-21", 78, 15), { polar: "day" });
    assert.deepEqual(sunTimes("2026-12-21", 78, 15), { polar: "night" });
  });

  test("whole, partial and no daylight", () => {
    const sun = { sunrise: 1000, sunset: 50_000 };
    assert.equal(daylightFlag(2000, 3600, sun), 2);
    assert.equal(daylightFlag(48_000, 3600, sun), 1);
    assert.equal(daylightFlag(60_000, 3600, sun), 0);
  });
});

describe("best windows", () => {
  const days = Array.from({ length: 48 }, (_, i) => (i < 24 ? "2026-10-31" : "2026-11-01"));

  test("the fastest hour, then the fastest on another day", () => {
    const times = Array.from({ length: 48 }, (_, i) => 10_000 + Math.abs(i - 10) * 10 + (i >= 24 ? Math.abs(i - 33) * 5 : 0));
    const calm = times.map(() => 10_100);
    const best = bestWindows(times, calm, { from: 0, days });
    assert.equal(best[0].hour, 10);
    assert.equal(best[0].saved_s, 100);
    assert.equal(best.length, 2);
    assert.equal(days[best[1].hour], "2026-11-01");
  });

  test("skips the past, the dark and the wet when it can", () => {
    const times = Array.from({ length: 48 }, (_, i) => 10_000 + i);
    const calm = times.map(() => 10_000);
    const daylight = times.map((_, i) => ((i % 24) >= 8 && (i % 24) <= 16 ? 2 : 0) as 0 | 2);
    const precip = times.map((_, i) => (i === 32 ? 90 : 0));
    // 29 is 5 AM on the second day: dark until 32 (8 AM), which is wet.
    const best = bestWindows(times, calm, { from: 29, days, daylight, precip, count: 1 });
    assert.equal(best[0].hour, 33);
  });

  test("nothing to choose leaves no windows", () => {
    assert.deepEqual(bestWindows([null, null], [null, null], { from: 0, days: ["a", "a"] }), []);
  });

  test("the current hour counts until it is over", () => {
    const epochs = [0, 3600, 7200];
    assert.equal(nowIndex(epochs, 3700), 1);
    assert.equal(nowIndex(epochs, 99_999), 3);
  });
});

describe("words", () => {
  const geometry = (grades: number[]): SectionGeometry[] =>
    grades.map((grade, i) => ({ start_m: i * 1000, length_m: 1000, bearing_deg: 0, grade }));

  test("names an out-and-back", () => {
    assert.equal(windPhrase(geometry([0, 0, 0, 0]), [-3, -3, 3, 3]), "headwind out, tailwind home");
    assert.equal(windPhrase(geometry([0, 0, 0, 0]), [3, 3, -3, -3]), "tailwind out, headwind home");
  });

  test("names the climbs", () => {
    assert.equal(windPhrase(geometry([0.05, 0.05, 0, 0]), [2, 2, 2, 0]), "mostly tailwind on the climbs");
    assert.equal(windPhrase(geometry([0.05, 0, 0, 0]), [-2, 2, 2, 0]), "mostly tailwind, headwind on the climbs");
    assert.equal(windPhrase(geometry([0, 0, 0, 0]), [0.1, -0.2, 0, 0.3]), "barely any wind on the route");
  });

  test("labels and describes a window", () => {
    assert.equal(windowLabel("2026-10-31T09:00"), "Saturday 9 AM");
    assert.equal(windowLabel("2026-10-31T00:00"), "Saturday 12 AM");
    assert.equal(windowLabel("2026-10-31T15:00", "2026-10-31"), "Today 3 PM");
    assert.equal(windowLabel("2026-11-01T12:00", "2026-10-31"), "Tomorrow 12 PM");
    assert.equal(
      describeWindow(
        { hour: 0, time_s: 3 * 3600 + 48 * 60, calm_s: 4 * 3600 + 2 * 60, saved_s: 14 * 60 },
        "2026-10-31T09:00",
        "mostly tailwind on the climbs",
      ),
      "Saturday 9 AM: 3h 48m, 14 min faster than calm air, mostly tailwind on the climbs",
    );
  });
});
