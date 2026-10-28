import { describe, expect, it } from "vitest";
import type { Gear, MaintenanceRecord } from "./activity-types";
import { scheduleStatus } from "./maintenance";
import { decodePolyline, encodePolyline, hideRouteEnds, trimRouteEnds } from "./polyline";
import { parseSettings, settingsOrDefaults } from "./settings";

describe("route privacy", () => {
  // A straight line north from "home", about 111 m per 0.001 degree.
  const line: Array<[number, number]> = Array.from({ length: 31 }, (_, index) => [37.8 + index * 0.001, -122.4]);

  it("drops everything within 500 m of either end", () => {
    const trimmed = trimRouteEnds(line);
    expect(trimmed[0][0]).toBeCloseTo(37.805);
    expect(trimmed.at(-1)![0]).toBeCloseTo(37.825);
  });

  it("withholds a route that never leaves the hidden radius", () => {
    expect(trimRouteEnds(line.slice(0, 5))).toEqual([]);
  });

  it("hides streamed coordinates near home while keeping samples aligned", () => {
    const hidden = hideRouteEnds([null, ...line, null]);
    expect(hidden).toHaveLength(line.length + 2);
    expect(hidden[1]).toBeNull();
    expect(hidden[16]).toEqual(line[15]);
  });

  it("round-trips Google's polyline encoding", () => {
    const decoded = decodePolyline(encodePolyline(line));
    expect(decoded).toHaveLength(line.length);
    expect(decoded[10][0]).toBeCloseTo(line[10][0], 5);
  });
});

describe("maintenance schedules", () => {
  const bike: Gear = { id: "b1", name: "Vader Velo", brand: "", model: "", distance: 7300, retired: false, kind: "bike" };
  const record = (part: string, service: string, date: string, mileage: number): MaintenanceRecord => ({
    id: `${part}-${service}-${date}`,
    bikeId: "b1",
    bike: "Vader Velo",
    part,
    service,
    date,
    mileage,
  });

  it("counts miles since the last service and flags overdue work", () => {
    const status = scheduleStatus(
      [record("Chain", "Lube", "2026-09-01", 7100), record("Chain", "Lube", "2026-10-01", 7200)],
      bike,
      "2026-10-27",
    );
    expect(status).toHaveLength(1);
    expect(status[0].remaining).toBe(50);
  });

  it("schedules sealant by the calendar", () => {
    const [status] = scheduleStatus([record("Tires", "Top-Up", "2026-05-01", 6000)], bike, "2026-10-27");
    expect(status.unit).toBe("days");
    expect(status.remaining).toBeLessThan(0);
  });

  it("matches records logged before bikes were stored by ID", () => {
    const legacy = { ...record("Chain", "Hot Wax", "2026-10-01", 7000), bikeId: undefined };
    expect(scheduleStatus([legacy], bike, "2026-10-27")[0].remaining).toBe(700);
  });
});

describe("settings", () => {
  it("accepts in-range values and rejects anything else", () => {
    const valid = { goals: { "Ride:distance": 5000, "Pickleball:sessions": 120 }, athlete: { weightKg: 72, restingHr: 48, maxHr: null, ftpOverride: null } };
    expect(parseSettings(valid)).toEqual(valid);
    expect(parseSettings({ ...valid, goals: { "Ride:watts": 1 } })).toBeNull();
    expect(parseSettings({ ...valid, athlete: { ...valid.athlete, restingHr: 5 } })).toBeNull();
  });

  it("fills missing stored fields with defaults", () => {
    expect(settingsOrDefaults({ goals: { "Ride:distance": 4000 } }).athlete.restingHr).toBe(49);
    expect(settingsOrDefaults(null).goals).toEqual({});
  });
});
