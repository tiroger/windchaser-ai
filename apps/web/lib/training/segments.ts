import { decodePolyline } from "./polyline";

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
  average_heartrate?: number | null;
  weather?: EffortWeather | null;
};

export type StoredSegment = {
  id: number;
  name: string;
  distance_m?: number | null;
  average_grade?: number | null;
  /** The segment's line, [lat, lng]; used only on the server to place efforts. */
  points?: Array<[number, number]> | null;
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

// ----------------------------------------------------------- history --

export type SegmentHistoryPoint = {
  /** Local date of the effort when its activity is known, else the UTC date. */
  date: string;
  elapsedSeconds: number;
  activityId: string | null;
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

  return mine.map(({ effort }) => {
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
    return {
      segmentId: effort.segment_id,
      name: segment?.name ?? "Segment",
      distance: segment?.distance_m ?? null,
      averageGrade: segment?.average_grade ?? null,
      elapsedSeconds: effort.elapsed_time_s,
      averageWatts: effort.average_watts ?? null,
      averageHeartrate: effort.average_heartrate ?? null,
      rank: effortRank(effort.elapsed_time_s, times),
      efforts: all.length,
      prSeconds: pr.elapsed_time_s,
      deltaSeconds: effort.elapsed_time_s - pr.elapsed_time_s,
      prDate: effortDate(pr, prActivityId, activityDates),
      prActivityId,
      weather: effort.weather ?? null,
      history: [...indices]
        .sort((a, b) => history.efforts[a].start_date.localeCompare(history.efforts[b].start_date))
        .map((index) => {
          const entry = history.efforts[index];
          const linked = links.get(index) ?? null;
          return {
            date: effortDate(entry, linked, activityDates),
            elapsedSeconds: entry.elapsed_time_s,
            activityId: linked,
          };
        }),
    };
  });
}
