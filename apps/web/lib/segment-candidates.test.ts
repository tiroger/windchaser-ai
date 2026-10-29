import { describe, expect, it } from "vitest";

import { segmentAt } from "@/test/segments";

import {
  ageWeight,
  buildRegions,
  mergeCandidates,
  normaliseState,
  parseUsage,
  RANK_FLOOR,
  rankFactor,
  rankScore,
  RECENCY_HALF_LIFE_DAYS,
  regionName,
  ridingFromDates,
} from "./segment-candidates";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const HAWK: [number, number] = [37.83, -122.49];
const TWIN: [number, number] = [37.75, -122.45];
const OAKLAND: [number, number] = [37.8, -122.19];
const NYACK: [number, number] = [41.09, -73.92];

describe("mergeCandidates", () => {
  it("lists each segment once, marked with every source it came from", () => {
    const starredHawk = segmentAt(1, HAWK, { city: "Sausalito", state: "California", pr_elapsed_time: 400 });
    const trackedHawk = segmentAt(1, HAWK, {
      source: "tracked",
      pr_elapsed_time: 380,
      pr_date: "2026-10-16",
      riding: ridingFromDates([daysAgo(12), daysAgo(40)], NOW),
      record: { pr_elapsed_s: 380 } as never,
    });
    const trackedOnly = segmentAt(2, TWIN, { source: "tracked", riding: ridingFromDates([daysAgo(400)], NOW) });
    const discovered = segmentAt(3, OAKLAND, { source: "discovered" });
    const discoveredDup = segmentAt(2, TWIN, { source: "discovered" });

    const merged = mergeCandidates(
      { starred: [starredHawk], tracked: [trackedHawk, trackedOnly], discovered: [discovered, discoveredDup] },
      new Map(),
      NOW,
    );

    expect(merged.map((s) => s.id).sort()).toEqual([1, 2, 3]);
    const hawk = merged.find((s) => s.id === 1)!;
    expect(hawk.source).toBe("starred");
    expect(hawk.sources).toEqual(["starred", "tracked"]);
    // Strava's town survives; the effort history's PR and riding replace the stale starred copy.
    expect(hawk.city).toBe("Sausalito");
    expect(hawk.pr_elapsed_time).toBe(380);
    expect(hawk.riding?.attempts).toBe(2);
    expect(hawk.record?.pr_elapsed_s).toBe(380);
    expect(merged.find((s) => s.id === 2)!.sources).toEqual(["tracked", "discovered"]);
    expect(merged.find((s) => s.id === 3)!.sources).toEqual(["discovered"]);
  });

  it("does not mutate its inputs", () => {
    const starred = segmentAt(1, HAWK);
    mergeCandidates({ starred: [starred], tracked: [segmentAt(1, HAWK, { source: "tracked" })] }, new Map(), NOW);
    expect(starred.sources).toBeUndefined();
  });

  it("drops a candidate with no line to forecast on", () => {
    const merged = mergeCandidates({ discovered: [segmentAt(9, HAWK, { points: [HAWK] })] }, new Map(), NOW);
    expect(merged).toEqual([]);
  });

  it("adds usage counted by the worker to whichever candidate it matches", () => {
    const usage = parseUsage({
      segments: {
        "5": { id: 5, name: "Grizzly Peak", start: [37.88, -122.24], count: 6, last_ridden: daysAgo(3) },
        "6": { id: 6, count: 0 },
        bad: null,
      },
    });
    expect([...usage.keys()]).toEqual([5]);
    const merged = mergeCandidates({ starred: [segmentAt(5, [37.88, -122.24])] }, usage, NOW);
    expect(merged[0].riding?.attempts).toBe(6);
    expect(merged[0].riding?.recent).toBeGreaterThan(5.5);
  });
});

describe("recency weighting", () => {
  it("halves an effort's weight every half-life", () => {
    expect(ageWeight(daysAgo(0), NOW)).toBeCloseTo(1);
    expect(ageWeight(daysAgo(RECENCY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5);
    expect(ageWeight(daysAgo(2 * RECENCY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.25);
  });

  it("ranks a segment ridden lately above an equal score never ridden, without changing the score", () => {
    const lately = ridingFromDates([daysAgo(5), daysAgo(20), daysAgo(30)], NOW);
    const longAgo = ridingFromDates(Array.from({ length: 30 }, (_, i) => daysAgo(1500 + i)), NOW);
    expect(rankFactor(null)).toBe(RANK_FLOOR);
    expect(rankFactor(lately)).toBe(1);
    // Thirty efforts four years ago count for less than three this month.
    expect(rankFactor(longAgo)).toBeLessThan(rankFactor(lately));
    expect(rankScore(0.6, lately)).toBeGreaterThan(rankScore(0.6, longAgo));
    // A much better window still wins: the weighting tilts, it does not override.
    expect(rankScore(0.9, null)).toBeGreaterThan(rankScore(0.6, lately));
  });
});

describe("regions", () => {
  it("names a region after where the rider rides most, not the most common town", () => {
    const cupertino = [10, 11, 12].map((id) =>
      segmentAt(id, [37.29, -122.1], { city: "Cupertino", state: "CA" }),
    );
    const hawk = segmentAt(1, HAWK, {
      city: "Sausalito",
      state: "California",
      riding: ridingFromDates(Array.from({ length: 20 }, (_, i) => daysAgo(i * 7)), NOW),
    });
    const mcCullough = segmentAt(2, [37.84, -122.5], { city: "Sausalito", state: "CA" });
    expect(regionName([...cupertino, hawk, mcCullough])).toBe("Sausalito, CA");
    // With no riding anywhere, the most common town still wins.
    expect(regionName([...cupertino, segmentAt(3, HAWK, { city: "Sausalito", state: "CA" })])).toBe("Cupertino, CA");
    expect(regionName([segmentAt(4, HAWK)])).toBe("Unnamed region");
  });

  it("spells US states one way, so one town's votes are not split", () => {
    expect(normaliseState("California")).toBe("CA");
    expect(normaliseState("new york")).toBe("NY");
    expect(normaliseState("CA")).toBe("CA");
    expect(normaliseState("Andalucía")).toBe("Andalucía");
    expect(normaliseState("  ")).toBeNull();
  });

  it("orders regions by recent riding, so the first is where the rider rides now", () => {
    const newYork = Array.from({ length: 12 }, (_, i) =>
      segmentAt(100 + i, [NYACK[0] + i * 0.01, NYACK[1]], {
        city: "Nyack",
        state: "NY",
        riding: ridingFromDates([daysAgo(800)], NOW),
      }),
    );
    const bay = [
      segmentAt(1, HAWK, { city: "Sausalito", state: "CA", riding: ridingFromDates([daysAgo(3), daysAgo(10)], NOW) }),
      segmentAt(2, TWIN, { city: "San Francisco", state: "CA" }),
    ];
    const merged = mergeCandidates({ starred: [...newYork, ...bay] }, new Map(), NOW);
    const regions = buildRegions(merged);
    expect(regions.map((r) => r.name)).toEqual(["Sausalito, CA", "Nyack, NY"]);
    expect(regions[0]).toMatchObject({ id: "r0", segment_count: 2, starred_count: 2 });
    expect(merged.find((s) => s.id === 2)!.region_id).toBe("r0");
    expect(merged.find((s) => s.id === 100)!.region_id).toBe("r1");
  });
});
