import { describe, expect, it } from "vitest";
import { decodePolyline } from "./polyline";
import { mapValue, normalizeActivity, normalizeDate } from "./data";

describe("activity normalization", () => {
  it("keeps Strava local dates as wall-clock time", () => {
    expect(normalizeDate("2026-01-01T06:30:00Z")).toBe("2026-01-01T06:30:00");
    expect(normalizeDate("2026-01-01T06:30:00+01:00")).toBe("2026-01-01T06:30:00");
  });

  it("converts the legacy CSV date format to ISO", () => {
    expect(normalizeDate("12-11-2024")).toBe("2024-12-11");
  });

  it("extracts summary polylines from S3 objects and CSV strings", () => {
    expect(
      normalizeActivity({ id: 1, map: { summary_polyline: "abc" } }).polyline,
    ).toBe("abc");
    expect(
      normalizeActivity({ id: 2, map: "{'id': 'a2', 'summary_polyline': 'xyz'}" })
        .polyline,
    ).toBe("xyz");
    expect(normalizeActivity({ id: 3, map: { summary_polyline: "" } }).polyline).toBeNull();
  });

  it("unescapes the Python repr the CSV snapshot stores polylines in", () => {
    // From the snapshot: the polyline contains a backslash, written as "\\".
    const stored = "{'id': 'a1', 'summary_polyline': 'o{veF`rgjVm\\\\n^iO~G', 'resource_state': 2}";
    const polyline = mapValue(stored)!;
    expect(polyline).toBe("o{veF`rgjVm\\n^iO~G");
    const [, second, third] = decodePolyline(polyline);
    // Without unescaping, the extra character swaps latitude and longitude deltas.
    expect(Math.abs(third[0] - second[0])).toBeLessThan(0.01);
    expect(Math.abs(third[1] - second[1])).toBeLessThan(0.01);
  });
});
