"""Reanalysis weather for recorded efforts.

The same ERA5 archive scripts/fetch_effort_history.py uses, and deliberately so:
the calibration is fitted across every effort at once, so mixing a second
weather source for recent rides would put a systematic step in the middle of the
training data that no metric would attribute to its cause.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

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

# ERA5 trails real time. An effort newer than this has no reanalysis yet, which
# is why ingestion records efforts without weather and a later pass fills it in
# rather than the two happening together.
ARCHIVE_LAG_DAYS = 6


def ready_before() -> datetime:
    """Efforts before this instant can be joined to reanalysis."""
    return datetime.now(timezone.utc) - timedelta(days=ARCHIVE_LAG_DAYS)


def month_bounds(year: int, month: int) -> tuple[str, str]:
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = (start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    cutoff = ready_before()
    if end > cutoff:
        end = cutoff
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def fetch_cell_month(lat: float, lon: float, year: int, month: int) -> dict[str, dict]:
    """Hourly reanalysis for one cell-month, keyed by ISO hour.

    Fetched per cell-month rather than per effort. A month of rides on the same
    roads is one request instead of dozens.
    """
    start, end = month_bounds(year, month)
    if start > end:
        return {}

    query = (
        f"latitude={lat:.4f}&longitude={lon:.4f}"
        f"&start_date={start}&end_date={end}"
        f"&hourly={HOURLY}&wind_speed_unit=ms&timezone=UTC"
    )
    request = urllib.request.Request(
        f"{ARCHIVE}?{query}",
        headers={"Accept": "application/json", "User-Agent": "windchaser-worker/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"[weather] archive unavailable for {lat},{lon} {year}-{month}: {exc}")
        return {}

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


def hour_key(start_date: str) -> str:
    """The archive's hourly key for an effort's start, in UTC."""
    stamp = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00")
