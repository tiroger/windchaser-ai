import { describe, expect, it } from "vitest";
import { activity } from "../test-fixtures";
import {
  buildPerformanceModel,
  estimateFtp,
  fitCriticalPower,
  fitnessSeries,
  powerTss,
  timeInZones,
  trimp,
  type CurvePoint,
  type StreamsIndex,
} from "./performance";

const point = (duration: number, watts: number): CurvePoint => ({
  duration,
  watts,
  activityId: "1",
  date: "2026-10-01",
});

describe("FTP", () => {
  // Generated from CP = 260 W and W' = 20 kJ: P(t) = CP + W'/t.
  const curve = [180, 300, 600, 1200].map((t) => point(t, Math.round(260 + 20000 / t)));

  it("recovers critical power and W' from the work-time model", () => {
    const fit = fitCriticalPower(curve)!;
    // Watts are whole numbers in the data, so the fit is close rather than exact.
    expect(Math.abs(fit.cp - 260) / 260).toBeLessThan(0.01);
    expect(Math.abs(fit.wPrime - 20000) / 20000).toBeLessThan(0.02);
  });

  it("takes the lower of critical power and 95% of the 20-minute best", () => {
    const estimate = estimateFtp(curve)!;
    expect(estimate.best20).toBe(277);
    expect(estimate.ftp).toBe(Math.round(Math.min(estimate.cp!, 277 * 0.95)));
  });

  it("refuses fits from efforts that were not all-out", () => {
    expect(fitCriticalPower([point(180, 200), point(300, 210), point(600, 220)])).toBeNull();
  });
});

describe("load", () => {
  it("scores an hour at FTP as 100 TSS", () => {
    expect(powerTss(3600, 250, 250)).toBeCloseTo(100);
  });

  it("follows Banister's TRIMP with heart-rate reserve", () => {
    const reserve = (150 - 50) / (190 - 50);
    expect(trimp(60, 150, 50, 190)).toBeCloseTo(60 * reserve * 0.64 * Math.exp(1.92 * reserve));
  });

  it("scores pickleball from heart rate and rides from power", () => {
    const today = { year: 2026, month: 9, day: 27 };
    const index: StreamsIndex = {};
    for (let week = 0; week < 6; week++) {
      const day = String(1 + week * 4).padStart(2, "0");
      index[`r${week}`] = {
        date: `2026-09-${day}T08:00:00Z`,
        sport_type: "Ride",
        has_streams: true,
        power_bests: { "180": 360, "300": 320, "480": 300, "600": 290, "1200": 270 },
        normalized_power: 220,
        average_watts: 200,
        max_watts: 700,
        average_heartrate: 140,
        max_heartrate: 170,
        moving_seconds: 3600,
        first_half: null,
        second_half: null,
      };
    }
    const activities = [
      ...Object.entries(index).map(([id, entry]) =>
        activity({ id, date: entry.date.slice(0, 19), moving_time: 1, average_heartrate: 140 }),
      ),
      activity({ id: "p1", date: "2026-10-20T18:00:00", type: "Pickleball", moving_time: 1.5, average_heartrate: 135, max_heartrate: 175 }),
      activity({ id: "w1", date: "2026-10-21T18:00:00", type: "Workout", moving_time: 0.5 }),
    ];
    const model = buildPerformanceModel(
      activities,
      index,
      { weightKg: 75, restingHr: 50, maxHr: 185, ftpOverride: null },
      today,
    );
    expect(model.ftp?.source).toBe("estimate");
    expect(model.loads.r0.source).toBe("power");
    expect(model.loads.p1.source).toBe("heart rate");
    expect(model.loads.p1.tss).toBeGreaterThan(0);
    expect(model.loads.w1).toEqual({ tss: 0.5 * 0.36 * 100, intensity: null, source: "estimate" });

    const series = fitnessSeries(activities, model.loads, today);
    const last = series.at(-1)!;
    expect(last.date).toBe("2026-10-27");
    expect(last.fitness).toBeGreaterThan(0);
    expect(last.fatigue).toBeGreaterThan(0);
  });
});

describe("zones", () => {
  it("weights samples by elapsed time and ignores pauses", () => {
    const time = [0, 10, 20, 500, 510];
    const watts = [100, 300, 300, 300, 300];
    const seconds = timeInZones(time, watts, 250, [{ upTo: 0.55 }, { upTo: 1.05 }, { upTo: Infinity }]);
    expect(seconds).toEqual([10, 0, 20]);
  });
});
