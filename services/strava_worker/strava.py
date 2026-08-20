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
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
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
