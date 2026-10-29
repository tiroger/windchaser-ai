/**
 * A poster's default title: the name of the area in view, found without a
 * geocoder. A short list of well-known riding areas, each a centre and a
 * radius, is matched against the view; the rider can always retype it.
 */

type Place = { name: string; lat: number; lon: number; km: number };

// Metro areas and cycling regions, with cities inside the larger ones so a
// zoomed-in view gets the city and a wide one the region.
export const PLACES: readonly Place[] = [
  { name: "San Francisco Bay Area", lat: 37.7, lon: -122.2, km: 70 },
  { name: "San Francisco", lat: 37.765, lon: -122.44, km: 9 },
  { name: "Oakland", lat: 37.81, lon: -122.24, km: 9 },
  { name: "Berkeley", lat: 37.875, lon: -122.27, km: 5 },
  { name: "East Bay", lat: 37.82, lon: -122.12, km: 18 },
  { name: "Marin", lat: 38.0, lon: -122.6, km: 18 },
  { name: "Peninsula", lat: 37.48, lon: -122.25, km: 20 },
  { name: "Silicon Valley", lat: 37.37, lon: -122.0, km: 18 },
  { name: "San Jose", lat: 37.33, lon: -121.89, km: 14 },
  { name: "Santa Cruz", lat: 36.98, lon: -122.03, km: 15 },
  { name: "Napa Valley", lat: 38.4, lon: -122.36, km: 22 },
  { name: "Sonoma County", lat: 38.48, lon: -122.82, km: 35 },
  { name: "Sacramento", lat: 38.58, lon: -121.49, km: 25 },
  { name: "Lake Tahoe", lat: 39.05, lon: -120.03, km: 35 },
  { name: "Sierra Nevada", lat: 38.4, lon: -119.8, km: 120 },
  { name: "Monterey", lat: 36.6, lon: -121.89, km: 20 },
  { name: "Santa Barbara", lat: 34.43, lon: -119.75, km: 20 },
  { name: "Los Angeles", lat: 34.05, lon: -118.3, km: 50 },
  { name: "San Diego", lat: 32.8, lon: -117.15, km: 30 },
  { name: "Seattle", lat: 47.61, lon: -122.33, km: 30 },
  { name: "Portland", lat: 45.52, lon: -122.67, km: 25 },
  { name: "Boulder", lat: 40.02, lon: -105.27, km: 18 },
  { name: "Denver", lat: 39.74, lon: -104.99, km: 30 },
  { name: "Salt Lake City", lat: 40.76, lon: -111.89, km: 30 },
  { name: "Phoenix", lat: 33.45, lon: -112.07, km: 45 },
  { name: "Tucson", lat: 32.22, lon: -110.97, km: 30 },
  { name: "Austin", lat: 30.27, lon: -97.74, km: 30 },
  { name: "Chicago", lat: 41.88, lon: -87.68, km: 35 },
  { name: "Minneapolis", lat: 44.97, lon: -93.26, km: 25 },
  { name: "Boston", lat: 42.36, lon: -71.08, km: 25 },
  { name: "New York", lat: 40.75, lon: -73.95, km: 40 },
  { name: "Manhattan", lat: 40.78, lon: -73.97, km: 8 },
  { name: "Brooklyn", lat: 40.65, lon: -73.95, km: 8 },
  { name: "Hudson Valley", lat: 41.6, lon: -73.95, km: 60 },
  { name: "Finger Lakes", lat: 42.65, lon: -76.85, km: 55 },
  { name: "Philadelphia", lat: 39.95, lon: -75.17, km: 25 },
  { name: "Washington", lat: 38.9, lon: -77.04, km: 25 },
  { name: "Atlanta", lat: 33.75, lon: -84.39, km: 30 },
  { name: "Miami", lat: 25.77, lon: -80.2, km: 30 },
  { name: "Vancouver", lat: 49.26, lon: -123.12, km: 25 },
  { name: "Toronto", lat: 43.7, lon: -79.4, km: 30 },
  { name: "Montréal", lat: 45.5, lon: -73.6, km: 20 },
  { name: "Mexico City", lat: 19.43, lon: -99.13, km: 30 },
  { name: "Medellín", lat: 6.24, lon: -75.58, km: 20 },
  { name: "London", lat: 51.5, lon: -0.12, km: 30 },
  { name: "Paris", lat: 48.86, lon: 2.35, km: 20 },
  { name: "Amsterdam", lat: 52.37, lon: 4.9, km: 15 },
  { name: "Copenhagen", lat: 55.68, lon: 12.57, km: 15 },
  { name: "Berlin", lat: 52.52, lon: 13.4, km: 25 },
  { name: "Munich", lat: 48.14, lon: 11.58, km: 20 },
  { name: "Zürich", lat: 47.38, lon: 8.54, km: 15 },
  { name: "Geneva", lat: 46.2, lon: 6.15, km: 15 },
  { name: "Vienna", lat: 48.21, lon: 16.37, km: 20 },
  { name: "Flanders", lat: 50.95, lon: 3.6, km: 60 },
  { name: "Girona", lat: 41.98, lon: 2.82, km: 25 },
  { name: "Barcelona", lat: 41.39, lon: 2.17, km: 18 },
  { name: "Mallorca", lat: 39.62, lon: 2.98, km: 55 },
  { name: "Madrid", lat: 40.42, lon: -3.7, km: 25 },
  { name: "Granada", lat: 37.18, lon: -3.6, km: 25 },
  { name: "Nice", lat: 43.71, lon: 7.26, km: 20 },
  { name: "Provence", lat: 43.95, lon: 5.2, km: 70 },
  { name: "Dolomites", lat: 46.5, lon: 11.85, km: 45 },
  { name: "Lake Como", lat: 45.98, lon: 9.25, km: 25 },
  { name: "Milan", lat: 45.46, lon: 9.19, km: 20 },
  { name: "Rome", lat: 41.9, lon: 12.5, km: 20 },
  { name: "Tokyo", lat: 35.68, lon: 139.76, km: 35 },
  { name: "Kyoto", lat: 35.01, lon: 135.77, km: 12 },
  { name: "Taipei", lat: 25.04, lon: 121.56, km: 20 },
  { name: "Hong Kong", lat: 22.32, lon: 114.17, km: 25 },
  { name: "Singapore", lat: 1.35, lon: 103.82, km: 25 },
  { name: "Sydney", lat: -33.87, lon: 151.2, km: 35 },
  { name: "Melbourne", lat: -37.81, lon: 144.96, km: 35 },
  { name: "Auckland", lat: -36.85, lon: 174.76, km: 25 },
  { name: "Cape Town", lat: -33.92, lon: 18.42, km: 30 },
];

export const FALLBACK_TITLE = "Where I Ride";

/** Great-circle distance in km. */
export function distanceKm([lng1, lat1]: number[], [lng2, lat2]: number[]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The area a view shows, named. Of the places whose radius covers the view's
 * centre, the one closest in size to the view wins: a view across the bay is
 * the Bay Area, one of a few streets is the city. `bounds` is [west, south,
 * east, north].
 */
export function placeName(
  bounds: [number, number, number, number],
  places: readonly Place[] = PLACES,
): string | null {
  const [west, south, east, north] = bounds;
  const center = [(west + east) / 2, (south + north) / 2];
  // Half the longer side: a poster frame contains the whole view, so its
  // longer side is the area the poster covers.
  const width = distanceKm([west, center[1]], [east, center[1]]);
  const height = distanceKm([center[0], south], [center[0], north]);
  const viewKm = Math.max(1, Math.max(width, height) / 2);
  let best: { place: Place; score: number } | null = null;
  for (const place of places) {
    const away = distanceKm(center, [place.lon, place.lat]);
    if (away > place.km) continue;
    // Size match first, and a place smaller than the view counts double: a
    // poster can be of a region within a wider one, but should not be named
    // after a corner of it. A nearer centre breaks near-ties.
    const ratio = Math.log(place.km / viewKm);
    const score = (ratio < 0 ? -2 * ratio : ratio) + (0.25 * away) / place.km;
    if (!best || score < best.score) best = { place, score };
  }
  return best?.place.name ?? null;
}

/** The title a poster starts with. */
export function posterTitle(bounds: [number, number, number, number]): string {
  return placeName(bounds) ?? FALLBACK_TITLE;
}
