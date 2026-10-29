import { describe, expect, it } from "vitest";

import { segmentAt } from "@/test/segments";

import { rideableHours, targetSeconds, weekChances } from "./chances";
import { evaluate, normalCdf } from "./physics";
import type { Evaluation, ForecastCell, Segment } from "./types";

const HOURS = 72;
/** Wall-clock hours in the cell's zone, as Open-Meteo returns them. */
const times = Array.from({ length: HOURS }, (_, h) => {
  const t = new Date(Date.UTC(2026, 9, 29, h));
  return t.toISOString().slice(0, 16);
});

/** Three days at Hawk Hill: a steady wind that swings round through north each afternoon. */
const cell: ForecastCell = {
  cell_id: "37.80,-122.50",
  latitude: 37.8,
  longitude: -122.5,
  timezone: "America/Los_Angeles",
  utc_offset_seconds: -25200,
  issued_at: "2026-10-29T00:00",
  time: times,
  temperature_c: times.map(() => 15),
  humidity_pct: times.map(() => 60),
  pressure_hpa: times.map(() => 1013),
  precip_mm: times.map(() => 0),
  precip_prob: times.map((_, h) => (h >= 48 ? 80 : 5)),
  wind_speed_ms: times.map(() => 6),
  wind_from_deg: times.map((_, h) => ((h % 24) * 15 + 180) % 360),
  gust_ms: times.map(() => 8),
};

const NOW = Date.parse("2026-10-29T07:00:00Z");

function setup(overrides: Partial<Segment>[] = [{}]) {
  const segments = overrides.map((o, i) =>
    segmentAt(i + 1, [37.83 + i * 0.002, -122.49], { cell_id: cell.cell_id, ...o }),
  );
  const matrix = new Map<number, Evaluation[]>(
    segments.map((s) => [s.id, times.map((_, h) => evaluate(s, cell, h))]),
  );
  return { segments, matrix, cellFor: () => cell };
}

describe("week chances on the wind view's own evaluations", () => {
  it("reports each chance with the evaluation's predicted time and probability for that hour", () => {
    // A record the forecast can reach: within the margin of the fastest daylight hour.
    const probe = setup();
    const series = probe.matrix.get(1)!;
    const fastest = Math.min(
      ...rideableHours(probe.segments[0], probe.matrix, probe.cellFor, NOW).map((h) => series[h].predicted_time_s),
    );
    const { segments, matrix, cellFor } = setup([{ pr_elapsed_time: Math.round(fastest + 2) }]);

    const week = weekChances(segments, matrix, cellFor, NOW);

    expect(week.chances.length).toBeGreaterThan(0);
    for (const chance of week.chances) {
      const ev = matrix.get(chance.segmentId)![chance.hourIndex];
      expect(chance.time).toBe(times[chance.hourIndex]);
      expect(chance.predictedSeconds).toBe(ev.predicted_time_s);
      expect(chance.pBeat).toBeCloseTo(ev.p_beat!, 10);
      expect(chance.gapSeconds).toBeCloseTo(ev.predicted_time_s - targetSeconds(chance.segment)!, 10);
    }
  });

  it("measures against the target evaluate() uses: best moving time over Strava's PR", () => {
    const { segments, matrix, cellFor } = setup([{ pr_elapsed_time: 400, best_moving_time_s: 200 }]);
    expect(targetSeconds(segments[0])).toBe(200);
    const [closest] = weekChances(segments, matrix, cellFor, NOW).closest;
    const ev = matrix.get(1)![closest.hourIndex];
    expect(closest.pBeat).toBeCloseTo(normalCdf((200 - ev.predicted_time_s) / ev.sigma_s), 10);
  });

  it("names only hours that can be ridden: daylight, not wet, not past", () => {
    const { segments, matrix, cellFor } = setup([{ pr_elapsed_time: 99999 }]);
    const hours = rideableHours(segments[0], matrix, cellFor, NOW);
    expect(hours.length).toBeGreaterThan(0);
    for (const h of hours) {
      const hourOfDay = Number(times[h].slice(11, 13));
      expect(hourOfDay).toBeGreaterThanOrEqual(7);
      expect(hourOfDay).toBeLessThanOrEqual(18); // sunset is after 6 PM here in late October
      expect(h).toBeLessThan(48); // the wet third day is out
      expect(Date.parse(`${times[h]}:00Z`) + 7 * 3_600_000).toBeGreaterThanOrEqual(NOW - 3_600_000);
    }
  });

  it("lists a soft record apart, never as a chance", () => {
    const probe = setup();
    const series = probe.matrix.get(1)!;
    const fastest = Math.min(
      ...rideableHours(probe.segments[0], probe.matrix, probe.cellFor, NOW).map((h) => series[h].predicted_time_s),
    );
    const { segments, matrix, cellFor } = setup([
      { pr_elapsed_time: Math.round(fastest + 2), record: { soft: true } as Segment["record"] },
    ]);
    const week = weekChances(segments, matrix, cellFor, NOW);
    expect(week.chances).toEqual([]);
    expect(week.closest).toEqual([]);
    expect(week.soft.map((c) => c.segmentId)).toEqual([1]);
  });
});
