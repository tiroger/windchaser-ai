import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { DEFAULT_RIDER } from "@/lib/physics";
import type { Rider } from "@/lib/types";

import { encodePolyline } from "./polyline";
import { buildSections, sampleCells, sunTimes, type CellSeries, type RawProfile, type RouteSection } from "./route-forecast";
import {
  LIGHT_WIND_SPREAD_S,
  RANKING_CELL_CAP,
  addDays,
  bestDayWindow,
  candidateHours,
  compareRanked,
  darkShare,
  gainPhrase,
  lightWinds,
  planCells,
  polylineCells,
  rankingDates,
  routeCells,
  savingHeadline,
  scoreRide,
  sketchOf,
  sportMatches,
  windShares,
  type RouteModel,
} from "./route-ranking";

const MILE = 1609.344;
const RIDER: Rider = { ...DEFAULT_RIDER, power_w: 200 };

/** A straight route from (lat, lon) heading `bearing`, `km` long, rising `rise` per metre. */
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

/** North on the flat, then back south up a 4% climb's worth of altitude, mirrored. */
function outAndBack(km: number, climbBack = false): RawProfile {
  const out = straight(km / 2, 200, 0);
  const back = [...out.latlng].reverse().slice(1);
  const half = out.distance[out.distance.length - 1];
  const rise = climbBack ? 0.04 : 0;
  return {
    distance: [...out.distance, ...out.distance.slice(1).map((d) => half + d)],
    altitude: [
      ...out.altitude,
      ...out.distance.slice(1).map((d) => (rise * d * MILE) / 0.3048),
    ],
    latlng: [...out.latlng, ...back],
  };
}

const sectionsOf = (p: RawProfile, visible?: boolean[]) => buildSections(p, visible ?? p.latlng.map(() => true));

function cellOver(hours: number, wind: (h: number) => { speed: number; from: number }): CellSeries {
  const speed: number[] = [];
  const from: number[] = [];
  for (let h = 0; h < hours; h++) {
    const w = wind(h);
    speed.push(w.speed);
    from.push(w.from);
  }
  return { speed, from, rho: Array(hours).fill(1.225) };
}

function model(sections: RouteSection[], cell: CellSeries, rain: number[] = [], temp: number[] = []): RouteModel {
  const hours = cell.speed.length;
  return {
    sections,
    assignment: sections.map(() => 0),
    cells: [cell],
    weather: {
      precip_prob: Array.from({ length: hours }, (_, i) => rain[i] ?? 0),
      temperature_c: Array.from({ length: hours }, (_, i) => temp[i] ?? 15),
    },
    rider: RIDER,
  };
}

const allDay = () => ({ polar: "day" as const });

describe("day windows", () => {
  test("today, tomorrow and the weekend map to calendar dates", () => {
    // 2026-10-28 is a Wednesday.
    assert.deepEqual(rankingDates("today", "2026-10-28"), ["2026-10-28"]);
    assert.deepEqual(rankingDates("tomorrow", "2026-10-28"), ["2026-10-29"]);
    assert.deepEqual(rankingDates("weekend", "2026-10-28"), ["2026-10-31", "2026-11-01"]);
    assert.deepEqual(rankingDates("weekend", "2026-10-31"), ["2026-10-31", "2026-11-01"], "Saturday");
    assert.deepEqual(rankingDates("weekend", "2026-11-01"), ["2026-11-01"], "Sunday: what is left of today");
    assert.deepEqual(rankingDates("tomorrow", "2026-12-31"), ["2027-01-01"]);
    assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  });

  test("only daylight starts on the chosen dates that have not passed", () => {
    const hours: string[] = [];
    const epochs: number[] = [];
    const start = Date.parse("2026-10-28T07:00:00Z") / 1000; // midnight PDT
    for (let i = 0; i < 48; i++) {
      const at = new Date((start + i * 3600 - 7 * 3600) * 1000).toISOString();
      hours.push(at.slice(0, 16));
      epochs.push(start + i * 3600);
    }
    const sun = (date: string) => sunTimes(date, 37.8, -122.27);
    // At 2 PM today: from 2 PM to the last start before sunset (~6:10 PM).
    const today = candidateHours(hours, epochs, ["2026-10-28"], 14, sun);
    assert.deepEqual(today.map((i) => hours[i].slice(11, 13)), ["14", "15", "16", "17", "18"].slice(0, today.length));
    assert.ok(today.length >= 4 && today[0] === 14);
    // Remaining daylight is nothing after sunset.
    assert.deepEqual(candidateHours(hours, epochs, ["2026-10-28"], 20, sun), []);
    // Tomorrow: every daylight hour, none before sunrise (~7:30 AM).
    const tomorrow = candidateHours(hours, epochs, ["2026-10-29"], 14, sun);
    assert.equal(hours[tomorrow[0]].slice(0, 13), "2026-10-29T08");
    assert.ok(tomorrow.every((i) => hours[i].startsWith("2026-10-29")));
    assert.ok(tomorrow.length >= 9 && tomorrow.length <= 11);
  });

  test("dark share counts the part of a ride outside daylight", () => {
    const sun = { sunrise: 1000, sunset: 5000 };
    assert.equal(darkShare(1000, 2000, sun), 0);
    assert.equal(darkShare(4000, 2000, sun), 0.5);
    assert.equal(darkShare(6000, 1000, sun), 1);
    assert.equal(darkShare(0, 100, { polar: "night" }), 1);
    assert.equal(darkShare(0, 100, { polar: "day" }), 0);
  });
});

describe("scoring", () => {
  const dry = { saved_pct: 3, rain_pct: 0, dark_share: 0, min_temp_c: 15, max_temp_c: 20 };

  test("is the time saved when nothing else is wrong", () => {
    assert.deepEqual(scoreRide(dry), { score: 3, penalties: { rain: 0, dark: 0, temperature: 0 } });
    assert.equal(scoreRide({ ...dry, saved_pct: -2 }).score, -2);
  });

  test("rain costs nothing to 20%, then 1.5 points per 10%", () => {
    assert.equal(scoreRide({ ...dry, rain_pct: 20 }).penalties.rain, 0);
    assert.equal(scoreRide({ ...dry, rain_pct: 60 }).penalties.rain, 6);
    assert.equal(scoreRide({ ...dry, rain_pct: 100 }).score, 3 - 12);
  });

  test("any darkness costs 2, all of it 10", () => {
    assert.equal(scoreRide({ ...dry, dark_share: 0.25 }).penalties.dark, 4);
    assert.equal(scoreRide({ ...dry, dark_share: 1 }).penalties.dark, 10);
  });

  test("heat and cold cost outside 5 to 30 °C", () => {
    assert.equal(scoreRide({ ...dry, max_temp_c: 30 }).penalties.temperature, 0);
    assert.equal(scoreRide({ ...dry, max_temp_c: 40 }).penalties.temperature, 4);
    assert.equal(scoreRide({ ...dry, min_temp_c: -3 }).penalties.temperature, 2);
  });

  test("a dry route with less wind beats a wet one with more", () => {
    const wet = scoreRide({ ...dry, saved_pct: 6, rain_pct: 90 });
    const plain = scoreRide({ ...dry, saved_pct: 1 });
    assert.ok(plain.score > wet.score);
  });

  test("ranking is by score, then saving, then name", () => {
    const rows = [
      { name: "B", score: 1, saved_s: 60 },
      { name: "A", score: 1, saved_s: 60 },
      { name: "C", score: 1, saved_s: 120 },
      { name: "D", score: 4, saved_s: 10 },
    ];
    assert.deepEqual(
      rows.sort(compareRanked).map((r) => r.name),
      ["D", "C", "A", "B"],
    );
  });
});

describe("best window on a day", () => {
  const sections = sectionsOf(outAndBack(60));
  // A southerly until noon, a northerly after: whoever leaves north at the
  // right hour has the wind behind them both ways.
  const turning = cellOver(48, (h) => ({ speed: 4, from: h < 12 ? 180 : 0 }));
  const epochs = Array.from({ length: 48 }, (_, h) => h * 3600);

  test("on an out-and-back the wind's turn picks the hour", () => {
    // Starting at 11 the southerly blows the rider out and the northerly,
    // arriving as they turn, blows them home.
    const window = bestDayWindow(model(sections, turning), [6, 8, 10, 11, 14], epochs, allDay);
    assert.ok(window);
    assert.ok(window.saved_s > 0, `saved ${window.saved_s}`);
    assert.equal(window.hour, 11);
    assert.ok(Math.abs(window.saved_pct - (window.saved_s / window.calm_s) * 100) < 0.05);
  });

  test("rain on the fastest hour moves the pick to a dry one", () => {
    const rain = Array(48).fill(0);
    rain[11] = 90;
    rain[12] = 90;
    const window = bestDayWindow(model(sections, turning, rain), [6, 8, 10, 11, 14], epochs, allDay);
    assert.ok(window && window.hour !== 11 && window.rain_max_pct < 90, JSON.stringify(window));
  });

  test("darkness and heat count against an hour", () => {
    const calm = cellOver(48, () => ({ speed: 0, from: 0 }));
    const sun = () => ({ sunrise: 0, sunset: 9.5 * 3600 });
    const late = bestDayWindow(model(sections, calm), [9], epochs, sun)!;
    assert.ok(late.dark_share > 0 && late.penalties.dark > 2);
    const hot = bestDayWindow(model(sections, calm, [], Array(48).fill(38)), [5], epochs, sun)!;
    assert.ok(hot.penalties.temperature > 3 && hot.score < 0);
    const early = bestDayWindow(model(sections, calm), [5, 9], epochs, sun)!;
    assert.equal(early.hour, 5, "the hour that finishes in daylight");
  });

  test("no window when the ride outlasts the forecast", () => {
    assert.equal(bestDayWindow(model(sections, turning), [47], epochs, allDay), null);
    assert.equal(bestDayWindow(model(sections, turning), [], epochs, allDay), null);
  });
});

describe("words", () => {
  test("names the part of the route the wind works on", () => {
    const sections = sectionsOf(outAndBack(20, true));
    // A northerly: headwind out (north) on the flat, tailwind back up the climb.
    const tail = sections.map((s) => (s.bearing_deg > 90 && s.bearing_deg < 270 ? 5 : -1));
    const phrase = gainPhrase(sections, tail, RIDER);
    assert.equal(phrase, "tailwind on the climb back");
    assert.equal(savingHeadline(540, phrase), "Saves 9 min with tailwind on the climb back");
  });

  test("falls back to the planner's phrase when nothing dominates", () => {
    const sections = sectionsOf(straight(10, 200));
    const tail = sections.map(() => 0.1);
    assert.equal(gainPhrase(sections, tail, RIDER), "barely any wind on the route");
  });

  test("headlines stay honest about small and negative effects", () => {
    assert.equal(savingHeadline(20, "mostly crosswind"), "Same as calm air, mostly crosswind");
    assert.equal(savingHeadline(-180, "headwind on the climb back"), "Costs 3 min with headwind on the climb back");
    assert.equal(savingHeadline(120, ""), "Saves 2 min against calm air");
    assert.equal(savingHeadline(180, "mostly crosswind"), "Saves 3 min, mostly crosswind");
  });

  test("light winds are called light", () => {
    assert.deepEqual(lightWinds([{ saved_s: 40 }, { saved_s: -95 }]), {
      light: true,
      spread_s: 95,
      message: "Light winds: every route within 2 min of calm.",
    });
    assert.equal(lightWinds([{ saved_s: 40 }, { saved_s: LIGHT_WIND_SPREAD_S }]).light, false);
    assert.equal(lightWinds([]).message, null);
  });

  test("wind shares count noticeable help and hindrance by distance", () => {
    const sections = sectionsOf(straight(10, 200));
    const tail = sections.map((_, i) => (i < sections.length / 2 ? 2 : -0.2));
    const shares = windShares(sections, tail);
    assert.ok(Math.abs(shares.tail - 0.5) < 0.05 && shares.head === 0);
  });
});

describe("forecast cells", () => {
  const c = (lat: number, lon: number): [number, number] => [lat, lon];

  test("shared cells are asked for once", () => {
    const plan = planCells([
      [c(37.8, -122.3), c(37.9, -122.3)],
      [c(37.8, -122.3), c(37.9, -122.2)],
      [c(37.8, -122.3)],
    ]);
    assert.equal(plan.cells.length, 3);
    assert.equal(plan.requested, 3);
    assert.equal(plan.dropped, 0);
    assert.deepEqual(plan.cells[0], c(37.8, -122.3), "the most shared first");
  });

  test("the cap keeps one cell for every route before filling with the most shared", () => {
    const shared = Array.from({ length: 10 }, (_, i) => c(37 + i / 10, -122));
    const routes = [
      ...Array.from({ length: 5 }, () => shared),
      [c(40, -120), c(40.1, -120)],
      [c(45, -110)],
    ];
    const plan = planCells(routes, 6);
    assert.equal(plan.cells.length, 6);
    assert.equal(plan.requested, 13);
    assert.equal(plan.dropped, 7);
    const keys = plan.cells.map((x) => x.join());
    assert.ok(keys.includes("45,-110") && (keys.includes("40,-120") || keys.includes("40.1,-120")));
    assert.ok(RANKING_CELL_CAP >= 40);
  });

  test("the list's summary track asks for the same cells as the profile", () => {
    const profile = straight(60, 600, 30, 0, 37.7, -122.3);
    const fromProfile = sampleCells(sectionsOf(profile)).cells;
    const fromTrack = polylineCells(
      encodePolyline(profile.latlng.filter((p, i): p is [number, number] => p !== null && i % 10 === 0)),
    );
    assert.deepEqual(new Set(fromTrack.map((x) => x.join())), new Set(fromProfile.map((x) => x.join())));
    assert.deepEqual(polylineCells(null), []);
  });

  test("a route whose cell failed falls back to the nearest one that arrived", () => {
    const sections = sectionsOf(straight(30, 300, 0, 0, 37.75, -122.27));
    const own: Array<[number, number]> = [c(37.8, -122.3), c(37.9, -122.3), c(38, -122.3)];
    const arrived: Array<[number, number]> = [c(37.8, -122.3), c(38, -122.3)];
    const index = new Map(arrived.map((x, i) => [`${x[0].toFixed(2)},${x[1].toFixed(2)}`, i]));
    const local = routeCells(sections, own, index, arrived)!;
    assert.equal(local.missing, 1);
    assert.deepEqual(new Set(local.cells), new Set([0, 1]));
    assert.equal(local.assignment.length, sections.length);
    // Nothing near: not ranked rather than ranked on a forecast 100 km away.
    const far: Array<[number, number]> = [c(39, -121)];
    assert.equal(routeCells(sections, own, new Map([["39.00,-121.00", 0]]), far), null);
  });

  test("with every cell present, routes use exactly their own", () => {
    const sections = sectionsOf(straight(5, 100, 0, 0, 37.81, -122.27));
    const own: Array<[number, number]> = [c(37.8, -122.3)];
    const arrived: Array<[number, number]> = [c(37.9, -122.3), c(37.8, -122.3)];
    const index = new Map(arrived.map((x, i) => [`${x[0].toFixed(2)},${x[1].toFixed(2)}`, i]));
    const local = routeCells(sections, own, index, arrived)!;
    assert.deepEqual(local.cells, [1]);
    assert.equal(local.missing, 0);
  });
});

describe("sketch", () => {
  test("uses only the sections outside the privacy radius, in relative units", () => {
    const profile = straight(10, 200, 45);
    const visible = profile.latlng.map((_, i) => i > 20 && i < 180);
    const sections = sectionsOf(profile, visible);
    const sketch = sketchOf(sections, sections.map(() => 1.234))!;
    assert.equal(sketch.points.length, sections.length);
    sections.forEach((s, i) => assert.equal(sketch.points[i] === null, !s.visible));
    for (const point of sketch.points) {
      if (!point) continue;
      assert.ok(point[0] >= 0 && point[0] <= 100 && point[1] >= 0 && point[1] <= 100);
    }
    assert.ok(sketch.points[0] === null && sketch.points[sketch.points.length - 1] === null);
    assert.equal(sketch.tail[3], 1.2);
    assert.ok(!JSON.stringify(sketch).includes("37.8"), "no coordinates");
  });

  test("a route hidden entirely has no sketch", () => {
    const profile = straight(1, 20);
    assert.equal(sketchOf(sectionsOf(profile, profile.latlng.map(() => false)), []), null);
  });
});

test("sport choices: rides by default, runs only under all", () => {
  assert.ok(sportMatches({ type: "ride", sub_type: "road" }, "ride"));
  assert.ok(!sportMatches({ type: "run", sub_type: "mixed" }, "ride"));
  assert.ok(sportMatches({ type: "run", sub_type: "mixed" }, "all"));
  assert.ok(sportMatches({ type: "ride", sub_type: "cx" }, "gravel"));
  assert.ok(!sportMatches({ type: "ride", sub_type: "cx" }, "road"));
});
