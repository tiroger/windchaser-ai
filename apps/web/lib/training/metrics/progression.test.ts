import { describe, expect, it } from "vitest";
import { activity } from "../test-fixtures";
import { activeDays } from "./active-days";
import { defaultGoal, goalProgress, progression, yearPosition } from "./progression";

const today = { year: 2026, month: 9, day: 27 };

describe("progression", () => {
  const rides = [
    activity({ id: "1", date: "2025-01-10T08:00:00", distance: 30 }),
    activity({ id: "2", date: "2025-10-27T08:00:00", distance: 40 }),
    activity({ id: "3", date: "2025-12-31T08:00:00", distance: 50 }),
    activity({ id: "4", date: "2026-01-02T08:00:00", distance: 20 }),
    activity({ id: "5", date: "2026-10-27T06:00:00", distance: 25 }),
  ];
  const result = progression(rides, "distance", today);

  it("accumulates each year by day and stops this year at today", () => {
    const current = result.current!;
    expect(current.lastPosition).toBe(yearPosition(today));
    expect(current.total).toBe(45);
    expect(result.series[0].cumulative.at(-1)).toBe(120);
  });

  it("compares this year with last year on the same day", () => {
    expect(result.lastYearToDate).toBe(70);
  });

  it("projects the year at the current daily rate", () => {
    expect(result.onPace).toBeCloseTo((45 / yearPosition(today)) * 365);
  });

  it("names the best completed year", () => {
    expect(result.best).toEqual({ year: 2025, total: 120 });
  });

  it("lines February 29 up with February 28", () => {
    expect(yearPosition({ month: 1, day: 29 })).toBe(yearPosition({ month: 1, day: 28 }));
    expect(yearPosition({ month: 2, day: 1 })).toBe(60);
  });
});

describe("goals", () => {
  it("defaults to last year plus ten percent, rounded", () => {
    expect(defaultGoal(4321, "distance")).toBe(4750);
    expect(defaultGoal(180_000, "elevation")).toBe(198_000);
    expect(defaultGoal(0, "distance")).toBeNull();
  });

  it("measures progress against an even pace", () => {
    const progress = goalProgress(3650, 1500, 146);
    expect(progress.expected).toBeCloseTo(1460);
    expect(progress.delta).toBeCloseTo(40);
    expect(progress.neededPerWeek).toBeCloseTo((3650 - 1500) / ((365 - 146) / 7));
  });
});

describe("active days", () => {
  it("counts streaks across consecutive days and the current run", () => {
    const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-25", "2026-10-26", "2026-10-27"].map(
      (date, index) => activity({ id: String(index), date: `${date}T07:00:00`, type: index % 2 ? "Pickleball" : "Ride" }),
    );
    const summary = activeDays(days, 2026, today);
    expect(summary.activeDays).toBe(6);
    expect(summary.longestStreak).toBe(3);
    expect(summary.currentStreak).toBe(3);
    expect(summary.byKind.map((entry) => entry.kind).sort()).toEqual(["Pickleball", "Ride"]);
  });
});
