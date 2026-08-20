#!/usr/bin/env python3
"""Check what the calibration builder ships, and what it refuses to.

Plain assertions, no framework, matching the physics parity check in CI.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))

from cycling_analytics.calibration import build_calibration  # noqa: E402

PROFILE = {
    "distance_m": [0, 500, 1000, 1500],
    "altitude_m": [10, 40, 90, 130],
}
POINTS = [[41.0, -73.9], [41.005, -73.9], [41.01, -73.9]]


def segment(sid: int, **extra) -> dict:
    return {
        "id": sid,
        "name": f"Segment {sid}",
        "cell_id": "41.00,-73.90",
        "average_grade": 8.0,
        "pr_elapsed_time": 400,
        "points": POINTS,
        **extra,
    }


def effort(sid: int, eid: int, weather: dict | None) -> dict:
    return {
        "segment_id": sid,
        "effort_id": eid,
        "start_date": f"2026-0{1 + eid % 8}-01T12:00:00Z",
        "elapsed_time_s": 400,
        "moving_time_s": 395,
        "average_watts": 250,
        "device_watts": True,
        "cell_id": "41.00,-73.90",
        "weather": weather,
    }


WEATHER = {
    "wind_speed_ms": 2.0,
    "wind_from_deg": 180.0,
    "temperature_c": 15.0,
    "pressure_hpa": 1013.0,
    "humidity_pct": 60.0,
}


def run(name: str, fn) -> None:
    fn()
    print(f"  ok  {name}")


def test_a_profile_alone_earns_an_entry() -> None:
    # No efforts at all. The profile still ships: it makes gradient vary along
    # the segment instead of being one average, which the backtest scores as
    # the largest single improvement available, and the interface draws the
    # segment's shape from it.
    bundle = build_calibration(
        {"segments": {"1": segment(1, elevation_profile=PROFILE)}, "efforts": []}
    )
    assert "1" in bundle["segments"], bundle["segments"]
    entry = bundle["segments"]["1"]
    assert entry["power_w"] is None, "no efforts means no fitted power"
    assert entry["elevation_profile"]["distance_m"], "the profile must survive"


def test_a_segment_with_neither_is_left_out() -> None:
    bundle = build_calibration({"segments": {"2": segment(2)}, "efforts": []})
    assert "2" not in bundle["segments"], "nothing to say about it"


def test_efforts_without_weather_are_ignored() -> None:
    # Reanalysis trails real time by about a week, so a ride ingested this
    # morning has none yet. Treating it as a calm day would teach the model
    # that this rider is slow in still air.
    payload = {
        "segments": {"3": segment(3, elevation_profile=PROFILE)},
        "efforts": [effort(3, i, None) for i in range(8)],
    }
    bundle = build_calibration(payload)
    assert bundle["segments"]["3"]["power_w"] is None
    assert "rider" not in bundle, "a rider model needs weather to fit against"


def test_enough_weathered_efforts_produce_a_fit() -> None:
    payload = {
        "segments": {"4": segment(4, elevation_profile=PROFILE)},
        "efforts": [effort(4, i, WEATHER) for i in range(8)],
    }
    bundle = build_calibration(payload)
    entry = bundle["segments"]["4"]
    assert entry["power_w"], "eight weathered attempts should fit a power"
    assert 40 < entry["power_w"] < 900, entry["power_w"]


def main() -> None:
    print("Calibration builder")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            run(name[5:].replace("_", " "), fn)
    print("  all passed")


if __name__ == "__main__":
    main()
