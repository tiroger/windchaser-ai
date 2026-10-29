import { describe, expect, it } from "vitest";

import { homeFocus, nearFocus } from "./heatmap-focus";

const ride = (date: string, lng: number, lat: number) => ({ date, start: [lng, lat] });

describe("heatmap focus", () => {
  it("frames where the rider rides now, not between two coasts", () => {
    // Years on the east coast, then a move west. A per-axis median of every
    // start pairs one coast's latitude with the other's longitude.
    const routes = [
      ...Array.from({ length: 300 }, (_, i) => ride(`2016-01-${String((i % 28) + 1).padStart(2, "0")}`, -73.9, 40.7)),
      ...Array.from({ length: 150 }, (_, i) => ride(`2024-03-${String((i % 28) + 1).padStart(2, "0")}`, -122.3, 37.8)),
    ];
    const focus = homeFocus(routes)!;
    expect(nearFocus(focus, [-122.3, 37.8])).toBe(true);
  });

  it("follows a year filter to wherever that year's riding was", () => {
    const routes = Array.from({ length: 40 }, () => ride("2015-06-01", -73.9, 40.7));
    expect(nearFocus(homeFocus(routes)!, [-73.9, 40.7])).toBe(true);
  });

  it("prefers the densest area over a few recent rides elsewhere", () => {
    const routes = [
      ride("2026-10-20", 2.35, 48.85),
      ride("2026-10-21", 2.35, 48.86),
      ...Array.from({ length: 30 }, () => ride("2026-09-01", -122.3, 37.8)),
    ];
    expect(nearFocus(homeFocus(routes)!, [-122.3, 37.8])).toBe(true);
  });

  it("has no focus without routes", () => {
    expect(homeFocus([])).toBeNull();
  });
});
