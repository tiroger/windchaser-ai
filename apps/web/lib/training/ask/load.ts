import "server-only";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { localIsoDate } from "@/lib/training/activity-types";
import { loadStreamsIndex, loadTrainingData } from "@/lib/training/data";

import type { AskData, EffortSegment, EffortsData, SegmentEffort } from "./types";

/**
 * Reads for the Ask tools. Activities, gear, the maintenance log, settings and
 * the streams index come through lib/training/data, which caches by ETag.
 * efforts.json is not part of the Training pages' data, so it gets its own
 * small reader here, with the same ETag revalidation and the geometry (segment
 * points and elevation profiles) dropped on parse: nothing downstream may see
 * coordinates, and it keeps the cached copy small.
 */

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
let effortsCache: { etag: string; value: EffortsData } | null = null;

const EMPTY: EffortsData = { generated_at: null, segments: {}, efforts: [] };

function numberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseEfforts(raw: unknown): EffortsData {
  if (typeof raw !== "object" || raw === null) throw new Error("efforts.json must be an object");
  const root = raw as Record<string, unknown>;
  const segments: Record<string, EffortSegment> = {};
  const rawSegments = (root.segments ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, segment] of Object.entries(rawSegments)) {
    if (typeof segment !== "object" || segment === null) continue;
    segments[key] = {
      id: numberOr(segment.id, Number(key)),
      name: typeof segment.name === "string" ? segment.name : "",
      distance_m: numberOr(segment.distance_m, 0),
      average_grade: numberOr(segment.average_grade, 0),
      pr_elapsed_time: numberOr(segment.pr_elapsed_time, null),
    };
  }
  const efforts: SegmentEffort[] = [];
  for (const item of Array.isArray(root.efforts) ? root.efforts : []) {
    if (typeof item !== "object" || item === null) continue;
    const effort = item as Record<string, unknown>;
    const weather = (effort.weather ?? null) as Record<string, unknown> | null;
    if (typeof effort.start_date !== "string" || typeof effort.segment_id !== "number") continue;
    efforts.push({
      segment_id: effort.segment_id,
      start_date: effort.start_date,
      elapsed_time_s: numberOr(effort.elapsed_time_s, 0),
      moving_time_s: numberOr(effort.moving_time_s, 0),
      distance_m: numberOr(effort.distance_m, 0),
      average_watts: numberOr(effort.average_watts, null),
      device_watts: effort.device_watts === true,
      average_heartrate: numberOr(effort.average_heartrate, null),
      cell_id: typeof effort.cell_id === "string" ? effort.cell_id : null,
      weather: weather
        ? {
            wind_speed_ms: numberOr(weather.wind_speed_ms, null),
            wind_from_deg: numberOr(weather.wind_from_deg, null),
            gust_ms: numberOr(weather.gust_ms, null),
            temperature_c: numberOr(weather.temperature_c, null),
          }
        : null,
    });
  }
  return {
    generated_at: typeof root.generated_at === "string" ? root.generated_at : null,
    segments,
    efforts,
  };
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

export async function loadEfforts(): Promise<EffortsData> {
  const bucket = process.env.APP_DATA_BUCKET;
  if (!bucket) {
    const dir = process.env.TRAINING_LOCAL_DATA_DIR;
    if (!dir) return EMPTY;
    try {
      const text = await readFile(path.resolve(/*turbopackIgnore: true*/ dir, "efforts.json"), "utf8");
      return parseEfforts(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw error;
    }
  }
  const key = process.env.EFFORTS_S3_KEY ?? "efforts.json";
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: effortsCache?.etag }),
    );
    if (!response.Body) throw new Error(`${key} has an empty body`);
    const value = parseEfforts(JSON.parse(await response.Body.transformToString()));
    effortsCache = { etag: response.ETag ?? "", value };
    return value;
  } catch (error) {
    if (effortsCache && httpStatus(error) === 304) return effortsCache.value;
    if (httpStatus(error) === 404) return EMPTY;
    throw error;
  }
}

/** One question's data: read once, shared by every tool call it makes. */
export async function loadAskData(): Promise<AskData> {
  const [training, streamsIndex] = await Promise.all([loadTrainingData(), loadStreamsIndex()]);
  let efforts: Promise<EffortsData> | null = null;
  return {
    today: localIsoDate(),
    activities: training.activities,
    gear: training.gear,
    maintenance: training.maintenance,
    settings: training.settings,
    streamsIndex,
    efforts: () => (efforts ??= loadEfforts()),
  };
}
