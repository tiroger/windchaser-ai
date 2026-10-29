import { describe, expect, it } from "vitest";

import { segmentAt } from "@/test/segments";

import type { WindChance } from "./chances";
import {
  BRIEFING_BODY_LIMIT,
  bodyBytes,
  briefingPayload,
  MAX_BRIEFED_SEGMENTS,
  MAX_NEAR_MISSES,
  sanitizePayload,
} from "./briefing-evidence";
import { evidenceHash, templateBriefing, buildPrompt, type BriefingInput } from "./server/briefing";
import { formatDelta, formatDuration } from "./geo";
import { formatHours } from "./training/activity-types";
import type { RankedRoute } from "./training/route-ranking";
import type { Evaluation, Segment, SegmentRecord } from "./types";

const evaluation = (predicted: number, pBeat: number | null, overrides: Partial<Evaluation> = {}): Evaluation =>
  ({
    predicted_time_s: predicted,
    p_beat: pBeat,
    score: 0.6431,
    effective_tailwind_ms: 1.4637,
    mean_crosswind_ms: 0.8123,
    sigma_s: 12.3,
    weather: {
      wind_speed_ms: 4.27,
      wind_from_deg: 41.6,
      gust_ms: 6.04,
      temperature_c: 17.66,
      precip_prob: 4,
      precip_mm: 0,
      air_density: 1.21,
    },
    ...overrides,
  }) as Evaluation;

const record = (overrides: Partial<SegmentRecord> = {}): SegmentRecord => ({
  pr_elapsed_s: 603,
  pr_date: "2023-03-17",
  pr_activity_id: "1",
  soft: false,
  model_error_s: 20,
  model_error_source: "attempts",
  still_air: { best_s: 591.4, best_date: "2023-03-17", best_activity_id: "1", count: 65, pr_rank: 7, check: "worse", top: [] },
  ...overrides,
});

const hawk = segmentAt(229781, [37.83, -122.49], {
  name: "Hawk Hill",
  distance_m: 2661.7,
  average_grade: 6.84,
  pr_elapsed_time: 603,
  best_moving_time_s: 600,
  record: record(),
});
const montebello = segmentAt(627158, [37.29, -122.1], { name: "Montebello", record: record({ soft: true, still_air: null }) });
const twinPeaks = segmentAt(811512, [37.76, -122.45], { name: "Twin Peaks Blvd from Clarendon", pr_elapsed_time: 318 });

const chance = (segment: Segment, predicted: number, gap: number, pBeat: number, time: string): WindChance =>
  ({ segment, segmentId: segment.id, predictedSeconds: predicted, gapSeconds: gap, pBeat, time, hourIndex: 0 }) as WindChance;

const route = (overrides: Partial<RankedRoute> = {}): RankedRoute =>
  ({
    id: "3149747571858540334",
    name: "One More City Century",
    distance_mi: 99.84,
    start: "2026-10-29T12:00",
    start_label: "Tomorrow 12 PM",
    time_s: 20761.6,
    calm_s: 21243.2,
    saved_s: 481.6,
    tail_share: 0.5631,
    before_sunset: true,
    ...overrides,
  }) as RankedRoute;

function payload(overrides: { route?: RankedRoute | null } = {}) {
  return briefingPayload({
    regionName: "Sausalito, CA",
    athleteName: "Roger",
    timezone: "America/Los_Angeles",
    blockedCount: 3,
    ranked: [
      { segment: montebello, evaluation: evaluation(2366, 1), whenIso: "2026-11-02T11:00" },
      { segment: hawk, evaluation: evaluation(646.3, 0.08), whenIso: "2026-11-02T12:00" },
      { segment: twinPeaks, evaluation: evaluation(289.2, 0.96), whenIso: "2026-11-01T13:00" },
    ],
    closest: [
      chance(montebello, 2366, -570, 1, "2026-11-02T11:00"),
      chance(hawk, 646.3, 43.3, 0.08, "2026-11-02T12:00"),
    ],
    route: overrides.route === null ? null : { route: overrides.route ?? route(), day: "tomorrow" },
  });
}

const input = (p = payload()): BriefingInput => ({ ...p, now: new Date("2026-10-29T05:00:00Z"), timezone: "UTC" });

describe("briefing evidence", () => {
  it("copies every number from the computed inputs, leaving soft records out", () => {
    const p = payload();
    expect(p.ranked.map((r) => r.segment.name)).toEqual(["Hawk Hill", "Twin Peaks Blvd from Clarendon"]);
    expect(p.nearMisses.map((m) => m.name)).toEqual(["Hawk Hill"]);
    const [h] = p.ranked;
    expect(h.segment).toEqual({
      id: 229781,
      name: "Hawk Hill",
      distance_m: 2662,
      average_grade: 6.8,
      target_time_s: 600,
      still_air: { best_s: 591.4, pr_s: 603, pr_rank: 7, count: 65, rough: true },
    });
    expect(h.evaluation).toMatchObject({ predicted_time_s: 646.3, p_beat: 0.08, effective_tailwind_ms: 1.5 });
    expect(p.nearMisses[0]).toEqual({
      name: "Hawk Hill",
      when: "2026-11-02T12:00",
      predicted_s: 646.3,
      target_s: 603,
      gap_s: 43.3,
      p_beat: 0.08,
    });
    expect(p.route).toEqual({
      name: "One More City Century",
      day: "tomorrow",
      distance_mi: 99.8,
      start_label: "Tomorrow 12 PM",
      predicted_s: 20762,
      calm_s: 21243,
      saved_s: 482,
      tail_pct: 56,
      before_sunset: true,
    });
  });

  it("puts no number in the prompt that cannot be traced to the evidence", () => {
    const p = payload();
    // Every rendering the prompt may use, of every figure in the evidence.
    const renderings: string[] = [p.regionName, String(p.blockedCount)];
    const add = (value: number) =>
      renderings.push(
        String(value),
        value.toFixed(0),
        value.toFixed(1),
        formatDuration(value),
        formatDelta(value),
        formatHours(value / 3600),
        String(Math.round(value * 100)),
        String(Math.round(value / 60)),
        String(Math.round(Math.abs(value) / 60)),
      );
    for (const r of p.ranked) {
      renderings.push(r.segment.name, r.whenIso);
      [r.segment.distance_m / 1000, r.segment.average_grade, r.segment.target_time_s ?? 0, r.evaluation.predicted_time_s,
        r.evaluation.predicted_time_s - (r.segment.target_time_s ?? 0), r.evaluation.p_beat ?? 0,
        r.evaluation.effective_tailwind_ms, r.evaluation.mean_crosswind_ms, ...Object.values(r.evaluation.weather)].forEach(add);
      const sa = r.segment.still_air;
      if (sa) [sa.best_s, sa.pr_s, sa.pr_rank ?? 0, sa.count].forEach(add);
    }
    for (const m of p.nearMisses) {
      renderings.push(m.name, m.when);
      [m.predicted_s, m.target_s, m.gap_s, m.p_beat].forEach(add);
    }
    if (p.route) {
      renderings.push(p.route.name, p.route.start_label);
      [p.route.distance_mi, p.route.predicted_s, p.route.calm_s, p.route.saved_s, p.route.tail_pct].forEach(add);
    }
    const allowed = new Set(renderings.join(" ").match(/\d+(?:[.:]\d+)*/g));
    // Hours of day from the windows' wall-clock times.
    for (const time of [...p.ranked.map((r) => r.whenIso), ...p.nearMisses.map((m) => m.when)]) {
      const hour = Number(time.slice(11, 13));
      allowed.add(String(hour % 12 || 12));
    }

    const prompt = buildPrompt(input(p))
      .split("\n")
      .filter((line) => !line.startsWith("Local time now:"))
      .join("\n");
    const numbers = prompt.match(/\d+(?:[.:]\d+)*/g) ?? [];
    expect(numbers.length).toBeGreaterThan(20);
    const untraced = numbers.filter((n) => !allowed.has(n));
    expect(untraced).toEqual([]);
    expect(prompt).toContain("rough here");
    expect(prompt).toContain("One More City Century");
    expect(prompt).not.toContain("Montebello");
  });

  it("changes the evidence hash when the route window changes, and only then", () => {
    const base = evidenceHash(input());
    expect(evidenceHash(input())).toBe(base);
    expect(evidenceHash(input(payload({ route: route({ start_label: "Tomorrow 1 PM" }) })))).not.toBe(base);
    expect(evidenceHash(input(payload({ route: route({ saved_s: 300 }) })))).not.toBe(base);
    expect(evidenceHash(input(payload({ route: null })))).not.toBe(base);
  });

  it("stays under Amplify's body limit with worst-case inputs", () => {
    const long = "W".repeat(400);
    const rows = Array.from({ length: 30 }, (_, i) => {
      const segment = segmentAt(1_000_000_000 + i, [37.8, -122.4], {
        name: `${long} ${i}`,
        distance_m: 123456.789,
        average_grade: 12.3456789,
        pr_elapsed_time: 99999.999,
        best_moving_time_s: 99998.123,
        record: record({ still_air: { ...record().still_air!, best_s: 99999.987, count: 9999, pr_rank: 9999 } }),
      });
      return { segment, evaluation: evaluation(99999.123456, 0.123456789), whenIso: "2026-11-02T12:00:00.000Z" };
    });
    const worst = briefingPayload({
      regionName: long,
      athleteName: long,
      timezone: "America/Argentina/ComodRivadavia",
      blockedCount: 168 * 30,
      ranked: rows,
      closest: rows.map((r) => chance(r.segment, 99999.123, 9999.987, 0.123456, "2026-11-02T12:00")),
      route: { route: route({ name: long, start_label: long, distance_mi: 1234.5678 }), day: "weekend" },
    });
    expect(worst.ranked).toHaveLength(MAX_BRIEFED_SEGMENTS);
    expect(worst.nearMisses).toHaveLength(MAX_NEAR_MISSES);
    const bytes = bodyBytes(worst);
    expect(bytes).toBeLessThan(BRIEFING_BODY_LIMIT);
    // The server applies the same caps to whatever a browser sends.
    const resent = sanitizePayload({ ...worst, ranked: [...worst.ranked, ...worst.ranked], nearMisses: [...worst.nearMisses, ...worst.nearMisses] });
    expect(bodyBytes(resent)).toBeLessThanOrEqual(bytes);
  });

  it("drops malformed fields rather than passing them to the model", () => {
    const clean = sanitizePayload({
      regionName: 7,
      ranked: [{ segment: { name: "x" } }, { segment: { name: "Real", target_time_s: "600" }, evaluation: { weather: {} }, whenIso: "2026-11-02T12:00" }],
      nearMisses: [null, { name: "Miss", gap_s: Infinity }],
      route: { name: "Loop", day: "someday" },
    })!;
    expect(clean.regionName).toBe("your area");
    expect(clean.ranked).toHaveLength(1);
    expect(clean.ranked[0].segment.target_time_s).toBeNull();
    expect(clean.nearMisses[0].gap_s).toBe(0);
    expect(clean.route?.day).toBe("today");
    expect(sanitizePayload({ ranked: "no" })).toBeNull();
  });

  it("has the template mention the best route", () => {
    const briefing = templateBriefing(input());
    expect(briefing.body).toContain("One More City Century (99.8 mi)");
    expect(briefing.body).toContain("tomorrow");
    expect(briefing.body).toContain("8 min faster than in calm air");
    expect(briefing.headline).toBe("Monday 12 PM on Hawk Hill");
    expect(templateBriefing(input(payload({ route: null }))).body).not.toContain("route");
  });
});
