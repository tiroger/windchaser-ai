import { haversineM } from "@/lib/geo";
import {
  applyCalibration,
  savedOpportunityBundle,
} from "@/lib/server/calibration";
import { discoverNear, discoveryNotice } from "@/lib/server/discovery";
import { stravaConfig } from "@/lib/server/env";
import { trackedSegments } from "@/lib/server/segment-records";
import { fetchAthlete, fetchStarredSegments } from "@/lib/server/strava";
import { cellId, cellOf, fetchCells } from "@/lib/server/weather";
import {
  buildRegions,
  mergeCandidates,
  parseUsage,
  type UsageEntry,
} from "@/lib/segment-candidates";
import { loadSegmentUsageObject } from "@/lib/training/data";
import type { Bundle, LatLon, Region, Segment } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Strava and Open-Meteo fail independently, so they degrade independently.
 * A Strava rate limit must not cost us a live forecast: segment geometry is
 * effectively static, while wind is the thing that actually changes.
 *
 * The candidates are what the rider rides: starred segments, the tracked
 * segments with effort history, and segments discovered around the rider's
 * position (see lib/segment-candidates.ts). Each source fails on its own.
 */
type Freshness = "live" | "saved";

/** Beyond this from every region, the rider is somewhere new. */
const NEW_REGION_KM = 60;
/** Saved discoveries within this of where discovery searched stand in when it fails. */
const SAVED_DISCOVERY_KM = 40;

interface SegmentCache {
  segments: Segment[];
  athlete: Bundle["athlete"];
  fetchedAt: number;
}
let starredCache: SegmentCache | null = null;
const STARRED_TTL_MS = 60 * 60 * 1000;

const mid = (s: Segment): LatLon => s.points[Math.floor(s.points.length / 2)];

async function loadStarred(known?: Map<number, Segment>): Promise<SegmentCache> {
  if (starredCache && Date.now() - starredCache.fetchedAt < STARRED_TTL_MS) {
    return starredCache;
  }
  // Both must succeed before anything is cached. A throw here leaves the
  // previous good cache in place rather than replacing it with a bad one.
  const [athlete, segments] = await Promise.all([
    fetchAthlete(),
    fetchStarredSegments(known),
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

/** segment-usage.json, or nothing: usage only refines the ranking. */
async function loadUsage(): Promise<Map<number, UsageEntry>> {
  try {
    return parseUsage((await loadSegmentUsageObject()).value);
  } catch (error) {
    console.error(
      "[opportunities] could not read segment usage:",
      error instanceof Error ? error.message : error,
    );
    return new Map();
  }
}

/** Strava's town for a tracked segment, which the effort history does not record. */
function withTowns(tracked: Segment[], known: Map<number, Segment>): Segment[] {
  return tracked.map((segment) => {
    const other = known.get(segment.id);
    return other ? { ...segment, city: segment.city ?? other.city, state: segment.state ?? other.state } : segment;
  });
}

/** Copies, so a cached segment never carries one request's region into the next. */
const fresh = (segments: Segment[]): Segment[] =>
  segments.map((s) => ({ ...s, sources: undefined, region_id: "", cell_id: "" }));

/** A finite latitude and longitude from the query, or null. */
function position(url: URL): LatLon | null {
  const lat = url.searchParams.get("lat");
  const lon = url.searchParams.get("lon");
  if (!lat || !lon) return null;
  const at: LatLon = [Number(lat), Number(lon)];
  return Number.isFinite(at[0]) && Number.isFinite(at[1]) && Math.abs(at[0]) <= 90 && Math.abs(at[1]) <= 180
    ? at
    : null;
}

export async function GET(request: Request) {
  const here = position(new URL(request.url));

  let segmentSource: Freshness = "live";
  let forecastSource: Freshness = "live";
  const notices: string[] = [];

  let starred: Segment[];
  let athlete: Bundle["athlete"];
  let saved: Bundle | null = null;
  let savedChecked = false;

  const loadSaved = async (): Promise<Bundle | null> => {
    if (!savedChecked) {
      saved = await savedOpportunityBundle();
      savedChecked = true;
    }
    return saved;
  };

  if (!(await stravaConfig())) {
    const bundle = await loadSaved();
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
      // The saved bundle doubles as durable segment geometry, which turns a
      // starred refresh from twenty-seven Strava reads into one. The PR on a
      // reused record can then be as old as the bundle; the effort history
      // below replaces it wherever the rider has one.
      const stored = await loadSaved();
      const known = new Map<number, Segment>(
        (stored?.segments ?? []).map((s) => [s.id, s]),
      );
      const loaded = await loadStarred(known);
      starred = loaded.segments;
      athlete = loaded.athlete;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const bundle = await loadSaved();
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
    const savedSegments = (await loadSaved())?.segments ?? [];
    const towns = new Map<number, Segment>(
      [...savedSegments, ...starred].map((s) => [s.id, s]),
    );

    // The tracked segments: the effort history's, with the rider's record on
    // each. Losing them costs the history, not the starred segments.
    let tracked: Segment[] = [];
    try {
      tracked = withTowns(await trackedSegments(), towns);
    } catch (error) {
      console.error(
        "[opportunities] could not read the effort history:",
        error instanceof Error ? error.message : error,
      );
      notices.push("Your segment history could not be read this time, so only starred segments are shown.");
    }
    const usage = await loadUsage();

    // Discovery searches the rider's own position when there is one, and
    // otherwise the region they ride most, which buildRegions puts first.
    const known = mergeCandidates({ starred: fresh(starred), tracked: fresh(tracked) }, usage);
    const ridden = buildRegions(known)[0];
    const searchAt: LatLon | null = here ?? (ridden ? [ridden.lat, ridden.lon] : null);
    const knownIds = new Set(known.map((s) => s.id));

    // Discovery never warns on the page. Its failures are logged where they
    // happen (lib/server/discovery.ts); the page gets a quiet note saying
    // where the nearby segments came from.
    let discovered: Segment[] = [];
    let discovery: NonNullable<Bundle["discovery"]> = { source: "none", note: null };
    let discoveryFailure: string | null = null;
    if (searchAt && segmentSource === "live") {
      try {
        discovered = await discoverNear(searchAt, knownIds);
        discovery = { source: "live", note: null };
      } catch (error) {
        discoveryFailure = discoveryNotice(error);
      }
    }
    if (discovered.length === 0 && searchAt) {
      // Whatever the saved bundle discovered near there stands in.
      discovered = savedSegments.filter(
        (s) =>
          s.source === "discovered" &&
          !knownIds.has(s.id) &&
          haversineM(searchAt, mid(s)) < SAVED_DISCOVERY_KM * 1000,
      );
      if (discovered.length > 0) {
        discovery = { source: "saved", note: "Nearby segments from the last saved discovery." };
      } else if (discoveryFailure) {
        discovery = { source: "none", note: "No nearby segments discovered this time." };
      }
      if (discoveryFailure) {
        console.info(
          `[discovery] ${discoveryFailure} ${discovered.length} saved discoveries stand in.`,
        );
      }
    }

    const all = mergeCandidates(
      { starred: fresh(starred), tracked: fresh(tracked), discovered: fresh(discovered) },
      usage,
    );
    const regions = buildRegions(all);

    // The region the rider is in. Far from every region, they are somewhere
    // new: whatever was discovered around them already forms its own region,
    // and with nothing discovered an empty one says so.
    let targetRegion: Region | null = regions[0] ?? null;
    if (here) {
      const closest = regions
        .map((region) => ({ region, distance: haversineM(here, [region.lat, region.lon]) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (closest && closest.distance < NEW_REGION_KM * 1000) {
        targetRegion = closest.region;
      } else {
        targetRegion = {
          id: "here",
          name: "Around you",
          lat: here[0],
          lon: here[1],
          starred_count: 0,
          segment_count: 0,
        };
        regions.unshift(targetRegion);
      }
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
        (await loadSaved())?.forecast_cells ?? {},
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
      forecastCells = (await loadSaved())?.forecast_cells ?? {};
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
      discovery,
    };
    return Response.json(
      notices.length ? { ...bundle, notice: notices.join(" ") } : bundle,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const bundle = await loadSaved();
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
