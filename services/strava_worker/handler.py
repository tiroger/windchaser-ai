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

from . import segment_usage, store, strava, weather
from .strava import RateLimited, Unavailable, activity

EFFORTS_KEY = os.environ.get("EFFORTS_S3_KEY", "efforts.json")
CALIBRATION_KEY = os.environ.get("CALIBRATION_S3_KEY", "calibration.json")
# The saved bundle the application falls back to. Read here only as the list of
# segments the rider actually sees, which is what makes a segment worth the
# quota to learn about.
BUNDLE_KEY = os.environ.get("BUNDLE_S3_KEY", "opportunities.json")
# How often the rider rides every segment, tracked or not. See segment_usage.
USAGE_KEY = os.environ.get("SEGMENT_USAGE_S3_KEY", "segment-usage.json")

# Rides on an untracked segment, counted from ingested activities, before it is
# worth a backfill. One ride is a route taken once; three is a habit.
MIN_USAGE_COUNT = 3

CELL_DEG = 0.1

# Elevation profiles are fetched separately from effort history and far more
# freely, because they cost one call each and are worth more per call than
# anything else here: the backtest attributes a drop from 72.5s to 52.3s of mean
# error purely to gradient varying along a segment instead of being one average.
# Every displayed segment benefits, whether or not the rider has ever ridden it.
MAX_PROFILES_PER_RUN = int(os.environ.get("MAX_PROFILES_PER_RUN", "25"))
# Tracked segments whose full history is re-read per refresh, one call each.
MAX_RESYNC_PER_RUN = int(os.environ.get("MAX_RESYNC_PER_RUN", "25"))


def cell_id(lat: float, lon: float) -> str:
    """The forecast cell a point falls in, matching lib/server/weather.ts."""
    return f"{round(lat / CELL_DEG) * CELL_DEG:.2f},{round(lon / CELL_DEG) * CELL_DEG:.2f}"


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


def apply_event(body: dict, payload: dict, usage: dict | None = None) -> int:
    """Fold one webhook event into the history. Returns efforts added or removed.

    With a usage object, every effort in the activity is also counted there,
    tracked segment or not, from the same activity detail: usage costs no
    Strava read of its own. Without one, only the history changes.
    """
    if body.get("object_type") != "activity":
        return 0

    activity_id = body.get("object_id")
    aspect = body.get("aspect_type")
    if not activity_id:
        return 0

    if aspect == "delete":
        if usage is not None:
            segment_usage.forget(usage, activity_id)
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
        # that this rider already exhausts. Untracked segments are only counted,
        # in usage below; the refresh adds the frequently ridden ones one per run.
        if sid not in known:
            continue
        if effort.get("id") in seen:
            continue
        if not effort.get("start_date") or not effort.get("elapsed_time"):
            continue
        payload["efforts"].append(_record(effort, known[sid], activity_id))
        added += 1

    counted = ""
    if usage is not None:
        counted = f", {segment_usage.record(usage, activity_id, efforts)} counted as usage"

    print(
        f"[ingest] activity {activity_id}: {len(efforts)} efforts, "
        f"{added} on tracked segments{counted}"
    )
    return added


def backfill_candidate(
    payload: dict, bundle: dict, usage: dict | None = None
) -> dict | None:
    """The untracked segment worth learning about next.

    Ranked by how often the rider has ridden it, because that is both the most
    evidence per call and the strongest signal that they care about the segment.
    Segments they have never ridden are skipped: there is no history to fetch,
    and no record to compare a prediction against either.

    Two sources. The bundle's segments are the ones the rider sees, and come
    with geometry. Usage holds every segment ingested rides crossed, so a climb
    ridden every week is found even if no bundle ever showed it; those need
    MIN_USAGE_COUNT rides and their geometry fetched. Ties go to the segment
    ridden most recently.
    """
    # Segments Strava would not describe are passed over, or the same refused
    # candidate would come round every run and block every other one.
    known = set(payload.get("segments") or {}) | set(payload.get("undescribed_segments") or {})
    counted = (usage or {}).get("segments") or {}
    bundled = {str(s.get("id")): s for s in bundle.get("segments") or []}
    ranked: dict[str, tuple[tuple[int, str], dict]] = {}

    for sid, s in bundled.items():
        if sid in known or (s.get("effort_count_personal") or 0) <= 0:
            continue
        seen = counted.get(sid) or {}
        rank = (
            max(s.get("effort_count_personal") or 0, seen.get("count") or 0),
            seen.get("last_ridden") or "",
        )
        ranked[sid] = (rank, s)

    for sid, seen in counted.items():
        if sid in known or (seen.get("count") or 0) < MIN_USAGE_COUNT:
            continue
        if sid in ranked:
            continue  # the bundle's entry already carries its count and geometry
        # A bundle entry with no personal count (an older bundle) still has the
        # geometry worth reusing; otherwise backfill_segment fetches it.
        candidate = bundled.get(sid) or {
            "id": seen.get("id") or int(sid),
            "name": seen.get("name"),
            "distance_m": seen.get("distance_m"),
            "average_grade": seen.get("average_grade"),
        }
        ranked[sid] = ((seen.get("count") or 0, seen.get("last_ridden") or ""), candidate)

    if not ranked:
        return None
    return max(ranked.values(), key=lambda pair: pair[0])[1]


def backfill_profiles(payload: dict, bundle: dict, limit: int) -> int:
    """Fetch elevation profiles for displayed segments that lack one.

    Separate from the effort-history backfill, and much less rationed. A profile
    is a single call, it improves the prediction for that segment immediately,
    and it is what the interface draws the segment's shape from. Rationing it
    at the same rate as effort history meant a segment the rider was looking at
    could sit blank for a fortnight waiting behind segments they ride more.
    """
    known = payload.setdefault("segments", {})
    wanted = [
        s
        for s in (bundle.get("segments") or [])
        if not (known.get(str(s.get("id"))) or {}).get("elevation_profile")
    ]
    # The rider's own segments first: those are the ones with a record to beat,
    # so a better gradient changes an answer rather than only a picture.
    wanted.sort(key=lambda s: -(s.get("effort_count_personal") or 0))

    added = 0
    for segment in wanted[:limit]:
        if not strava.discretionary_allowed():
            print(f"[profiles] stopping at {added}, quota at {strava.quota()}")
            break
        segment_id = int(segment["id"])
        try:
            profile = strava.altitude_profile(segment_id)
        except (RateLimited, Unavailable) as exc:
            print(f"[profiles] {segment.get('name')}: {exc}")
            break
        if not profile:
            continue

        record = known.get(str(segment_id))
        if record is None:
            points = segment.get("points") or []
            if len(points) < 2:
                continue
            middle = points[len(points) // 2]
            record = {
                "id": segment_id,
                "name": segment.get("name"),
                "distance_m": segment.get("distance_m"),
                "average_grade": segment.get("average_grade"),
                "pr_elapsed_time": segment.get("pr_elapsed_time"),
                "cell_id": segment.get("cell_id") or cell_id(middle[0], middle[1]),
                "points": points,
            }
            known[str(segment_id)] = record
        record["elevation_profile"] = profile
        added += 1

    if added:
        print(f"[profiles] added {added} elevation profiles")
    return added


def _segment_detail(payload: dict, segment: dict) -> dict | None:
    """The candidate with geometry and figures from Strava's segment detail.

    None when Strava refuses or describes no line; the caller records nothing,
    because a segment that cannot be drawn or placed in a weather cell is no
    use to the application or the calibration. A refusal that will not change
    (a private or deleted segment) or a missing line is remembered in
    `undescribed_segments`, so backfill_candidate moves on to the next one; a
    rate limit is not, since it says nothing about the segment.
    """
    name = segment.get("name")
    try:
        detail = strava.segment(int(segment["id"]))
    except RateLimited as exc:
        print(f"[backfill] {name}: no segment detail ({exc})")
        return None
    except Unavailable as exc:
        print(f"[backfill] {name}: no segment detail ({exc}); not asking again")
        payload.setdefault("undescribed_segments", {})[str(segment["id"])] = _now()
        return None
    shape = detail.get("map") or {}
    line = shape.get("polyline") or shape.get("summary_polyline")
    points = strava.simplify(strava.decode_polyline(line)) if line else []
    if len(points) < 2:
        print(f"[backfill] {name}: Strava describes no line, recording nothing")
        payload.setdefault("undescribed_segments", {})[str(segment["id"])] = _now()
        return None
    stats = detail.get("athlete_segment_stats") or {}
    return {
        **segment,
        "name": detail.get("name") or name,
        "distance_m": detail.get("distance", segment.get("distance_m")),
        "average_grade": detail.get("average_grade", segment.get("average_grade")),
        "pr_elapsed_time": stats.get("pr_elapsed_time"),
        "points": points,
    }


def backfill_segment(payload: dict, segment: dict) -> int:
    """Pull one segment's effort history into the store. Returns efforts added.

    Costs a handful of Strava reads, which is why exactly one segment is taken
    per run. Coverage fills in over a fortnight instead of spiking a daily
    allowance this rider already spends, and every segment added moves from the
    rider-level model at 83s mean error to its own fit at 52s.

    A segment known only from usage has no geometry, so its detail is fetched
    first: one more call, and spent before the effort history so that a
    segment Strava will not describe costs one read rather than several.
    """
    segment_id = int(segment["id"])
    if len((segment.get("points") or [])) < 2:
        segment = _segment_detail(payload, segment)
        if segment is None:
            return 0
    efforts = strava.all_efforts(segment_id)
    usable = [e for e in efforts if e.get("elapsed_time") and e.get("start_date")]
    if not usable:
        print(f"[backfill] {segment.get('name')}: no usable efforts, recording nothing")
        return 0

    points = segment.get("points") or []
    if len(points) < 2:
        print(f"[backfill] {segment.get('name')}: no geometry in the bundle")
        return 0
    middle = points[len(points) // 2]

    profile = None
    try:
        profile = strava.altitude_profile(segment_id)
    except (RateLimited, Unavailable) as exc:
        # The efforts are the expensive part and they are already in hand. A
        # segment with history and an average gradient still beats one with
        # neither, and the profile can arrive on a later run.
        print(f"[backfill] {segment.get('name')}: no elevation profile ({exc})")

    payload["segments"][str(segment_id)] = {
        "id": segment_id,
        "name": segment.get("name"),
        "distance_m": segment.get("distance_m"),
        "average_grade": segment.get("average_grade"),
        "pr_elapsed_time": segment.get("pr_elapsed_time"),
        "cell_id": segment.get("cell_id") or cell_id(middle[0], middle[1]),
        "points": points,
        "elevation_profile": profile,
    }

    cell = payload["segments"][str(segment_id)]["cell_id"]
    added = _merge_history(payload, segment_id, cell, usable)
    payload["segments"][str(segment_id)]["efforts_synced_at"] = _now()

    print(
        f"[backfill] {segment.get('name')}: {added} efforts, "
        f"profile {'yes' if profile else 'no'}"
    )
    return added


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _merge_history(payload: dict, segment_id: int, cell: str | None, efforts: list[dict]) -> int:
    """Add fetched efforts not yet held. Returns how many were added.

    Efforts already held but stored without their activity -- the offline
    history recorded none -- gain it, because a fetched effort names its ride.
    """
    held = {e.get("effort_id"): e for e in payload["efforts"]}
    added = 0
    for effort in efforts:
        activity_id = (effort.get("activity") or {}).get("id")
        existing = held.get(effort.get("id"))
        if existing is not None:
            if activity_id and not existing.get("activity_id"):
                existing["activity_id"] = activity_id
            continue
        payload["efforts"].append(
            {
                "segment_id": segment_id,
                "effort_id": effort.get("id"),
                "activity_id": activity_id,
                "start_date": effort["start_date"],
                "elapsed_time_s": effort["elapsed_time"],
                "moving_time_s": effort.get("moving_time"),
                "distance_m": effort.get("distance"),
                "average_watts": effort.get("average_watts"),
                "device_watts": effort.get("device_watts"),
                "average_heartrate": effort.get("average_heartrate"),
                "cell_id": cell,
                "weather": None,
            }
        )
        added += 1
    return added


def resync_segments(payload: dict, limit: int) -> tuple[int, int]:
    """Re-read the effort history of the tracked segments synced longest ago.

    Ingestion only sees rides the webhook delivers. Anything it missed -- an
    outage, a rejected message, the envelope bug that dropped every ride from
    August to October -- would otherwise be missing for good. One call per
    segment, taken a few at a time, keeps every tracked segment complete.
    Returns (segments re-read, efforts added). A re-read that adds nothing
    still has to be saved, or the same segments come round every run.
    """
    segments = list((payload.get("segments") or {}).values())
    segments.sort(key=lambda s: s.get("efforts_synced_at") or "")
    synced = added = 0
    for segment in segments[:limit]:
        if not strava.discretionary_allowed():
            print(f"[resync] stopping, quota at {strava.quota()}")
            break
        segment_id = int(segment["id"])
        try:
            efforts = strava.all_efforts(segment_id)
        except (RateLimited, Unavailable) as exc:
            print(f"[resync] {segment.get('name')}: {exc}")
            break
        usable = [e for e in efforts if e.get("elapsed_time") and e.get("start_date")]
        added += _merge_history(payload, segment_id, segment.get("cell_id"), usable)
        segment["efforts_synced_at"] = _now()
        synced += 1
    if synced:
        print(f"[resync] re-read {synced} segments, recovered {added} efforts")
    return synced, added


def ingest(event, _context=None):
    """SQS entry point. One event per invocation; see the reserved concurrency."""
    records = event.get("Records") or []
    payload = store.load(EFFORTS_KEY)
    # Loaded once and tolerantly: None means usage is skipped this invocation,
    # never that the efforts are.
    usage = segment_usage.load(USAGE_KEY)
    usage_before = segment_usage.fingerprint(usage)

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
        # The webhook wraps each Strava event as {"received_at", "event"}.
        # Reading the envelope as the event drops every ride without a word,
        # which is how this went unnoticed from August to October.
        if isinstance(body, dict) and isinstance(body.get("event"), dict):
            body = body["event"]
        if not isinstance(body, dict) or "object_type" not in body:
            print(f"[ingest] ignoring a message that is not a Strava event: {record.get('body')!r}")
            continue
        changed += apply_event(body, payload, usage)

    # Usage first and efforts last. A failed usage write is logged and dropped,
    # so it cannot cost the efforts; a failed efforts write still fails the
    # message, and the retry finds this activity already counted in usage.
    usage_changed = usage is not None and segment_usage.fingerprint(usage) != usage_before
    if usage_changed:
        usage["generated_at"] = _now()
        try:
            store.save(USAGE_KEY, usage)
        except Exception as exc:  # noqa: BLE001 - usage must never cost the efforts
            print(f"[usage] could not save {USAGE_KEY}: {exc}")
            usage_changed = False

    if changed:
        payload["effort_count"] = len(payload["efforts"])
        payload["segment_count"] = len(payload["segments"])
        payload["generated_at"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        store.save(EFFORTS_KEY, payload)

    return {
        "records": len(records),
        "efforts_changed": changed,
        "usage_changed": usage_changed,
    }


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

    # One untracked segment per run, and only while there is daily allowance to
    # spare. This is discretionary work: nobody asked for it today, so it must
    # never be the call that leaves the application unable to refresh the
    # segments the rider did ask for.
    backfilled = 0
    profiles = 0
    undescribed_before = len(payload.get("undescribed_segments") or {})
    resynced = recovered = 0
    try:
        if strava.discretionary_allowed():
            bundle = store.load(BUNDLE_KEY)
            usage = segment_usage.load(USAGE_KEY)
            # Profiles first. They are the cheaper call and the larger gain, so
            # if the run has budget for only one of the two, this is the one
            # worth spending it on.
            profiles = backfill_profiles(payload, bundle, MAX_PROFILES_PER_RUN)
            candidate = backfill_candidate(payload, bundle, usage)
            if candidate and strava.discretionary_allowed():
                backfilled = backfill_segment(payload, candidate)
            resynced, recovered = resync_segments(payload, MAX_RESYNC_PER_RUN)
        else:
            print(f"[backfill] skipped, quota at {strava.quota()}")
    except (RateLimited, Unavailable) as exc:
        # Never fatal. The rebuild below is the part that matters, and it works
        # on whatever history is already held.
        print(f"[backfill] unavailable this run: {exc}")

    attached = attach_weather(payload)

    # A newly undescribed segment is saved too, or it is asked about again.
    passed_over = len(payload.get("undescribed_segments") or {}) != undescribed_before
    if attached or backfilled or profiles or resynced or passed_over:
        payload["effort_count"] = len(payload["efforts"])
        payload["segment_count"] = len(payload["segments"])
        payload["generated_at"] = _now()
        store.save(EFFORTS_KEY, payload)

    # Rebuilt every run, not only when weather arrived. It is seconds of work
    # over a few hundred efforts, and it means a change to the model itself
    # reaches the application on the next schedule rather than needing someone
    # to remember.
    calibration = build_calibration(payload)
    store.save_calibration(CALIBRATION_KEY, calibration)

    rider = calibration.get("rider") or {}
    fitted = sum(1 for v in calibration["segments"].values() if v.get("power_w"))
    print(
        f"[refresh] calibration rebuilt: {len(calibration['segments'])} segments, "
        f"{fitted} with fitted power, "
        f"rider CP {rider.get('cp_w', 0):.0f} W over "
        f"{rider.get('attempt_count', 0)} attempts"
    )
    return {
        "weather_attached": attached,
        "profiles_added": profiles,
        "segments_backfilled": 1 if backfilled else 0,
        "efforts_backfilled": backfilled,
        "segments_resynced": resynced,
        "efforts_recovered": recovered,
        "segments": len(calibration["segments"]),
        "with_fitted_power": fitted,
        "efforts": len(payload["efforts"]),
        "strava_quota": strava.quota(),
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
