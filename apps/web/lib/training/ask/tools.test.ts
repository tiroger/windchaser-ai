import { describe, expect, it } from "vitest";

import { askData } from "./test-data";
import { matchEffortActivity, runTool, TOOL_DEFINITIONS, TOOL_NAMES } from "./tools";
import type { ToolOutcome } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function ok(name: string, input: unknown): Promise<Json> {
  const outcome = await runTool(name, input, askData());
  if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error}`);
  expect(outcome.summary.length).toBeGreaterThan(0);
  return outcome.result;
}

async function fails(name: string, input: unknown): Promise<string> {
  const outcome = await runTool(name, input, askData());
  expect(outcome.ok).toBe(false);
  return (outcome as Extract<ToolOutcome, { ok: false }>).error;
}

describe("tool definitions", () => {
  it("are listed in a fixed order with object schemas", () => {
    expect(TOOL_NAMES).toEqual([
      "search_activities",
      "totals",
      "goals_status",
      "performance",
      "gear_and_maintenance",
      "segment_efforts",
      "activity_detail",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.description!.length).toBeGreaterThan(80);
    }
    // Serialization is stable, so the cached prefix is byte-identical.
    expect(JSON.stringify(TOOL_DEFINITIONS)).toBe(JSON.stringify(TOOL_DEFINITIONS));
  });
});

describe("argument validation", () => {
  it("rejects unknown tools, unknown fields, wrong types and out-of-range values", async () => {
    expect(await fails("drop_tables", {})).toMatch(/Unknown tool/);
    expect(await fails("search_activities", { colour: "red" })).toMatch(/colour is not a known field/);
    expect(await fails("search_activities", { limit: 100 })).toMatch(/limit must be at most 25/);
    expect(await fails("search_activities", { limit: 2.5 })).toMatch(/integer/);
    expect(await fails("search_activities", { sport: "Rowing" })).toMatch(/must be one of/);
    expect(await fails("search_activities", { from: "Oct 1" })).toMatch(/expected format/);
    expect(await fails("activity_detail", {})).toMatch(/activity_id is required/);
    expect(await fails("activity_detail", { activity_id: "../etc" })).toMatch(/expected format/);
    expect(await fails("totals", "everything")).toMatch(/must be an object/);
  });

  it("rejects impossible dates and inverted ranges", async () => {
    expect(await fails("search_activities", { from: "2026-02-30" })).toMatch(/not a real calendar date/);
    expect(await fails("search_activities", { from: "2026-10-10", to: "2026-10-01" })).toMatch(/from must not be after to/);
    expect(await fails("totals", { period: "custom", from: "2026-01-01" })).toMatch(/from and to are required/);
    expect(await fails("totals", { period: "month" })).toMatch(/month \(1-12\) is required/);
    expect(await fails("totals", { period: "year", year: 2027 })).toMatch(/has not started yet/);
  });

  it("treats explicit nulls as omitted", async () => {
    const result = await ok("search_activities", { sport: null, limit: null });
    expect(result.returned).toBe(10);
  });
});

describe("search_activities", () => {
  it("sorts by distance within a sport", async () => {
    const result = await ok("search_activities", { sport: "Ride", sort_by: "distance", limit: 2 });
    expect(result.matched).toBe(7);
    expect(result.activities.map((row: Json) => row.id)).toEqual(["1009", "1006"]);
    expect(result.activities[0]).toMatchObject({ distance_mi: 100, time: "6h 0m", gear: "TIE Strider" });
  });

  it("finds a bike's activities by its model, not just its nickname", async () => {
    const result = await ok("search_activities", { gear: "TCR" });
    expect(result.activities.map((row: Json) => row.id)).toEqual(["1001", "1005"]);
  });

  it("sorts by power and says how many had none", async () => {
    const result = await ok("search_activities", { sport: "Ride", sort_by: "power" });
    expect(result.activities.map((row: Json) => row.id)).toEqual(["1010", "1001", "1002"]);
    expect(result.skipped_without_power).toBe(4);
  });

  it("explains an unknown bike instead of returning nothing", async () => {
    const result = await ok("search_activities", { gear: "Pinarello" });
    expect(result.matched).toBe(0);
    expect(result.known_gear).toContain("Vader Velo (Giant TCR)");
  });
});

describe("totals", () => {
  it("sums a month for one sport without distance for pickleball", async () => {
    const result = await ok("totals", { period: "month", year: 2026, month: 9, sport: "Pickleball" });
    expect(result.totals).toMatchObject({ sessions: 2, time_h: 3.5, time: "3h 30m" });
    expect(result.totals.distance_mi).toBeUndefined();
  });

  it("compares an in-progress month like for like across years", async () => {
    const result = await ok("totals", { period: "month", year: 2026, month: 10, sport: "Ride", compare_years: true });
    expect(result.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31", in_progress: true, through: "2026-10-15" });
    expect(result.totals).toMatchObject({ sessions: 3, distance_mi: 100, time_h: 6, kj: 4000 });
    const byYear = Object.fromEntries(result.comparison.by_year.map((row: Json) => [row.year, row]));
    expect(Object.keys(byYear)).toEqual(["2024", "2025", "2026"]);
    expect(byYear[2025].full).toMatchObject({ sessions: 2, distance_mi: 100 });
    expect(byYear[2025].to_date).toMatchObject({ sessions: 1, distance_mi: 40 });
    expect(result.comparison.best_full.time_h).toEqual({ year: 2025, value: 6.5 });
    expect(result.comparison.best_to_date.distance_mi).toEqual({ year: 2026, value: 100 });
  });

  it("groups by sport and resolves a Monday-to-Sunday week", async () => {
    const result = await ok("totals", { period: "week", week_of: "2026-10-14" });
    expect(result.period).toMatchObject({ from: "2026-10-12", to: "2026-10-18" });
    expect(result.by_sport).toEqual([expect.objectContaining({ sport: "Ride", sessions: 1, distance_mi: 20 })]);
  });
});

describe("goals_status", () => {
  it("reports a set goal with pace and weekly need", async () => {
    const result = await ok("goals_status", { sport: "Ride" });
    const distance = result.goals.find((goal: Json) => goal.metric === "distance");
    expect(distance).toMatchObject({ goal: 4000, goal_source: "set by the rider", actual: 100, status: "behind pace" });
    expect(distance.needed_per_week).toBeGreaterThan(0);
    expect(result.day_of_year).toBe(288);
  });
});

describe("performance", () => {
  it("returns FTP, a windowed power curve and training load", async () => {
    const result = await ok("performance", { window: "year", on_date: "2026-10-02" });
    expect(result.ftp.source).toMatch(/estimated/);
    expect(result.ftp.watts).toBeLessThanOrEqual(228);
    const fiveSeconds = result.power_curve.best_efforts.find((point: Json) => point.duration === "5s");
    expect(fiveSeconds).toMatchObject({ watts: 800, activity_id: "1001", watts_per_kg: 11.43 });
    expect(result.power_curve.from).toBe("2026-01-01");
    expect(result.training_load.today.date).toBe("2026-10-15");
    expect(result.training_load.on_date.date).toBe("2026-10-02");
  });

  it("returns an empty curve for a window without power", async () => {
    const result = await ok("performance", { window: "custom", from: "2020-01-01", to: "2020-12-31" });
    expect(result.power_curve.best_efforts).toEqual([]);
  });
});

describe("gear_and_maintenance", () => {
  it("finds the TCR's wax record and its service schedules", async () => {
    const result = await ok("gear_and_maintenance", { bike: "TCR", part: "wax" });
    expect(result.gear).toEqual([expect.objectContaining({ name: "Vader Velo", brand_model: "Giant TCR", miles_2026: 30 })]);
    expect(result.maintenance.records).toEqual([
      expect.objectContaining({ date: "2026-08-01", service: "Hot Wax", miles_since: 270 }),
    ]);
    expect(result.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: "Chain hot wax", remaining: "730 mi", overdue: false }),
        expect.objectContaining({ service: "Tire replacement", remaining: "1230 mi" }),
      ]),
    );
  });

  it("lists active bikes only by default and says when the log is empty", async () => {
    const result = await ok("gear_and_maintenance", {});
    expect(result.gear.map((gear: Json) => gear.name)).toEqual(["Vader Velo", "TIE Strider"]);
    const empty = await runTool("gear_and_maintenance", {}, askData({ maintenance: [] }));
    expect(empty.ok && (empty.result as Json).notes).toContain(
      "The maintenance log is empty: no services have been recorded.",
    );
  });
});

describe("segment_efforts", () => {
  it("ranks a segment's efforts and links the best one to its ride", async () => {
    const result = await ok("segment_efforts", { segment: "hawk" });
    const [segment] = result.segments;
    expect(segment).toMatchObject({ name: "Hawk Hill", attempts: 3, strava_pr: "10:00" });
    expect(segment.personal_best).toMatchObject({ rank: 1, time: "10:00", activity_id: "1005" });
    expect(segment.efforts.map((effort: Json) => effort.rank)).toEqual([1, 2, 3]);
    expect(result.efforts_data_as_of).toBe("2026-10-14");
  });

  it("lists the efforts on one activity with their rank", async () => {
    const result = await ok("segment_efforts", { activity_id: "1001" });
    expect(result.efforts).toEqual([
      expect.objectContaining({ rank: 2, of_attempts: 3, is_personal_best: false, time: "10:40" }),
    ]);
  });

  it("lists segments when nothing is named, and explains a miss", async () => {
    const list = await ok("segment_efforts", {});
    expect(list.segments.map((segment: Json) => segment.name)).toEqual(["Hawk Hill", "Four Horsemen"]);
    const miss = await ok("segment_efforts", { segment: "Alpe" });
    expect(miss.known_segments).toContain("Hawk Hill");
  });

  it("matches an effort to the ride it happened in by time", () => {
    const data = askData();
    const effort = { segment_id: 1, start_date: "2026-10-10T15:10:00Z", elapsed_time_s: 1, moving_time_s: 1, distance_m: 1, average_watts: null, device_watts: false, average_heartrate: null, cell_id: "37.8,-122.4", weather: null };
    expect(matchEffortActivity(effort, data.activities)?.id).toBe("1002");
    expect(matchEffortActivity({ ...effort, start_date: "2026-10-11T15:10:00Z" }, data.activities)).toBeNull();
  });
});

describe("activity_detail", () => {
  it("returns the summary and analysis of one ride", async () => {
    const result = await ok("activity_detail", { activity_id: "1001" });
    expect(result).toMatchObject({ name: "Morning ride", sport: "Ride", link: "/training/activities/1001" });
    expect(result.training_load.source).toBe("power");
    expect(result.analysis.normalized_power).toBe(210);
    expect(result.analysis.aerobic_decoupling_pct).toBe(11.9);
  });

  it("errors on an unknown id", async () => {
    expect(await fails("activity_detail", { activity_id: "42" })).toMatch(/No activity with id 42/);
  });
});

describe("privacy", () => {
  it("never returns coordinates or routes", async () => {
    const data = askData();
    const calls: Array<[string, unknown]> = [
      ["search_activities", { limit: 25 }],
      ["totals", { period: "year", compare_years: true }],
      ["goals_status", {}],
      ["performance", { window: "all_time" }],
      ["gear_and_maintenance", { include_retired: true, include_shoes: true }],
      ["segment_efforts", { segment: "hawk" }],
      ["segment_efforts", { activity_id: "1001" }],
      ["activity_detail", { activity_id: "1001" }],
    ];
    for (const [name, input] of calls) {
      const outcome = await runTool(name, input, data);
      expect(outcome.ok).toBe(true);
      expect(JSON.stringify(outcome)).not.toMatch(/latlng|polyline|cell_id|"points"|-122\./);
    }
  });
});
