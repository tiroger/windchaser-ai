import { toSections } from "@/lib/geo";
import type { Rider } from "@/lib/types";

import { decodePolyline } from "./polyline";
import { stillAirEffort, type StillAirReason, type StillAirResult } from "./still-air";

/**
 * Segment history for the Training section, from the effort history the
 * strava_worker keeps for WindChaser (efforts.json).
 *
 * Efforts recorded by the webhook carry their activity's ID. The older,
 * offline history does not, so those are matched to an activity by time and
 * place: the activity that had started most recently before the effort, whose
 * track passes the segment's start. Activities store wall-clock times and
 * efforts UTC, so the comparison allows for the time zones plausible at the
 * segment's longitude.
 */

export type EffortWeather = {
  wind_speed_ms?: number | null;
  wind_from_deg?: number | null;
  gust_ms?: number | null;
  temperature_c?: number | null;
  humidity_pct?: number | null;
  pressure_hpa?: number | null;
  precip_mm?: number | null;
};

export type StoredEffort = {
  segment_id: number;
  activity_id?: number | string | null;
  /** UTC, ISO 8601. */
  start_date: string;
  elapsed_time_s: number;
  moving_time_s?: number | null;
  average_watts?: number | null;
  /** True when average_watts came from a power meter rather than Strava's estimate. */
  device_watts?: boolean | null;
  average_heartrate?: number | null;
  weather?: EffortWeather | null;
};

export type StoredSegment = {
  id: number;
  name: string;
  distance_m?: number | null;
  average_grade?: number | null;
  /** The segment's line, [lat, lng]; used only on the server, never sent to a browser. */
  points?: Array<[number, number]> | null;
  /** Altitude along the segment, for gradient that varies section by section. */
  elevation_profile?: { distance_m: number[]; altitude_m: number[] } | null;
};

export type EffortHistory = {
  segments: Record<string, StoredSegment>;
  efforts: StoredEffort[];
};

/** The activity fields matching needs. */
export type EffortActivity = {
  id: string;
  /** Wall-clock start, "YYYY-MM-DDTHH:MM:SS". */
  date: string;
  /** Hours. */
  moving_time: number;
  polyline: string | null;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Allowance for stops beyond the moving time when deciding an activity was still going. */
const STOPPED_MS = 4 * HOUR_MS;
/** How close an activity's track must come to a segment's start. */
const NEAR_SEGMENT_METERS = 250;

function finite(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function parseProfile(raw: unknown): StoredSegment["elevation_profile"] {
  const profile = raw as { distance_m?: unknown; altitude_m?: unknown } | null | undefined;
  const distance = profile?.distance_m;
  const altitude = profile?.altitude_m;
  if (!Array.isArray(distance) || !Array.isArray(altitude)) return null;
  if (distance.length < 2 || distance.length !== altitude.length) return null;
  if (![...distance, ...altitude].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return { distance_m: distance as number[], altitude_m: altitude as number[] };
}

/** Validates efforts.json, dropping entries too incomplete to rank. */
export function parseEffortHistory(raw: unknown): EffortHistory {
  const object = (raw ?? {}) as { segments?: unknown; efforts?: unknown };
  const segments: Record<string, StoredSegment> = {};
  if (object.segments && typeof object.segments === "object") {
    for (const [key, value] of Object.entries(object.segments as Record<string, unknown>)) {
      const segment = value as Partial<StoredSegment> | null;
      const id = finite(segment?.id) ?? finite(key);
      if (!segment || id === null) continue;
      segments[String(id)] = {
        id,
        name:
          typeof segment.name === "string" && segment.name.trim() ? segment.name.trim() : "Segment",
        distance_m: finite(segment.distance_m),
        average_grade: finite(segment.average_grade),
        points: Array.isArray(segment.points) ? segment.points : null,
        elevation_profile: parseProfile(segment.elevation_profile),
      };
    }
  }
  const efforts: StoredEffort[] = [];
  if (Array.isArray(object.efforts)) {
    for (const value of object.efforts) {
      const effort = value as Partial<StoredEffort> | null;
      const segmentId = finite(effort?.segment_id);
      const elapsed = finite(effort?.elapsed_time_s);
      if (!effort || segmentId === null || !elapsed || elapsed <= 0) continue;
      if (typeof effort.start_date !== "string" || Number.isNaN(Date.parse(effort.start_date))) {
        continue;
      }
      efforts.push({
        segment_id: segmentId,
        activity_id: effort.activity_id ?? null,
        start_date: effort.start_date,
        elapsed_time_s: elapsed,
        moving_time_s: finite(effort.moving_time_s),
        average_watts: finite(effort.average_watts),
        device_watts: effort.device_watts === true,
        average_heartrate: finite(effort.average_heartrate),
        weather: effort.weather && typeof effort.weather === "object" ? effort.weather : null,
      });
    }
  }
  return { segments, efforts };
}

/** Wall-clock milliseconds of a "YYYY-MM-DDTHH:MM:SS" string, read as if UTC. */
function wallClockMs(date: string): number {
  const text = date.length === 10 ? `${date}T00:00:00` : date;
  return Date.parse(`${text.replace(/(Z|[+-]\d{2}:?\d{2})$/, "")}Z`);
}

function nearTrack(point: [number, number], track: Array<[number, number]>): boolean {
  const cosLat = Math.cos((point[0] * Math.PI) / 180);
  const kx = 111_320 * cosLat;
  const ky = 110_574;
  for (let i = 0; i < track.length; i++) {
    const ax = (track[i][1] - point[1]) * kx;
    const ay = (track[i][0] - point[0]) * ky;
    if (i === track.length - 1) return Math.hypot(ax, ay) <= NEAR_SEGMENT_METERS;
    const bx = (track[i + 1][1] - point[1]) * kx;
    const by = (track[i + 1][0] - point[0]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    if (Math.hypot(ax + t * dx, ay + t * dy) <= NEAR_SEGMENT_METERS) return true;
  }
  return false;
}

/**
 * The activity each effort belongs to: effort index → activity ID. Efforts
 * that cannot be placed (a deleted or private activity) are left out.
 */
export function linkEfforts(
  history: EffortHistory,
  activities: EffortActivity[],
): Map<number, string> {
  const known = new Set(activities.map((activity) => activity.id));
  const sorted = activities
    .map((activity) => ({ activity, start: wallClockMs(activity.date) }))
    .filter((entry) => Number.isFinite(entry.start))
    .sort((a, b) => a.start - b.start);
  const starts = sorted.map((entry) => entry.start);
  const decoded = new Map<string, Array<[number, number]> | null>();
  const trackOf = (activity: EffortActivity) => {
    if (!decoded.has(activity.id)) {
      decoded.set(activity.id, activity.polyline ? decodePolyline(activity.polyline) : null);
    }
    return decoded.get(activity.id)!;
  };

  const links = new Map<number, string>();
  history.efforts.forEach((effort, index) => {
    const direct =
      effort.activity_id === null || effort.activity_id === undefined
        ? null
        : String(effort.activity_id);
    if (direct && known.has(direct)) {
      links.set(index, direct);
      return;
    }
    const segment = history.segments[String(effort.segment_id)];
    const origin = segment?.points?.[0] ?? null;
    const utc = Date.parse(effort.start_date);
    // Plausible UTC offsets at this longitude, most likely first: solar time,
    // then daylight saving and zone boundaries. The first that places the
    // effort inside an activity wins.
    const solar = origin ? Math.round(origin[1] / 15) : null;
    const offsets = solar === null ? range(-12, 14) : [solar, solar + 1, solar + 2, solar - 1];
    let best: string | null = null;
    for (const offset of offsets) {
      const local = utc + offset * HOUR_MS;
      // The latest activity that started at or before this wall-clock time.
      let low = 0;
      let high = starts.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (starts[mid] <= local) low = mid + 1;
        else high = mid;
      }
      for (let i = low - 1; i >= 0 && local - sorted[i].start <= DAY_MS; i--) {
        const { activity, start } = sorted[i];
        // Over by then, even allowing for long stops.
        if (local - start > activity.moving_time * HOUR_MS + STOPPED_MS + HOUR_MS / 10) continue;
        if (origin) {
          const track = trackOf(activity);
          if (!track?.length || !nearTrack(origin, track)) continue;
        }
        best = activity.id;
        break;
      }
      if (best) break;
    }
    if (best) links.set(index, best);
  });
  return links;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

// ---------------------------------------------------------- still air --

/**
 * Whether still-air time is borne out on a segment, judged by the power meter.
 *
 * If the wind correction is right, an effort's still-air time should follow
 * the power the meter recorded more closely than its raw time does: the wind
 * was noise between the two, and the correction removes it. That is checked
 * per segment rather than assumed, because it is not true everywhere. On a
 * sheltered road the hourly reanalysis describes wind the rider never met, and
 * correcting for it adds scatter instead of removing it.
 *
 * - `better`: still-air time tracks measured power at least as well as raw time.
 * - `worse`: it tracks it noticeably less well; shown with a caveat.
 * - `unchecked`: too few metered efforts here to say.
 */
export type StillAirCheck = "better" | "worse" | "unchecked";

/** Metered efforts a segment needs before the check is trusted. */
export const CHECK_MIN_EFFORTS = 5;
/** How much worse (in R²) still-air may track power before it earns a caveat. */
const CHECK_TOLERANCE = 0.03;

export type StillAirIndex = {
  /** Aligned with history.efforts. */
  results: StillAirResult[];
  checks: Map<number, StillAirCheck>;
};

/** Squared correlation; null when either side has no spread. */
export function rSquared(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = x.reduce((a, b) => a + b, 0) / x.length;
  const my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  x.forEach((xi, i) => {
    sxy += (xi - mx) * (y[i] - my);
    sxx += (xi - mx) ** 2;
    syy += (y[i] - my) ** 2;
  });
  return sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : null;
}

/** The segment's line as physics sections, or none when it has no usable line. */
export function segmentSections(segment: StoredSegment | undefined) {
  if (!segment?.points || segment.points.length < 2) return [];
  return toSections(segment.points, segment.average_grade ?? 0, segment.elevation_profile);
}

/**
 * Still-air time for every effort, and the per-segment check against the
 * power meter. Computed once per effort history and cached by the caller.
 */
export function stillAirIndex(history: EffortHistory, rider: Rider): StillAirIndex {
  const sections = new Map<number, ReturnType<typeof segmentSections>>();
  const results = history.efforts.map((effort) => {
    let lines = sections.get(effort.segment_id);
    if (!lines) {
      lines = segmentSections(history.segments[String(effort.segment_id)]);
      sections.set(effort.segment_id, lines);
    }
    return stillAirEffort(lines, rider, effort);
  });

  const metered = new Map<number, Array<{ watts: number; raw: number; still: number }>>();
  history.efforts.forEach((effort, index) => {
    const result = results[index];
    if (result.kind !== "adjusted" || !effort.device_watts || !effort.average_watts) return;
    // Like for like: moving time on both sides, so stops add no scatter.
    const moving = Math.min(effort.moving_time_s || effort.elapsed_time_s, effort.elapsed_time_s);
    const stopped = effort.elapsed_time_s - moving;
    const list = metered.get(effort.segment_id) ?? [];
    list.push({ watts: effort.average_watts, raw: moving, still: result.stillAirSeconds - stopped });
    metered.set(effort.segment_id, list);
  });

  const checks = new Map<number, StillAirCheck>();
  for (const id of sections.keys()) {
    const list = metered.get(id) ?? [];
    if (list.length < CHECK_MIN_EFFORTS) {
      checks.set(id, "unchecked");
      continue;
    }
    // Time against power is a power law, so straight in logs.
    const watts = list.map((entry) => Math.log(entry.watts));
    const raw = rSquared(watts, list.map((entry) => Math.log(entry.raw)));
    const still = rSquared(watts, list.map((entry) => Math.log(entry.still)));
    checks.set(
      id,
      raw === null || still === null ? "unchecked" : still >= raw - CHECK_TOLERANCE ? "better" : "worse",
    );
  }
  return { results, checks };
}

// ----------------------------------------------------------- history --

export type SegmentHistoryPoint = {
  /** Local date of the effort when its activity is known, else the UTC date. */
  date: string;
  elapsedSeconds: number;
  /** Null when the effort has no still-air time; see the row's reason. */
  stillAirSeconds: number | null;
  activityId: string | null;
};

/** This effort and its segment, measured in still air. */
export type StillAirSummary = {
  /** This effort's still-air time; null with a reason when there is none. */
  seconds: number | null;
  reason: StillAirReason | null;
  /** Net tailwind along the segment at rider height, m/s; negative is a headwind. */
  tailwindMs: number | null;
  /** The steady power that reproduces the recorded time in the recorded wind. */
  impliedWatts: number | null;
  /** Rank among the segment's efforts that have a still-air time. */
  rank: number | null;
  /** How many of the segment's efforts have a still-air time. */
  count: number;
  /** The fastest still-air time on the segment, and where it was ridden. */
  bestSeconds: number | null;
  bestDate: string | null;
  bestActivityId: string | null;
  check: StillAirCheck;
};

export type SegmentEffortRow = {
  segmentId: number;
  name: string;
  /** Meters. */
  distance: number | null;
  /** Percent. */
  averageGrade: number | null;
  elapsedSeconds: number;
  averageWatts: number | null;
  /** Average power from a power meter; null when Strava estimated it or none was recorded. */
  measuredWatts: number | null;
  averageHeartrate: number | null;
  /** 1 is the fastest of all your efforts; ties share a rank. */
  rank: number;
  /** How many efforts you have on this segment. */
  efforts: number;
  prSeconds: number;
  /** Seconds slower than the PR; 0 for the PR itself. */
  deltaSeconds: number;
  prDate: string;
  prActivityId: string | null;
  weather: EffortWeather | null;
  /** Null when still-air times were not computed (no rider model to compute them with). */
  stillAir: StillAirSummary | null;
  /** Every effort on the segment, oldest first. */
  history: SegmentHistoryPoint[];
};

/** The local date an effort happened on: its activity's, or the UTC date. */
function effortDate(effort: StoredEffort, activityId: string | null, dates: Map<string, string>) {
  const activityDate = activityId ? dates.get(activityId) : undefined;
  return (activityDate ?? effort.start_date).slice(0, 10);
}

/** The rank an effort holds among all of a segment's efforts. */
export function effortRank(elapsed: number, all: number[]): number {
  return 1 + all.filter((value) => value < elapsed).length;
}

/**
 * This activity's efforts on tracked segments, in the order they were ridden,
 * each ranked against every effort on that segment.
 */
export function activitySegments(
  activityId: string,
  history: EffortHistory,
  links: Map<number, string>,
  activityDates: Map<string, string>,
  stillAir: StillAirIndex | null = null,
): SegmentEffortRow[] {
  const bySegment = new Map<number, number[]>();
  history.efforts.forEach((effort, index) => {
    const list = bySegment.get(effort.segment_id);
    if (list) list.push(index);
    else bySegment.set(effort.segment_id, [index]);
  });

  const mine = history.efforts
    .map((effort, index) => ({ effort, index }))
    .filter(({ index }) => links.get(index) === activityId)
    .sort((a, b) => a.effort.start_date.localeCompare(b.effort.start_date));

  const round1 = (value: number) => Math.round(value * 10) / 10;
  const stillAt = (index: number) => {
    const result = stillAir?.results[index];
    return result?.kind === "adjusted" ? round1(result.stillAirSeconds) : null;
  };

  return mine.map(({ effort, index: effortIndex }) => {
    const indices = bySegment.get(effort.segment_id) ?? [];
    const all = indices.map((index) => history.efforts[index]);
    const times = all.map((entry) => entry.elapsed_time_s);
    // The PR is the fastest effort; between equal times, the first to set it.
    let prIndex = indices[0];
    for (const index of indices) {
      const candidate = history.efforts[index];
      const current = history.efforts[prIndex];
      if (
        candidate.elapsed_time_s < current.elapsed_time_s ||
        (candidate.elapsed_time_s === current.elapsed_time_s &&
          candidate.start_date < current.start_date)
      ) {
        prIndex = index;
      }
    }
    const pr = history.efforts[prIndex];
    const prActivityId = links.get(prIndex) ?? null;
    const segment = history.segments[String(effort.segment_id)];

    let summary: StillAirSummary | null = null;
    if (stillAir) {
      const result = stillAir.results[effortIndex];
      const adjusted = indices.filter((index) => stillAt(index) !== null);
      const stillTimes = adjusted.map((index) => stillAt(index)!);
      let best: number | null = null;
      for (const index of adjusted) {
        if (best === null || stillAt(index)! < stillAt(best)!) best = index;
      }
      const own = stillAt(effortIndex);
      const bestActivity = best === null ? null : (links.get(best) ?? null);
      summary = {
        seconds: own,
        reason: result?.kind === "none" ? result.reason : null,
        tailwindMs: result?.kind === "adjusted" ? round1(result.tailwindMs) : null,
        impliedWatts: result?.kind === "adjusted" ? Math.round(result.impliedWatts) : null,
        rank: own === null ? null : effortRank(own, stillTimes),
        count: adjusted.length,
        bestSeconds: best === null ? null : stillAt(best),
        bestDate: best === null ? null : effortDate(history.efforts[best], bestActivity, activityDates),
        bestActivityId: bestActivity,
        check: stillAir.checks.get(effort.segment_id) ?? "unchecked",
      };
    }

    return {
      segmentId: effort.segment_id,
      name: segment?.name ?? "Segment",
      distance: segment?.distance_m ?? null,
      averageGrade: segment?.average_grade ?? null,
      elapsedSeconds: effort.elapsed_time_s,
      averageWatts: effort.average_watts ?? null,
      measuredWatts: effort.device_watts ? (effort.average_watts ?? null) : null,
      averageHeartrate: effort.average_heartrate ?? null,
      rank: effortRank(effort.elapsed_time_s, times),
      efforts: all.length,
      prSeconds: pr.elapsed_time_s,
      deltaSeconds: effort.elapsed_time_s - pr.elapsed_time_s,
      prDate: effortDate(pr, prActivityId, activityDates),
      prActivityId,
      weather: effort.weather ?? null,
      stillAir: summary,
      history: [...indices]
        .sort((a, b) => history.efforts[a].start_date.localeCompare(history.efforts[b].start_date))
        .map((index) => {
          const entry = history.efforts[index];
          const linked = links.get(index) ?? null;
          return {
            date: effortDate(entry, linked, activityDates),
            elapsedSeconds: entry.elapsed_time_s,
            stillAirSeconds: stillAt(index),
            activityId: linked,
          };
        }),
    };
  });
}
