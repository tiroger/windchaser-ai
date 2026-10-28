import { getActivityKind } from "./activity-types";
import { decodePolyline } from "./polyline";

/**
 * Loops: the same route ridden (or run) more than once, found by comparing GPS
 * tracks rather than names.
 *
 * Everything here runs on the server against the full, untrimmed summary
 * polylines. Only activity IDs and metrics ever leave it, so matching on the
 * true start and end reveals nothing the privacy trim hides.
 *
 * Two tracks are the same loop when all of these hold:
 *  - the same sport, with virtual and outdoor activities kept apart;
 *  - reported distances within 10% of each other;
 *  - starts within 500 m of each other, and ends within 500 m;
 *  - in both directions, at least 85% of one track's resampled points lie
 *    within 150 m of the other, near the same fraction of the way round.
 *
 * The last condition makes direction matter: the same roads ridden the other
 * way round climb different hills and are a different loop for comparing
 * times.
 *
 * Clustering is chronological "leader" clustering. Activities are visited
 * oldest first; each joins the existing loop whose founding ride it matches
 * best, or founds a new one. A loop's ID is its founder's activity ID, so new
 * rides never renumber or reshuffle the loops already found, and a loop
 * cannot drift into a different route through a chain of near matches.
 */
export const LOOP_MATCH = {
  /** Points each track is resampled to, evenly by distance. */
  samples: 100,
  /**
   * Largest gap between the two starts, and between the two ends. Riders
   * start their computers a little up or down the street; on real data,
   * 250 m → 500 m adds about a sixth more rides to loops without merging any
   * two loops, since coverage still has to hold.
   */
  endpointMeters: 500,
  /** Largest relative difference in reported distance. */
  distanceTolerance: 0.1,
  /** How far a resampled point may be from the other track and still count. */
  corridorMeters: 150,
  /** Share of points that must lie within the corridor, checked both ways. */
  coverage: 0.85,
  /**
   * How far along the other track a point may be matched, as a fraction of
   * the route. It absorbs the shift a detour or GPS drift causes while still
   * telling a loop from the same loop reversed.
   */
  alignmentWindow: 0.15,
  /** Shorter activities are too small to tell routes apart. */
  minMiles: 1,
};

export type LoopSettings = typeof LOOP_MATCH;

export type LoopActivity = {
  id: string;
  type: string;
  /** Wall-clock start, "YYYY-MM-DDTHH:MM:SS". */
  date: string;
  /** Miles, as reported. */
  distance: number;
  polyline: string | null;
};

export type Loop = {
  /** The founding activity's ID; stable as later rides join. */
  id: string;
  /** Activity IDs, oldest first. Always includes the founder. */
  members: string[];
};

export type LoopIndex = {
  loops: Loop[];
  /** Activity ID → loop ID, for every activity in a loop of two or more. */
  byActivity: Map<string, string>;
};

const METERS_PER_DEGREE_LAT = 110_574;
const METERS_PER_DEGREE_LNG = 111_320;
/**
 * Start cells: 0.01° of latitude (1.1 km) by 0.02° of longitude (1.8 km at
 * 37°N, still 0.58 km at 75°N). Each is larger than the endpoint tolerance,
 * so the 3×3 neighbourhood of a start cell holds every possible match.
 */
const CELL_LAT_DEGREES = 0.01;
const CELL_LNG_DEGREES = 0.02;

type Track = {
  id: string;
  date: string;
  sport: string;
  distance: number;
  /** Decoded vertices, flattened [lat, lng] in degrees. */
  lat: Float64Array;
  lng: Float64Array;
  /** Fraction of the track's length at each vertex, 0 to 1. */
  fraction: Float64Array;
  /** Resampled points, evenly spaced along the track. */
  sampleLat: Float64Array;
  sampleLng: Float64Array;
  /** Bounding box in degrees. */
  box: [number, number, number, number];
  /** cos(latitude) at the start, for local planar distances. */
  cosLat: number;
  cellLat: number;
  cellLng: number;
};

function sportClass(type: string): string {
  const kind = getActivityKind(type);
  return /virtual/i.test(type) ? `${kind}:virtual` : kind;
}

function metersApprox(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  cosLat: number,
): number {
  const dy = (lat2 - lat1) * METERS_PER_DEGREE_LAT;
  const dx = (lng2 - lng1) * METERS_PER_DEGREE_LNG * cosLat;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Decodes and resamples one activity's track; null when it cannot be compared. */
export function buildTrack(activity: LoopActivity, settings = LOOP_MATCH): Track | null {
  const samples = settings.samples;
  if (!activity.polyline || !(activity.distance >= settings.minMiles)) return null;
  let points: Array<[number, number]>;
  try {
    points = decodePolyline(activity.polyline);
  } catch {
    return null;
  }
  // Drop repeated vertices; they add nothing and make zero-length segments.
  points = points.filter(
    (point, index) =>
      index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1],
  );
  if (points.length < 4) return null;
  const n = points.length;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const cumulative = new Float64Array(n);
  const cosLat = Math.cos((points[0][0] * Math.PI) / 180);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (let i = 0; i < n; i++) {
    lat[i] = points[i][0];
    lng[i] = points[i][1];
    if (i > 0) {
      cumulative[i] =
        cumulative[i - 1] + metersApprox(lat[i - 1], lng[i - 1], lat[i], lng[i], cosLat);
    }
    minLat = Math.min(minLat, lat[i]);
    maxLat = Math.max(maxLat, lat[i]);
    minLng = Math.min(minLng, lng[i]);
    maxLng = Math.max(maxLng, lng[i]);
  }
  const length = cumulative[n - 1];
  if (!(length > 0)) return null;
  const fraction = new Float64Array(n);
  for (let i = 0; i < n; i++) fraction[i] = cumulative[i] / length;

  const sampleLat = new Float64Array(samples);
  const sampleLng = new Float64Array(samples);
  let segment = 0;
  for (let s = 0; s < samples; s++) {
    const target = s / (samples - 1);
    while (segment < n - 2 && fraction[segment + 1] < target) segment++;
    const span = fraction[segment + 1] - fraction[segment];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - fraction[segment]) / span)) : 0;
    sampleLat[s] = lat[segment] + (lat[segment + 1] - lat[segment]) * t;
    sampleLng[s] = lng[segment] + (lng[segment + 1] - lng[segment]) * t;
  }

  return {
    id: activity.id,
    date: activity.date,
    sport: sportClass(activity.type),
    distance: activity.distance,
    lat,
    lng,
    fraction,
    sampleLat,
    sampleLng,
    box: [minLat, minLng, maxLat, maxLng],
    cosLat,
    cellLat: Math.floor(lat[0] / CELL_LAT_DEGREES),
    cellLng: Math.floor(lng[0] / CELL_LNG_DEGREES),
  };
}

/** Distance from a point to the segment a→b, in a local plane, in meters. */
function pointToSegment(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
  cosLat: number,
): number {
  const kx = METERS_PER_DEGREE_LNG * cosLat;
  const ky = METERS_PER_DEGREE_LAT;
  const ax = (aLng - pLng) * kx;
  const ay = (aLat - pLat) * ky;
  const bx = (bLng - pLng) * kx;
  const by = (bLat - pLat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared > 0 ? -(ax * dx + ay * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

/** First vertex index whose fraction is at least `value`. */
function lowerBound(values: Float64Array, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Share of `a`'s resampled points within the corridor of `b`'s track, each
 * compared only with the part of `b` near the same fraction of the way along.
 * Stops early, returning a value under `required`, once it cannot reach it.
 */
export function coverage(a: Track, b: Track, required = 0, settings = LOOP_MATCH): number {
  const samples = a.sampleLat.length;
  const window = settings.alignmentWindow;
  const corridor = settings.corridorMeters;
  const allowedMisses = Math.floor((1 - required) * samples);
  const last = b.lat.length - 1;
  let hits = 0;
  let misses = 0;
  for (let s = 0; s < samples; s++) {
    const position = s / (samples - 1);
    const from = Math.max(0, lowerBound(b.fraction, position - window) - 1);
    let hit = false;
    for (let v = from; v < last; v++) {
      if (b.fraction[v] > position + window) break;
      const d = pointToSegment(
        a.sampleLat[s],
        a.sampleLng[s],
        b.lat[v],
        b.lng[v],
        b.lat[v + 1],
        b.lng[v + 1],
        a.cosLat,
      );
      if (d <= corridor) {
        hit = true;
        break;
      }
    }
    if (hit) hits++;
    else if (++misses > allowedMisses) return hits / samples;
  }
  return hits / samples;
}

function boxesOverlap(a: Track, b: Track, settings: LoopSettings): boolean {
  const pad = settings.corridorMeters / METERS_PER_DEGREE_LAT;
  const padLng = pad / Math.max(a.cosLat, 0.1);
  return !(
    a.box[2] + pad < b.box[0] ||
    b.box[2] + pad < a.box[0] ||
    a.box[3] + padLng < b.box[1] ||
    b.box[3] + padLng < a.box[1]
  );
}

/**
 * How well two tracks match as the same loop: the smaller of the two
 * coverages, or 0 when any of the cheaper conditions already fails.
 */
export function matchScore(a: Track, b: Track, settings = LOOP_MATCH): number {
  if (a.sport !== b.sport) return 0;
  const longer = Math.max(a.distance, b.distance);
  if (Math.abs(a.distance - b.distance) > settings.distanceTolerance * longer) return 0;
  const endpoint = settings.endpointMeters;
  const lastA = a.lat.length - 1;
  const lastB = b.lat.length - 1;
  if (metersApprox(a.lat[0], a.lng[0], b.lat[0], b.lng[0], a.cosLat) > endpoint) return 0;
  if (metersApprox(a.lat[lastA], a.lng[lastA], b.lat[lastB], b.lng[lastB], a.cosLat) > endpoint) {
    return 0;
  }
  if (!boxesOverlap(a, b, settings)) return 0;
  const forward = coverage(a, b, settings.coverage, settings);
  if (forward < settings.coverage) return 0;
  const backward = coverage(b, a, settings.coverage, settings);
  if (backward < settings.coverage) return 0;
  return Math.min(forward, backward);
}

/** Whether two activities are the same loop. */
export function sameLoop(a: LoopActivity, b: LoopActivity, settings = LOOP_MATCH): boolean {
  const trackA = buildTrack(a, settings);
  const trackB = buildTrack(b, settings);
  return !!trackA && !!trackB && matchScore(trackA, trackB, settings) > 0;
}

function byDateThenId(a: { date: string; id: string }, b: { date: string; id: string }): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

/**
 * Groups activities into loops. Only loops ridden at least `minRides` times
 * are returned; every other activity is simply not in one.
 */
export function findLoops(
  activities: LoopActivity[],
  minRides = 2,
  settings = LOOP_MATCH,
): LoopIndex {
  const tracks = activities
    .map((activity) => buildTrack(activity, settings))
    .filter((track): track is Track => track !== null)
    .sort(byDateThenId);

  // Founders by sport and start cell, so each track is compared only with the
  // loops that start within reach of it.
  const founders = new Map<string, Track[]>();
  const membersOf = new Map<string, string[]>();
  for (const track of tracks) {
    let best: Track | null = null;
    let bestScore = 0;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const candidates = founders.get(
          `${track.sport}|${track.cellLat + dLat}|${track.cellLng + dLng}`,
        );
        if (!candidates) continue;
        for (const founder of candidates) {
          const score = matchScore(track, founder, settings);
          if (score > bestScore) {
            best = founder;
            bestScore = score;
          }
        }
      }
    }
    if (best) {
      membersOf.get(best.id)!.push(track.id);
    } else {
      const key = `${track.sport}|${track.cellLat}|${track.cellLng}`;
      const bucket = founders.get(key);
      if (bucket) bucket.push(track);
      else founders.set(key, [track]);
      membersOf.set(track.id, [track.id]);
    }
  }

  const loops: Loop[] = [];
  const byActivity = new Map<string, string>();
  for (const [id, members] of membersOf) {
    if (members.length < minRides) continue;
    loops.push({ id, members });
    for (const member of members) byActivity.set(member, id);
  }
  loops.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
  return { loops, byActivity };
}

// ------------------------------------------------------------ metrics --

/** What one ride of a loop is compared on. */
export type LoopRide = {
  id: string;
  name: string;
  date: string;
  /** Miles. */
  distance: number;
  /** Seconds; null when unknown. */
  movingSeconds: number | null;
  /** Miles per hour. */
  averageSpeed: number | null;
  normalizedPower: number | null;
  averageWatts: number | null;
  averageHeartrate: number | null;
  /** Whether second-by-second streams are available to overlay. */
  hasStreams: boolean;
  /** 1 for the fastest; rides without a time are unranked (null). */
  rank: number | null;
};

export type LoopRideSource = {
  id: string;
  name: string;
  date: string;
  distance: number;
  /** Hours, as stored: rounded to a tenth. */
  moving_time: number;
  average_speed: number;
  average_watts: number | null;
  weighted_average_watts: number | null;
  average_heartrate: number | null;
};

export type LoopStreamsEntry = {
  has_streams?: boolean;
  moving_seconds?: number | null;
  normalized_power?: number | null;
};

/**
 * Moving time in seconds, as precisely as the data allows. Streams record it
 * to the second. Without them, distance over average speed is accurate to
 * about half a percent, where the stored moving time is rounded to six minutes.
 */
export function movingSeconds(ride: LoopRideSource, streams?: LoopStreamsEntry): number | null {
  if (streams?.moving_seconds && streams.moving_seconds > 0) return streams.moving_seconds;
  if (ride.average_speed > 0 && ride.distance > 0) {
    return Math.round((ride.distance / ride.average_speed) * 3600);
  }
  return ride.moving_time > 0 ? Math.round(ride.moving_time * 3600) : null;
}

export function loopRide(source: LoopRideSource, streams?: LoopStreamsEntry): Omit<LoopRide, "rank"> {
  const seconds = movingSeconds(source, streams);
  return {
    id: source.id,
    name: source.name,
    date: source.date,
    distance: source.distance,
    movingSeconds: seconds,
    averageSpeed:
      source.average_speed > 0
        ? source.average_speed
        : seconds && source.distance > 0
          ? (source.distance / seconds) * 3600
          : null,
    normalizedPower: streams?.normalized_power ?? source.weighted_average_watts ?? null,
    averageWatts: source.average_watts,
    averageHeartrate: source.average_heartrate,
    hasStreams: !!streams?.has_streams,
  };
}

/** Fastest first; ties go to the earlier ride. Untimed rides come last, unranked. */
export function rankRides(rides: Array<Omit<LoopRide, "rank">>): LoopRide[] {
  const timed = rides
    .filter((ride) => ride.movingSeconds !== null)
    .sort((a, b) => a.movingSeconds! - b.movingSeconds! || byDateThenId(a, b));
  const untimed = rides.filter((ride) => ride.movingSeconds === null).sort(byDateThenId);
  let rank = 0;
  let previous: number | null = null;
  const ranked = timed.map((ride, index) => {
    if (ride.movingSeconds !== previous) rank = index + 1;
    previous = ride.movingSeconds;
    return { ...ride, rank };
  });
  return [...ranked, ...untimed.map((ride) => ({ ...ride, rank: null }))];
}

const DEFAULT_NAME =
  /^(morning|afternoon|evening|lunch|night)\s+(ride|run|walk|hike|swim|gravel ride|mountain bike ride)$/i;

/** The name the rider gives this loop most often, preferring any over Strava's default. */
export function loopName(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.trim(), (counts.get(name.trim()) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (ranked.find(([name]) => name && !DEFAULT_NAME.test(name)) ?? ranked[0])?.[0] ?? "Loop";
}
