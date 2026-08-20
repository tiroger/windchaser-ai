"""Strava access for the worker: credentials, tokens, and rate-limited reads.

Deliberately stdlib only. The whole package is a plain zip with no dependency
layer, which keeps deployment to a single artefact and avoids a build step that
could produce something different from what was tested.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"

# Strava rejects requests without one, and the web application's firewall has a
# matching exception. Identifying the caller also makes it obvious in their logs
# which of our components is spending quota.
USER_AGENT = "windchaser-worker/1.0"


class RateLimited(RuntimeError):
    """Strava refused for quota reasons. Retryable, but not immediately."""


# Strava reports quota on every response, refusals included. Recording it lets
# optional work stand down before the quota is gone rather than after: this
# rider's daily read allowance is routinely spent, and when it is, the whole
# application falls back to saved segments.
_quota: dict[str, int] | None = None

# Fraction of the daily allowance beyond which discretionary work stops.
# Backfilling a segment nobody asked for today must never be the call that
# leaves the application unable to refresh the segments they did.
DISCRETIONARY_CEILING = 0.8


def _record_quota(headers) -> None:
    global _quota
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
    }


def quota() -> dict[str, int] | None:
    """What Strava last said about our usage, or None before any call."""
    return _quota


def discretionary_allowed() -> bool:
    """Whether there is enough daily allowance left for optional work."""
    if not _quota or not _quota["daily_limit"]:
        return True
    return _quota["daily_used"] / _quota["daily_limit"] < DISCRETIONARY_CEILING


class Unavailable(RuntimeError):
    """Strava failed in a way that may succeed later."""


# Imported on first use, so the module stays importable without the cloud
# dependencies the Lambda runtime supplies. See store._client.
_secrets = None
_credentials: dict[str, str] | None = None
_token: tuple[str, float] | None = None


def _client():
    global _secrets
    if _secrets is None:
        import boto3

        _secrets = boto3.client("secretsmanager")
    return _secrets


def _secret_id() -> str:
    arn = os.environ.get("STRAVA_SECRET_ARN")
    if not arn:
        raise RuntimeError("STRAVA_SECRET_ARN is not set")
    return arn


def credentials() -> dict[str, str]:
    global _credentials
    if _credentials is None:
        raw = _client().get_secret_value(SecretId=_secret_id())["SecretString"]
        _credentials = json.loads(raw)
    return _credentials


def _http(url: str, *, data: dict | None = None, token: str | None = None) -> dict:
    body = urllib.parse.urlencode(data).encode() if data else None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    last: Exception | None = None
    for attempt in range(3):
        request = urllib.request.Request(url, data=body, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                _record_quota(response.headers)
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            # Recorded from refusals too: a 429 still reports where we stand.
            _record_quota(exc.headers)
            if exc.code == 429:
                # Raised rather than slept through. The message returns to the
                # queue and is retried later, which costs nothing, where sleeping
                # burns the function's own timeout doing nothing.
                raise RateLimited("Strava rate limit reached") from exc
            if exc.code in (500, 502, 503, 504) and attempt < 2:
                time.sleep(2**attempt)
                last = exc
                continue
            if exc.code in (401, 403, 404):
                raise Unavailable(f"Strava {exc.code} for {url}") from exc
            raise Unavailable(f"Strava {exc.code} for {url}") from exc
        except urllib.error.URLError as exc:
            last = exc
            if attempt < 2:
                time.sleep(2**attempt)
                continue
    raise Unavailable(f"Strava unreachable: {last}")


def access_token() -> str:
    """A valid access token, refreshing and persisting rotation when needed.

    Strava may return a new refresh token, and when it does the old one stops
    working. Nothing else in the system writes it back, so a rotation that went
    unrecorded would take the worker and the web application down together some
    days later, with no clue as to why. Writing it to the secret keeps both
    working.
    """
    global _token, _credentials
    if _token and time.time() < _token[1] - 60:
        return _token[0]

    creds = credentials()
    payload = _http(
        TOKEN_URL,
        data={
            "client_id": creds["STRAVA_CLIENT_ID"],
            "client_secret": creds["STRAVA_CLIENT_SECRET"],
            "refresh_token": creds["STRAVA_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        },
    )
    if "access_token" not in payload:
        raise Unavailable("Strava refused the token refresh")

    rotated = payload.get("refresh_token")
    if rotated and rotated != creds["STRAVA_REFRESH_TOKEN"]:
        updated = {**creds, "STRAVA_REFRESH_TOKEN": rotated}
        _client().put_secret_value(
            SecretId=_secret_id(), SecretString=json.dumps(updated)
        )
        _credentials = updated
        # Never log the value itself.
        print("[strava] refresh token rotated; the secret was updated")

    _token = (payload["access_token"], float(payload.get("expires_at", 0)))
    return _token[0]


def get(path: str) -> dict:
    return _http(f"{API}{path}", token=access_token())


def activity(activity_id: int) -> dict:
    """A detailed activity, which is what carries its segment efforts."""
    return get(f"/activities/{activity_id}?include_all_efforts=true")


def all_efforts(segment_id: int, per_page: int = 200, max_pages: int = 5) -> list[dict]:
    """Every recorded effort this athlete has on one segment."""
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        batch = get(
            f"/segments/{segment_id}/all_efforts?per_page={per_page}&page={page}"
        )
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < per_page:
            break
    return out


def altitude_profile(segment_id: int) -> dict | None:
    """Distance and altitude streams, so gradient can vary along the segment.

    Worth one call on its own: a single average gradient describes a rolling
    segment badly, and the backtest attributes a third of the improvement from
    calibration to having the real profile.
    """
    payload = get(
        f"/segments/{segment_id}/streams?keys=distance,altitude&key_by_type=true"
    )
    distance = (payload.get("distance") or {}).get("data")
    altitude = (payload.get("altitude") or {}).get("data")
    if not distance or not altitude or len(distance) != len(altitude):
        return None
    return {"distance_m": distance, "altitude_m": altitude}
