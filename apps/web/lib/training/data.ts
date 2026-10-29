import "server-only";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";

import type { Activity, Gear, MaintenanceRecord } from "@/lib/training/activity-types";
import { calendarDate, localIsoDate } from "@/lib/training/activity-types";
import { calibrationTable } from "@/lib/server/calibration";
import type { GarminLoads } from "@/lib/training/metrics/load";
import {
  performanceSummary,
  type ActivityStream,
  type PerformanceSummary,
  type StreamsIndex,
} from "@/lib/training/metrics/performance";
import type { RouteProfile, SavedRoute } from "@/lib/training/metrics/route-profile";
import { hideRouteEnds, publicPolyline } from "@/lib/training/polyline";
import { settingsOrDefaults, type Settings } from "@/lib/training/settings";

/**
 * The Training section's data, as services/training_sync writes it to S3.
 *
 * Every object is JSON under APP_DATA_BUCKET, keyed by the variables listed in
 * docs/architecture/TRAINING_INTEGRATION.md. Reads are revalidated by ETag, so
 * the polling that keeps an open page current costs a 304 per object when
 * nothing changed. The two objects the browser can edit (the maintenance log
 * and settings) are written conditionally on the version that was read.
 *
 * Without a bucket, development reads the my-strava snapshot layout from
 * TRAINING_LOCAL_DATA_DIR instead. A production build refuses that fallback
 * unless ALLOW_LOCAL_SNAPSHOT=true, so a deployment that lost its bucket
 * variable fails loudly rather than quietly serving nothing.
 */

// Amplify sets AWS_REGION in the compute runtime; the rest of the app uses the
// same fallback.
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

// Route polylines stay on the server and are fetched per activity, which
// keeps the page payload small.
export type ActivityRecord = Omit<Activity, "hasRoute"> & {
  polyline: string | null;
};

export type Stored<T> = { etag: string; value: T };

export class ConflictError extends Error {
  constructor(what: string) {
    super(`${what} changed during the update`);
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} entry must be an object`);
  }
  return value as Record<string, unknown>;
}

function textOrFallback(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text && !["nan", "none", "null"].includes(text.toLowerCase())) {
      return text;
    }
  }
  return "Activity";
}

function textOrNull(value: unknown): string | null {
  const text = textOrFallback(value);
  return text === "Activity" ? null : text;
}

/**
 * The CSV snapshot stores the map as a Python dict repr, which escapes every
 * backslash. Backslash is a legal polyline character, so leaving the escapes
 * in shifts every coordinate decoded after one, mirroring the rest of the route.
 */
export function mapValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = value.match(/summary_polyline['"]?\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/);
  return match?.[2]?.replace(/\\(.)/g, "$1") || null;
}

export function normalizeDate(value: unknown): string {
  const text = String(value ?? "").trim();
  // The legacy CSV snapshot stores dates as MM-DD-YYYY.
  const legacy = /^(\d{2})-(\d{2})-(\d{4})/.exec(text);
  if (legacy) return `${legacy[3]}-${legacy[1]}-${legacy[2]}`;
  // Strava's start_date_local is wall-clock time despite its trailing "Z".
  return text.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
}

export function normalizeActivity(row: Record<string, unknown>): ActivityRecord {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? "Untitled activity"),
    type: textOrFallback(row.sport_type, row.type),
    date: normalizeDate(row.start_date_local ?? row.date),
    distance: numberOrNull(row.distance) ?? 0,
    moving_time: numberOrNull(row.moving_time) ?? 0,
    total_elevation_gain: numberOrNull(row.total_elevation_gain) ?? 0,
    average_speed: numberOrNull(row.average_speed) ?? 0,
    average_heartrate: numberOrNull(row.average_heartrate),
    max_heartrate: numberOrNull(row.max_heartrate),
    average_watts: numberOrNull(row.average_watts),
    weighted_average_watts: numberOrNull(row.weighted_average_watts),
    max_watts: numberOrNull(row.max_watts),
    kilojoules: numberOrNull(row.kilojoules),
    suffer_score: numberOrNull(row.suffer_score),
    kudos_count: numberOrNull(row.kudos_count) ?? 0,
    gear_id: textOrNull(row.gear_id),
    polyline:
      typeof row.map === "string"
        ? mapValue(row.map)
        : typeof row.map === "object" && row.map !== null
          ? String(
              (row.map as { summary_polyline?: string }).summary_polyline ?? "",
            ) || null
          : null,
  };
}

export function normalizeGear(row: Record<string, unknown>): Gear {
  const id = textOrFallback(row.id, "");
  const kind =
    row.kind === "shoe" || row.kind === "bike" ? row.kind : id.startsWith("g") ? "shoe" : "bike";
  return {
    id,
    name: textOrFallback(row.name, row.nickname, kind === "shoe" ? "Shoes" : "Bike"),
    brand: textOrFallback(row.brand, row.brand_name, "").replace(/^Activity$/, ""),
    model: textOrFallback(row.model, row.model_name, "").replace(/^Activity$/, ""),
    distance: numberOrNull(row.distance) ?? 0,
    retired: row.retired === true || row.retired === "True",
    kind,
  };
}

function normalizeMaintenance(row: Record<string, unknown>): MaintenanceRecord {
  return {
    id: String(row.id ?? ""),
    ...(typeof row.bikeId === "string" ? { bikeId: row.bikeId } : {}),
    bike: String(row.bike ?? ""),
    part: String(row.part ?? ""),
    service: String(row.service ?? ""),
    date: String(row.date ?? ""),
    mileage: numberOrNull(row.mileage) ?? 0,
  };
}

function normalizeSavedRoute(row: Record<string, unknown>): SavedRoute {
  const type = row.type === "ride" || row.type === "run" ? row.type : "other";
  const subTypes = ["road", "mtb", "cx", "trail", "mixed"] as const;
  return {
    id: String(row.id ?? ""),
    name: textOrFallback(row.name, "Route"),
    description: typeof row.description === "string" ? row.description : "",
    type,
    sub_type: subTypes.find((value) => value === row.sub_type) ?? null,
    distance: numberOrNull(row.distance) ?? 0,
    elevation_gain: numberOrNull(row.elevation_gain) ?? 0,
    estimated_moving_time: numberOrNull(row.estimated_moving_time),
    starred: row.starred === true,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    profile_updated_at:
      typeof row.profile_updated_at === "string" ? row.profile_updated_at : null,
    polyline: typeof row.polyline === "string" && row.polyline ? row.polyline : null,
  };
}

// ------------------------------------------------------------ sources --

/**
 * The bucket, or undefined to read the local snapshot. Throws in production
 * when neither is allowed, so a misconfigured deployment cannot look healthy.
 */
function dataBucket(): string | undefined {
  const bucket = process.env.APP_DATA_BUCKET;
  if (
    !bucket &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_LOCAL_SNAPSHOT !== "true"
  ) {
    throw new Error("APP_DATA_BUCKET is not configured");
  }
  return bucket;
}

// Defaults match services/training_sync, so only an unusual layout needs them set.
const objectKeys = {
  activities: () => process.env.ACTIVITIES_S3_KEY ?? "activities.json",
  gear: () => process.env.BIKES_S3_KEY ?? "bikes.json",
  maintenance: () => process.env.MAINTENANCE_S3_KEY ?? "maintenance.json",
  settings: () => process.env.SETTINGS_S3_KEY ?? "settings.json",
  streamsIndex: () => process.env.STREAMS_INDEX_S3_KEY ?? "streams-index.json",
  stream: (id: string) => `${process.env.STREAMS_S3_PREFIX ?? "streams/"}${id}.json`,
  savedRoutes: () => process.env.SAVED_ROUTES_S3_KEY ?? "saved-routes.json",
  efforts: () => process.env.EFFORTS_S3_KEY ?? "efforts.json",
  segmentUsage: () => process.env.SEGMENT_USAGE_S3_KEY ?? "segment-usage.json",
  savedRoute: (id: string) =>
    `${process.env.SAVED_ROUTES_S3_PREFIX ?? "saved-routes/"}${id}.json`,
};

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
}

const objectCache = new Map<string, Stored<unknown>>();

/**
 * Reads a JSON object from S3, reusing the parsed value while its ETag is
 * unchanged. A missing object (before the first sync) reads as `empty`.
 */
async function readJson<T>(
  bucket: string,
  key: string,
  parseValue: (raw: unknown) => T,
  empty: T,
  useCache = true,
): Promise<Stored<T>> {
  const cached = useCache ? (objectCache.get(key) as Stored<T> | undefined) : undefined;
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: cached?.etag }),
    );
    if (!response.Body) throw new Error(`${key} has an empty body`);
    const stored = {
      etag: response.ETag ?? "",
      value: parseValue(JSON.parse(await response.Body.transformToString())),
    };
    if (useCache) objectCache.set(key, stored);
    return stored;
  } catch (error) {
    if (cached && httpStatus(error) === 304) return cached;
    if (httpStatus(error) === 404) {
      objectCache.delete(key);
      return { etag: "", value: empty };
    }
    throw error;
  }
}

function arrayOf<T>(label: string, normalize: (row: Record<string, unknown>) => T) {
  return (raw: unknown): T[] => {
    if (!Array.isArray(raw)) throw new Error(`${label} object must contain a JSON array`);
    return raw.map((row) => normalize(objectRecord(row, label)));
  };
}

const objectOf = (label: string) => (raw: unknown) => objectRecord(raw, label);

let warnedNoLocalDir = false;

/**
 * A file from the local snapshot directory, or null when it (or the directory
 * setting) is absent. The directory is never defaulted: the repository's own
 * data/ folder holds WindChaser's effort history, which is a different thing.
 */
async function readLocalFile(file: string): Promise<string | null> {
  const dir = process.env.TRAINING_LOCAL_DATA_DIR;
  if (!dir) {
    if (!warnedNoLocalDir) {
      warnedNoLocalDir = true;
      console.warn(
        "[training] neither APP_DATA_BUCKET nor TRAINING_LOCAL_DATA_DIR is set; Training shows no data",
      );
    }
    return null;
  }
  try {
    return await readFile(path.resolve(/*turbopackIgnore: true*/ dir, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLocalCsv(file: string): Promise<Record<string, unknown>[]> {
  const contents = await readLocalFile(file);
  if (!contents) return [];
  const rows = parse(contents, { columns: true, skip_empty_lines: true }) as
    | Record<string, unknown>[]
    | undefined;
  return rows ?? [];
}

// ------------------------------------------------------------ objects --

export async function loadActivityRecords(): Promise<Stored<ActivityRecord[]>> {
  const bucket = dataBucket();
  if (bucket) {
    return readJson(bucket, objectKeys.activities(), arrayOf("Activity", normalizeActivity), []);
  }
  const rows = await readLocalCsv("processed_data.csv");
  return { etag: "local", value: rows.map(normalizeActivity) };
}

async function loadGear(): Promise<Stored<Gear[]>> {
  const bucket = dataBucket();
  if (bucket) return readJson(bucket, objectKeys.gear(), arrayOf("Gear", normalizeGear), []);
  const rows = await readLocalCsv("bike_data.csv");
  return {
    etag: "local",
    value: rows.map((row) =>
      normalizeGear({ ...row, distance: row.converted_distance, name: row.nickname || row.name }),
    ),
  };
}

async function loadMaintenance(): Promise<Stored<MaintenanceRecord[]>> {
  const bucket = dataBucket();
  if (!bucket) return { etag: "local", value: [] };
  return readJson(
    bucket,
    objectKeys.maintenance(),
    arrayOf("Maintenance", normalizeMaintenance),
    [],
  );
}

async function loadSettings(): Promise<Stored<Settings>> {
  const bucket = dataBucket();
  if (!bucket) return { etag: "local", value: settingsOrDefaults(null) };
  return readJson(bucket, objectKeys.settings(), settingsOrDefaults, settingsOrDefaults(null));
}

export async function loadStreamsIndex(): Promise<StreamsIndex> {
  const bucket = dataBucket();
  if (bucket) {
    const stored = await readJson(
      bucket,
      objectKeys.streamsIndex(),
      objectOf("Streams index"),
      {},
    );
    return stored.value as StreamsIndex;
  }
  const local = await readLocalFile("streams-index.json");
  return local ? (JSON.parse(local) as StreamsIndex) : {};
}

/**
 * WindChaser's segment effort history (efforts.json, written by
 * strava_worker), parsed by the caller. Null before the first sync.
 */
export async function loadEffortHistoryObject(): Promise<Stored<unknown>> {
  const bucket = dataBucket();
  if (bucket) return readJson(bucket, objectKeys.efforts(), (raw) => raw, null);
  const local = await readLocalFile("efforts.json");
  return { etag: "local", value: local ? (JSON.parse(local) as unknown) : null };
}

/**
 * How often the rider rides every segment, tracked or not (segment-usage.json,
 * counted by strava_worker from each ingested activity). Null before the
 * first ride after it was introduced.
 */
export async function loadSegmentUsageObject(): Promise<Stored<unknown>> {
  const bucket = dataBucket();
  if (bucket) return readJson(bucket, objectKeys.segmentUsage(), (raw) => raw, null);
  const local = await readLocalFile("segment-usage.json");
  return { etag: "local", value: local ? (JSON.parse(local) as unknown) : null };
}

export async function loadActivityStream(id: string): Promise<ActivityStream | null> {
  const bucket = dataBucket();
  if (bucket) {
    // Individual streams are not cached: there are many and each is read rarely.
    const stored = await readJson(bucket, objectKeys.stream(id), objectOf("Stream"), null, false);
    return stored.value as ActivityStream | null;
  }
  const local = await readLocalFile(`streams/${id}.json`);
  return local ? (JSON.parse(local) as ActivityStream) : null;
}

export type RawRouteProfile = {
  id: string;
  updated_at: string;
  distance: number[];
  altitude: number[];
  latlng: Array<[number, number]>;
};

export async function loadSavedRoutes(): Promise<SavedRoute[]> {
  return (await loadSavedRoutesStored()).value;
}

/**
 * The saved routes with the version they were read at. The sync rewrites the
 * list whenever a route or its profile changes, so the ETag doubles as a
 * version for anything derived from every route's profile.
 */
export async function loadSavedRoutesStored(): Promise<Stored<SavedRoute[]>> {
  const bucket = dataBucket();
  if (bucket) {
    return readJson(bucket, objectKeys.savedRoutes(), arrayOf("Saved route", normalizeSavedRoute), []);
  }
  const local = await readLocalFile("saved-routes.json");
  return {
    etag: "local",
    value: local ? arrayOf("Saved route", normalizeSavedRoute)(JSON.parse(local)) : [],
  };
}

export async function loadSavedRouteProfile(id: string): Promise<RawRouteProfile | null> {
  const bucket = dataBucket();
  if (bucket) {
    const stored = await readJson(
      bucket,
      objectKeys.savedRoute(id),
      objectOf("Route profile"),
      null,
      false,
    );
    return stored.value as RawRouteProfile | null;
  }
  const local = await readLocalFile(`saved-routes/${id}.json`);
  return local ? (JSON.parse(local) as RawRouteProfile) : null;
}

export function toActivity({ polyline, ...activity }: ActivityRecord): Activity {
  return { ...activity, hasRoute: !!polyline };
}

export async function loadActivities(): Promise<Activity[]> {
  return (await loadActivityRecords()).value.map(toActivity);
}

export type TrainingData = {
  activities: Activity[];
  gear: Gear[];
  maintenance: MaintenanceRecord[];
  settings: Settings;
  version: string;
};

/**
 * Everything the Training pages render from, read once per request.
 *
 * The layout and the page both need it, and React's cache() makes the second
 * call within one server render free rather than another round of S3
 * revalidations. Route handlers are outside a render, so there it is a plain
 * call.
 */
export const loadTrainingData = cache(async (): Promise<TrainingData> => {
  const [activities, gear, maintenance, settings] = await Promise.all([
    loadActivityRecords(),
    loadGear(),
    loadMaintenance(),
    loadSettings(),
  ]);
  return {
    activities: activities.value.map(toActivity),
    gear: gear.value,
    maintenance: maintenance.value,
    settings: settings.value,
    version: [activities.etag, gear.etag, maintenance.etag, settings.etag].join("|"),
  };
});

/**
 * FTP history, power curves, the five-point profile and training load, scored
 * as of the server's date. Deduplicated per render like loadTrainingData.
 */
export const loadPerformance = cache(async (): Promise<PerformanceSummary> => {
  const [activities, index, settings, garmin, calibration] = await Promise.all([
    loadActivities(),
    loadStreamsIndex(),
    loadSettingsValue(),
    loadGarminLoads(),
    calibrationTable(),
  ]);
  return performanceSummary(activities, index, settings.athlete, calendarDate(localIsoDate())!, {
    garmin,
    fallbackMassKg: calibration.rider?.mass_kg ?? null,
  });
});

/**
 * Garmin's own per-activity training load, keyed by Strava activity id.
 *
 * Reading it needs the Garmin Personal API key in production, which is not
 * set up, so there is nothing to load yet and every load is an estimate. This
 * is the seam for that ingestion: a worker that matches Garmin activities to
 * Strava ones by start time (±3 minutes) and writes their
 * `activityTrainingLoad` here. Whatever it returns takes precedence over the
 * estimates, activity by activity.
 */
async function loadGarminLoads(): Promise<GarminLoads> {
  return {};
}

/** Cheap when nothing changed: cached objects are revalidated with ETags. */
export async function loadDataVersion(): Promise<string> {
  const objects = await Promise.all([
    loadActivityRecords(),
    loadGear(),
    loadMaintenance(),
    loadSettings(),
  ]);
  return objects.map((object) => object.etag).join("|");
}

export async function loadActivityRecord(id: string): Promise<ActivityRecord | null> {
  const { value } = await loadActivityRecords();
  return value.find((activity) => activity.id === id) ?? null;
}

export async function loadActivityRoute(id: string): Promise<string | null> {
  return (await loadActivityRecord(id))?.polyline ?? null;
}

export async function loadRoutes(): Promise<ActivityRecord[]> {
  return (await loadActivityRecords()).value.filter((activity) => activity.polyline);
}

export async function loadMaintenanceRecords(): Promise<MaintenanceRecord[]> {
  return (await loadMaintenance()).value;
}

export async function loadSettingsValue(): Promise<Settings> {
  return (await loadSettings()).value;
}

// ------------------------------------------------------- public shapes --
//
// Anything carrying coordinates leaves the server through one of these, so the
// 500 m privacy trim is applied in one place whether a page renders it or an
// API route returns it.

export type ActivityDetailData = { polyline: string | null; stream: ActivityStream | null };

/** One activity's route and streams with both ends hidden; null when unknown. */
export async function loadPublicActivityDetail(id: string): Promise<ActivityDetailData | null> {
  const [record, stream] = await Promise.all([loadActivityRecord(id), loadActivityStream(id)]);
  if (!record) return null;
  const latlng = stream?.samples.latlng;
  const publicStream =
    stream && latlng
      ? { ...stream, samples: { ...stream.samples, latlng: hideRouteEnds(latlng) } }
      : stream;
  return { polyline: publicPolyline(record.polyline), stream: publicStream };
}

/** Saved routes with their overview polylines trimmed. */
export async function loadPublicSavedRoutes(): Promise<SavedRoute[]> {
  return (await loadSavedRoutes()).map((route) => ({
    ...route,
    polyline: publicPolyline(route.polyline),
  }));
}

/**
 * A saved route's elevation profile and track. Distance and altitude are
 * complete; coordinates near either end are withheld, so the profile still
 * covers the whole route while the map never shows where it starts.
 */
export async function loadPublicRouteProfile(id: string): Promise<RouteProfile | null> {
  const raw = await loadSavedRouteProfile(id);
  if (!raw || !raw.distance?.length) return null;
  return {
    id: raw.id,
    updated_at: raw.updated_at,
    distance: raw.distance,
    altitude: raw.altitude,
    latlng: hideRouteEnds(raw.latlng ?? []),
  };
}

export type HeatRoute = { id: string; type: string; date: string; polyline: string };

/**
 * Every mapped outdoor activity's route, ends trimmed, for the heatmap. Virtual
 * rides are left out: their coordinates place Zwift's worlds on the real map,
 * Watopia in the Pacific among them.
 */
export async function loadPublicHeatmap(): Promise<HeatRoute[]> {
  return (await loadRoutes()).flatMap((activity) => {
    if (/virtual/i.test(activity.type)) return [];
    const polyline = publicPolyline(activity.polyline);
    return polyline
      ? [{ id: activity.id, type: activity.type, date: activity.date.slice(0, 10), polyline }]
      : [];
  });
}

// -------------------------------------------------------------- writes --

// Writes are conditional on the version that was read, so two concurrent
// edits cannot silently overwrite each other.
async function writeConditionally<T>(
  key: string,
  current: Stored<T>,
  value: T,
  what: string,
): Promise<void> {
  const bucket = process.env.APP_DATA_BUCKET;
  if (!bucket) throw new Error("APP_DATA_BUCKET is not configured");
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json",
        CacheControl: "no-cache",
        ...(current.etag ? { IfMatch: current.etag } : { IfNoneMatch: "*" }),
      }),
    );
  } catch (error) {
    if (httpStatus(error) === 412 || httpStatus(error) === 409) {
      objectCache.delete(key);
      throw new ConflictError(what);
    }
    throw error;
  }
}

export async function updateMaintenanceRecords(
  update: (records: MaintenanceRecord[]) => MaintenanceRecord[],
): Promise<void> {
  if (!process.env.APP_DATA_BUCKET) throw new Error("APP_DATA_BUCKET is not configured");
  const current = await loadMaintenance();
  await writeConditionally(
    objectKeys.maintenance(),
    current,
    update(current.value),
    "Maintenance records",
  );
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!process.env.APP_DATA_BUCKET) throw new Error("APP_DATA_BUCKET is not configured");
  const current = await loadSettings();
  await writeConditionally(objectKeys.settings(), current, settings, "Settings");
}
