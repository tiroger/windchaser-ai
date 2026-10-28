import { describe, expect, it } from "vitest";

import { encodePolyline } from "./polyline";
import {
  activitySegments,
  effortRank,
  linkEfforts,
  parseEffortHistory,
  type EffortActivity,
  type EffortHistory,
} from "./segments";

// A segment in Oakland, and a track that passes its start.
const SEGMENT_START: [number, number] = [37.8, -122.2];
const PASSING = encodePolyline([
  [37.79, -122.21],
  [37.8, -122.2],
  [37.81, -122.19],
]);
const ELSEWHERE = encodePolyline([
  [37.7, -122.4],
  [37.71, -122.41],
]);

function history(efforts: EffortHistory["efforts"]): EffortHistory {
  return {
    segments: {
      "1": { id: 1, name: "Hawk Hill", distance_m: 2658, average_grade: 6.8, points: [SEGMENT_START] },
      "2": { id: 2, name: "Unplaced", points: null },
    },
    efforts,
  };
}

const effort = (start_date: string, elapsed_time_s: number, extra: object = {}) => ({
  segment_id: 1,
  start_date,
  elapsed_time_s,
  ...extra,
});

describe("parseEffortHistory", () => {
  it("keeps valid efforts and segments and drops incomplete ones", () => {
    const parsed = parseEffortHistory({
      segments: { "1": { id: 1, name: " Hawk Hill ", distance_m: 2658.5, points: [[1, 2]] } },
      efforts: [
        { segment_id: 1, start_date: "2023-09-17T17:31:26Z", elapsed_time_s: 295, weather: { wind_speed_ms: 3 } },
        { segment_id: 1, start_date: "not a date", elapsed_time_s: 295 },
        { segment_id: 1, start_date: "2023-09-17T17:31:26Z", elapsed_time_s: 0 },
        { start_date: "2023-09-17T17:31:26Z", elapsed_time_s: 300 },
        null,
      ],
    });
    expect(parsed.segments["1"]).toMatchObject({ id: 1, name: "Hawk Hill", distance_m: 2658.5 });
    expect(parsed.efforts).toHaveLength(1);
    expect(parsed.efforts[0]).toMatchObject({ elapsed_time_s: 295, weather: { wind_speed_ms: 3 } });
  });

  it("reads a missing object as empty", () => {
    expect(parseEffortHistory(null)).toEqual({ segments: {}, efforts: [] });
  });
});

describe("linkEfforts", () => {
  const activities: EffortActivity[] = [
    // Saturday morning ride over the segment, wall-clock Pacific time.
    { id: "100", date: "2023-09-16T09:00:00", moving_time: 2, polyline: PASSING },
    // A run elsewhere later that day.
    { id: "101", date: "2023-09-16T12:00:00", moving_time: 1, polyline: ELSEWHERE },
    // Sunday: a ride over the segment, then pickleball with no track.
    { id: "200", date: "2023-09-17T10:00:00", moving_time: 1.5, polyline: PASSING },
    { id: "201", date: "2023-09-17T10:50:00", moving_time: 1, polyline: null },
    // A winter ride (PST, UTC−8).
    { id: "300", date: "2023-01-07T09:00:00", moving_time: 1, polyline: PASSING },
  ];

  it("uses the activity ID the webhook recorded", () => {
    const links = linkEfforts(
      history([effort("2023-09-16T16:30:00Z", 300, { activity_id: 200 })]),
      activities,
    );
    expect(links.get(0)).toBe("200");
  });

  it("places older efforts by time and place across daylight saving", () => {
    const links = linkEfforts(
      history([
        // 09:30 PDT.
        effort("2023-09-16T16:30:00Z", 300),
        // 11:05 PDT: after the pickleball started, but only the ride passed the segment.
        effort("2023-09-17T18:05:00Z", 300),
        // 09:20 PST.
        effort("2023-01-07T17:20:00Z", 300),
      ]),
      activities,
    );
    expect([links.get(0), links.get(1), links.get(2)]).toEqual(["100", "200", "300"]);
  });

  it("leaves an effort unplaced when no activity was under way", () => {
    const links = linkEfforts(
      history([
        // A week later: nothing recorded.
        effort("2023-09-23T16:30:00Z", 300),
        // 05:00 PDT, hours before Saturday's ride began.
        effort("2023-09-16T12:00:00Z", 300),
        // An unknown activity ID falls back to matching, and matches nothing.
        effort("2023-09-30T16:30:00Z", 300, { activity_id: 999 }),
      ]),
      activities,
    );
    expect(links.size).toBe(0);
  });
});

describe("activitySegments", () => {
  const efforts = [
    effort("2020-05-01T16:00:00Z", 640),
    effort("2021-04-24T16:00:00Z", 600, { weather: { wind_speed_ms: 7, wind_from_deg: 266 } }),
    effort("2022-06-01T16:00:00Z", 610, { activity_id: 7 }),
    effort("2023-03-17T16:00:00Z", 600),
    effort("2023-09-16T16:30:00Z", 700, { activity_id: 7 }),
    { segment_id: 2, start_date: "2022-06-01T16:30:00Z", elapsed_time_s: 90, activity_id: 7 },
  ];
  const links = new Map<number, string>([
    [1, "5"],
    [2, "7"],
    [4, "8"],
    [5, "7"],
  ]);
  const dates = new Map([
    ["5", "2021-04-24T09:00:00"],
    ["7", "2022-06-01T08:30:00"],
    ["8", "2023-09-16T09:00:00"],
  ]);

  it("ranks each effort against all efforts, with the first PR as the record", () => {
    const rows = activitySegments("7", history(efforts), links, dates);
    expect(rows.map((row) => row.name)).toEqual(["Hawk Hill", "Unplaced"]);
    expect(rows[0]).toMatchObject({
      elapsedSeconds: 610,
      rank: 3,
      efforts: 5,
      prSeconds: 600,
      deltaSeconds: 10,
      prDate: "2021-04-24",
      prActivityId: "5",
    });
    // The only effort on its segment is the record.
    expect(rows[1]).toMatchObject({ rank: 1, efforts: 1, deltaSeconds: 0, prActivityId: "7" });
  });

  it("returns the segment's history oldest first, dated locally where known", () => {
    const [row] = activitySegments("7", history(efforts), links, dates);
    expect(row.history.map((point) => [point.date, point.elapsedSeconds, point.activityId])).toEqual([
      ["2020-05-01", 640, null],
      ["2021-04-24", 600, "5"],
      ["2022-06-01", 610, "7"],
      ["2023-03-17", 600, null],
      ["2023-09-16", 700, "8"],
    ]);
  });

  it("carries the recorded weather and is empty for an activity with no efforts", () => {
    expect(activitySegments("5", history(efforts), links, dates)[0]).toMatchObject({
      rank: 1,
      weather: { wind_speed_ms: 7, wind_from_deg: 266 },
    });
    expect(activitySegments("404", history(efforts), links, dates)).toEqual([]);
  });

  it("shares a rank between equal times", () => {
    expect(effortRank(600, [640, 600, 610, 600])).toBe(1);
    expect(effortRank(610, [640, 600, 610, 600])).toBe(3);
    expect(effortRank(640, [640, 600, 610, 600])).toBe(4);
  });
});
