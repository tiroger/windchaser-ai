"""Turn Strava webhook events into calibration, without anyone watching.

Two entry points, because the work splits on a hard external constraint.

Ingestion runs off the queue the moment a ride lands. It records the efforts and
stops there, because the reanalysis weather those efforts need to be useful does
not exist yet -- ERA5 trails real time by about a week. Recording an effort with
no weather is honest; recording it as a calm day would quietly teach the model
that this rider is slow in still air.

Refresh runs on a schedule, attaches weather to whatever has since become
available, and rebuilds the calibration the application reads. That is the step
that closes the loop: ride, wait out the archive, and the predictions improve
without anyone running a script.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timezone

from cycling_analytics.calibration import build_calibration

from . import store, weather
from .strava import RateLimited, Unavailable, activity

EFFORTS_KEY = os.environ.get("EFFORTS_S3_KEY", "efforts.json")
CALIBRATION_KEY = os.environ.get("CALIBRATION_S3_KEY", "calibration.json")


def _record(effort: dict, segment: dict, activity_id: int) -> dict:
    """One effort in the stored shape, matching the offline history exactly."""
    return {
        "segment_id": int(segment["id"]),
        "effort_id": effort.get("id"),
        # Recorded so a later delete event can find what it removes. Segment
        # efforts carry no back-reference to their activity.
        "activity_id": activity_id,
        "start_date": effort.get("start_date"),
        "elapsed_time_s": effort.get("elapsed_time"),
        "moving_time_s": effort.get("moving_time"),
        "distance_m": effort.get("distance"),
        "average_watts": effort.get("average_watts"),
        "device_watts": effort.get("device_watts"),
        "average_heartrate": effort.get("average_heartrate"),
        "cell_id": segment.get("cell_id"),
        # Filled by refresh once the archive covers this hour.
        "weather": None,
    }


def apply_event(body: dict, payload: dict) -> int:
    """Fold one webhook event into the history. Returns efforts added or removed."""
    if body.get("object_type") != "activity":
        return 0

    activity_id = body.get("object_id")
    aspect = body.get("aspect_type")
    if not activity_id:
        return 0

    if aspect == "delete":
        before = len(payload["efforts"])
        payload["efforts"] = [
            e for e in payload["efforts"] if e.get("activity_id") != activity_id
        ]
        removed = before - len(payload["efforts"])
        if removed:
            print(f"[ingest] activity {activity_id} deleted, dropped {removed} efforts")
        return removed

    if aspect not in ("create", "update"):
        return 0

    detail = activity(activity_id)
    efforts = detail.get("segment_efforts") or []
    known = payload["segments"]
    # Efforts already stored, so a redelivered event or an update to an activity
    # already seen changes nothing. Strava retries, and the queue is at-least-once.
    seen = {e.get("effort_id") for e in payload["efforts"]}

    added = 0
    for effort in efforts:
        segment = effort.get("segment") or {}
        sid = str(segment.get("id"))
        # Only segments the history already tracks. An activity can touch dozens
        # of segments nobody asked about, and each new one would cost further
        # Strava calls for its geometry and elevation against a daily read quota
        # that this rider already exhausts. Adding segments stays an explicit
        # act, through scripts/fetch_effort_history.py.
        if sid not in known:
            continue
        if effort.get("id") in seen:
            continue
        if not effort.get("start_date") or not effort.get("elapsed_time"):
            continue
        payload["efforts"].append(_record(effort, known[sid], activity_id))
        added += 1

    print(
        f"[ingest] activity {activity_id}: {len(efforts)} efforts, "
        f"{added} on tracked segments"
    )
    return added


def ingest(event, _context=None):
    """SQS entry point. One event per invocation; see the reserved concurrency."""
    records = event.get("Records") or []
    payload = store.load(EFFORTS_KEY)

    changed = 0
    for record in records:
        try:
            body = json.loads(record["body"])
        except (KeyError, ValueError):
            # Unparseable bodies will never parse. Failing sends them round the
            # queue five more times before the dead letter queue; dropping them
            # with a log says the same thing sooner.
            print(f"[ingest] discarding unparseable message: {record.get('body')!r}")
            continue
        changed += apply_event(body, payload)

    if changed:
        payload["effort_count"] = len(payload["efforts"])
        payload["segment_count"] = len(payload["segments"])
        payload["generated_at"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        store.save(EFFORTS_KEY, payload)

    return {"records": len(records), "efforts_changed": changed}


def attach_weather(payload: dict) -> int:
    """Join efforts to reanalysis, once the archive has caught up with them."""
    cutoff = weather.ready_before()
    pending = defaultdict(list)

    for effort in payload["efforts"]:
        if effort.get("weather") or not effort.get("start_date"):
            continue
        stamp = datetime.fromisoformat(effort["start_date"].replace("Z", "+00:00"))
        if stamp.astimezone(timezone.utc) >= cutoff:
            continue
        cell = effort.get("cell_id")
        if not cell:
            continue
        pending[(cell, stamp.year, stamp.month)].append(effort)

    if not pending:
        return 0

    attached = 0
    for (cell, year, month), efforts in sorted(pending.items()):
        try:
            lat, lon = (float(part) for part in cell.split(","))
        except ValueError:
            print(f"[refresh] unusable cell id {cell!r}, skipping {len(efforts)}")
            continue
        hours = weather.fetch_cell_month(lat, lon, year, month)
        if not hours:
            continue
        for effort in efforts:
            hour = weather.hour_key(effort["start_date"])
            found = hours.get(hour)
            if found:
                effort["weather"] = found
                attached += 1

    print(f"[refresh] attached weather to {attached} efforts")
    return attached


def refresh(_event=None, _context=None):
    """Scheduled entry point: backfill weather, then rebuild the calibration."""
    payload = store.load(EFFORTS_KEY)
    attached = attach_weather(payload)

    if attached:
        payload["generated_at"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        store.save(EFFORTS_KEY, payload)

    # Rebuilt every run, not only when weather arrived. It is seconds of work
    # over a few hundred efforts, and it means a change to the model itself
    # reaches the application on the next schedule rather than needing someone
    # to remember.
    bundle = build_calibration(payload)
    store.save_calibration(CALIBRATION_KEY, bundle)

    rider = bundle.get("rider") or {}
    fitted = sum(1 for v in bundle["segments"].values() if v.get("power_w"))
    print(
        f"[refresh] calibration rebuilt: {len(bundle['segments'])} segments, "
        f"{fitted} with fitted power, "
        f"rider CP {rider.get('cp_w', 0):.0f} W over "
        f"{rider.get('attempt_count', 0)} attempts"
    )
    return {
        "weather_attached": attached,
        "segments": len(bundle["segments"]),
        "with_fitted_power": fitted,
        "efforts": len(payload["efforts"]),
    }


def main(event, context=None):
    """The Lambda entry point for both triggers.

    One function rather than two, because both paths read the effort history,
    change it, and write it back. Two functions could interleave those steps and
    lose whichever write finished first. A single function pinned to a reserved
    concurrency of one cannot: every invocation, from either trigger, is
    serialised against every other. That limit is correctness, not throughput
    tuning, and the same is true of holding the history as one object.
    """
    records = (event or {}).get("Records") or []
    if any(r.get("eventSource") == "aws:sqs" for r in records):
        return ingest(event, context)
    return refresh(event, context)


# Re-exported so a failure mode is visible where the handlers are read.
__all__ = ["main", "ingest", "refresh", "RateLimited", "Unavailable"]
