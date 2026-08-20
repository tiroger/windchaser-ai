import { readFileSync } from "node:fs";
import { join } from "node:path";

import { haversineM } from "@/lib/geo";
import { applyCalibration } from "@/lib/server/calibration";
import { stravaConfig } from "@/lib/server/env";
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

/**
 * Strava and Open-Meteo fail independently, so they degrade independently.
 * A Strava rate limit must not cost us a live forecast: segment geometry is
 * effectively static, while wind is the thing that actually changes.
 */
type Freshness = "live" | "saved";

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

/**
 * The saved bundle is a development convenience, not a deployment artifact. It
 * holds real ride locations and personal record times, so it is gitignored and
 * genuinely absent in a deployed environment. Its absence is normal and must
 * never fail a request: live data is the point, and the fallback only exists
 * for when a provider is unreachable.
 */
function readFixtures(): Bundle | null {
  try {
    const path = join(process.cwd(), "fixtures", "opportunities.json");
    return JSON.parse(readFileSync(path, "utf8")) as Bundle;
  } catch {
    return null;
  }
}


async function loadStarred(): Promise<SegmentCache> {
  if (starredCache && Date.now() - starredCache.fetchedAt < STARRED_TTL_MS) {
    return starredCache;
  }
  // Both must succeed before anything is cached. A throw here leaves the
  // previous good cache in place rather than replacing it with a bad one.
  const [athlete, segments] = await Promise.all([
    fetchAthlete(),
    fetchStarredSegments(),
  ]);
  if (segments.length === 0) {
    throw new Error("Strava returned no starred segments; not caching that.");
  }
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

  let segmentSource: Freshness = "live";
  let forecastSource: Freshness = "live";
  const notices: string[] = [];

  let starred: Segment[];
  let athlete: Bundle["athlete"];
  let saved: Bundle | null = null;
  let savedChecked = false;

  const loadSaved = (): Bundle | null => {
    if (!savedChecked) {
      saved = readFixtures();
      savedChecked = true;
    }
    return saved;
  };

  if (!(await stravaConfig())) {
    const bundle = loadSaved();
    if (!bundle) {
      return Response.json(
        {
          error:
            "No Strava credentials and no saved bundle. Populate the Strava secret for this environment.",
        },
        { status: 503 },
      );
    }
    starred = bundle.segments.filter((s) => s.source === "starred");
    athlete = bundle.athlete;
    segmentSource = "saved";
    notices.push("No Strava credentials found, so segments come from the last saved bundle.");
  } else {
    try {
      const loaded = await loadStarred();
      starred = loaded.segments;
      athlete = loaded.athlete;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const bundle = loadSaved();
      if (!bundle) {
        return Response.json({ error: message }, { status: 502 });
      }
      starred = bundle.segments.filter((s) => s.source === "starred");
      athlete = bundle.athlete;
      segmentSource = "saved";
      notices.push(`Strava unavailable (${message}); segments come from the last saved bundle.`);
    }
  }

  try {
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

    if (targetRegion && segmentSource === "live") {
      try {
        const discovered = await discoverAround(
          targetRegion.lat,
          targetRegion.lon,
          known,
        );
        for (const seg of discovered) {
          seg.region_id = targetRegion!.id;
          all.push(seg);
        }
        targetRegion.discovered_count = discovered.length;
      } catch {
        // Discovery is a bonus. Losing it must not cost the starred segments.
        notices.push("Nearby segment discovery was unavailable this time.");
      }
    } else if (targetRegion) {
      // Reuse whatever discovered segments the saved bundle already had.
      const cached = (loadSaved()?.segments ?? []).filter(
        (s) => s.source === "discovered" && !known.has(s.id),
      );
      for (const seg of cached) all.push(seg);
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
    await applyCalibration(all);

    // Always try for a live forecast, even when segments came from the bundle.
    // Each cell falls back on its own, so one bad cell costs only that cell.
    let forecastCells: Bundle["forecast_cells"];
    try {
      const result = await fetchCells(
        all.map((s) => {
          const m = mid(s);
          return cellOf(m[0], m[1]);
        }),
        loadSaved()?.forecast_cells ?? {},
      );
      forecastCells = result.cells;
      if (result.savedCount > 0 || result.failed.length > 0) {
        forecastSource = "saved";
        notices.push(
          `${result.liveCount} of ${
            result.liveCount + result.savedCount + result.failed.length
          } forecast cells are live; the rest fall back to the last saved forecast.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      forecastCells = loadSaved()?.forecast_cells ?? {};
      forecastSource = "saved";
      notices.push(`Forecast provider unavailable (${message}); using the last saved forecast.`);
    }

    const centre = targetRegion ?? regions[0];
    const bundle: Bundle = {
      generated_at: new Date().toISOString(),
      live: segmentSource === "live" && forecastSource === "live",
      sources: { segments: segmentSource, forecast: forecastSource },
      athlete,
      centre: { lat: centre.lat, lon: centre.lon },
      regions,
      segments: all.sort((a, b) => a.name.localeCompare(b.name)),
      forecast_cells: forecastCells,
    };
    return Response.json(
      notices.length ? { ...bundle, notice: notices.join(" ") } : bundle,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const bundle = loadSaved();
    if (!bundle) {
      return Response.json({ error: message }, { status: 502 });
    }
    await applyCalibration(bundle.segments);
    return Response.json({
      ...bundle,
      live: false,
      sources: { segments: "saved", forecast: "saved" },
      notice: `Live data unavailable (${message}). Showing the last saved bundle.`,
    });
  }
}
