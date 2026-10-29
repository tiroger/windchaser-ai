import { describe, expect, it } from "vitest";

import { distanceKm, FALLBACK_TITLE, placeName, PLACES, posterTitle } from "./place";

/** A view of `km` across, centred on [lng, lat]: [west, south, east, north]. */
function view([lng, lat]: number[], km: number): [number, number, number, number] {
  const dLat = km / 2 / 111.32;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

describe("poster title", () => {
  it("names a view across the bay the Bay Area", () => {
    expect(placeName(view([-122.25, 37.75], 110))).toBe("San Francisco Bay Area");
  });

  it("names a view of a few streets after the city", () => {
    expect(placeName(view([-122.43, 37.77], 10))).toBe("San Francisco");
    expect(placeName(view([-122.26, 37.81], 8))).toBe("Oakland");
    expect(placeName(view([-73.97, 40.78], 10))).toBe("Manhattan");
  });

  it("picks the region a wide view sits in, the city a close one", () => {
    expect(placeName(view([-73.95, 40.75], 60))).toBe("New York");
    expect(placeName(view([2.35, 48.86], 20))).toBe("Paris");
  });

  it("falls back to a plain title where no place matches", () => {
    expect(placeName(view([-40, 30], 50))).toBeNull(); // mid-Atlantic
    expect(posterTitle(view([-40, 30], 50))).toBe(FALLBACK_TITLE);
  });

  it("needs no network: every place is a name, a centre and a radius", () => {
    for (const place of PLACES) {
      expect(place.name.trim()).toBe(place.name);
      expect(Math.abs(place.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(place.lon)).toBeLessThanOrEqual(180);
      expect(place.km).toBeGreaterThan(0);
    }
  });

  it("measures distance on the sphere", () => {
    expect(distanceKm([-122.42, 37.77], [-73.99, 40.73])).toBeGreaterThan(4100);
    expect(distanceKm([-122.42, 37.77], [-73.99, 40.73])).toBeLessThan(4200);
  });
});
