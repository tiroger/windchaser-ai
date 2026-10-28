/** Google encoded polyline, as Strava returns it: [latitude, longitude] pairs. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    latitude += next();
    longitude += next();
    coordinates.push([latitude / 1e5, longitude / 1e5]);
  }
  return coordinates;
}

export function encodePolyline(points: Array<[number, number]>): string {
  let output = "";
  let previousLat = 0;
  let previousLng = 0;
  const write = (value: number) => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      output += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    output += String.fromCharCode(shifted + 63);
  };
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    write(latE5 - previousLat);
    write(lngE5 - previousLng);
    previousLat = latE5;
    previousLng = lngE5;
  }
  return output;
}

function metersBetween([lat1, lng1]: [number, number], [lat2, lng2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Distance hidden at each end of a public route, so it never leads to a door. */
export const PRIVACY_TRIM_METERS = 500;

/**
 * Drops every point within the trim distance of the route's start and end,
 * measured as the crow flies, so a loop from home loses both of its ends. A
 * route that never leaves that radius is withheld entirely.
 */
export function trimRouteEnds(
  points: Array<[number, number]>,
  meters = PRIVACY_TRIM_METERS,
): Array<[number, number]> {
  const range = publicRange(points, meters);
  return range ? points.slice(range[0], range[1] + 1) : [];
}

/** Index range of the points far enough from both ends to show; null when none are. */
export function publicRange(
  points: Array<[number, number]>,
  meters = PRIVACY_TRIM_METERS,
): [number, number] | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const first = points.findIndex(
    (point) => metersBetween(point, start) > meters && metersBetween(point, end) > meters,
  );
  if (first === -1) return null;
  let last = points.length - 1;
  while (last > first && (metersBetween(points[last], end) <= meters || metersBetween(points[last], start) <= meters)) {
    last--;
  }
  return last > first ? [first, last] : null;
}

export function publicPolyline(encoded: string | null): string | null {
  if (!encoded) return null;
  const trimmed = trimRouteEnds(decodePolyline(encoded));
  return trimmed.length >= 2 ? encodePolyline(trimmed) : null;
}

/** Nulls every coordinate within the privacy distance of either end, keeping indices aligned. */
export function hideRouteEnds(
  points: Array<[number, number] | null>,
  meters = PRIVACY_TRIM_METERS,
): Array<[number, number] | null> {
  const present = points.flatMap((point, index) => (point ? [{ point, index }] : []));
  const range = publicRange(present.map((entry) => entry.point), meters);
  const visible = new Set(range ? present.slice(range[0], range[1] + 1).map((entry) => entry.index) : []);
  return points.map((point, index) => (point && visible.has(index) ? point : null));
}
