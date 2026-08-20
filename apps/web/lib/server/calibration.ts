import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { Bundle, RiderModel, Segment } from "../types";

/**
 * Per-segment calibration: power fitted across recorded attempts in their real
 * weather, plus a real elevation profile.
 *
 * Produced offline by scripts/build_calibration.py, which needs the full effort
 * history and reanalysis weather, so it cannot be built at deploy time. It also
 * carries fitted power, best times and attempt dates -- personal training data
 * that has no business in a public repository -- so deployed it is read from
 * S3, and locally from the working copy.
 *
 * Without it every segment falls back to single-PR calibration, which backtests
 * roughly twice as inaccurate and biased 81 seconds optimistic. Functional, but
 * the probabilities are not honest.
 */

export interface CalibrationEntry {
  segment_id: number;
  power_w: number | null;
  attempt_count: number | null;
  best_moving_time_s: number | null;
  elevation_profile: Segment["elevation_profile"];
}

type Table = Record<string, CalibrationEntry>;

/** The per-segment table plus the rider-level model that backs everything else. */
interface Calibration {
  segments: Table;
  rider: RiderModel | null;
}

let cached: Calibration | null = null;
let inFlight: Promise<Calibration> | null = null;

function parse(text: string): Calibration | null {
  const parsed = JSON.parse(text) as {
    segments?: Table;
    rider?: RiderModel | null;
  };
  if (!parsed.segments) return null;
  return { segments: parsed.segments, rider: parsed.rider ?? null };
}

function fromDisk(): Calibration | null {
  try {
    const path = join(process.cwd(), "fixtures", "calibration.json");
    return parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function fromS3(): Promise<Calibration | null> {
  const bucket = process.env.APP_DATA_BUCKET;
  const key = process.env.CALIBRATION_S3_KEY;
  if (!bucket || !key) return null;

  try {
    const client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await result.Body?.transformToString();
    if (!body) return null;
    return parse(body);
  } catch (error) {
    // Missing calibration degrades accuracy; it must not fail a request.
    console.error(
      "[calibration] could not read from S3:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function load(): Promise<Calibration> {
  // The working copy wins, so a local run uses freshly generated calibration
  // without needing to upload it first.
  return fromDisk() ?? (await fromS3()) ?? { segments: {}, rider: null };
}

/** Resolved once per container, coalescing concurrent callers. */
export async function calibrationTable(): Promise<Calibration> {
  if (cached) return cached;
  if (!inFlight) {
    inFlight = load().then((table) => {
      cached = table;
      inFlight = null;
      return table;
    });
  }
  return inFlight;
}

/**
 * Attach the fit to each segment.
 *
 * The rider model goes on every segment, including those with no fit of their
 * own -- they are the reason it exists. Roughly two thirds of what the app
 * shows has never been ridden enough to calibrate, and those previously fell
 * back to fitting power from a single record in still air.
 */
export async function applyCalibration(segments: Segment[]): Promise<number> {
  const { segments: table, rider } = await calibrationTable();
  let applied = 0;
  for (const seg of segments) {
    seg.rider_model = rider;
    const entry = table[String(seg.id)];
    if (!entry) continue;
    seg.calibrated_power_w = entry.power_w ?? null;
    seg.attempt_count = entry.attempt_count ?? null;
    seg.best_moving_time_s = entry.best_moving_time_s ?? null;
    seg.elevation_profile = entry.elevation_profile ?? null;
    if (entry.power_w) applied++;
  }
  return applied;
}


/**
 * The saved opportunity bundle, used only when a provider is unreachable.
 *
 * Deployed, this lives beside the calibration in S3 for the same reason: it
 * holds real segment geometry and personal record times. Without it a Strava
 * rate limit -- which happens routinely, the read quota is a hundred calls per
 * fifteen minutes -- takes the whole app down instead of degrading it.
 */
let savedBundle: Bundle | null | undefined;
let bundleInFlight: Promise<Bundle | null> | null = null;

async function loadBundle(): Promise<Bundle | null> {
  try {
    const path = join(process.cwd(), "fixtures", "opportunities.json");
    return JSON.parse(readFileSync(path, "utf8")) as Bundle;
  } catch {
    // Expected when deployed; the working copy is not shipped.
  }

  const bucket = process.env.APP_DATA_BUCKET;
  const key = process.env.BUNDLE_S3_KEY;
  if (!bucket || !key) return null;

  try {
    const client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await result.Body?.transformToString();
    return body ? (JSON.parse(body) as Bundle) : null;
  } catch (error) {
    console.error(
      "[bundle] could not read the saved bundle:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Resolved once per container. Null means there is no fallback available. */
export async function savedOpportunityBundle(): Promise<Bundle | null> {
  if (savedBundle !== undefined) return savedBundle;
  if (!bundleInFlight) {
    bundleInFlight = loadBundle().then((b) => {
      savedBundle = b;
      bundleInFlight = null;
      return b;
    });
  }
  return bundleInFlight;
}
