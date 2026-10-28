"""Keep the Training section's copy of the rider's Strava history current.

Three kinds of message arrive on one FIFO queue, all in message group
``strava-events`` so that SQS hands this function one change at a time:

- a webhook activity event, forwarded by /api/strava/webhook as the raw Strava
  body (WindChaser's ``{"received_at", "event"}`` envelope is accepted too);
- ``{"source": "scheduled-reconciliation"}`` daily, the safety net for events
  Strava never delivered, which also refreshes gear and saved routes;
- ``{"source": "streams-backfill"}`` every hour, filling in detailed
  streams a batch at a time; ``{"source": "routes-sync"}`` on demand.

Serialisation is what makes the read-modify-write of activities.json safe, and
it comes from the message group rather than reserved concurrency: a FIFO group
never has two messages in flight, and pinning concurrency to one would throttle
a long sync's queue-mates into the dead letter queue instead.

Strava's read allowance is shared with strava_worker, which already runs this
rider close to the daily limit. Everything here that nobody is waiting for --
the streams backfill, streams beyond the first few a reconciliation finds,
saved-route profiles, gear the current event does not use -- stands down at 80%
of the daily allowance, the same ceiling strava_worker applies to its own
optional work. Applying an event and listing activities for reconciliation
always run, because those are what keep the data correct rather than complete.

The contract this implements is docs/architecture/TRAINING_INTEGRATION.md.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from . import saved_routes
from . import streams as stream_math

_STRAVA_API = "https://www.strava.com/api/v3"
_STRAVA_OAUTH = "https://www.strava.com/oauth/token"

# Strava rejects requests without one. Distinct from strava_worker's, so the
# Strava API dashboard shows which of the two is spending the shared allowance.
USER_AGENT = "windchaser-training-sync/1.0"

# Fraction of the daily read allowance beyond which optional work stops. The
# same ceiling as strava_worker.strava.DISCRETIONARY_CEILING, deliberately: two
# workers with different ceilings would let the more generous one spend what
# the other was holding back.
DISCRETIONARY_CEILING = 0.8

# Streams for this many of the newest activities a reconciliation adds are
# fetched whatever the quota says. Reconciliation finds rides the webhook
# missed, and the newest of those are as wanted as a ride the webhook did
# deliver; the rest of history can wait for the backfill.
RECONCILE_STREAMS_ALWAYS = 3

# Only these fields are stored; the full Strava payload (segment efforts,
# laps, full-resolution polylines) would bloat the object the site reads.
_STORED_FIELDS = (
    "id",
    "name",
    "type",
    "sport_type",
    "start_date_local",
    "distance",
    "moving_time",
    "elapsed_time",
    "total_elevation_gain",
    "average_speed",
    "max_speed",
    "average_heartrate",
    "max_heartrate",
    "average_watts",
    "weighted_average_watts",
    "max_watts",
    "device_watts",
    "kilojoules",
    "suffer_score",
    "average_cadence",
    "elev_high",
    "kudos_count",
    "gear_id",
    "trainer",
    "year",
    "month",
    "day",
    "map",
)


class StravaHTTPError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"Strava returned HTTP {status}: {body[:500]}")
        self.status = status


# ------------------------------------------------------------ AWS clients --

# Created on first use rather than at import. The Lambda runtime provides boto3
# but the tests do not, and a module that cannot be imported without its cloud
# dependencies cannot have its logic tested at all. Same pattern as
# strava_worker.store.
_s3 = None
_secrets = None


def _s3_client():
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client("s3")
    return _s3


def _secrets_client():
    global _secrets
    if _secrets is None:
        import boto3

        _secrets = boto3.client("secretsmanager")
    return _secrets


def _read_json(key: str, default: Any) -> Any:
    try:
        result = _s3_client().get_object(Bucket=os.environ["APP_DATA_BUCKET"], Key=key)
    except Exception as error:  # noqa: BLE001 - narrowed immediately below
        # NoSuchKey only because the role holds s3:ListBucket; without it S3
        # answers AccessDenied and the very first sync could not start.
        code = getattr(error, "response", {}).get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            return default
        raise
    return json.loads(result["Body"].read())


def _delete_object(key: str) -> None:
    _s3_client().delete_object(Bucket=os.environ["APP_DATA_BUCKET"], Key=key)


def _write_json(key: str, value: Any) -> None:
    _s3_client().put_object(
        Bucket=os.environ["APP_DATA_BUCKET"],
        Key=key,
        Body=json.dumps(value, separators=(",", ":")).encode(),
        ContentType="application/json",
        CacheControl="no-cache",
    )


# ------------------------------------------------------------- rate limit --

# What Strava last said about the application's read usage. The headers count
# every caller of the application, strava_worker and the web runtime included,
# so this is the shared allowance rather than this worker's share of it.
_quota: dict[str, Any] | None = None

# Set by any 429 during the current invocation. A refusal means the 15-minute
# window is spent even when the daily figure looks fine, and asking again for
# optional work only adds to the count Strava holds against the application.
_throttled = False


def _record_quota(headers: Any) -> None:
    global _quota
    if headers is None:
        return
    usage = headers.get("x-readratelimit-usage")
    limit = headers.get("x-readratelimit-limit")
    if not usage or not limit:
        return
    try:
        short_used, daily_used = (int(x.strip()) for x in usage.split(",")[:2])
        short_limit, daily_limit = (int(x.strip()) for x in limit.split(",")[:2])
    except (ValueError, TypeError):
        return
    _quota = {
        "short_used": short_used,
        "short_limit": short_limit,
        "daily_used": daily_used,
        "daily_limit": daily_limit,
        # Strava's daily window resets at midnight UTC. A warm container must
        # not carry yesterday's 95% into today and skip a backfill nobody else
        # is going to run.
        "day": datetime.now(timezone.utc).date().isoformat(),
    }


def quota() -> dict[str, Any] | None:
    """What Strava last said about read usage, or None before any call."""
    return _quota


def _discretionary_allowed() -> bool:
    """Whether optional work may spend more of the shared daily allowance."""
    if _throttled:
        return False
    if not _quota or not _quota["daily_limit"]:
        return True
    if _quota.get("day") != datetime.now(timezone.utc).date().isoformat():
        return True
    return _quota["daily_used"] / _quota["daily_limit"] < DISCRETIONARY_CEILING


# ------------------------------------------------------------ Strava HTTP --


def _request_json(request: urllib.request.Request) -> Any:
    global _throttled
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            _record_quota(response.headers)
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        # Refusals report usage too, and a 429's is the one most worth having.
        _record_quota(error.headers)
        if error.code == 429:
            _throttled = True
        body = error.read().decode("utf-8", errors="replace")
        raise StravaHTTPError(error.code, body) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Strava request failed: {error.reason}") from error


def _strava_get(path: str, access_token: str, query: dict[str, Any] | None = None) -> Any:
    suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
    request = urllib.request.Request(
        f"{_STRAVA_API}{path}{suffix}",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    return _request_json(request)


# ------------------------------------------------------------ credentials --

# The access token lives here and nowhere else. The secret is shared with
# strava_worker and the web runtime, and an access token written into it would
# be one more value for three readers to disagree about; it is cheap to mint
# and lasts six hours, so a cold start simply mints another.
_token: tuple[str, float] | None = None

_REQUIRED_KEYS = ("STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN")


def _secret_id() -> str:
    arn = os.environ.get("STRAVA_SECRET_ARN")
    if not arn:
        raise RuntimeError("STRAVA_SECRET_ARN is not set")
    return arn


def _read_secret() -> dict[str, Any]:
    raw = _secrets_client().get_secret_value(SecretId=_secret_id())["SecretString"]
    return json.loads(raw)


def _store_rotated_refresh_token(rotated: str) -> None:
    """Write a rotated refresh token back without disturbing anything else.

    Strava invalidates the previous refresh token once it hands out a new one,
    and strava_worker and the web runtime refresh from the same secret. So the
    new token must land, and nothing else may change: the secret is re-read
    immediately before writing, and only STRAVA_REFRESH_TOKEN is replaced.
    Writing back the copy read before the OAuth call would undo any edit made
    meanwhile, such as a new STRAVA_VERIFY_TOKEN.
    """
    current = _read_secret()
    current["STRAVA_REFRESH_TOKEN"] = rotated
    _secrets_client().put_secret_value(SecretId=_secret_id(), SecretString=json.dumps(current))
    # Never log the value itself.
    print("[credentials] refresh token rotated; the shared secret was updated")


def _credentials() -> str:
    """A valid access token, refreshing it from the shared secret when needed.

    The secret is read on every refresh rather than held for the container's
    lifetime. Another reader may have rotated the refresh token since, and a
    stale copy would fail the refresh outright.
    """
    global _token
    if _token and _token[1] > time.time() + 60:
        return _token[0]

    credentials = _read_secret()
    missing = [key for key in _REQUIRED_KEYS if not credentials.get(key)]
    if missing:
        raise RuntimeError(f"Strava secret is missing {', '.join(missing)}")

    data = urllib.parse.urlencode(
        {
            "client_id": credentials["STRAVA_CLIENT_ID"],
            "client_secret": credentials["STRAVA_CLIENT_SECRET"],
            "refresh_token": credentials["STRAVA_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        }
    ).encode()
    request = urllib.request.Request(
        _STRAVA_OAUTH,
        data=data,
        method="POST",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    response = _request_json(request)
    access_token = response.get("access_token")
    expires_at = response.get("expires_at")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError("Strava OAuth response did not contain an access token")
    if not isinstance(expires_at, (int, float)):
        raise RuntimeError("Strava OAuth response did not contain an expiration time")

    rotated = response.get("refresh_token")
    if isinstance(rotated, str) and rotated and rotated != credentials["STRAVA_REFRESH_TOKEN"]:
        _store_rotated_refresh_token(rotated)

    _token = (access_token, float(expires_at))
    return access_token


# ------------------------------------------------------------- activities --


def _is_public(activity: dict[str, Any]) -> bool:
    # The repository and the site are public; "Only You" activities never
    # reach storage, whatever else is true of them.
    return not activity.get("private") and activity.get("visibility") != "only_me"


def _compact(record: dict[str, Any]) -> dict[str, Any]:
    compacted = {key: record[key] for key in _STORED_FIELDS if key in record}
    map_data = record.get("map")
    if isinstance(map_data, dict):
        compacted["map"] = {"summary_polyline": map_data.get("summary_polyline") or ""}
    return compacted


def _to_processed(activity: dict[str, Any]) -> dict[str, Any]:
    start = activity.get("start_date_local") or activity.get("start_date")
    parsed = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
    map_data = activity.get("map") or {}
    return _compact({
        **activity,
        "id": str(activity["id"]),
        "start_date_local": start,
        "distance": round(float(activity.get("distance", 0)) * 0.000621371, 1),
        "moving_time": round(float(activity.get("moving_time", 0)) / 3600, 1),
        "elapsed_time": round(float(activity.get("elapsed_time", 0)) / 3600, 1),
        "total_elevation_gain": round(
            float(activity.get("total_elevation_gain", 0)) * 3.28084, 1
        ),
        "average_speed": round(float(activity.get("average_speed", 0)) * 2.23694, 1),
        "max_speed": round(float(activity.get("max_speed", 0)) * 2.23694, 1),
        "year": parsed.year,
        "month": parsed.month,
        "day": parsed.day,
        "map": map_data,
    })


def _reconcile(access_token: str, activities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    state_key = os.getenv("SYNC_STATE_S3_KEY", "sync-state.json")
    state = _read_json(state_key, {})
    # A two-day overlap lets a retry recover events that arrived while Strava
    # was temporarily unavailable. IDs make this safe to replay.
    after = max(0, int(state.get("last_sync_epoch", 0)) - 2 * 24 * 60 * 60)
    by_id = {activity["id"]: activity for activity in activities}
    page = 1
    while True:
        batch = _strava_get(
            "/athlete/activities",
            access_token,
            {"after": after, "per_page": 100, "page": page},
        )
        if not batch:
            break
        for activity in batch:
            activity_id = str(activity["id"])
            if _is_public(activity):
                by_id[activity_id] = _to_processed(activity)
            else:
                by_id.pop(activity_id, None)
        if len(batch) < 100:
            break
        page += 1
        if page > 100:
            raise RuntimeError("Strava pagination limit exceeded during reconciliation")
    return list(by_id.values())


# ------------------------------------------------------------------- gear --

# Gear detail needs profile:read_all, which the shared token may not carry: it
# was authorised for WindChaser, which never needed it. Said once per container
# rather than on every event, because it is a standing condition, not news.
_gear_scope_reported = False


def _report_gear_scope(reason: str) -> None:
    global _gear_scope_reported
    if _gear_scope_reported:
        return
    _gear_scope_reported = True
    print(
        f"[gear] {reason}. Gear details need a token with profile:read_all; "
        "activities keep syncing without them."
    )


def _gear_kind(gear_id: str, fallback: str = "bike") -> str:
    # Strava prefixes bike IDs with "b" and shoe IDs with "g".
    if gear_id.startswith("b"):
        return "bike"
    if gear_id.startswith("g"):
        return "shoe"
    return fallback


def _gear_record(gear: dict[str, Any], kind: str, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = previous or {}
    gear_id = str(gear.get("id", ""))
    return {
        "id": gear_id,
        "name": gear.get("nickname") or gear.get("name") or previous.get("name") or "Gear",
        # Summary gear from /athlete has no brand or model; keep what /gear gave.
        "brand": gear.get("brand_name") or previous.get("brand") or "",
        "model": gear.get("model_name") or previous.get("model") or "",
        "distance": round(float(gear.get("distance") or 0) * 0.000621371, 1),
        "retired": bool(gear.get("retired", previous.get("retired", False))),
        "kind": _gear_kind(gear_id, kind),
    }


def _sync_gear(
    access_token: str,
    activities: list[dict[str, Any]],
    refresh_athlete: bool,
    needed: set[str] | None = None,
) -> bool:
    """Keep bikes.json covering every bike and shoe the activities use.

    The athlete profile lists current gear, so reconciliation refreshes
    distances from it. Gear it does not list, such as a bike added since the
    last reconciliation or one now retired, is found through the gear IDs on
    activities and looked up once. Stored gear is never dropped.

    ``needed`` is the gear of the activities this invocation applied; it is
    looked up whatever the quota. Other unknown gear is optional work. Gear is
    never a reason to fail: a refusal or an error leaves bikes.json as it was
    and the event is still applied.
    """
    key = os.getenv("BIKES_S3_KEY", "bikes.json")
    stored = {gear["id"]: gear for gear in _read_json(key, []) if gear.get("id")}
    needed = needed or set()
    changed = False

    listed_ids: set[str] = set()
    if refresh_athlete:
        try:
            athlete = _strava_get("/athlete", access_token)
        except (StravaHTTPError, RuntimeError) as error:
            print(f"[gear] athlete profile unavailable ({error}); distances not refreshed")
            athlete = {}
        else:
            # A token without profile:read_all gets the summary athlete, which
            # has no gear lists at all rather than empty ones.
            if "bikes" not in athlete and "shoes" not in athlete:
                _report_gear_scope("The athlete profile carries no bikes or shoes")
        for kind, listed in (("bike", athlete.get("bikes") or []), ("shoe", athlete.get("shoes") or [])):
            for gear in listed:
                gear_id = str(gear.get("id", ""))
                if not gear_id:
                    continue
                listed_ids.add(gear_id)
                # Gear first seen here is detailed below like any other new gear.
                if gear_id in stored and "kind" in stored[gear_id]:
                    stored[gear_id] = _gear_record(gear, kind, stored[gear_id])
                    changed = True

    used = {str(activity["gear_id"]) for activity in activities if activity.get("gear_id")}
    used |= listed_ids
    # Records without a kind predate gear discovery and lack brand and model.
    unknown = sorted(gear_id for gear_id in used if "kind" not in stored.get(gear_id, {}))
    # The current event's gear first, so the quota gate below can only ever
    # defer gear nobody is looking at yet.
    unknown.sort(key=lambda gear_id: gear_id not in needed)
    for gear_id in unknown:
        if gear_id not in needed and not _discretionary_allowed():
            print(f"[gear] remaining lookups deferred, quota at {quota()}")
            break
        try:
            gear = _strava_get(f"/gear/{gear_id}", access_token)
        except StravaHTTPError as error:
            if error.status == 404:
                print(f"[gear] {gear_id} is not visible to this athlete; skipped")
                continue
            if error.status in (401, 403):
                _report_gear_scope(f"Strava refused /gear with HTTP {error.status}")
                break
            print(f"[gear] lookup for {gear_id} failed with HTTP {error.status}; left for a later run")
            break
        except RuntimeError as error:
            print(f"[gear] lookup for {gear_id} failed: {error}; left for a later run")
            break
        stored[gear_id] = _gear_record(gear, _gear_kind(gear_id), stored.get(gear_id))
        changed = True

    if changed:
        gear_list = sorted(
            stored.values(),
            key=lambda gear: (gear.get("kind") != "bike", bool(gear.get("retired")), -float(gear.get("distance") or 0)),
        )
        _write_json(key, gear_list)
    return changed


# ---------------------------------------------------------------- streams --


def _streams_key(activity_id: str) -> str:
    return f"{os.getenv('STREAMS_S3_PREFIX', 'streams/')}{activity_id}.json"


def _fetch_streams(activity: dict[str, Any], access_token: str) -> dict[str, Any]:
    """Fetch, store, and summarize one activity's streams; return its index entry."""
    activity_id = str(activity["id"])
    entry: dict[str, Any] = {
        "date": activity.get("start_date_local"),
        "sport_type": activity.get("sport_type") or activity.get("type"),
        "has_streams": False,
    }
    empty_summary = stream_math.summarize({})
    try:
        payload = _strava_get(
            f"/activities/{int(activity_id)}/streams",
            access_token,
            {"keys": ",".join(stream_math.STREAM_KEYS), "key_by_type": "true"},
        )
    except StravaHTTPError as error:
        if error.status != 404:
            raise
        return {**entry, **{key: None for key in empty_summary}, "power_bests": {}}

    data = stream_math.by_type(payload)
    if not data.get("time"):
        return {**entry, **{key: None for key in empty_summary}, "power_bests": {}}
    summary = stream_math.summarize(data)
    _write_json(
        _streams_key(activity_id),
        {
            "id": activity_id,
            "start_date_local": entry["date"],
            "sport_type": entry["sport_type"],
            "samples": stream_math.samples(data),
            "summary": summary,
        },
    )
    return {**entry, "has_streams": True, **summary}


def _fetch_streams_for(
    activities: list[dict[str, Any]],
    access_token: str,
    index: dict[str, Any],
    deadline: float,
    limit: int,
    discretionary: bool = False,
) -> int:
    """Fetch streams in order until the limit, the deadline, or Strava's quota."""
    fetched = 0
    for activity in activities:
        if fetched >= limit or time.monotonic() > deadline:
            break
        if discretionary and not _discretionary_allowed():
            print(f"[streams] backfill paused at {fetched}, quota at {quota()}")
            break
        try:
            index[str(activity["id"])] = _fetch_streams(activity, access_token)
        except StravaHTTPError as error:
            if error.status == 429:
                print("[streams] Strava rate limit reached; remaining streams wait for the next backfill")
                break
            print(f"[streams] {activity['id']} failed with HTTP {error.status}; left for backfill")
            continue
        except RuntimeError as error:
            print(f"[streams] {activity['id']} failed: {error}; left for backfill")
            continue
        fetched += 1
    return fetched


# ----------------------------------------------------------- saved routes --


def _saved_route_key(route_id: str) -> str:
    return f"{os.getenv('SAVED_ROUTES_S3_PREFIX', 'saved-routes/')}{route_id}.json"


def _list_saved_routes(access_token: str) -> list[dict[str, Any]]:
    athlete_id = os.getenv("STRAVA_ATHLETE_ID") or str(_strava_get("/athlete", access_token)["id"])
    routes: list[dict[str, Any]] = []
    page = 1
    while True:
        batch = _strava_get(f"/athletes/{athlete_id}/routes", access_token, {"page": page, "per_page": 100})
        routes += batch or []
        if not batch or len(batch) < 100:
            return routes
        page += 1
        if page > 50:
            raise RuntimeError("Strava pagination limit exceeded while listing routes")


def _sync_saved_routes(access_token: str, deadline: float) -> int:
    """Store public saved routes and fetch the profiles of new or edited ones.

    The listing always runs: it is a call or two a day, and it is what removes
    a route the rider deleted or made private. The profiles are optional work
    and wait for quota like the streams backfill does.
    """
    key = os.getenv("SAVED_ROUTES_S3_KEY", "saved-routes.json")
    limit = int(os.getenv("SAVED_ROUTES_PROFILE_LIMIT", "30"))
    previous = {route["id"]: route for route in _read_json(key, [])}
    listed = [route for route in _list_saved_routes(access_token) if not route.get("private")]
    records = {
        saved_routes.route_id(route): saved_routes.summary(
            route, (previous.get(saved_routes.route_id(route)) or {}).get("profile_updated_at")
        )
        for route in listed
    }

    # Routes deleted or made private take their profiles with them.
    for route_id, old in previous.items():
        if route_id not in records and old.get("profile_updated_at"):
            _delete_object(_saved_route_key(route_id))

    stale = sorted(
        (route for route in listed if records[saved_routes.route_id(route)]["profile_updated_at"] != route.get("updated_at")),
        key=lambda route: route.get("updated_at") or "",
        reverse=True,
    )
    fetched = 0
    for route in stale:
        if fetched >= limit or time.monotonic() > deadline:
            break
        if not _discretionary_allowed():
            print(f"[routes] profiles paused at {fetched}, quota at {quota()}")
            break
        route_id = saved_routes.route_id(route)
        try:
            payload = _strava_get(f"/routes/{route_id}/streams", access_token)
        except StravaHTTPError as error:
            if error.status == 429:
                print("[routes] Strava rate limit reached; remaining profiles wait for the next sync")
                break
            print(f"[routes] profile for {route_id} failed with HTTP {error.status}; skipped")
            continue
        except RuntimeError as error:
            print(f"[routes] profile for {route_id} failed: {error}; skipped")
            continue
        fetched += 1
        profile = saved_routes.profile(route, payload)
        if profile:
            _write_json(_saved_route_key(route_id), profile)
            records[route_id]["profile_updated_at"] = route.get("updated_at")

    _write_json(
        key,
        sorted(records.values(), key=lambda route: route.get("updated_at") or "", reverse=True),
    )
    return fetched


# ----------------------------------------------------------------- events --


def _process_event(event: dict[str, Any], access_token: str, activities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply a webhook event using Strava as the source of truth.

    Webhook payloads are unauthenticated, so the event only says which
    activity to look at: deletes are confirmed by a 404, and only the
    configured athlete's public activities are stored.
    """
    athlete_id = os.getenv("STRAVA_ATHLETE_ID", "")
    if not athlete_id:
        raise RuntimeError("STRAVA_ATHLETE_ID is not configured")
    if str(event.get("owner_id")) != athlete_id:
        return activities

    activity_id = str(event["object_id"])
    remaining = [old for old in activities if old["id"] != activity_id]
    try:
        activity = _strava_get(f"/activities/{int(activity_id)}", access_token)
    except StravaHTTPError as error:
        if error.status == 404:
            return remaining
        raise
    if str((activity.get("athlete") or {}).get("id")) != athlete_id:
        return activities
    if not _is_public(activity):
        return remaining
    return remaining + [_to_processed(activity)]


def _normalise(body: Any) -> dict[str, Any]:
    """One message body in the shape main() dispatches on."""
    if not isinstance(body, dict):
        return {}
    # WindChaser's own queue wraps the Strava body as {"received_at", "event"}.
    # The webhook forwards the raw body here, but accepting the envelope means a
    # message replayed from the other queue's dead letter queue still works.
    if isinstance(body.get("event"), dict):
        body = body["event"]
    source = body.get("source")
    if source in ("scheduled-reconciliation", "reconcile"):
        return {"source": "reconcile"}
    if source in ("streams-backfill", "routes-sync"):
        return {"source": source}
    return body


def _records_from_sqs(record: dict[str, Any]) -> dict[str, Any]:
    try:
        body = json.loads(record["body"])
    except (KeyError, TypeError, ValueError):
        # An unparseable body will never parse. Failing would block the whole
        # FIFO group for five visibility timeouts before the dead letter queue
        # took it; dropping it with a log says the same thing without the wait.
        print(f"[sync] discarding unparseable message: {str(record.get('body'))[:200]!r}")
        return {}
    return _normalise(body)


def _deadline(context: Any) -> float:
    # Leave time to write what was fetched before Lambda stops the invocation.
    remaining_ms = getattr(context, "get_remaining_time_in_millis", lambda: 300_000)()
    return time.monotonic() + max(0.0, remaining_ms / 1000 - 30)


def _newest_first(activities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(activities, key=lambda activity: activity.get("start_date_local") or "", reverse=True)


def main(event: dict[str, Any], context: Any) -> dict[str, Any]:
    global _throttled
    # A 429 from a previous invocation says nothing about now; the window it
    # described has likely rolled over.
    _throttled = False

    messages = (event or {}).get("Records") or []
    if messages:
        events = [_records_from_sqs(record) for record in messages]
    else:
        events = [_normalise(event or {})]

    deadline = _deadline(context)
    access_token = _credentials()
    activities_key = os.getenv("ACTIVITIES_S3_KEY", "activities.json")
    state_key = os.getenv("SYNC_STATE_S3_KEY", "sync-state.json")
    index_key = os.getenv("STREAMS_INDEX_S3_KEY", "streams-index.json")
    backfill_limit = int(os.getenv("STREAMS_BACKFILL_LIMIT", "25"))
    activities = _read_json(activities_key, [])
    index = _read_json(index_key, {})

    changed = False
    reconciled = False
    index_changed = False
    event_targets: list[str] = []
    reconcile_added: list[str] = []
    backfill = False
    routes_sync = False
    for item in events:
        if item.get("source") == "reconcile":
            before = {activity["id"] for activity in activities}
            activities = _reconcile(access_token, activities)
            changed = True
            reconciled = True
            # Only activities this run added; older gaps are the backfill's job.
            reconcile_added += [activity["id"] for activity in activities if activity["id"] not in before]
        elif item.get("source") == "streams-backfill":
            backfill = True
        elif item.get("source") == "routes-sync":
            routes_sync = True
        elif item.get("object_type") == "activity":
            activity_id = str(item.get("object_id"))
            activities = _process_event(item, access_token, activities)
            changed = True
            if any(activity["id"] == activity_id for activity in activities):
                event_targets.append(activity_id)
            elif activity_id in index:
                # Deleted, or now private: its detailed data goes with it.
                _delete_object(_streams_key(activity_id))
                del index[activity_id]
                index_changed = True

    if changed:
        activities = [_compact(activity) for activity in activities if _is_public(activity)]
        activities.sort(key=lambda activity: activity.get("start_date_local", ""), reverse=True)
        _write_json(activities_key, activities)

    by_id = {activity["id"]: activity for activity in activities}
    applied = [by_id[activity_id] for activity_id in event_targets + reconcile_added if activity_id in by_id]
    needed_gear = {str(activity["gear_id"]) for activity in applied if activity.get("gear_id")}
    _sync_gear(access_token, activities, refresh_athlete=reconciled, needed=needed_gear)

    # Streams in two passes. What this invocation applied comes first and is
    # not rationed: a ride that just arrived is the one the rider will open.
    # Everything else is backfill and stops at the quota ceiling.
    newest_added = [activity["id"] for activity in _newest_first(
        [by_id[activity_id] for activity_id in reconcile_added if activity_id in by_id]
    )[:RECONCILE_STREAMS_ALWAYS]]
    urgent_ids = set(event_targets) | set(newest_added)
    wanted = set(reconcile_added)
    missing = _newest_first([activity for activity in activities if activity["id"] not in index])
    urgent = [activity for activity in missing if activity["id"] in urgent_ids]
    optional = [
        activity for activity in missing
        if activity["id"] not in urgent_ids and (backfill or activity["id"] in wanted)
    ]
    streams_fetched = 0
    if urgent:
        streams_fetched += _fetch_streams_for(urgent, access_token, index, deadline, len(urgent))
    if optional:
        streams_fetched += _fetch_streams_for(
            optional, access_token, index, deadline, backfill_limit, discretionary=True
        )
    if streams_fetched or index_changed:
        _write_json(index_key, index)

    route_profiles_fetched = _sync_saved_routes(access_token, deadline) if reconciled or routes_sync else 0

    if reconciled:
        _write_json(
            state_key,
            {
                "last_sync_epoch": int(time.time()),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    return {
        "ok": True,
        "events": len(events),
        "activities": len(activities),
        "streams_fetched": streams_fetched,
        "route_profiles_fetched": route_profiles_fetched,
        "strava_quota": quota(),
    }
