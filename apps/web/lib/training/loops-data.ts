import "server-only";

import type { ActivityRecord } from "@/lib/training/data";
import { loadActivityRecords, loadEffortHistoryObject, loadStreamsIndex } from "@/lib/training/data";
import {
  findLoops,
  loopName,
  loopRide,
  rankRides,
  type LoopIndex,
  type LoopRide,
} from "@/lib/training/loops";
import {
  activitySegments,
  linkEfforts,
  parseEffortHistory,
  type EffortHistory,
  type SegmentEffortRow,
} from "@/lib/training/segments";

/**
 * Loops and segment history as the pages and APIs serve them: activity IDs
 * and metrics only. The tracks they are computed from never leave this module.
 *
 * Both are derived from whole objects and cached against those objects'
 * ETags, so a request after the first costs S3 revalidations and a lookup.
 */

export type LoopDetail = {
  id: string;
  name: string;
  /** Strava sport type of the loop's rides. */
  type: string;
  /** Miles, the median of the rides. */
  distance: number;
  count: number;
  /** Wall-clock start of the first ride. */
  since: string;
  /** Fastest first; see rankRides. */
  rides: LoopRide[];
};

export type LoopSummary = {
  id: string;
  name: string;
  type: string;
  distance: number;
  count: number;
  since: string;
  best: { id: string; date: string; movingSeconds: number; averageSpeed: number | null } | null;
  latest: { id: string; date: string };
};

type LoopCache = {
  key: string;
  index: LoopIndex;
  records: Map<string, ActivityRecord>;
};

let loopCache: LoopCache | null = null;
let loopsInFlight: { key: string; promise: Promise<LoopCache> } | null = null;

/** The loop index for the current activities, recomputed only when they change. */
async function loopIndex(): Promise<LoopCache> {
  const stored = await loadActivityRecords();
  // The local snapshot has no ETag of its own; its length stands in.
  const key = `${stored.etag}#${stored.value.length}`;
  if (loopCache?.key === key) return loopCache;
  if (loopsInFlight?.key === key) return loopsInFlight.promise;
  const promise = Promise.resolve().then(() => {
    const started = performance.now();
    const index = findLoops(stored.value);
    const elapsed = performance.now() - started;
    if (elapsed > 500) console.warn(`[training] loop matching took ${Math.round(elapsed)} ms`);
    const records = new Map(stored.value.map((record) => [record.id, record]));
    loopCache = { key, index, records };
    loopsInFlight = null;
    return loopCache;
  });
  loopsInFlight = { key, promise };
  return promise;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function detailFor(loopId: string, cache: LoopCache): Promise<LoopDetail | null> {
  const loop = cache.index.loops.find((entry) => entry.id === loopId);
  if (!loop) return null;
  const streams = await loadStreamsIndex();
  const records = loop.members.flatMap((id) => cache.records.get(id) ?? []);
  if (!records.length) return null;
  const rides = rankRides(records.map((record) => loopRide(record, streams[record.id])));
  return {
    id: loop.id,
    name: loopName(records.map((record) => record.name)),
    type: records[0].type,
    distance: median(records.map((record) => record.distance)),
    count: records.length,
    since: records[0].date,
    rides,
  };
}

/** The loop an activity belongs to, with every ride ranked; null when it is in none. */
export async function loadActivityLoop(activityId: string): Promise<LoopDetail | null> {
  const cache = await loopIndex();
  const loopId = cache.index.byActivity.get(activityId);
  return loopId ? detailFor(loopId, cache) : null;
}

/** The most-ridden loops, most rides first, optionally limited to some sports. */
export async function loadTopLoops(
  limit = 12,
  include: (type: string) => boolean = () => true,
): Promise<LoopSummary[]> {
  const cache = await loopIndex();
  const streams = await loadStreamsIndex();
  const summaries: LoopSummary[] = [];
  for (const loop of cache.index.loops) {
    if (summaries.length >= limit) break;
    const records = loop.members.flatMap((id) => cache.records.get(id) ?? []);
    if (!records.length || !include(records[0].type)) continue;
    const ranked = rankRides(records.map((record) => loopRide(record, streams[record.id])));
    const best = ranked[0];
    const latest = records[records.length - 1];
    summaries.push({
      id: loop.id,
      name: loopName(records.map((record) => record.name)),
      type: records[0].type,
      distance: median(records.map((record) => record.distance)),
      count: records.length,
      since: records[0].date,
      best:
        best && best.movingSeconds !== null
          ? {
              id: best.id,
              date: best.date,
              movingSeconds: best.movingSeconds,
              averageSpeed: best.averageSpeed,
            }
          : null,
      latest: { id: latest.id, date: latest.date },
    });
  }
  return summaries;
}

// ------------------------------------------------------------ segments --

type SegmentCache = {
  key: string;
  history: EffortHistory;
  links: Map<number, string>;
  dates: Map<string, string>;
};

let segmentCache: SegmentCache | null = null;

async function segmentIndex(): Promise<SegmentCache> {
  const [activities, efforts] = await Promise.all([
    loadActivityRecords(),
    loadEffortHistoryObject(),
  ]);
  const key = `${activities.etag}#${activities.value.length}|${efforts.etag}`;
  if (segmentCache?.key === key) return segmentCache;
  const history = parseEffortHistory(efforts.value);
  const links = linkEfforts(history, activities.value);
  const dates = new Map(activities.value.map((record) => [record.id, record.date]));
  segmentCache = { key, history, links, dates };
  return segmentCache;
}

/** This activity's efforts on WindChaser's tracked segments, each ranked against your history. */
export async function loadActivitySegments(activityId: string): Promise<SegmentEffortRow[]> {
  const { history, links, dates } = await segmentIndex();
  return activitySegments(activityId, history, links, dates);
}
