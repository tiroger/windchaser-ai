"""Segments, calibration and forecast, assembled for the tools to query.

Reads the same artefacts the web application does. Geometry and calibration come
from the saved bundle and the calibration the worker rebuilds daily, either from
the working copy or from S3 through the AWS CLI. Forecast comes from Open-Meteo
directly.

Deliberately not from Strava. Their read allowance is a thousand a day and the
application needs it; a question asked here should never be the reason a segment
list falls back to saved data. Everything below is either already on disk or
from a source with no such limit.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent

# Overridable so the server can be pointed at a different set of artefacts: a
# synthetic one for the tests, which cannot use the real files because those
# hold personal training data and are not in the repository, or a public sample
# for anyone who wants to try this without an athlete's history.
FIXTURES = Path(os.environ.get("WINDCHASER_FIXTURES") or (REPO / "apps" / "web" / "fixtures"))
CALIBRATION = FIXTURES / "calibration.json"
BUNDLE = FIXTURES / "opportunities.json"

BUCKET = os.environ.get("WINDCHASER_BUCKET", "")
FORECAST = "https://api.open-meteo.com/v1/forecast"
CELL_DEG = 0.1
# Long enough that a conversation does not refetch on every question, short
# enough that a forecast never goes properly stale mid-answer.
FORECAST_TTL_S = 20 * 60


def _refresh_from_s3(key: str, target: Path) -> None:
    """Best effort. A stale local copy answers better than an error."""
    if not BUCKET:
        return
    try:
        subprocess.run(
            ["aws", "s3", "cp", f"s3://{BUCKET}/{key}", str(target)],
            check=True,
            capture_output=True,
            timeout=60,
        )
    except (subprocess.SubprocessError, FileNotFoundError) as exc:
        print(f"[data] could not refresh {key}: {exc}", file=sys.stderr)


_cache: dict[str, object] = {}


def load(refresh: bool = False) -> tuple[dict, dict]:
    """The calibration table and the segment bundle, keyed by segment id."""
    if refresh or "calibration" not in _cache:
        _refresh_from_s3("calibration.json", CALIBRATION)
        _refresh_from_s3("opportunities.json", BUNDLE)
        _cache.pop("calibration", None)

    if "calibration" not in _cache:
        if not CALIBRATION.exists() or not BUNDLE.exists():
            raise RuntimeError(
                f"No artefacts at {FIXTURES}. Set WINDCHASER_BUCKET to fetch them, "
                "or run scripts/build_calibration.py."
            )
        _cache["calibration"] = json.loads(CALIBRATION.read_text())
        _cache["bundle"] = json.loads(BUNDLE.read_text())
    return _cache["calibration"], _cache["bundle"]  # type: ignore[return-value]


def segments() -> dict[str, dict]:
    """Every known segment, geometry and calibration merged into one record."""
    calibration, bundle = load()
    table = calibration.get("segments") or {}
    rider = calibration.get("rider")

    out: dict[str, dict] = {}
    for seg in bundle.get("segments") or []:
        sid = str(seg["id"])
        entry = table.get(sid) or {}
        merged = dict(seg)
        merged["calibrated_power_w"] = entry.get("power_w")
        merged["attempt_count"] = entry.get("attempt_count")
        merged["best_moving_time_s"] = entry.get("best_moving_time_s")
        merged["elevation_profile"] = entry.get("elevation_profile")
        merged["rider_model"] = rider
        out[sid] = merged
    return out


def find(query: str) -> list[dict]:
    """Segments matching a name fragment or an exact id, best match first."""
    known = segments()
    if query.strip() in known:
        return [known[query.strip()]]

    needle = query.strip().lower()
    scored = []
    for seg in known.values():
        name = (seg.get("name") or "").lower()
        if needle == name:
            scored.append((0, seg))
        elif name.startswith(needle):
            scored.append((1, seg))
        elif needle in name:
            scored.append((2, seg))
    scored.sort(key=lambda pair: (pair[0], pair[1].get("name") or ""))
    return [seg for _, seg in scored]


def cell_id(lat: float, lon: float) -> str:
    return f"{round(lat / CELL_DEG) * CELL_DEG:.2f},{round(lon / CELL_DEG) * CELL_DEG:.2f}"


def midpoint(seg: dict) -> tuple[float, float]:
    points = seg.get("points") or []
    if not points:
        raise ValueError(f"{seg.get('name')} has no geometry")
    middle = points[len(points) // 2]
    return float(middle[0]), float(middle[1])


_forecast_cache: dict[str, tuple[float, dict]] = {}


def forecast_for(seg: dict) -> dict:
    """Hourly forecast for the cell a segment sits in, cached briefly."""
    lat, lon = midpoint(seg)
    key = cell_id(lat, lon)
    hit = _forecast_cache.get(key)
    if hit and time.time() - hit[0] < FORECAST_TTL_S:
        return hit[1]

    cell_lat, cell_lon = (float(part) for part in key.split(","))
    query = urllib.parse.urlencode(
        {
            "latitude": f"{cell_lat:.4f}",
            "longitude": f"{cell_lon:.4f}",
            "hourly": ",".join(
                [
                    "temperature_2m",
                    "relative_humidity_2m",
                    "surface_pressure",
                    "precipitation_probability",
                    "wind_speed_10m",
                    "wind_direction_10m",
                    "wind_gusts_10m",
                ]
            ),
            "wind_speed_unit": "ms",
            "timezone": "auto",
            "forecast_days": 7,
        }
    )
    request = urllib.request.Request(
        f"{FORECAST}?{query}",
        headers={"Accept": "application/json", "User-Agent": "windchaser-mcp/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode())

    hourly = payload.get("hourly") or {}
    cell = {
        "timezone": payload.get("timezone", "UTC"),
        "time": hourly.get("time") or [],
        "wind_speed_ms": hourly.get("wind_speed_10m") or [],
        "wind_from_deg": hourly.get("wind_direction_10m") or [],
        "gust_ms": hourly.get("wind_gusts_10m") or [],
        "temperature_c": hourly.get("temperature_2m") or [],
        "humidity_pct": hourly.get("relative_humidity_2m") or [],
        "pressure_hpa": hourly.get("surface_pressure") or [],
        "precip_prob": hourly.get("precipitation_probability") or [],
    }
    _forecast_cache[key] = (time.time(), cell)
    return cell


def weather_at(cell: dict, index: int) -> dict:
    """One hour of a forecast, in the shape the physics expects."""
    def at(key: str, fallback: float) -> float:
        series = cell.get(key) or []
        value = series[index] if index < len(series) else None
        return float(fallback if value is None else value)

    return {
        "wind_speed_ms": at("wind_speed_ms", 0.0),
        "wind_from_deg": at("wind_from_deg", 0.0),
        "gust_ms": at("gust_ms", 0.0),
        "temperature_c": at("temperature_c", 15.0),
        "humidity_pct": at("humidity_pct", 60.0),
        "pressure_hpa": at("pressure_hpa", 1013.0),
        "precip_prob": at("precip_prob", 0.0),
    }


def compass(degrees: float) -> str:
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
             "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int((degrees % 360) / 22.5 + 0.5) % 16]


def duration(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def delta(seconds: float) -> str:
    sign = "-" if seconds < 0 else "+"
    total = int(round(abs(seconds)))
    return f"{sign}{total // 60}:{total % 60:02d}" if total >= 60 else f"{sign}{total}s"


def normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))
