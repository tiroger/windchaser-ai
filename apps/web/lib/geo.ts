import type { LatLon } from "./types";

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
  mid: LatLon;
}

/**
 * Resample a polyline into sections short enough that bearing is roughly
 * constant within each, per section 9 of the project plan.
 */
export function toSections(points: LatLon[], targetLen = 80): Section[] {
  const sections: Section[] = [];
  if (points.length < 2) return sections;

  let anchor = points[0];
  let accum = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineM(points[i - 1], points[i]);
    if (!Number.isFinite(d) || d === 0) continue;
    accum += d;
    if (accum >= targetLen || i === points.length - 1) {
      sections.push({
        distance_m: accum,
        bearing_deg: bearingDeg(anchor, points[i]),
        mid: [
          (anchor[0] + points[i][0]) / 2,
          (anchor[1] + points[i][1]) / 2,
        ],
      });
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
