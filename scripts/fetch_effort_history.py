#!/usr/bin/env python3
"""Build a labelled training set of segment efforts joined to historical weather.

Why this exists
---------------
Calibrating a rider's power from a single PR assumes that PR was set in still
air. It almost never was: personal records are usually set with a favourable
wind. The fitted power therefore absorbs that day's tailwind, and the model then
adds tailwind again on top, so predictions are optimistic and every probability
inflates toward 100 percent.

The fix is not a better model class. It is efforts that span many different wind
conditions, which decorrelates power from wind. This script assembles that data:

  1. every recorded effort on each starred segment, with its timestamp;
  2. the actual weather at that hour, from the ERA5 reanalysis archive;
  3. optionally the segment's real elevation profile, so gradient stops being a
     single average.

Weather is fetched once per grid cell per calendar month rather than once per
effort, which keeps the request count in the dozens instead of the hundreds.

Output feeds the prediction evolution staged in section 9 of the project plan:
a physics baseline calibrated on efforts, then a learned model of the residual.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fetch_strava_fixtures import (  # noqa: E402
    REPO,
    STRAVA,
    access_token,
    cell_id,
    cell_of,
    http_json,
    load_env,
)

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
BUNDLE = REPO / "apps" / "web" / "fixtures" / "opportunities.json"
OUT_FILE = REPO / "data" / "training" / "efforts.json"

HOURLY = ",".join(
    [
        "temperature_2m",
        "relative_humidity_2m",
        "surface_pressure",
        "precipitation",
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
    ]
)

# ERA5 lags real time. Efforts newer than this cannot be joined to weather yet.
ARCHIVE_LAG_DAYS = 6


# --------------------------------------------------------------------------
# strava
# --------------------------------------------------------------------------

def fetch_efforts(token: str, segment_id: int, per_page: int = 200) -> list[dict]:
    """All of the authenticated athlete's efforts on one segment."""
    out: list[dict] = []
    page = 1
    while page <= 10:
        try:
            batch = http_json(
                f"{STRAVA}/segments/{segment_id}/all_efforts"
                f"?per_page={per_page}&page={page}",
                token=token,
            )
        except SystemExit as exc:
            print(f"    efforts unavailable: {exc}")
            return out
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return out


def fetch_altitude(token: str, segment_id: int) -> dict | None:
    """Distance and altitude streams, for a real gradient profile."""
    try:
        payload = http_json(
            f"{STRAVA}/segments/{segment_id}/streams"
            "?keys=distance,altitude&key_by_type=true",
            token=token,
        )
    except SystemExit as exc:
        print(f"    streams unavailable: {exc}")
        return None
    distance = (payload.get("distance") or {}).get("data")
    altitude = (payload.get("altitude") or {}).get("data")
    if not distance or not altitude or len(distance) != len(altitude):
        return None
    return {"distance_m": distance, "altitude_m": altitude}


# --------------------------------------------------------------------------
# weather archive
# --------------------------------------------------------------------------

def month_bounds(year: int, month: int) -> tuple[str, str]:
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = (start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    cutoff = datetime.now(timezone.utc) - timedelta(days=ARCHIVE_LAG_DAYS)
    if end > cutoff:
        end = cutoff
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def fetch_archive_month(
    lat: float, lon: float, year: int, month: int
) -> dict[str, dict]:
    """Hourly reanalysis for one cell-month, keyed by ISO hour."""
    start, end = month_bounds(year, month)
    if start > end:
        return {}
    query = (
        f"latitude={lat:.4f}&longitude={lon:.4f}"
        f"&start_date={start}&end_date={end}"
        f"&hourly={HOURLY}&wind_speed_unit=ms&timezone=UTC"
    )
    payload = http_json(f"{ARCHIVE}?{query}")
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []

    out: dict[str, dict] = {}
    for i, stamp in enumerate(times):
        def at(key: str):
            series = hourly.get(key) or []
            return series[i] if i < len(series) else None

        wind = at("wind_speed_10m")
        direction = at("wind_direction_10m")
        if wind is None or direction is None:
            continue
        out[stamp] = {
            "wind_speed_ms": wind,
            "wind_from_deg": direction,
            "gust_ms": at("wind_gusts_10m"),
            "temperature_c": at("temperature_2m"),
            "humidity_pct": at("relative_humidity_2m"),
            "pressure_hpa": at("surface_pressure"),
            "precip_mm": at("precipitation"),
        }
    return out


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-streams",
        action="store_true",
        help="Skip elevation streams to halve the Strava request count.",
    )
    args = parser.parse_args()

    if not BUNDLE.exists():
        sys.exit(
            f"No segment bundle at {BUNDLE}.\n"
            "Run scripts/fetch_strava_fixtures.py first."
        )
    bundle = json.loads(BUNDLE.read_text())
    # Any segment this athlete has ridden. Restricting to starred ones missed
    # segments discovery had surfaced that they ride constantly -- one with 59
    # recorded efforts, more history than the best-calibrated starred segment.
    segments = {
        s["id"]: s
        for s in bundle["segments"]
        if (s.get("effort_count_personal") or 0) > 0
    }
    print(f"{len(segments)} segments with recorded efforts")

    env = load_env()
    token = access_token(env)

    # ---- efforts -----------------------------------------------------------
    records: list[dict] = []
    profiles: dict[int, dict] = {}

    for index, (segment_id, segment) in enumerate(segments.items(), start=1):
        expected = segment.get("effort_count_personal") or 0
        print(f"[{index}/{len(segments)}] {segment['name']} (~{expected} efforts)")
        efforts = fetch_efforts(token, segment_id)
        usable = [
            e
            for e in efforts
            if e.get("elapsed_time") and e.get("start_date")
        ]
        print(f"    {len(usable)} efforts returned")

        for effort in usable:
            records.append(
                {
                    "segment_id": segment_id,
                    "effort_id": effort.get("id"),
                    "start_date": effort["start_date"],
                    "elapsed_time_s": effort["elapsed_time"],
                    "moving_time_s": effort.get("moving_time"),
                    "distance_m": effort.get("distance"),
                    "average_watts": effort.get("average_watts"),
                    "device_watts": effort.get("device_watts"),
                    "average_heartrate": effort.get("average_heartrate"),
                    "cell_id": segment["cell_id"],
                }
            )

        if not args.skip_streams:
            profile = fetch_altitude(token, segment_id)
            if profile:
                profiles[segment_id] = profile
                print(f"    elevation profile: {len(profile['distance_m'])} points")
        time.sleep(0.4)

    if not records:
        sys.exit(
            "No efforts returned. The all_efforts endpoint needs activity:read "
            "scope, and Strava restricts it for some accounts."
        )

    # Everything fetched is kept. A threshold used to drop segments with only a
    # couple of efforts, which also dropped the elevation profile fetched for
    # them a moment earlier -- a Strava call spent and then thrown away, and the
    # most valuable part of the result: real gradient is worth more to the model
    # than a sparse segment's efforts are. The thresholds that matter live in
    # cycling_analytics.calibration, which decides per segment what it has
    # enough evidence to fit.
    per_segment: dict[int, int] = defaultdict(int)
    for r in records:
        per_segment[r["segment_id"]] += 1
    kept = set(segments)
    print(f"\n{len(records)} efforts across {len(per_segment)} segments")

    # ---- weather -----------------------------------------------------------
    cells = {
        s["cell_id"]: cell_of(
            s["points"][len(s["points"]) // 2][0],
            s["points"][len(s["points"]) // 2][1],
        )
        for sid, s in segments.items()
    }

    needed: dict[tuple[str, int, int], None] = {}
    for r in records:
        stamp = datetime.fromisoformat(r["start_date"].replace("Z", "+00:00"))
        needed[(r["cell_id"], stamp.year, stamp.month)] = None

    print(f"Fetching {len(needed)} cell-months of reanalysis")
    archive: dict[str, dict[str, dict]] = defaultdict(dict)
    for i, (cid, year, month) in enumerate(sorted(needed), start=1):
        cell = cells.get(cid)
        if not cell:
            continue
        hours = fetch_archive_month(cell[0], cell[1], year, month)
        archive[cid].update(hours)
        if i % 10 == 0:
            print(f"  {i}/{len(needed)}")
        time.sleep(0.15)

    # ---- join --------------------------------------------------------------
    joined = 0
    for r in records:
        stamp = datetime.fromisoformat(r["start_date"].replace("Z", "+00:00"))
        key = stamp.strftime("%Y-%m-%dT%H:00")
        weather = archive.get(r["cell_id"], {}).get(key)
        if weather:
            r["weather"] = weather
            joined += 1
        else:
            r["weather"] = None

    labelled = [r for r in records if r["weather"]]
    print(f"\n{joined}/{len(records)} efforts joined to reanalysis weather")

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "strava all_efforts + open-meteo ERA5 archive",
        "effort_count": len(labelled),
        "segment_count": len({r["segment_id"] for r in labelled}),
        "segments": {
            str(sid): {
                "id": sid,
                "name": segments[sid]["name"],
                "distance_m": segments[sid]["distance_m"],
                "average_grade": segments[sid]["average_grade"],
                "pr_elapsed_time": segments[sid]["pr_elapsed_time"],
                "points": segments[sid]["points"],
                "cell_id": segments[sid]["cell_id"],
                "elevation_profile": profiles.get(sid),
            }
            for sid in sorted(segments)
        },
        "efforts": labelled,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(payload, indent=1))
    size_kb = OUT_FILE.stat().st_size / 1024

    spans = defaultdict(list)
    for r in labelled:
        spans[r["segment_id"]].append(r["weather"]["wind_speed_ms"])

    print(
        f"\nWrote {OUT_FILE.relative_to(REPO)} ({size_kb:.0f} KB)\n"
        f"  {len(labelled)} labelled efforts, "
        f"{len(payload['segments'])} segments, "
        f"{len(profiles)} elevation profiles"
    )
    rich = [
        (segments[sid]["name"], len(v), min(v), max(v))
        for sid, v in sorted(spans.items(), key=lambda kv: -len(kv[1]))
    ]
    print("\n  segment                              n   wind range (m/s)")
    for name, n, lo, hi in rich[:12]:
        print(f"  {name[:36]:<36} {n:>3}   {lo:4.1f} - {hi:4.1f}")


if __name__ == "__main__":
    main()
