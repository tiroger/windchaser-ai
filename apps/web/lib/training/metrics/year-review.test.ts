import { describe, expect, it } from "vitest";

import { encodePolyline } from "../polyline";
import { activity } from "../test-fixtures";
import {
  buildYearReview,
  courtChapter,
  dayOfYear,
  defaultReviewYear,
  gearRace,
  inYear,
  longestBreak,
  longestStreak,
  placesSketch,
  reviewWindow,
  ringCalendar,
  routeSketch,
  simplify,
  streamLayers,
  timeOfDay,
  weekBucket,
  weekdayRhythm,
  weeklyStream,
  yearOverYear,
  yearSummary,
  type ReviewTotals,
} from "./year-review";

const totals = (overrides: Partial<ReviewTotals> = {}): ReviewTotals => ({
  activities: 180,
  distance: 3366.4,
  hours: 271.2,
  elevation: 170285,
  activeDays: 150,
  kudos: 0,
  kilojoules: 0,
  ...overrides,
});

describe("dates", () => {
  it("reads the day of the year from the wall-clock date", () => {
    expect(dayOfYear({ year: 2025, month: 0, day: 1 })).toBe(0);
    expect(dayOfYear({ year: 2025, month: 11, day: 31 })).toBe(364);
    expect(dayOfYear({ year: 2024, month: 11, day: 31 })).toBe(365);
  });

  it("counts a past year whole and the current year to today", () => {
    const today = { year: 2026, month: 9, day: 27 };
    expect(reviewWindow(2025, today)).toMatchObject({ partial: false, lastIndex: 364, through: "2025-12-31" });
    expect(reviewWindow(2026, today)).toMatchObject({ partial: true, through: "2026-10-27" });
  });

  it("limits last year to the same point when a cutoff is given", () => {
    const list = [
      activity({ id: "a", date: "2025-10-27T23:30:00" }),
      activity({ id: "b", date: "2025-10-28T00:10:00" }),
      activity({ id: "c", date: "2024-10-01T08:00:00" }),
    ];
    expect(inYear(list, 2025, { month: 9, day: 27 }).map((a) => a.id)).toEqual(["a"]);
    expect(inYear(list, 2025).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("opens on the last complete year, and on this year in December", () => {
    expect(defaultReviewYear([2024, 2025, 2026], { year: 2026, month: 9, day: 27 })).toBe(2025);
    expect(defaultReviewYear([2024, 2025, 2026], { year: 2026, month: 11, day: 2 })).toBe(2026);
    expect(defaultReviewYear([2026], { year: 2026, month: 3, day: 1 })).toBe(2026);
    expect(defaultReviewYear([], { year: 2026, month: 3, day: 1 })).toBeUndefined();
  });
});

describe("ring calendar", () => {
  const list = [
    activity({ id: "1", date: "2025-01-01T07:05:00", type: "Ride", moving_time: 2 }),
    activity({ id: "2", date: "2025-01-01T18:00:00", type: "Pickleball", moving_time: 1.5 }),
    activity({ id: "3", date: "2025-01-01T06:00:00", type: "Ride", moving_time: 1 }),
    activity({ id: "4", date: "2025-12-31T23:59:00", type: "Run", moving_time: 0.5 }),
    activity({ id: "5", date: "2024-12-31T10:00:00", type: "Ride", moving_time: 3 }),
  ];
  const ring = ringCalendar(list, 2025);

  it("groups by wall-clock day, not the host timezone", () => {
    expect(ring.map((day) => [day.index, day.date])).toEqual([
      [0, "2025-01-01"],
      [364, "2025-12-31"],
    ]);
  });

  it("stacks each day's sports in a fixed order and lists its activities by start", () => {
    expect(ring[0].hours).toBe(4.5);
    expect(ring[0].segments).toEqual([
      { kind: "Ride", hours: 3 },
      { kind: "Pickleball", hours: 1.5 },
    ]);
    expect(ring[0].activities.map((a) => a.time)).toEqual(["06:00", "07:05", "18:00"]);
  });
});

describe("streaks", () => {
  it("finds the longest run of consecutive days, earliest on a tie", () => {
    expect(longestStreak([1, 2, 3, 10, 11, 12, 20], 2025)).toEqual({
      length: 3,
      startIndex: 1,
      endIndex: 3,
      start: "2025-01-02",
      end: "2025-01-04",
    });
    expect(longestStreak([], 2025)).toBeNull();
    expect(longestStreak([5, 5, 6], 2025)?.length).toBe(2);
  });

  it("crosses the end of February in a leap year", () => {
    expect(longestStreak([58, 59, 60], 2024)).toMatchObject({ start: "2024-02-28", end: "2024-03-01" });
  });

  it("finds the longest rest between active days", () => {
    expect(longestBreak([0, 3, 20, 21], 2025)).toMatchObject({
      length: 16,
      start: "2025-01-05",
      end: "2025-01-20",
    });
    expect(longestBreak([4], 2025)).toBeNull();
  });
});

describe("time of day", () => {
  it("spreads moving time across the clock hours it covers", () => {
    const clock = timeOfDay([
      activity({ id: "1", date: "2025-05-01T07:30:00", moving_time: 2 }),
      activity({ id: "2", date: "2025-05-02T23:30:00", type: "Run", moving_time: 1 }),
      activity({ id: "3", date: "2025-05-03", moving_time: 5 }),
    ]);
    expect(clock.total[7]).toBeCloseTo(0.5);
    expect(clock.total[8]).toBeCloseTo(1);
    expect(clock.total[9]).toBeCloseTo(0.5);
    expect(clock.total[23]).toBeCloseTo(0.5);
    expect(clock.total[0]).toBeCloseTo(0.5);
    expect(clock.starts[7]).toBe(1);
    expect(clock.peakHour).toBe(8);
    expect(clock.byKind.map((entry) => entry.kind)).toEqual(["Ride", "Run"]);
    // The date-only activity has no clock time to place.
    expect(clock.total.reduce((a, b) => a + b, 0)).toBeCloseTo(3);
  });

  it("buckets weekdays Monday first", () => {
    const days = weekdayRhythm([
      activity({ id: "1", date: "2025-10-27T08:00:00", moving_time: 2 }), // Monday
      activity({ id: "2", date: "2025-11-02T08:00:00", moving_time: 1 }), // Sunday
    ]);
    expect(days[0]).toMatchObject({ label: "Mon", hours: 2, count: 1 });
    expect(days[6]).toMatchObject({ label: "Sun", hours: 1, count: 1 });
  });
});

describe("weekly sport stream", () => {
  it("divides the year into 52 buckets with the last absorbing the spare days", () => {
    expect(weekBucket(0, 365)).toBe(0);
    expect(weekBucket(7, 365)).toBe(0);
    expect(weekBucket(8, 365)).toBe(1);
    expect(weekBucket(364, 365)).toBe(51);
    expect(weekBucket(365, 366)).toBe(51);
  });

  it("sums hours per sport per week, largest sport first", () => {
    const stream = weeklyStream(
      [
        activity({ id: "1", date: "2025-01-02T08:00:00", type: "Pickleball", moving_time: 1 }),
        activity({ id: "2", date: "2025-01-03T08:00:00", type: "Ride", moving_time: 2 }),
        activity({ id: "3", date: "2025-06-03T08:00:00", type: "VirtualRide", moving_time: 4 }),
        activity({ id: "4", date: "2024-06-03T08:00:00", type: "Ride", moving_time: 9 }),
      ],
      2025,
    );
    expect(stream.series.map((entry) => [entry.kind, entry.total])).toEqual([
      ["Ride", 6],
      ["Pickleball", 1],
    ]);
    expect(stream.totals[0]).toBe(3);
    expect(stream.peak).toEqual({ week: weekBucket(dayOfYear({ year: 2025, month: 5, day: 3 }), 365), hours: 4 });
  });

  it("centres the stacked layers around zero", () => {
    const layers = streamLayers([
      [2, 0],
      [2, 4],
    ]);
    expect(layers[0]).toEqual({ lower: [-2, -2], upper: [0, -2] });
    expect(layers[1]).toEqual({ lower: [0, -2], upper: [2, 2] });
  });
});

describe("year over year", () => {
  it("compares totals and running monthly curves", () => {
    const now = [
      activity({ id: "1", date: "2025-01-05T08:00:00", distance: 30, moving_time: 2 }),
      activity({ id: "2", date: "2025-03-05T08:00:00", distance: 20, moving_time: 1 }),
    ];
    const then = [activity({ id: "3", date: "2024-02-05T08:00:00", distance: 40, moving_time: 2 })];
    const [distance, sessions, days] = yearOverYear(now, then, ["distance", "activities", "activeDays"], 3);
    expect(distance).toMatchObject({ current: 50, previous: 40, change: 0.25 });
    expect(distance.currentMonthly).toEqual([30, 30, 50]);
    expect(distance.previousMonthly).toEqual([0, 40, 40]);
    expect(sessions.change).toBe(1);
    expect(days.currentMonthly).toEqual([1, 1, 2]);
  });

  it("has no change when last year was empty", () => {
    const [entry] = yearOverYear([activity({ id: "1", date: "2025-01-05T08:00:00", distance: 3 })], [], ["distance"]);
    expect(entry.change).toBeNull();
  });
});

describe("summary sentence", () => {
  it("writes a finished year with its comparison and biggest month", () => {
    expect(
      yearSummary({
        year: 2025,
        filter: "All",
        partial: false,
        totals: totals(),
        previous: totals({ hours: 333 }),
        busiestMonth: 5,
      }),
    ).toBe(
      "In 2025 you covered 3,366 miles across 180 activities and climbed 170,285 ft — 19% less time on the move than 2024, with June the biggest month.",
    );
  });

  it("compares a single distance sport on miles, to this point last year", () => {
    expect(
      yearSummary({
        year: 2026,
        filter: "Ride",
        partial: true,
        totals: totals({ activities: 151, distance: 2800 }),
        previous: totals({ distance: 2000 }),
        busiestMonth: null,
      }),
    ).toBe(
      "So far in 2026 you've covered 2,800 miles across 151 rides and climbed 170,285 ft — 40% more miles than this time in 2025.",
    );
  });

  it("speaks in sessions and hours for pickleball", () => {
    expect(
      yearSummary({
        year: 2025,
        filter: "Pickleball",
        partial: false,
        totals: totals({ activities: 23, distance: 0, hours: 40.6, elevation: 0 }),
        previous: totals({ hours: 40 }),
        busiestMonth: 2,
      }),
    ).toBe(
      "In 2025 you played 23 sessions over 41 hours — about the same time as 2024, with March the biggest month.",
    );
  });

  it("handles an empty year", () => {
    expect(
      yearSummary({
        year: 2019,
        filter: "Run",
        partial: false,
        totals: totals({ activities: 0 }),
        previous: null,
        busiestMonth: null,
      }),
    ).toBe("No runs were logged in 2019.");
  });
});

describe("gear and pickleball", () => {
  it("races gear on running weekly miles", () => {
    const race = gearRace(
      [
        activity({ id: "1", date: "2025-01-02T08:00:00", distance: 10, gear_id: "b1" }),
        activity({ id: "2", date: "2025-12-30T08:00:00", distance: 25, gear_id: "b1" }),
        activity({ id: "3", date: "2025-03-02T08:00:00", distance: 30, gear_id: "b2" }),
        activity({ id: "4", date: "2025-03-02T08:00:00", distance: 30 }),
      ],
      [
        { id: "b1", name: "Strider", brand: "Storck", model: "Scenero", distance: 0, retired: false, kind: "bike" },
      ],
      2025,
    );
    expect(race.entries.map((entry) => [entry.name, entry.total])).toEqual([
      ["Strider", 35],
      ["Unnamed gear", 30],
    ]);
    expect(race.entries[0].cumulative[0]).toBe(10);
    expect(race.entries[0].cumulative[51]).toBe(35);
    expect(race.entries[0].detail).toBe("Storck Scenero");
  });

  it("summarises the court", () => {
    const court = courtChapter(
      [
        activity({ id: "1", date: "2025-03-02T18:00:00", type: "Pickleball", moving_time: 2, average_heartrate: 120 }),
        activity({ id: "2", date: "2025-03-09T18:00:00", type: "Pickleball", moving_time: 1, average_heartrate: 130 }),
        activity({ id: "3", date: "2025-04-09T18:00:00", type: "Pickleball", moving_time: 1.5 }),
        activity({ id: "4", date: "2025-04-10T18:00:00", type: "Ride", moving_time: 3 }),
      ],
      [],
    )!;
    expect(court).toMatchObject({ sessions: 3, hours: 4.5, heartrate: 125, busiestMonth: 2, previousSessions: 0 });
    expect(court.longest).toMatchObject({ id: "1", hours: 2 });
    expect(court.balls).toHaveLength(3);
    expect(courtChapter([activity({ id: "1", date: "2025-01-01" })], null)).toBeNull();
  });
});

describe("sketches", () => {
  it("simplifies a straight line to its ends", () => {
    expect(simplify([[0, 0], [1, 0.001], [2, 0], [3, 0]], 0.1)).toEqual([[0, 0], [3, 0]]);
  });

  it("fits a route into the sketch square", () => {
    const d = routeSketch([[37.8, -122.2], [37.85, -122.2], [37.85, -122.1]], 100, 0)!;
    const numbers = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThanOrEqual(100);
    expect(d.startsWith("M")).toBe(true);
  });

  it("frames the home area and counts routes ridden elsewhere", () => {
    const loop = (lat: number, lng: number): Array<[number, number]> => [
      [lat, lng],
      [lat + 0.02, lng],
      [lat + 0.02, lng + 0.02],
    ];
    const sketch = placesSketch([
      { id: "a", date: "2025-02-01", points: loop(37.8, -122.2) },
      { id: "b", date: "2025-01-01", points: loop(37.82, -122.18) },
      { id: "c", date: "2025-03-01", points: loop(45.5, -73.6) },
    ])!;
    expect(sketch.routes.map((route) => route.id)).toEqual(["b", "a"]);
    expect(sketch.elsewhere).toBe(1);
    expect(sketch.height).toBeGreaterThan(0);
  });
});

describe("buildYearReview", () => {
  it("assembles a year, leaving virtual routes out of the places sketch", () => {
    const route = encodePolyline([
      [37.8, -122.2],
      [37.82, -122.2],
      [37.82, -122.18],
    ]);
    const review = buildYearReview({
      activities: [
        activity({ id: "1", date: "2025-06-01T08:00:00", distance: 50, moving_time: 3, total_elevation_gain: 3000, hasRoute: true }),
        activity({ id: "2", date: "2025-06-02T08:00:00", type: "VirtualRide", distance: 20, moving_time: 1, hasRoute: true }),
        activity({ id: "3", date: "2024-06-02T08:00:00", distance: 20, moving_time: 1 }),
      ],
      gear: [],
      routes: [
        { id: "1", type: "Ride", date: "2025-06-01", polyline: route },
        { id: "2", type: "VirtualRide", date: "2025-06-02", polyline: route },
      ],
      filter: "All",
      year: 2025,
      today: { year: 2026, month: 9, day: 27 },
    });
    expect(review.totals).toMatchObject({ activities: 2, distance: 70, activeDays: 2 });
    expect(review.previous).toMatchObject({ activities: 1 });
    expect(review.streak?.length).toBe(2);
    expect(review.places?.routes.map((entry) => entry.id)).toEqual(["1"]);
    expect(review.bigDays.find((day) => day.key === "longest")?.sketch).toMatch(/^M/);
    expect(review.years.map((entry) => entry.year)).toEqual([2024, 2025]);
    expect(review.comparisons[0]).toMatchObject({ key: "distance", current: 70, previous: 20 });
    expect(review.summary).toContain("June the biggest month");
  });
});
