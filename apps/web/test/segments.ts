import type { LatLon, Segment } from "@/lib/types";

/** A short straight segment heading north from `start`, with defaults for every field. */
export function segmentAt(id: number, start: LatLon, overrides: Partial<Segment> = {}): Segment {
  const points: LatLon[] = Array.from({ length: 40 }, (_, i) => [start[0] + i * 0.00025, start[1]]);
  return {
    id,
    name: `Segment ${id}`,
    source: "starred",
    distance_m: 1100,
    average_grade: 4,
    maximum_grade: 8,
    elevation_high: 100,
    elevation_low: 56,
    total_elevation_gain: 44,
    climb_category: 0,
    city: null,
    state: null,
    effort_count: null,
    athlete_count: null,
    star_count: null,
    pr_elapsed_time: 240,
    pr_date: null,
    effort_count_personal: null,
    points,
    region_id: "",
    cell_id: "",
    ...overrides,
  };
}
