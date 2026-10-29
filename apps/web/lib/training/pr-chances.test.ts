import { describe, expect, it, vi } from "vitest";

import {
  chooseSegments,
  closestHours,
  isSoftRecord,
  selectChances,
  ttlCache,
  withinReach,
  type HourCandidate,
} from "./pr-chances";

const NOW = Date.parse("2026-10-29T15:00:00Z") / 1000;

function hour(segmentId: number, time: string, predictedSeconds: number, extra: Partial<HourCandidate> = {}): HourCandidate {
  return {
    segmentId,
    time,
    epoch: Date.parse(`${time}:00Z`) / 1000 + 7 * 3600,
    predictedSeconds,
    sigmaSeconds: 20,
    tailwindMs: 2,
    windSpeedMs: 5,
    windFromDeg: 270,
    daylight: 2,
    gated: false,
    precipProb: 0,
    ...extra,
  };
}

describe("withinReach", () => {
  it("allows 2% of the PR, and at least 3 seconds", () => {
    expect(withinReach(612, 600)).toBe(true);
    expect(withinReach(613, 600)).toBe(false);
    expect(withinReach(589, 600)).toBe(true);
    // 2% of 60 s is 1.2 s; the floor is 3 s.
    expect(withinReach(63, 60)).toBe(true);
    expect(withinReach(64, 60)).toBe(false);
  });
});

describe("selectChances", () => {
  const targets = [
    { segmentId: 1, prSeconds: 600 },
    { segmentId: 2, prSeconds: 300 },
  ];

  it("offers daylight hours only, and none that are wet, gated or past", () => {
    const chances = selectChances(
      [
        hour(1, "2026-10-30T06:00", 590, { daylight: 0 }),
        hour(1, "2026-10-30T07:00", 590, { daylight: 1 }),
        hour(1, "2026-10-31T10:00", 590, { gated: true }),
        hour(1, "2026-11-01T10:00", 590, { precipProb: 80 }),
        hour(1, "2026-10-28T10:00", 590),
        hour(1, "2026-11-02T10:00", 598),
      ],
      targets,
      NOW,
    );
    expect(chances.map((c) => c.time)).toEqual(["2026-11-02T10:00"]);
  });

  it("drops hours beyond reach of the PR", () => {
    expect(selectChances([hour(1, "2026-10-30T10:00", 640)], targets, NOW)).toEqual([]);
    expect(closestHours([hour(1, "2026-10-30T10:00", 640)], targets, NOW)[0].gapSeconds).toBe(40);
  });

  it("ranks by gap relative to the PR, then by likelihood, one hour per segment per day", () => {
    const chances = selectChances(
      [
        hour(1, "2026-10-30T10:00", 594), // −1% on a 600 s PR
        hour(1, "2026-10-30T11:00", 591), // better, same day: replaces 10:00
        hour(2, "2026-10-30T10:00", 291), // −3% on a 300 s PR: the best
        hour(1, "2026-10-31T10:00", 605), // +0.8%
        hour(2, "2026-10-31T10:00", 303, { sigmaSeconds: 5 }),
        hour(2, "2026-11-01T10:00", 303, { sigmaSeconds: 30 }), // same gap, likelier
      ],
      targets,
      NOW,
      12,
      3,
    );
    expect(chances.map((c) => [c.segmentId, c.time])).toEqual([
      [2, "2026-10-30T10:00"],
      [1, "2026-10-30T11:00"],
      [1, "2026-10-31T10:00"],
      [2, "2026-11-01T10:00"],
      [2, "2026-10-31T10:00"],
    ]);
    expect(chances[0].gapSeconds).toBe(-9);
    expect(chances[0].pBeat).toBeGreaterThan(0.5);
    expect(chances[3].pBeat).toBeGreaterThan(chances[4].pBeat);
  });

  it("caps hours per segment and in total", () => {
    const days = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"];
    const many = days.map((day, d) => hour(1, `${day}T10:00`, 590 + d));
    expect(selectChances(many, targets, NOW).length).toBe(2);
    expect(selectChances(many, targets, NOW, 1, 6).length).toBe(1);
  });

  it("does not rank soft records as chances", () => {
    const soft = [{ segmentId: 1, prSeconds: 900, soft: true }];
    expect(selectChances([hour(1, "2026-10-30T10:00", 600)], soft, NOW)).toEqual([]);
  });
});

describe("isSoftRecord", () => {
  it("flags records ridden easily or with a stop, judged by power and stops, not time", () => {
    const base = { elapsedSeconds: 600, movingSeconds: 600, impliedWatts: 220, abilityWatts: 230 };
    expect(isSoftRecord(base)).toBe(false);
    expect(isSoftRecord({ ...base, impliedWatts: 180 })).toBe(true);
    expect(isSoftRecord({ ...base, movingSeconds: 540 })).toBe(true);
    expect(isSoftRecord({ ...base, impliedWatts: null })).toBe(false);
  });
});

describe("chooseSegments", () => {
  const cellOf = ([lat, lon]: [number, number]) =>
    `${(Math.round(lat * 10) / 10).toFixed(2)},${(Math.round(lon * 10) / 10).toFixed(2)}`;
  const segment = (id: number, mid: [number, number], lastRidden: string) => ({ id, mid, lastRidden });

  it("keeps segments near the latest ride, sharing cells, within the caps", () => {
    const { chosen, cells, skipped } = chooseSegments(
      [
        segment(1, [37.83, -122.49], "2026-10-16"), // home
        segment(2, [37.84, -122.48], "2025-01-01"), // same cell
        segment(3, [37.76, -122.44], "2024-01-01"), // nearby, own cell
        segment(4, [41.0, -73.9], "2026-01-01"), // New York: too far
        segment(5, [37.3, -122.1], "2023-01-01"), // 65 km: in range, over the cell cap
      ],
      cellOf,
      { maxCells: 2 },
    );
    expect(chosen.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(cells).toEqual(["37.80,-122.50", "37.80,-122.40"]);
    expect(skipped).toBe(1);
  });
});

describe("ttlCache", () => {
  it("computes once per key within the TTL, coalescing concurrent callers", async () => {
    let now = 0;
    const cache = ttlCache<number>(1000, () => now);
    const load = vi.fn(async () => 42);
    await Promise.all([cache.get("a", load), cache.get("a", load)]);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1500;
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(2);
    // A new key (the effort history changed) recomputes at once.
    await cache.get("b", load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failure", async () => {
    const cache = ttlCache<number>(1000, () => 0);
    await expect(cache.get("a", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.get("a", async () => 7)).toBe(7);
  });
});
