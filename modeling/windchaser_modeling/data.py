"""Read-only access to the app data bucket, cached locally, as typed frames.

Everything the notebooks use comes from the same objects the web app and the
Lambda workers read. Nothing is ever written back: the loaders only list and
download.

The bucket name is not in this file. It carries the AWS account id and this
repository is public, so it comes from the environment, under the same name the
web app uses:

    export APP_DATA_BUCKET=<the data bucket>
    export AWS_PROFILE=<a profile that can read it>   AWS_REGION=us-east-1

Downloads land in modeling/.cache/s3/ (gitignored) and are reused on later runs.
`sync(refresh=True)` re-lists the bucket and fetches whatever changed.

Units. The stored objects mix units because they were shaped for display:

    activities.json   distance miles, moving/elapsed time HOURS (one decimal,
                      so +-3 minutes), elevation feet, speed mph
    streams/{id}.json distance miles (two decimals, ~16 m), altitude feet,
                      velocity mph, time seconds since the activity started
    saved-routes/     distance miles, altitude feet
    efforts.json      SI throughout

Every loader converts to SI (metres, seconds, m/s) and says so in the column
name. Times: efforts carry true UTC instants. Activities carry
`start_date_local`, the wall-clock time where the ride happened, with a
misleading trailing "Z"; it is parsed here as a naive local timestamp, never as
UTC. features.py derives the offset between the two.
"""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import MODELING_DIR

CACHE_DIR = Path(os.environ.get("WINDCHASER_MODELING_CACHE", MODELING_DIR / ".cache"))
S3_DIR = CACHE_DIR / "s3"
MANIFEST = S3_DIR / "_manifest.json"

TOP_LEVEL_KEYS = (
    "efforts.json",
    "calibration.json",
    "activities.json",
    "streams-index.json",
    "saved-routes.json",
    "settings.json",
)
PREFIXES = ("streams/", "saved-routes/")

MILE_M = 1609.344
FOOT_M = 0.3048
MPH_MS = 0.44704

WEATHER_FIELDS = (
    "wind_speed_ms",
    "wind_from_deg",
    "gust_ms",
    "temperature_c",
    "humidity_pct",
    "pressure_hpa",
    "precip_mm",
)


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------


@dataclass
class Snapshot:
    """What the local cache holds, and when each object was last changed upstream."""

    root: Path
    objects: dict[str, dict[str, Any]] = field(default_factory=dict)
    synced_at: str | None = None

    def last_modified(self, key: str) -> str | None:
        meta = self.objects.get(key) or {}
        return meta.get("last_modified")

    def table(self) -> pd.DataFrame:
        """One row per top-level object plus one per prefix, for the notebooks."""
        rows = []
        for key in TOP_LEVEL_KEYS:
            meta = self.objects.get(key, {})
            rows.append(
                {
                    "object": key,
                    "last_modified_utc": meta.get("last_modified"),
                    "bytes": meta.get("size"),
                }
            )
        for prefix in PREFIXES:
            members = [m for k, m in self.objects.items() if k.startswith(prefix)]
            stamps = [m.get("last_modified") for m in members if m.get("last_modified")]
            rows.append(
                {
                    "object": f"{prefix}* ({len(members)} objects)",
                    "last_modified_utc": max(stamps) if stamps else None,
                    "bytes": sum(m.get("size") or 0 for m in members),
                }
            )
        return pd.DataFrame(rows)


def _bucket() -> str | None:
    return os.environ.get("APP_DATA_BUCKET") or os.environ.get("WINDCHASER_DATA_BUCKET")


def _client():
    import boto3

    session = boto3.Session(
        profile_name=os.environ.get("AWS_PROFILE") or None,
        region_name=os.environ.get("AWS_REGION") or "us-east-1",
    )
    return session.client("s3")


def _list(client, bucket: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key in TOP_LEVEL_KEYS or key.startswith(PREFIXES):
                out[key] = {
                    "etag": obj["ETag"].strip('"'),
                    "size": obj["Size"],
                    "last_modified": obj["LastModified"]
                    .astimezone(timezone.utc)
                    .strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
    return out


def _local_snapshot() -> Snapshot:
    """Describe the cache from disk alone, for offline runs."""
    objects: dict[str, dict[str, Any]] = {}
    if MANIFEST.exists():
        saved = json.loads(MANIFEST.read_text())
        return Snapshot(S3_DIR, saved.get("objects", {}), saved.get("synced_at"))
    for path in S3_DIR.rglob("*.json"):
        key = path.relative_to(S3_DIR).as_posix()
        if key.startswith("_"):
            continue
        stat = path.stat()
        objects[key] = {
            "size": stat.st_size,
            "last_modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
        }
    return Snapshot(S3_DIR, objects, None)


def sync(refresh: bool = False, include_streams: bool = True) -> Snapshot:
    """Make sure the cache holds the data, downloading only what is missing.

    With `refresh=False` and a populated cache this makes no network call at
    all, so notebooks re-run offline and reproducibly against the same
    snapshot. `refresh=True` re-lists the bucket and fetches every object whose
    ETag changed.
    """
    have_cache = (S3_DIR / "efforts.json").exists()
    if have_cache and not refresh:
        return _local_snapshot()

    bucket = _bucket()
    if not bucket:
        if have_cache:
            return _local_snapshot()
        raise RuntimeError(
            "No cached data and no bucket configured. Set APP_DATA_BUCKET (and "
            "AWS_PROFILE / AWS_REGION) to the app data bucket, then re-run."
        )

    client = _client()
    listing = _list(client, bucket)
    previous = _local_snapshot().objects
    wanted = [
        key
        for key in listing
        if include_streams or not key.startswith("streams/")
    ]

    def stale(key: str) -> bool:
        path = S3_DIR / key
        if not path.exists():
            return True
        if not refresh:
            return False
        # Unknown provenance (no manifest entry) counts as changed.
        return previous.get(key, {}).get("etag") != listing[key]["etag"]

    todo = [k for k in wanted if stale(k)]

    def fetch(key: str) -> None:
        path = S3_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        client.download_file(bucket, key, str(tmp))
        tmp.replace(path)

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(fetch, todo))

    snapshot = Snapshot(
        S3_DIR, listing, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(
        json.dumps({"synced_at": snapshot.synced_at, "objects": listing}, indent=0)
    )
    return snapshot


def _read(key: str) -> Any:
    path = S3_DIR / key
    if not path.exists():
        raise FileNotFoundError(f"{key} is not cached; call data.sync() first.")
    return json.loads(path.read_text())


# --------------------------------------------------------------------------
# parsing helpers
# --------------------------------------------------------------------------


def parse_utc(value: str | None) -> pd.Timestamp:
    """An ISO instant with a real offset (or Z meaning UTC), as UTC."""
    if not value:
        return pd.NaT
    return pd.Timestamp(str(value).replace("Z", "+00:00")).tz_convert("UTC")


def parse_local(value: str | None) -> pd.Timestamp:
    """Strava's start_date_local: wall-clock time with a fake 'Z'. Naive result."""
    if not value:
        return pd.NaT
    return pd.Timestamp(str(value).rstrip("Z"))


def _num(value: Any) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return out if np.isfinite(out) else float("nan")


# --------------------------------------------------------------------------
# efforts and segments
# --------------------------------------------------------------------------


@dataclass
class EffortData:
    """efforts.json, both raw (for build_calibration) and as a frame."""

    payload: dict[str, Any]
    efforts: pd.DataFrame
    segments: dict[str, dict[str, Any]]


def efforts_frame(payload: dict[str, Any]) -> pd.DataFrame:
    rows = []
    for e in payload.get("efforts") or []:
        w = e.get("weather") or {}
        row = {
            "segment_id": str(e["segment_id"]),
            "effort_id": str(e["effort_id"]),
            "activity_id": str(e.get("activity_id")),
            "start_utc": parse_utc(e.get("start_date")),
            "elapsed_s": _num(e.get("elapsed_time_s")),
            "moving_s": _num(e.get("moving_time_s") or e.get("elapsed_time_s")),
            "distance_m": _num(e.get("distance_m")),
            "average_watts": _num(e.get("average_watts")),
            "device_watts": bool(e.get("device_watts")),
            "average_hr": _num(e.get("average_heartrate")),
            "has_weather": bool(e.get("weather")),
        }
        for k in WEATHER_FIELDS:
            row[k] = _num(w.get(k))
        rows.append(row)
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    return frame.sort_values("start_utc").reset_index(drop=True)


def load_efforts() -> EffortData:
    payload = _read("efforts.json")
    return EffortData(payload, efforts_frame(payload), payload.get("segments") or {})


def load_calibration() -> dict[str, Any]:
    return _read("calibration.json")


def load_settings() -> dict[str, Any]:
    return _read("settings.json")


# --------------------------------------------------------------------------
# activities
# --------------------------------------------------------------------------


def activities_frame(raw: list[dict[str, Any]], index: dict[str, Any]) -> pd.DataFrame:
    """activities.json in SI units, joined to the per-stream summaries."""
    rows = []
    for a in raw:
        aid = str(a["id"])
        idx = index.get(aid) or {}
        hours = _num(a.get("moving_time"))
        precise = _num(idx.get("moving_seconds"))
        rows.append(
            {
                "activity_id": aid,
                "name": a.get("name"),
                "sport_type": a.get("sport_type") or a.get("type"),
                "start_local": parse_local(a.get("start_date_local")),
                "distance_m": _num(a.get("distance")) * MILE_M,
                # Hours to one decimal place is +-3 minutes; the stream summary
                # measured riding seconds at 1 Hz, so it wins where present.
                "moving_s": precise if np.isfinite(precise) else hours * 3600.0,
                "moving_s_precise": bool(np.isfinite(precise)),
                "elapsed_s": _num(a.get("elapsed_time")) * 3600.0,
                "elevation_gain_m": _num(a.get("total_elevation_gain")) * FOOT_M,
                "average_speed_ms": _num(a.get("average_speed")) * MPH_MS,
                "average_hr": _num(a.get("average_heartrate")),
                "max_hr": _num(a.get("max_heartrate")),
                "average_watts": _num(a.get("average_watts")),
                "weighted_average_watts": _num(a.get("weighted_average_watts")),
                "device_watts": bool(a.get("device_watts")),
                "kilojoules": _num(a.get("kilojoules")),
                "trainer": bool(a.get("trainer")),
                "has_stream": bool(idx.get("has_streams")),
                "normalized_power": _num(idx.get("normalized_power")),
                "exercise_load": _num(idx.get("exercise_load")),
                "power_bests": idx.get("power_bests") or {},
            }
        )
    frame = pd.DataFrame(rows)
    return frame.sort_values("start_local").reset_index(drop=True)


def load_streams_index() -> dict[str, Any]:
    return _read("streams-index.json")


def load_activities() -> pd.DataFrame:
    return activities_frame(_read("activities.json"), load_streams_index())


# --------------------------------------------------------------------------
# streams
# --------------------------------------------------------------------------


def stream_frame(raw: dict[str, Any]) -> pd.DataFrame:
    """One activity's stored samples in SI units.

    These are at most 1,200 samples picked evenly by index from the 1 Hz
    recording (services/training_sync/streams.py), not averaged. A sample is
    the instantaneous value at that moment, so a mean over a few samples is an
    unbiased but noisy estimate of the mean power in between.
    """
    s = raw.get("samples") or {}
    n = len(s.get("time") or [])

    def col(name: str, scale: float = 1.0) -> np.ndarray:
        values = s.get(name)
        if not values or len(values) != n:
            return np.full(n, np.nan)
        return np.array([np.nan if v is None else float(v) * scale for v in values])

    latlng = s.get("latlng") or []
    lat = np.full(n, np.nan)
    lng = np.full(n, np.nan)
    if len(latlng) == n:
        for i, p in enumerate(latlng):
            if p:
                lat[i], lng[i] = p[0], p[1]
    return pd.DataFrame(
        {
            "t_s": col("time"),
            "distance_m": col("distance", MILE_M),
            "altitude_m": col("altitude", FOOT_M),
            "watts": col("watts"),
            "hr": col("heartrate"),
            "speed_ms": col("velocity", MPH_MS),
            "lat": lat,
            "lng": lng,
        }
    )


@lru_cache(maxsize=4096)
def load_stream(activity_id: str) -> pd.DataFrame | None:
    path = S3_DIR / "streams" / f"{activity_id}.json"
    if not path.exists():
        return None
    return stream_frame(json.loads(path.read_text()))


def stream_ids() -> list[str]:
    folder = S3_DIR / "streams"
    return sorted(p.stem for p in folder.glob("*.json")) if folder.exists() else []


# --------------------------------------------------------------------------
# saved routes
# --------------------------------------------------------------------------


def load_routes() -> pd.DataFrame:
    rows = []
    for r in _read("saved-routes.json"):
        rows.append(
            {
                "route_id": str(r["id"]),
                "name": r.get("name"),
                "distance_m": _num(r.get("distance")) * MILE_M,
                "elevation_gain_m": _num(r.get("elevation_gain")) * FOOT_M,
                "strava_estimate_s": _num(r.get("estimated_moving_time")),
                "has_profile": (S3_DIR / "saved-routes" / f"{r['id']}.json").exists(),
            }
        )
    return pd.DataFrame(rows)


def route_profile_frame(raw: dict[str, Any]) -> pd.DataFrame:
    latlng = raw.get("latlng") or []
    return pd.DataFrame(
        {
            "distance_m": np.asarray(raw.get("distance") or [], dtype=float) * MILE_M,
            "altitude_m": np.asarray(raw.get("altitude") or [], dtype=float) * FOOT_M,
            "lat": [p[0] if p else np.nan for p in latlng],
            "lng": [p[1] if p else np.nan for p in latlng],
        }
    )


def load_route_profile(route_id: str) -> pd.DataFrame | None:
    path = S3_DIR / "saved-routes" / f"{route_id}.json"
    if not path.exists():
        return None
    return route_profile_frame(json.loads(path.read_text()))
