#!/usr/bin/env python3
"""Build the WindChaser demo fixture bundle from live Strava and weather data.

Reads credentials from .env, pulls starred and nearby segments from Strava,
attaches an hourly forecast to each one, and writes a single JSON bundle that
the web interface consumes without any runtime API access.

Forecasts are fetched per provider grid cell rather than per segment, matching
the caching policy in docs/architecture/COST_STRATEGY.md and the ForecastCell
entity in section 8 of docs/PROJECT_PLAN.md. Segments sharing a cell share one
provider call.

Standard library only, so it runs with no dependency install.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_FILE = REPO / ".env"
OUT_FILE = REPO / "apps" / "web" / "fixtures" / "opportunities.json"

STRAVA = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

# Forecast grid cell size in degrees. ~0.1 deg is a good match for the
# resolution of the underlying weather models and keeps the cell count low.
CELL_DEG = 0.1


# --------------------------------------------------------------------------
# environment
# --------------------------------------------------------------------------

def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        sys.exit(
            f"No .env at {ENV_FILE}\n"
            "Copy .env.example to .env and fill in your Strava credentials."
        )
    env: dict[str, str] = {}
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip("'\"")
    # Accept the unprefixed names used by the my-strava project as a fallback,
    # so an existing .env can be reused without editing it.
    missing = []
    for key in ("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN"):
        if env.get(key):
            continue
        legacy = key.removeprefix("STRAVA_")
        if env.get(legacy):
            env[key] = env[legacy]
        else:
            missing.append(f"{key} (or {legacy})")
    if missing:
        sys.exit(f"Missing required values in .env: {', '.join(missing)}")
    return env


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

def http_json(url: str, *, data: dict | None = None, token: str | None = None):
    """GET or POST JSON with backoff on transient failures and rate limits."""
    body = urllib.parse.urlencode(data).encode() if data else None
    headers = {"Accept": "application/json", "User-Agent": "windchaser-fixtures/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    for attempt in range(5):
        req = urllib.request.Request(url, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                wait = 60 * (attempt + 1)
                print(f"  rate limited, waiting {wait}s", flush=True)
                time.sleep(wait)
                continue
            if exc.code in (500, 502, 503, 504) and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            detail = exc.read().decode()[:400]
            raise SystemExit(f"HTTP {exc.code} from {url}\n{detail}") from exc
        except urllib.error.URLError as exc:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"Network error for {url}: {exc.reason}") from exc
    raise SystemExit(f"Gave up on {url}")


def access_token(env: dict[str, str]) -> str:
    print("Refreshing Strava access token")
    payload = http_json(
        TOKEN_URL,
        data={
            "client_id": env["STRAVA_CLIENT_ID"],
            "client_secret": env["STRAVA_CLIENT_SECRET"],
            "refresh_token": env["STRAVA_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        },
    )
    if "access_token" not in payload:
        sys.exit(f"Token refresh failed: {payload}")
    new_refresh = payload.get("refresh_token")
    if new_refresh and new_refresh != env["STRAVA_REFRESH_TOKEN"]:
        # Never print the token itself; this output may be captured in logs.
        (REPO / ".strava-refresh-token").write_text(new_refresh + "\n")
        print(
            "  Strava rotated your refresh token. The new value was written to\n"
            "  .strava-refresh-token (gitignored). Move it into .env, then delete\n"
            "  that file. The old token in .env will stop working."
        )
    return payload["access_token"]


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def decode_polyline(encoded: str) -> list[tuple[float, float]]:
    """Decode a Google encoded polyline into (lat, lon) pairs."""
    points: list[tuple[float, float]] = []
    index = lat = lon = 0
    while index < len(encoded):
        for axis in ("lat", "lon"):
            result = shift = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == "lat":
                lat += delta
            else:
                lon += delta
        points.append((lat / 1e5, lon / 1e5))
    return points


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def simplify(points: list[tuple[float, float]], max_points: int = 240):
    """Even stride reduction. Keeps payload small without distorting shape."""
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    out = [points[int(i * step)] for i in range(max_points)]
    out[-1] = points[-1]
    return out


def cell_of(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat / CELL_DEG) * CELL_DEG, round(lon / CELL_DEG) * CELL_DEG)


def cell_id(cell: tuple[float, float]) -> str:
    return f"{cell[0]:.2f},{cell[1]:.2f}"


# --------------------------------------------------------------------------
# strava
# --------------------------------------------------------------------------

def starred_segments(token: str) -> list[dict]:
    print("Fetching starred segments")
    out: list[dict] = []
    page = 1
    while True:
        batch = http_json(
            f"{STRAVA}/segments/starred?per_page=100&page={page}", token=token
        )
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    print(f"  {len(out)} starred")
    return out


def explore_segments(token: str, lat: float, lon: float, radius_km: float) -> list[dict]:
    print(f"Exploring segments within {radius_km} km of {lat:.4f},{lon:.4f}")
    d_lat = radius_km / 111.0
    d_lon = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.01))
    bounds = f"{lat - d_lat},{lon - d_lon},{lat + d_lat},{lon + d_lon}"
    payload = http_json(
        f"{STRAVA}/segments/explore?bounds={bounds}&activity_type=riding", token=token
    )
    found = payload.get("segments", [])
    print(f"  {len(found)} discovered")
    return found


def segment_detail(token: str, segment_id: int) -> dict | None:
    try:
        return http_json(f"{STRAVA}/segments/{segment_id}", token=token)
    except SystemExit as exc:
        print(f"  skipped segment {segment_id}: {exc}")
        return None


def midpoint(record: dict) -> tuple[float, float]:
    pts = record["points"]
    return tuple(pts[len(pts) // 2])  # type: ignore[return-value]


def cluster_regions(records: list[dict], radius_km: float = 80.0) -> list[list[dict]]:
    """Group segments into riding regions by single-link distance.

    A starred list is naturally multi-region: aspirational stars sit thousands of
    kilometres from the roads someone actually rides. Averaging them produces a
    centre in the middle of nowhere, so cluster first and treat each cluster as
    its own region.
    """
    clusters: list[list[dict]] = []
    for rec in records:
        for cluster in clusters:
            if any(
                haversine_m(midpoint(rec), midpoint(other)) < radius_km * 1000
                for other in cluster
            ):
                cluster.append(rec)
                break
        else:
            clusters.append([rec])

    merged = True
    while merged:
        merged = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if any(
                    haversine_m(midpoint(a), midpoint(b)) < radius_km * 1000
                    for a in clusters[i]
                    for b in clusters[j]
                ):
                    clusters[i] += clusters.pop(j)
                    merged = True
                    break
            if merged:
                break
    return sorted(clusters, key=len, reverse=True)


def region_name(cluster: list[dict]) -> str:
    counts: dict[str, int] = {}
    for rec in cluster:
        city, state = rec.get("city"), rec.get("state")
        if city:
            key = f"{city}, {state}" if state else city
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return "Unnamed region"
    return max(counts.items(), key=lambda kv: kv[1])[0]


def normalize(detail: dict, source: str) -> dict | None:
    """Reduce a Strava segment to the fields the interface needs."""
    line = (detail.get("map") or {}).get("polyline") or (detail.get("map") or {}).get(
        "summary_polyline"
    )
    if not line:
        return None
    points = simplify(decode_polyline(line))
    if len(points) < 2:
        return None

    stats = detail.get("athlete_segment_stats") or {}
    pr_time = stats.get("pr_elapsed_time") or stats.get("elapsed_time")

    return {
        "id": detail["id"],
        "name": detail.get("name", "Unnamed segment"),
        "source": source,
        "distance_m": detail.get("distance"),
        "average_grade": detail.get("average_grade"),
        "maximum_grade": detail.get("maximum_grade"),
        "elevation_high": detail.get("elevation_high"),
        "elevation_low": detail.get("elevation_low"),
        "total_elevation_gain": detail.get("total_elevation_gain"),
        "climb_category": detail.get("climb_category"),
        "city": detail.get("city"),
        "state": detail.get("state"),
        "effort_count": detail.get("effort_count"),
        "athlete_count": detail.get("athlete_count"),
        "star_count": detail.get("star_count"),
        "pr_elapsed_time": pr_time,
        "pr_date": stats.get("pr_date"),
        "effort_count_personal": stats.get("effort_count"),
        "points": [[round(p[0], 5), round(p[1], 5)] for p in points],
    }


# --------------------------------------------------------------------------
# weather
# --------------------------------------------------------------------------

def fetch_cell_forecast(cell: tuple[float, float]) -> dict:
    query = urllib.parse.urlencode(
        {
            "latitude": f"{cell[0]:.4f}",
            "longitude": f"{cell[1]:.4f}",
            "hourly": ",".join(
                [
                    "temperature_2m",
                    "relative_humidity_2m",
                    "surface_pressure",
                    "precipitation",
                    "precipitation_probability",
                    "wind_speed_10m",
                    "wind_direction_10m",
                    "wind_gusts_10m",
                ]
            ),
            "wind_speed_unit": "ms",
            "forecast_days": 7,
            "timezone": "auto",
        }
    )
    payload = http_json(f"{OPEN_METEO}?{query}")
    hourly = payload["hourly"]
    return {
        "cell_id": cell_id(cell),
        "latitude": payload["latitude"],
        "longitude": payload["longitude"],
        "timezone": payload.get("timezone"),
        "utc_offset_seconds": payload.get("utc_offset_seconds", 0),
        "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "time": hourly["time"],
        "temperature_c": hourly["temperature_2m"],
        "humidity_pct": hourly["relative_humidity_2m"],
        "pressure_hpa": hourly["surface_pressure"],
        "precip_mm": hourly["precipitation"],
        "precip_prob": hourly["precipitation_probability"],
        "wind_speed_ms": hourly["wind_speed_10m"],
        "wind_from_deg": hourly["wind_direction_10m"],
        "gust_ms": hourly["wind_gusts_10m"],
    }


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> None:
    env = load_env()
    token = access_token(env)

    athlete = http_json(f"{STRAVA}/athlete", token=token)
    print(f"Athlete: {athlete.get('firstname')} {athlete.get('lastname')}")

    segments: dict[int, dict] = {}

    for summary in starred_segments(token):
        detail = segment_detail(token, summary["id"])
        if detail:
            record = normalize(detail, "starred")
            if record:
                segments[record["id"]] = record

    if not segments:
        sys.exit("No starred segments found. Star a few on Strava and re-run.")

    radius = float(env.get("WINDCHASER_EXPLORE_RADIUS_KM") or 12)
    limit = int(env.get("WINDCHASER_EXPLORE_LIMIT") or 8)

    clusters = cluster_regions(list(segments.values()))
    print(f"\n{len(clusters)} riding regions found")

    regions: list[dict] = []
    for index, cluster in enumerate(clusters):
        mids = [midpoint(r) for r in cluster]
        c_lat = sum(m[0] for m in mids) / len(mids)
        c_lon = sum(m[1] for m in mids) / len(mids)
        name = region_name(cluster)
        region_id = f"r{index}"
        for rec in cluster:
            rec["region_id"] = region_id
        regions.append(
            {"id": region_id, "name": name, "lat": c_lat, "lon": c_lon,
             "starred_count": len(cluster)}
        )
        print(f"  {name}: {len(cluster)} starred at {c_lat:.3f},{c_lon:.3f}")

        # Discover only around regions the rider actually rides. A single
        # aspirational star is not a riding region.
        if len(cluster) < 2:
            continue
        added = 0
        for summary in explore_segments(token, c_lat, c_lon, radius):
            if added >= limit:
                break
            if summary["id"] in segments:
                continue
            detail = segment_detail(token, summary["id"])
            if detail:
                record = normalize(detail, "discovered")
                if record:
                    record["region_id"] = region_id
                    segments[record["id"]] = record
                    added += 1
        regions[-1]["discovered_count"] = added

    centre_lat = regions[0]["lat"]
    centre_lon = regions[0]["lon"]

    # One forecast per grid cell, shared by every segment that lands in it.
    cells: dict[str, tuple[float, float]] = {}
    for seg in segments.values():
        mid = seg["points"][len(seg["points"]) // 2]
        cell = cell_of(mid[0], mid[1])
        seg["cell_id"] = cell_id(cell)
        cells[cell_id(cell)] = cell

    print(f"Fetching forecasts for {len(cells)} grid cells "
          f"({len(segments)} segments, {len(segments) - len(cells)} calls saved)")
    forecasts = {}
    for cid, cell in cells.items():
        forecasts[cid] = fetch_cell_forecast(cell)

    bundle = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "athlete": {
            "firstname": athlete.get("firstname"),
            "city": athlete.get("city"),
            "state": athlete.get("state"),
            "country": athlete.get("country"),
            "weight_kg": athlete.get("weight"),
            "ftp": athlete.get("ftp"),
        },
        "centre": {"lat": centre_lat, "lon": centre_lon},
        "regions": regions,
        "segments": sorted(segments.values(), key=lambda s: s["name"]),
        "forecast_cells": forecasts,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(bundle, indent=1))
    size_kb = OUT_FILE.stat().st_size / 1024
    starred = sum(1 for s in segments.values() if s["source"] == "starred")
    with_pr = sum(1 for s in segments.values() if s["pr_elapsed_time"])
    print(
        f"\nWrote {OUT_FILE.relative_to(REPO)} ({size_kb:.0f} KB)\n"
        f"  {starred} starred, {len(segments) - starred} discovered\n"
        f"  {with_pr} with a personal record time\n"
        f"  {len(cells)} forecast cells"
    )


if __name__ == "__main__":
    main()
