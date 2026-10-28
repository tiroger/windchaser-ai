import { describe, expect, it } from "vitest";

import { activity } from "../test-fixtures";
import {
  acsmVo2,
  acuteChronicSeries,
  classifyFocus,
  exerciseLoads,
  fiveMinuteVo2,
  loadFocus,
  powerLoad,
  ratioStatus,
  sourceShares,
  summaryLoad,
  vo2maxSummary,
  type ExerciseLoad,
} from "./load";
import { HEART_RATE_ANCHORS } from "./load-params";
import { exerciseLoadSummary, loadAnchors, type StreamsIndex, type StreamsIndexEntry } from "./performance";

const anchors = HEART_RATE_ANCHORS;
const today = { year: 2026, month: 9, day: 28 };

const entry = (overrides: Partial<StreamsIndexEntry>): StreamsIndexEntry => ({
  date: "2026-10-01T08:00:00",
  sport_type: "Ride",
  has_streams: true,
  power_bests: null,
  normalized_power: null,
  average_watts: null,
  max_watts: null,
  average_heartrate: null,
  max_heartrate: null,
  moving_seconds: null,
  first_half: null,
  second_half: null,
  ...overrides,
});

describe("load models", () => {
  // Reference values computed from the fitted equations in the research notebook.
  it("scores average and max heart rate like the fitted summary model", () => {
    expect(summaryLoad(90, 140, 170, false, anchors)).toBeCloseTo(143.63, 1);
    expect(summaryLoad(75, 120, 165, true, anchors)).toBeCloseTo(68.23, 1);
  });

  it("scores power alone like the fitted power model", () => {
    expect(powerLoad(1.5, 200)).toBeCloseTo(183.41, 1);
  });

  it("rises with duration and intensity", () => {
    expect(summaryLoad(120, 140, 170, false, anchors)).toBeGreaterThan(summaryLoad(60, 140, 170, false, anchors));
    expect(summaryLoad(60, 155, 175, false, anchors)).toBeGreaterThan(summaryLoad(60, 130, 175, false, anchors));
    expect(powerLoad(1, 230)).toBeGreaterThan(powerLoad(1, 180));
  });

  it("classifies easy riding as low aerobic and hard riding as high aerobic", () => {
    expect(classifyFocus(120, 118, 150, false, anchors)).toBe("lowAerobic");
    expect(classifyFocus(60, 165, 185, false, anchors)).toBe("highAerobic");
    expect(classifyFocus(60, 130, 190, true, anchors)).toBe("anaerobic");
    expect(classifyFocus(60, null, null, false, anchors, 0.9)).toBe("highAerobic");
    expect(classifyFocus(60, null, null, false, anchors, 0.6)).toBe("lowAerobic");
  });

  it("uses settings for heart-rate anchors and the fitted values otherwise", () => {
    expect(loadAnchors({ weightKg: null, restingHr: 45, maxHr: 185, ftpOverride: null }, [])).toEqual({
      restingHr: 45,
      maxHr: 185,
    });
    expect(loadAnchors({ weightKg: null, restingHr: 49, maxHr: null, ftpOverride: null }, [])).toEqual(anchors);
    // Without a setting, the maximum observed in the data, as the Performance page derives it.
    const observed = Array.from({ length: 100 }, (_, i) => activity({ id: `m${i}`, date: "2026-10-01T08:00:00", max_heartrate: 145 + (i % 40) }));
    expect(loadAnchors({ weightKg: null, restingHr: 49, maxHr: null, ftpOverride: null }, observed).maxHr).toBe(184);
  });
});

describe("exerciseLoads", () => {
  const activities = [
    activity({ id: "garmin", date: "2026-10-20T08:00:00", average_heartrate: 140, max_heartrate: 170 }),
    activity({ id: "detailed", date: "2026-10-21T08:00:00", average_heartrate: 140, max_heartrate: 170 }),
    activity({ id: "summary", date: "2026-10-22T08:00:00", type: "Pickleball", average_heartrate: 120, max_heartrate: 160 }),
    activity({ id: "power", date: "2026-10-23T08:00:00", type: "VirtualRide", weighted_average_watts: 200 }),
    activity({ id: "walk", date: "2026-10-24T08:00:00", type: "Walk" }),
  ];
  const index: StreamsIndex = { detailed: entry({ exercise_load: 111 }) };
  const loads = exerciseLoads(activities, index, anchors, { garmin: { load: 222 } });

  it("takes Garmin, then detailed, then summary, then power", () => {
    expect(loads.garmin).toMatchObject({ load: 222, source: "garmin" });
    expect(loads.detailed).toMatchObject({ load: 111, source: "detailed" });
    expect(loads.summary.source).toBe("summary");
    expect(loads.power).toMatchObject({ source: "power", load: powerLoad(1, 200) });
  });

  it("leaves activities with neither heart rate nor power unscored", () => {
    expect(loads.walk).toBeUndefined();
  });

  it("reports how much load came from each source", () => {
    const shares = sourceShares(activities, loads, "2026-10-01", "2026-10-28");
    expect(shares.garmin).toEqual({ activities: 1, load: 222 });
    expect(shares.detailed).toEqual({ activities: 1, load: 111 });
    expect(shares.summary.activities).toBe(1);
    expect(shares.power.activities).toBe(1);
  });
});

describe("acute and chronic load", () => {
  const steady = Array.from({ length: 121 }, (_, day) =>
    activity({
      id: String(day),
      date: new Date(Date.UTC(2026, 5, 30) + day * 86_400_000).toISOString().slice(0, 10),
    }),
  );
  const loads: Record<string, ExerciseLoad> = Object.fromEntries(
    steady.map((item) => [item.id, { load: 50, source: "summary", focus: "lowAerobic" } as ExerciseLoad]),
  );

  it("reads as load per week, and a steady routine settles at a ratio of 1", () => {
    const series = acuteChronicSeries(steady, loads, today);
    const last = series[series.length - 1];
    expect(last.acute).toBeCloseTo(350, 0);
    expect(last.chronic).toBeGreaterThan(330);
    expect(last.ratio!).toBeGreaterThan(0.95);
    expect(last.ratio!).toBeLessThan(1.06);
  });

  it("rises faster in acute than chronic after a big week, and decays after", () => {
    const big = { ...loads };
    for (const item of steady.slice(-14, -7)) big[item.id] = { ...big[item.id], load: 200 };
    const series = acuteChronicSeries(steady, big, today);
    const peak = series[series.length - 8];
    const last = series[series.length - 1];
    expect(peak.ratio!).toBeGreaterThan(1.5);
    expect(last.ratio!).toBeLessThan(peak.ratio!);
  });

  it("holds the ratio back until there is a chronic load", () => {
    const series = acuteChronicSeries(steady.slice(-5), loads, today);
    expect(series[0].ratio).toBeNull();
  });

  it("uses Garmin's ratio bands", () => {
    expect(ratioStatus(0.7)).toBe("low");
    expect(ratioStatus(1.0)).toBe("optimal");
    expect(ratioStatus(1.6)).toBe("high");
    expect(ratioStatus(2.1)).toBe("veryHigh");
  });
});

describe("load focus", () => {
  const activities = [
    activity({ id: "a", date: "2026-10-27" }),
    activity({ id: "b", date: "2026-10-10" }),
    activity({ id: "c", date: "2026-09-01" }),
  ];
  it("splits the last four weeks into Garmin's categories", () => {
    const focus = loadFocus(
      activities,
      {
        a: { load: 100, source: "detailed", focus: "highAerobic" },
        b: { load: 300, source: "summary", focus: "lowAerobic" },
        c: { load: 900, source: "summary", focus: "anaerobic" },
      },
      today,
    );
    expect(focus.byCategory).toEqual({ lowAerobic: 300, highAerobic: 100, anaerobic: 0 });
    expect(focus.total).toBe(400);
    expect(focus.focus).toBe("lowAerobic");
  });
});

describe("VO2max", () => {
  it("converts with the ACSM equation and the 5-minute regression", () => {
    expect(acsmVo2(300, 70)).toBeCloseTo((10.8 * 300) / 70 + 7, 6);
    expect(fiveMinuteVo2(280, 70)).toBeCloseTo(16.6 + (8.87 * 280) / 70, 6);
  });

  it("reports the trailing median of ride estimates, ignoring one odd ride", () => {
    const watts = [300, 305, 295, 600, 302];
    const index: StreamsIndex = Object.fromEntries(
      watts.map((value, i) => [
        String(i),
        entry({ date: `2026-10-${String(10 + i * 3).padStart(2, "0")}T08:00:00`, vo2_power: { watts: value, segments: 4 } }),
      ]),
    );
    index.best = entry({ date: "2026-10-05T08:00:00", power_bests: { "300": 280 } });
    const summary = vo2maxSummary(index, 70, today);
    expect(summary.rides).toHaveLength(5);
    expect(summary.current).toBeCloseTo(acsmVo2(302, 70), 6);
    expect(summary.trend[0].date).toBe("2026-10-16");
    expect(summary.fromBestFiveMinutes).toBeCloseTo(fiveMinuteVo2(280, 70), 6);
  });

  it("needs a body mass", () => {
    expect(vo2maxSummary({ a: entry({ vo2_power: { watts: 300, segments: 3 } }) }, null, today).current).toBeNull();
  });
});

describe("exerciseLoadSummary", () => {
  it("counts activities it could not score", () => {
    const activities = [
      activity({ id: "hr", date: "2026-10-20T08:00:00", average_heartrate: 140, max_heartrate: 170 }),
      activity({ id: "none", date: "2026-10-21T08:00:00", type: "Walk" }),
    ];
    const summary = exerciseLoadSummary(
      activities,
      {},
      { weightKg: null, restingHr: 49, maxHr: null, ftpOverride: null },
      today,
    );
    expect(summary.unscored).toBe(1);
    expect(summary.recentSources.summary.activities).toBe(1);
    expect(summary.series[summary.series.length - 1].date).toBe("2026-10-28");
  });
});
