import { describe, expect, it } from "vitest";
import {
  activityDay,
  activityMonth,
  activityYear,
  formatCalendarDate,
  formatMetric,
  getActivityKind,
  localIsoDate,
  metricsFor,
  sportLabel,
} from "./activity-types";
import { activity } from "./test-fixtures";

describe("sports", () => {
  it("treats pickleball as its own sport, whatever base type Strava records", () => {
    expect(getActivityKind("Pickleball")).toBe("Pickleball");
    expect(getActivityKind("VirtualRide")).toBe("Ride");
    expect(getActivityKind("GravelRide")).toBe("Ride");
    expect(getActivityKind("TrailRun")).toBe("Run");
    expect(getActivityKind("Hike")).toBe("Walk");
    expect(getActivityKind("HighIntensityIntervalTraining")).toBe("Training");
    expect(getActivityKind("AlpineSki")).toBe("Other");
  });

  it("labels Strava sport types for people", () => {
    expect(sportLabel("HighIntensityIntervalTraining")).toBe("HIIT");
    expect(sportLabel("VirtualRide")).toBe("Virtual ride");
    expect(sportLabel("WeightTraining")).toBe("Weight training");
  });

  it("offers only the metrics that make sense for a sport", () => {
    expect(metricsFor("Ride")).toEqual(["distance", "elevation", "time", "sessions"]);
    expect(metricsFor("Pickleball")).toEqual(["time", "sessions"]);
    expect(metricsFor("Swim")).toEqual(["distance", "time", "sessions"]);
  });

  it("formats metric values with consistent separators", () => {
    expect(formatMetric(1_183_155.8, "elevation")).toBe("1,183,156 ft");
    expect(formatMetric(3782, "distance")).toBe("3,782 mi");
    expect(formatMetric(1.5, "time")).toBe("1h 30m");
  });
});

describe("calendar dates", () => {
  it("reads wall-clock dates without shifting them into the viewer's timezone", () => {
    // The test script runs in America/Los_Angeles, where parsing this as UTC
    // would move the ride to December 31 of the previous year.
    const ride = activity({ id: "4", date: "2026-01-01T06:30:00", distance: 20 });
    expect(activityYear(ride)).toBe(2026);
    expect(activityMonth(ride)).toBe(0);
    expect(activityDay(ride)).toBe(1);
    expect(formatCalendarDate(ride.date)).toBe("1/1/2026");
    expect(formatCalendarDate("2026-10-26", { month: "short", day: "numeric" })).toBe("Oct 26");
    expect(formatCalendarDate("not a date")).toBe("—");
  });

  it("formats today's local date for new records", () => {
    expect(localIsoDate(new Date(2026, 9, 26, 23, 30))).toBe("2026-10-26");
  });
});
