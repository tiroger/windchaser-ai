import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { Segment } from "../types";

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

let cached: Table | null = null;
let inFlight: Promise<Table> | null = null;

function fromDisk(): Table | null {
  try {
    const path = join(process.cwd(), "fixtures", "calibration.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { segments: Table };
    return parsed.segments ?? null;
  } catch {
    return null;
  }
}

async function fromS3(): Promise<Table | null> {
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
    const parsed = JSON.parse(body) as { segments: Table };
    return parsed.segments ?? null;
  } catch (error) {
    // Missing calibration degrades accuracy; it must not fail a request.
    console.error(
      "[calibration] could not read from S3:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function load(): Promise<Table> {
  // The working copy wins, so a local run uses freshly generated calibration
  // without needing to upload it first.
  return fromDisk() ?? (await fromS3()) ?? {};
}

/** Resolved once per container, coalescing concurrent callers. */
export async function calibrationTable(): Promise<Table> {
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

/** Attach the fit to each segment; those without one keep the PR fallback. */
export async function applyCalibration(segments: Segment[]): Promise<number> {
  const table = await calibrationTable();
  let applied = 0;
  for (const seg of segments) {
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
