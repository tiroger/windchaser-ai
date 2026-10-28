import { describe, expect, it } from "vitest";

import {
  findLoops,
  loopName,
  loopRide,
  movingSeconds,
  rankRides,
  sameLoop,
  type LoopActivity,
  type LoopRideSource,
} from "./loops";
import { encodePolyline } from "./polyline";

const METERS_PER_DEGREE = 111_320;

/** A seeded generator, so the "noisy" tracks are the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type Shape = {
  /** Start, [lat, lng]. */
  start: [number, number];
  /** Radius of the circular loop in meters. */
  radius: number;
  /** Bearing from the start to the circle's centre, degrees. */
  heading: number;
  clockwise?: boolean;
};

/** A circular loop that starts and ends at `start`, as [lat, lng] points. */
function loopPoints(shape: Shape, noise = 0, seed = 1, points = 180): Array<[number, number]> {
  const next = random(seed);
  const cos = Math.cos((shape.start[0] * Math.PI) / 180);
  const heading = (shape.heading * Math.PI) / 180;
  const centre = {
    x: Math.sin(heading) * shape.radius,
    y: Math.cos(heading) * shape.radius,
  };
  const startAngle = Math.atan2(-centre.y, -centre.x);
  const direction = shape.clockwise ? -1 : 1;
  return Array.from({ length: points + 1 }, (_, index) => {
    const angle = startAngle + direction * ((index / points) * 2 * Math.PI);
    const jitter = () => (index === 0 || index === points ? 0 : (next() - 0.5) * 2 * noise);
    const x = centre.x + Math.cos(angle) * shape.radius + jitter();
    const y = centre.y + Math.sin(angle) * shape.radius + jitter();
    return [
      shape.start[0] + y / METERS_PER_DEGREE,
      shape.start[1] + x / (METERS_PER_DEGREE * cos),
    ] as [number, number];
  });
}

const miles = (shape: Shape) => (2 * Math.PI * shape.radius) / 1609.344;

function ride(
  id: string,
  date: string,
  shape: Shape,
  options: { noise?: number; seed?: number; distance?: number; type?: string } = {},
): LoopActivity {
  return {
    id,
    type: options.type ?? "Ride",
    date,
    distance: options.distance ?? miles(shape),
    polyline: encodePolyline(loopPoints(shape, options.noise ?? 25, options.seed ?? Number(id))),
  };
}

const HOME: [number, number] = [37.77, -122.27];
const NORTH: Shape = { start: HOME, radius: 4000, heading: 0 };

describe("sameLoop", () => {
  it("matches the same loop ridden again with GPS noise", () => {
    expect(sameLoop(ride("1", "2020-01-01", NORTH), ride("2", "2021-01-01", NORTH, { seed: 9 }))).toBe(
      true,
    );
  });

  it("matches a ride whose recording started a few hundred meters along", () => {
    // Points are 140 m apart: this one starts 280 m up the road.
    const late = loopPoints(NORTH, 25, 9).slice(2);
    const moved = { ...ride("2", "2021-01-01", NORTH), polyline: encodePolyline(late) };
    expect(sameLoop(ride("1", "2020-01-01", NORTH), moved)).toBe(true);
    // 840 m along is no longer the same start.
    const later = { ...moved, polyline: encodePolyline(loopPoints(NORTH, 25, 9).slice(6)) };
    expect(sameLoop(ride("1", "2020-01-01", NORTH), later)).toBe(false);
  });

  it("treats the same loop ridden the other way round as a different loop", () => {
    const back = ride("2", "2021-01-01", { ...NORTH, clockwise: true });
    expect(sameLoop(ride("1", "2020-01-01", NORTH), back)).toBe(false);
  });

  it("tells apart two loops that share a start", () => {
    const east = ride("2", "2021-01-01", { ...NORTH, heading: 90 });
    const west = ride("3", "2021-01-02", { ...NORTH, heading: 270 });
    const north = ride("1", "2020-01-01", NORTH);
    expect(sameLoop(north, east)).toBe(false);
    expect(sameLoop(east, west)).toBe(false);
  });

  it("tells apart overlapping loops of different sizes from the same start", () => {
    // Same start, same direction, same side: the larger circle shares the first
    // and last stretches but not the middle.
    const bigger = ride("2", "2021-01-01", { ...NORTH, radius: 4300 });
    expect(sameLoop(ride("1", "2020-01-01", NORTH), bigger)).toBe(false);
  });

  it("rejects a reported distance more than 10% apart", () => {
    const base = ride("1", "2020-01-01", NORTH);
    expect(sameLoop(base, { ...ride("2", "2021-01-01", NORTH), distance: base.distance * 1.15 })).toBe(
      false,
    );
    expect(sameLoop(base, { ...ride("2", "2021-01-01", NORTH), distance: base.distance * 1.05 })).toBe(
      true,
    );
  });

  it("keeps sports, and virtual and outdoor rides, apart", () => {
    const base = ride("1", "2020-01-01", NORTH);
    expect(sameLoop(base, ride("2", "2021-01-01", NORTH, { type: "Run" }))).toBe(false);
    expect(sameLoop(base, ride("3", "2021-01-01", NORTH, { type: "VirtualRide" }))).toBe(false);
    expect(sameLoop(base, ride("4", "2021-01-01", NORTH, { type: "GravelRide" }))).toBe(true);
  });

  it("ignores activities without a usable track", () => {
    const base = ride("1", "2020-01-01", NORTH);
    expect(sameLoop(base, { ...base, id: "2", polyline: null })).toBe(false);
    expect(sameLoop(base, { ...base, id: "2", polyline: "" })).toBe(false);
    expect(sameLoop(base, { ...base, id: "2", distance: 0.5 })).toBe(false);
  });
});

describe("findLoops", () => {
  const rides = [
    ride("10", "2016-04-01T08:00:00", NORTH),
    ride("11", "2017-05-01T08:00:00", NORTH),
    ride("12", "2018-06-01T08:00:00", NORTH),
    ride("20", "2017-01-01T08:00:00", { ...NORTH, heading: 90 }),
    ride("21", "2019-01-01T08:00:00", { ...NORTH, heading: 90 }),
    ride("30", "2019-03-01T08:00:00", { ...NORTH, heading: 180 }),
  ];

  it("groups rides of the same loop, keyed by the earliest ride", () => {
    const { loops, byActivity } = findLoops(rides);
    expect(loops).toEqual([
      { id: "10", members: ["10", "11", "12"] },
      { id: "20", members: ["20", "21"] },
    ]);
    expect(byActivity.get("12")).toBe("10");
    expect(byActivity.get("21")).toBe("20");
    // Ridden once: in no loop.
    expect(byActivity.has("30")).toBe(false);
  });

  it("is independent of input order", () => {
    const shuffled = [rides[3], rides[5], rides[1], rides[0], rides[4], rides[2]];
    expect(findLoops(shuffled).loops).toEqual(findLoops(rides).loops);
  });

  it("keeps existing loop IDs and members as new rides arrive", () => {
    const before = findLoops(rides).loops;
    const after = findLoops([
      ...rides,
      ride("13", "2020-07-01T08:00:00", NORTH),
      ride("31", "2020-08-01T08:00:00", { ...NORTH, heading: 180 }),
    ]).loops;
    for (const loop of before) {
      const same = after.find((entry) => entry.id === loop.id);
      expect(same?.members.slice(0, loop.members.length)).toEqual(loop.members);
    }
    expect(after.find((loop) => loop.id === "10")?.members).toEqual(["10", "11", "12", "13"]);
    // The once-ridden loop becomes a loop under its first ride's ID.
    expect(after.find((loop) => loop.id === "30")?.members).toEqual(["30", "31"]);
  });

  it("honours a minimum number of rides", () => {
    expect(findLoops(rides, 3).loops.map((loop) => loop.id)).toEqual(["10"]);
  });

  it("handles 2,000 tracks quickly and recovers every loop", () => {
    const next = random(42);
    const activities: LoopActivity[] = [];
    const loopCount = 100;
    const perLoop = 20;
    for (let loop = 0; loop < loopCount; loop++) {
      // 25 start points, four loops from each, all within a few kilometers.
      const startIndex = loop % 25;
      const start: [number, number] = [
        37.7 + (startIndex % 5) * 0.02,
        -122.3 + Math.floor(startIndex / 5) * 0.02,
      ];
      const shape: Shape = {
        start,
        radius: 2500 + (loop % 7) * 900,
        heading: Math.floor(loop / 25) * 90,
      };
      for (let ride = 0; ride < perLoop; ride++) {
        const id = String(loop * 1000 + ride);
        const year = 2010 + Math.floor(next() * 15);
        activities.push({
          id,
          type: "Ride",
          date: `${year}-0${1 + (ride % 9)}-1${ride % 10}T08:00:00`,
          distance: miles(shape) * (0.97 + next() * 0.06),
          polyline: encodePolyline(loopPoints(shape, 30, loop * 7919 + ride, 300)),
        });
      }
    }
    expect(activities).toHaveLength(2000);
    const started = performance.now();
    const { loops, byActivity } = findLoops(activities);
    const elapsed = performance.now() - started;
    expect(loops).toHaveLength(loopCount);
    expect(loops.every((loop) => loop.members.length === perLoop)).toBe(true);
    expect(byActivity.size).toBe(2000);
    // Every member of a loop came from the same synthetic route.
    for (const loop of loops) {
      const route = Math.floor(Number(loop.members[0]) / 1000);
      expect(loop.members.every((id) => Math.floor(Number(id) / 1000) === route)).toBe(true);
    }
    // About 0.2 s on a laptop; the bound leaves room for a slow CI runner.
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("ranking", () => {
  const source = (overrides: Partial<LoopRideSource> & Pick<LoopRideSource, "id">): LoopRideSource => ({
    name: "Ride",
    date: "2020-01-01T08:00:00",
    distance: 20,
    moving_time: 1.2,
    average_speed: 16,
    average_watts: null,
    weighted_average_watts: null,
    average_heartrate: null,
    ...overrides,
  });

  it("prefers streamed moving time, then distance over speed, then stored time", () => {
    expect(movingSeconds(source({ id: "1" }), { moving_seconds: 4321 })).toBe(4321);
    expect(movingSeconds(source({ id: "1" }))).toBe(4500);
    expect(movingSeconds(source({ id: "1", average_speed: 0 }))).toBe(4320);
    expect(movingSeconds(source({ id: "1", average_speed: 0, moving_time: 0 }))).toBeNull();
  });

  it("takes normalized power from streams, then Strava's weighted average", () => {
    expect(loopRide(source({ id: "1", weighted_average_watts: 180 })).normalizedPower).toBe(180);
    expect(
      loopRide(source({ id: "1", weighted_average_watts: 180 }), {
        normalized_power: 185.4,
        has_streams: true,
      }),
    ).toMatchObject({ normalizedPower: 185.4, hasStreams: true });
  });

  it("ranks fastest first, ties share a rank and go to the earlier ride", () => {
    const ranked = rankRides(
      [
        source({ id: "a", date: "2020-03-01", average_speed: 16 }),
        source({ id: "b", date: "2020-01-01", average_speed: 18 }),
        source({ id: "c", date: "2021-01-01", average_speed: 16 }),
        source({ id: "d", date: "2019-01-01", average_speed: 0, moving_time: 0 }),
        source({ id: "e", date: "2018-01-01", average_speed: 15 }),
      ].map((entry) => loopRide(entry)),
    );
    expect(ranked.map((entry) => [entry.id, entry.rank])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 2],
      ["e", 4],
      ["d", null],
    ]);
  });
});

describe("loopName", () => {
  it("prefers the rider's own most common name over Strava's defaults", () => {
    expect(loopName(["Morning Ride", "Morning Ride", "Hawk Hill", "Morning Ride"])).toBe(
      "Hawk Hill",
    );
    expect(loopName(["Bay loop", "Bay loop", "Hawk Hill"])).toBe("Bay loop");
    expect(loopName(["Evening Ride", "Evening Ride"])).toBe("Evening Ride");
  });
});
