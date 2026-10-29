"""How often the rider rides every segment, tracked or not.

The effort history holds full efforts for tracked segments only, because each
new segment costs further Strava reads. Knowing which untracked segments the
rider keeps coming back to costs nothing extra: every ingested activity already
carries a summary of each segment it crossed. Counting those is what lets the
refresh learn about the segments the rider actually rides, not only the ones a
saved bundle happened to show, and it is what the web application reads to
offer them.

Held as one object, beside the effort history and for the same reason: the
worker's reserved concurrency of one makes its read-modify-write safe.
"""

from __future__ import annotations

import json

from . import store


def empty() -> dict:
    return {"generated_at": None, "segments": {}, "activities": {}}


def load(key: str) -> dict | None:
    """The usage object, or None when it cannot be read this invocation.

    Never raises. Usage is a convenience on top of the effort history, so a
    failure to read it is logged and the caller carries on without it rather
    than losing the efforts it came to record.
    """
    try:
        raw = store.load(key)
    except Exception as exc:  # noqa: BLE001 - deliberately tolerant
        print(f"[usage] could not load {key}, skipping usage this run: {exc}")
        return None
    # store.load answers a missing object with the effort history's empty
    # shape, which has no activities. Anything without them starts afresh.
    if not isinstance(raw, dict) or not isinstance(raw.get("activities"), dict):
        return empty()
    if not isinstance(raw.get("segments"), dict):
        raw["segments"] = {}
    return raw


def fingerprint(usage: dict | None) -> str | None:
    """A cheap equality check, so an unchanged object is not rewritten."""
    return None if usage is None else json.dumps(usage, sort_keys=True)


def _start(segment: dict) -> list[float] | None:
    latlng = segment.get("start_latlng")
    if isinstance(latlng, (list, tuple)) and len(latlng) >= 2:
        return [latlng[0], latlng[1]]
    return None


def record(usage: dict, activity_id: int, efforts: list[dict]) -> int:
    """Count every effort in one activity. Returns efforts counted.

    An activity already counted is skipped, so a redelivered event or an update
    to a ride already seen changes nothing. An activity with no efforts is not
    marked as seen, so a later update that does carry them still counts.
    """
    key = str(activity_id)
    if key in usage["activities"]:
        return 0

    contributed: list[int] = []
    for effort in efforts:
        segment = effort.get("segment") or {}
        if segment.get("id") is None:
            continue
        segment_id = int(segment["id"])
        entry = usage["segments"].setdefault(
            str(segment_id),
            {
                "id": segment_id,
                "name": None,
                "start": None,
                "distance_m": None,
                "average_grade": None,
                "count": 0,
                "last_ridden": None,
            },
        )
        # The latest summary wins; Strava's names and lengths do get corrected.
        if segment.get("name") is not None:
            entry["name"] = segment["name"]
        if segment.get("distance") is not None:
            entry["distance_m"] = segment["distance"]
        if segment.get("average_grade") is not None:
            entry["average_grade"] = segment["average_grade"]
        entry["start"] = _start(segment) or entry.get("start")
        entry["count"] += 1
        when = effort.get("start_date")
        if when and (not entry.get("last_ridden") or when > entry["last_ridden"]):
            entry["last_ridden"] = when
        contributed.append(segment_id)

    if contributed:
        usage["activities"][key] = contributed
    return len(contributed)


def forget(usage: dict, activity_id: int) -> int:
    """Uncount a deleted activity. Returns efforts uncounted.

    last_ridden is left as it was: recomputing it would need every other
    activity's dates, which are not held. A deleted ride can therefore leave a
    segment looking ridden more recently than it was, which only nudges a tie.
    """
    contributed = usage["activities"].pop(str(activity_id), None) or []
    for segment_id in contributed:
        entry = usage["segments"].get(str(segment_id))
        if entry is None:
            continue
        entry["count"] = (entry.get("count") or 0) - 1
        if entry["count"] <= 0:
            del usage["segments"][str(segment_id)]
    return len(contributed)
