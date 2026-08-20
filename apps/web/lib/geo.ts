import type { ElevationProfile, LatLon } from "./types";

const R_EARTH = 6371000;

export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: LatLon, b: LatLon): number {
  const p1 = toRad(a[0]);
  const p2 = toRad(b[0]);
  const dp = p2 - p1;
  const dl = toRad(b[1] - a[1]);
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const p1 = toRad(a[0]);
  const p2 = toRad(b[0]);
  const dl = toRad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export interface Section {
  distance_m: number;
  bearing_deg: number;
  /** Rise over run for this section, from the profile when one exists. */
  grade: number;
  mid: LatLon;
}

/** Altitude at a distance along the segment, linearly interpolated. */
function altitudeAt(profile: ElevationProfile, target: number): number {
  const { distance_m: d, altitude_m: a } = profile;
  if (target <= d[0]) return a[0];
  if (target >= d[d.length - 1]) return a[a.length - 1];
  let lo = 0;
  let hi = d.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = d[hi] - d[lo];
  if (span <= 0) return a[lo];
  return a[lo] + ((a[hi] - a[lo]) * (target - d[lo])) / span;
}

/**
 * Resample a polyline into sections short enough that bearing is roughly
 * constant within each, per section 9 of the project plan.
 */
export function toSections(
  points: LatLon[],
  averageGrade = 0,
  profile?: ElevationProfile | null,
  targetLen = 80,
): Section[] {
  const sections: Section[] = [];
  if (points.length < 2) return sections;

  const usable =
    profile && profile.distance_m.length > 1 &&
    profile.distance_m.length === profile.altitude_m.length
      ? profile
      : null;

  let anchor = points[0];
  let accum = 0;
  let travelled = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    if (!Number.isFinite(d) || d === 0) continue;
    accum += d;
    if (accum >= targetLen || i === points.length - 1) {
      const grade = usable
        ? (altitudeAt(usable, travelled + accum) - altitudeAt(usable, travelled)) /
          accum
        : averageGrade / 100;
      sections.push({
        distance_m: accum,
        bearing_deg: bearingDeg(anchor, points[i]),
        grade,
        mid: [
          (anchor[0] + points[i][0]) / 2,
          (anchor[1] + points[i][1]) / 2,
        ],
      });
      travelled += accum;
      anchor = points[i];
      accum = 0;
    }
  }
  return sections;
}

/** Shortest signed difference a - b, in degrees, within (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

export function compassLabel(deg: number): string {
  const names = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatDelta(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "±";
  const abs = Math.abs(Math.round(seconds));
  if (abs >= 60) {
    const m = Math.floor(abs / 60);
    return `${sign}${m}:${String(abs % 60).padStart(2, "0")}`;
  }
  return `${sign}${abs}s`;
}
