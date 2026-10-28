"""Turn Strava activity streams into chart samples and effort summaries."""

from __future__ import annotations

from typing import Any

# Durations, in seconds, for best average power. Only windows that fit inside
# an activity are reported.
POWER_BEST_DURATIONS = (
    1, 5, 15, 30, 60, 120, 180, 300, 480, 600,
    1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400,
)

STREAM_KEYS = ("time", "distance", "altitude", "watts", "heartrate", "cadence", "velocity_smooth", "latlng")

# A recording gap up to this long is a dropped sample and is filled with the
# previous value; anything longer is a pause and is removed, so averages and
# best efforts describe riding time only.
MAX_FILLED_GAP_SECONDS = 5

MAX_SAMPLES = 1200


def by_type(payload: Any) -> dict[str, list[Any]]:
    """Normalise both stream response shapes to {type: data}."""
    if isinstance(payload, dict):
        return {
            key: value.get("data", []) for key, value in payload.items()
            if isinstance(value, dict)
        }
    if isinstance(payload, list):
        return {
            item["type"]: item.get("data", []) for item in payload
            if isinstance(item, dict) and "type" in item
        }
    return {}


def one_hz(time: list[int], values: dict[str, list[Any]]) -> dict[str, list[Any]]:
    """Resample channels onto one value per recorded second."""
    series: dict[str, list[Any]] = {key: [] for key in values}
    previous_time = None
    for index, moment in enumerate(time):
        if previous_time is not None:
            gap = moment - previous_time
            if gap <= 0:
                continue
            if gap <= MAX_FILLED_GAP_SECONDS:
                for key, channel in series.items():
                    channel.extend([channel[-1]] * (gap - 1))
        for key, data in values.items():
            series[key].append(data[index] if index < len(data) else None)
        previous_time = moment
    return series


def _mean(values: list[Any]) -> float | None:
    present = [value for value in values if value is not None]
    return sum(present) / len(present) if present else None


def _prefix_sums(values: list[float]) -> list[float]:
    sums = [0.0]
    for value in values:
        sums.append(sums[-1] + value)
    return sums


def power_bests(watts: list[float]) -> dict[str, int]:
    sums = _prefix_sums(watts)
    bests = {}
    for duration in POWER_BEST_DURATIONS:
        if duration > len(watts):
            break
        best = max(sums[end] - sums[end - duration] for end in range(duration, len(sums)))
        bests[str(duration)] = round(best / duration)
    return bests


def normalized_power(watts: list[float]) -> float | None:
    if len(watts) < 30:
        return None
    sums = _prefix_sums(watts)
    rolling = [(sums[end] - sums[end - 30]) / 30 for end in range(30, len(sums))]
    return round((sum(value ** 4 for value in rolling) / len(rolling)) ** 0.25, 1)


def _rounded(value: float | None, digits: int = 0) -> float | int | None:
    if value is None:
        return None
    return round(value) if digits == 0 else round(value, digits)


def summarize(streams: dict[str, list[Any]]) -> dict[str, Any]:
    """Effort summary over riding time, computed on the 1 Hz series."""
    time = streams.get("time") or []
    channels = {key: streams[key] for key in ("watts", "heartrate") if streams.get(key)}
    # The time channel itself measures how many riding seconds there are.
    series = one_hz(time, {**channels, "time": time})
    watts = [value or 0 for value in series.get("watts", [])]
    heartrate = series.get("heartrate", [])
    moving_seconds = len(series["time"])
    half = moving_seconds // 2

    def halves(values: list[Any]) -> tuple[float | None, float | None]:
        return _mean(values[:half]), _mean(values[half:])

    first_watts, second_watts = halves(watts) if watts else (None, None)
    first_hr, second_hr = halves(heartrate) if heartrate else (None, None)
    return {
        "power_bests": power_bests(watts) if watts else {},
        "normalized_power": normalized_power(watts) if watts else None,
        "average_watts": _rounded(_mean(watts)) if watts else None,
        "max_watts": max(watts) if watts else None,
        "average_heartrate": _rounded(_mean(heartrate), 1) if heartrate else None,
        "max_heartrate": max((value for value in heartrate if value is not None), default=None),
        "moving_seconds": moving_seconds,
        "first_half": {"watts": _rounded(first_watts, 1), "heartrate": _rounded(first_hr, 1)},
        "second_half": {"watts": _rounded(second_watts, 1), "heartrate": _rounded(second_hr, 1)},
    }


def _downsample_indices(length: int, limit: int = MAX_SAMPLES) -> list[int]:
    if length <= limit:
        return list(range(length))
    step = (length - 1) / (limit - 1)
    return sorted({round(position * step) for position in range(limit)})


# Display units match the activity summaries: miles, feet, and mph.
_SAMPLE_CONVERSIONS = {
    "time": ("time", lambda value: int(value)),
    "distance": ("distance", lambda value: round(value * 0.000621371, 2)),
    "altitude": ("altitude", lambda value: round(value * 3.28084, 1)),
    "watts": ("watts", lambda value: round(value)),
    "heartrate": ("heartrate", lambda value: round(value)),
    "cadence": ("cadence", lambda value: round(value)),
    "velocity_smooth": ("velocity", lambda value: round(value * 2.23694, 1)),
    # The web app hides the points near either end before anything leaves the server.
    "latlng": ("latlng", lambda value: [round(value[0], 5), round(value[1], 5)]),
}


def samples(streams: dict[str, list[Any]]) -> dict[str, list[Any]]:
    length = len(streams.get("time") or [])
    indices = _downsample_indices(length)
    result = {}
    for key, (name, convert) in _SAMPLE_CONVERSIONS.items():
        data = streams.get(key)
        if not data:
            continue
        result[name] = [
            None if index >= len(data) or data[index] is None else convert(data[index])
            for index in indices
        ]
    return result
