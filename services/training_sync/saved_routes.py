"""Turn Strava saved routes into the summaries and profiles the site reads."""

from __future__ import annotations

from typing import Any

from . import streams as stream_math

MAX_PROFILE_POINTS = 2000

_TYPES = {1: "ride", 2: "run"}
_SUB_TYPES = {1: "road", 2: "mtb", 3: "cx", 4: "trail", 5: "mixed"}


def route_id(route: dict[str, Any]) -> str:
    # Route IDs outgrow a double, so the string form is the one to trust.
    return str(route.get("id_str") or route["id"])


def summary(route: dict[str, Any], profile_updated_at: str | None) -> dict[str, Any]:
    estimated = route.get("estimated_moving_time")
    return {
        "id": route_id(route),
        "name": route.get("name") or "Untitled route",
        "description": route.get("description") or "",
        "type": _TYPES.get(route.get("type"), "other"),
        "sub_type": _SUB_TYPES.get(route.get("sub_type")),
        "distance": round(float(route.get("distance") or 0) * 0.000621371, 2),
        "elevation_gain": round(float(route.get("elevation_gain") or 0) * 3.28084),
        "estimated_moving_time": int(estimated) if isinstance(estimated, (int, float)) else None,
        "starred": bool(route.get("starred")),
        "created_at": route.get("created_at"),
        "updated_at": route.get("updated_at"),
        "polyline": (route.get("map") or {}).get("summary_polyline") or None,
        # Not part of Strava's route: when this route's profile was last stored,
        # so an unchanged route is never fetched twice and the site can tell
        # a route whose profile is still pending.
        "profile_updated_at": profile_updated_at,
    }


def profile(route: dict[str, Any], payload: Any) -> dict[str, Any] | None:
    """Distance, altitude, and position along the route, evenly downsampled."""
    data = stream_math.by_type(payload)
    distance = data.get("distance") or []
    altitude = data.get("altitude") or []
    latlng = data.get("latlng") or []
    length = min(len(distance), len(altitude), len(latlng))
    if length < 2:
        return None
    indices = stream_math._downsample_indices(length, MAX_PROFILE_POINTS)
    return {
        "id": route_id(route),
        "updated_at": route.get("updated_at"),
        "distance": [round(float(distance[i]) * 0.000621371, 3) for i in indices],
        "altitude": [round(float(altitude[i]) * 3.28084, 1) for i in indices],
        "latlng": [[round(float(latlng[i][0]), 5), round(float(latlng[i][1]), 5)] for i in indices],
    }
