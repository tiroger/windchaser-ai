import { readFileSync } from "node:fs";
import { join } from "node:path";

import { haversineM } from "@/lib/geo";
import { hasStravaCredentials } from "@/lib/server/env";
import {
  clusterRegions,
  exploreSegments,
  fetchAthlete,
  fetchStarredSegments,
  regionName,
} from "@/lib/server/strava";
import { cellId, cellOf, fetchCells } from "@/lib/server/weather";
import type { Bundle, LatLon, Region, Segment } from "@/lib/types";

export const dynamic = "force-dynamic";

const EXPLORE_RADIUS_KM = 12;
const EXPLORE_LIMIT = 8;
/** Beyond this from every known region, treat the rider as somewhere new. */
const NEW_REGION_KM = 60;

interface SegmentCache {
  segments: Segment[];
  athlete: Bundle["athlete"];
  fetchedAt: number;
}
let starredCache: SegmentCache | null = null;
const STARRED_TTL_MS = 60 * 60 * 1000;

const exploredCache = new Map<string, { segments: Segment[]; fetchedAt: number }>();
const EXPLORED_TTL_MS = 6 * 60 * 60 * 1000;

const mid = (s: Segment): LatLon => s.points[Math.floor(s.points.length / 2)];

function readFixtures(): Bundle {
  const path = join(process.cwd(), "fixtures", "opportunities.json");
  return JSON.parse(readFileSync(path, "utf8")) as Bundle;
}

interface CalibrationEntry {
  segment_id: number;
  power_w: number | null;
  attempt_count: number | null;
  best_moving_time_s: number | null;
  elevation_profile: Segment["elevation_profile"];
}

let calibrationCache: Record<string, CalibrationEntry> | null = null;

/**
 * Power fitted across recorded attempts, plus real elevation profiles.
 * Produced offline by scripts/build_calibration.py because it needs the
 * rider's full effort history and reanalysis weather.
 */
function readCalibration(): Record<string, CalibrationEntry> {
  if (calibrationCache) return calibrationCache;
  try {
    const path = join(process.cwd(), "fixtures", "calibration.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      segments: Record<string, CalibrationEntry>;
    };
    calibrationCache = parsed.segments ?? {};
  } catch {
    calibrationCache = {};
  }
  return calibrationCache;
}

/** Attach the fit to each segment; segments without one keep the PR fallback. */
function applyCalibration(segments: Segment[]): void {
  const calibration = readCalibration();
  for (const seg of segments) {
    const entry = calibration[String(seg.id)];
    if (!entry) continue;
    seg.calibrated_power_w = entry.power_w ?? null;
    seg.attempt_count = entry.attempt_count ?? null;
    seg.best_moving_time_s = entry.best_moving_time_s ?? null;
    seg.elevation_profile = entry.elevation_profile ?? null;
  }
}

async function loadStarred(): Promise<SegmentCache> {
  if (starredCache && Date.now() - starredCache.fetchedAt < STARRED_TTL_MS) {
    return starredCache;
  }
  const [athlete, segments] = await Promise.all([
    fetchAthlete(),
    fetchStarredSegments(),
  ]);
  starredCache = {
    segments,
    athlete: {
      firstname: athlete.firstname,
      city: athlete.city,
      state: athlete.state,
      country: athlete.country,
      weight_kg: athlete.weight,
      ftp: athlete.ftp,
    },
    fetchedAt: Date.now(),
  };
  return starredCache;
}

async function discoverAround(
  lat: number,
  lon: number,
  skip: Set<number>,
): Promise<Segment[]> {
  const key = cellId(cellOf(lat, lon));
  const hit = exploredCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < EXPLORED_TTL_MS) return hit.segments;

  const found = await exploreSegments(
    lat,
    lon,
    EXPLORE_RADIUS_KM,
    EXPLORE_LIMIT,
    skip,
  );
  exploredCache.set(key, { segments: found, fetchedAt: Date.now() });
  return found;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const latParam = url.searchParams.get("lat");
  const lonParam = url.searchParams.get("lon");
  const here: LatLon | null =
    latParam && lonParam ? [Number(latParam), Number(lonParam)] : null;

  if (!hasStravaCredentials()) {
    const bundle = readFixtures();
    applyCalibration(bundle.segments);
    return Response.json({
      ...bundle,
      live: false,
      notice:
        "No Strava credentials found. Showing the last saved fixture bundle.",
    });
  }

  try {
    const { segments: starred, athlete } = await loadStarred();
    const all: Segment[] = [];
    const regions: Region[] = [];

    const clusters = clusterRegions(starred);
    clusters.forEach((cluster, index) => {
      const id = `r${index}`;
      const mids = cluster.map(mid);
      const lat = mids.reduce((s, m) => s + m[0], 0) / mids.length;
      const lon = mids.reduce((s, m) => s + m[1], 0) / mids.length;
      for (const seg of cluster) {
        seg.region_id = id;
        all.push(seg);
      }
      regions.push({
        id,
        name: regionName(cluster),
        lat,
        lon,
        starred_count: cluster.length,
      });
    });

    // Discover around whichever region the rider is actually in. If they are
    // nowhere near a starred region, explore their real position instead.
    const known = new Set(all.map((s) => s.id));
    let targetRegion: Region | null = null;

    if (here) {
      let nearest: { region: Region; distance: number } | null = null;
      for (const region of regions) {
        const d = haversineM(here, [region.lat, region.lon]);
        if (!nearest || d < nearest.distance) nearest = { region, distance: d };
      }
      if (nearest && nearest.distance < NEW_REGION_KM * 1000) {
        targetRegion = nearest.region;
      } else {
        const id = "here";
        targetRegion = {
          id,
          name: "Around you",
          lat: here[0],
          lon: here[1],
          starred_count: 0,
        };
        regions.unshift(targetRegion);
      }
    } else if (regions.length > 0) {
      targetRegion = regions[0];
    }

    if (targetRegion) {
      const discovered = await discoverAround(
        targetRegion.lat,
        targetRegion.lon,
        known,
      );
      for (const seg of discovered) {
        seg.region_id = targetRegion.id;
        all.push(seg);
      }
      targetRegion.discovered_count = discovered.length;
    }

    if (all.length === 0) {
      return Response.json(
        { error: "No segments found. Star a few segments on Strava." },
        { status: 404 },
      );
    }

    for (const seg of all) {
      const m = mid(seg);
      seg.cell_id = cellId(cellOf(m[0], m[1]));
    }
    applyCalibration(all);
    const forecastCells = await fetchCells(
      all.map((s) => {
        const m = mid(s);
        return cellOf(m[0], m[1]);
      }),
    );

    const centre = targetRegion ?? regions[0];
    const bundle: Bundle = {
      generated_at: new Date().toISOString(),
      live: true,
      athlete,
      centre: { lat: centre.lat, lon: centre.lon },
      regions,
      segments: all.sort((a, b) => a.name.localeCompare(b.name)),
      forecast_cells: forecastCells,
    };
    return Response.json(bundle);
  } catch (error) {
    // Live data failed. The saved bundle keeps the interface usable.
    const message = error instanceof Error ? error.message : "Unknown error";
    try {
      const bundle = readFixtures();
      applyCalibration(bundle.segments);
      return Response.json({
        ...bundle,
        live: false,
        notice: `Live data unavailable (${message}). Showing the last saved bundle.`,
      });
    } catch {
      return Response.json({ error: message }, { status: 502 });
    }
  }
}
