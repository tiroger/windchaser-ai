"""Garmin-style exercise load and a VO2max signal from detailed streams.

Garmin's per-activity "training load" is Firstbeat's peak EPOC estimate: excess
post-exercise oxygen consumption, in ml/kg, built up from heart rate during the
activity. This module reproduces it with a small accumulate-and-decay model
fitted to the rider's own Garmin numbers, so activities Garmin never saw get a
load on the same scale.

Model (form "F2" of the ones tried, the simplest that matched the best):

    x(t)    = clamp((HR - HR_rest) / (HR_max - HR_rest), 0, X_MAX)   # %HR reserve
    dE/dt   = A * x^P  -  E / TAU                                    # per minute
    load    = max over the activity of E(t)

Heart rate is averaged into STEP_SECONDS cells; a cell inside a recording gap
longer than the fill limit is a pause and counts as rest (x = 0), so EPOC
decays through a cafe stop as it would on the watch.

How the numbers were fitted: 379 rides, Zwift rides and pickleball sessions
from 2024 onwards with Garmin FIT files (1 Hz heart rate) and Garmin's
`activityTrainingLoad` as the target; scipy least_squares, soft-L1 loss on
residuals scaled by 1/sqrt(load + 20), trained on the oldest 80% and validated
on the newest 20% (76 activities): MAE 13.5, MAPE 27%, R^2 0.91, bias -1.2.
A plain TRIMP sum scored MAE 19.4; adding an activation threshold, a separate
pickleball scale, intensity-dependent decay, or Garmin's own per-activity
heart-rate anchors did not improve the hold-out. The fitting scripts and the data
stay outside the repository because the data is personal. The web app's
TypeScript side mirrors the parameters it needs in lib/training/metrics/load-params.ts.
"""

from __future__ import annotations

import math
from statistics import median
from typing import Any

MODEL_VERSION = "epoc-f2-1"

# ------------------------------------------------------------ parameters --

PARAMS: dict[str, float] = {
    "A": 7.1175,
    "P": 3.1294,
    "TAU": 229.63,
    "X_MAX": 1.15,
}

# Fallback heart-rate anchors. The worker uses athlete settings where set and
# otherwise the 99th percentile of activity maxima, like the web app. The fit
# used the rider's measured anchors, which stay out of this public repository;
# setting them in athlete settings reproduces it exactly.
DEFAULT_REST_HR = 49.0
DEFAULT_MAX_HR = 190.0

STEP_SECONDS = 5.0
MIN_FILL_SECONDS = 10.0
VALID_HR = (35.0, 230.0)

# VO2max from steady riding. Heart rate rises about SLOPE bpm per watt within a
# ride (0.347: the pooled within-ride slope of steady stretches across 131 rides
# since 2024), so each steady stretch extrapolates to the power that would bring
# heart rate to its maximum.
VO2_PARAMS: dict[str, float] = {
    "WINDOW_SECONDS": 240,
    "STEP_SECONDS": 30,
    "LAG_SECONDS": 60,
    "MAX_POWER_CV": 0.12,
    "MIN_WATTS": 80,
    "MIN_RESERVE": 0.55,
    "MAX_RESERVE": 0.90,
    "MAX_HR_SPREAD": 20,
    "SLOPE": 0.347,
    "MIN_SEGMENTS": 2,
}


# ------------------------------------------------------------- EPOC load --


def _heart_rate_cells(time: list[Any], heartrate: list[Any]) -> list[float | None]:
    """Mean heart rate per STEP_SECONDS cell; None where the recording paused."""
    points = sorted(
        (float(moment), float(value))
        for moment, value in zip(time, heartrate)
        if moment is not None and value is not None and VALID_HR[0] <= value <= VALID_HR[1]
    )
    if len(points) < 30:
        return []
    start = points[0][0]
    offsets = [moment - start for moment, _ in points]
    gaps = sorted(later - earlier for earlier, later in zip(offsets, offsets[1:]) if later > earlier)
    # Downsampled samples are several seconds apart; a gap is a pause only when
    # it is clearly longer than the usual spacing.
    fill = max(MIN_FILL_SECONDS, 1.5 * gaps[len(gaps) // 2]) if gaps else MIN_FILL_SECONDS
    count = int(offsets[-1] // STEP_SECONDS) + 1
    sums = [0.0] * count
    counts = [0] * count
    for offset, (_, value) in zip(offsets, points):
        cell = min(int(offset // STEP_SECONDS), count - 1)
        sums[cell] += value
        counts[cell] += 1
    cells: list[float | None] = []
    last_value: float | None = None
    last_offset = -math.inf
    cursor = 0
    for cell in range(count):
        cell_start = cell * STEP_SECONDS
        while cursor < len(offsets) and offsets[cursor] < cell_start:
            last_offset = offsets[cursor]
            cursor += 1
        if counts[cell]:
            last_value = sums[cell] / counts[cell]
            cells.append(last_value)
        elif cell_start - last_offset <= fill:
            cells.append(last_value)
        else:
            cells.append(None)
    return cells


def epoc_load(
    time: list[Any],
    heartrate: list[Any],
    rest_hr: float = DEFAULT_REST_HR,
    max_hr: float = DEFAULT_MAX_HR,
) -> float | None:
    """Peak modelled EPOC (Garmin-scale training load), or None without heart rate."""
    if not time or not heartrate or max_hr <= rest_hr:
        return None
    cells = _heart_rate_cells(time, heartrate)
    if sum(cell is not None for cell in cells) < 12:
        return None
    a, p, tau, x_max = PARAMS["A"], PARAMS["P"], PARAMS["TAU"], PARAMS["X_MAX"]
    minutes = STEP_SECONDS / 60.0
    reserve = max_hr - rest_hr
    epoc = 0.0
    peak = 0.0
    for value in cells:
        x = 0.0 if value is None else min(max((value - rest_hr) / reserve, 0.0), x_max)
        if x > 0:
            epoc += a * x ** p * minutes
        epoc -= epoc * minutes / tau
        peak = max(peak, epoc)
    return round(peak, 1)


# ---------------------------------------------------------------- VO2max --


def _one_hz(time: list[Any], *channels: list[Any]) -> list[list[float | None]]:
    """1 Hz series with gaps up to five seconds filled and pauses kept as None breaks."""
    series: list[list[float | None]] = [[] for _ in channels]
    previous = None
    for index, moment in enumerate(time):
        if moment is None:
            continue
        if previous is not None:
            gap = int(round(moment - previous))
            if gap <= 0:
                continue
            for channel in series:
                channel.extend([channel[-1]] * (gap - 1) if gap <= 5 else [None])
        for channel, data in zip(series, channels):
            value = data[index] if index < len(data) else None
            channel.append(None if value is None else float(value))
        previous = moment
    return series


def vo2_power(
    time: list[Any],
    watts: list[Any],
    heartrate: list[Any],
    rest_hr: float = DEFAULT_REST_HR,
    max_hr: float = DEFAULT_MAX_HR,
) -> dict[str, float | int] | None:
    """
    Power at maximum heart rate, extrapolated from steady stretches.

    Each stretch of WINDOW_SECONDS with steady power (30 s smoothed, coefficient
    of variation under MAX_POWER_CV) and heart rate between MIN_RESERVE and
    MAX_RESERVE of reserve gives power + (max_hr - heart rate) / SLOPE, with
    heart rate taken LAG_SECONDS later to let it settle. The ride's value is the
    median over at least MIN_SEGMENTS stretches. The web app turns it into
    ml/kg/min with the ACSM cycling equation and the rider's weight.
    """
    if not time or not watts or not heartrate or max_hr <= rest_hr:
        return None
    power, heart = _one_hz(time, watts, heartrate)
    v = VO2_PARAMS
    window, step, lag = int(v["WINDOW_SECONDS"]), int(v["STEP_SECONDS"]), int(v["LAG_SECONDS"])
    reserve = max_hr - rest_hr
    estimates: list[float] = []
    start = 0
    while start + window + lag <= len(power):
        p = power[start:start + window]
        h = heart[start + lag:start + window + lag]
        if all(value is not None for value in p) and all(value is not None for value in h):
            mean_power = sum(p) / window
            smooth = [sum(p[i:i + 30]) / 30 for i in range(window - 29)]
            smooth_mean = sum(smooth) / len(smooth)
            spread = (sum((value - smooth_mean) ** 2 for value in smooth) / len(smooth)) ** 0.5
            coasting = sum(value < 10 for value in p) / window
            mean_hr = sum(h) / window
            x = (mean_hr - rest_hr) / reserve
            if (
                mean_power > v["MIN_WATTS"]
                and smooth_mean > 0
                and spread / smooth_mean < v["MAX_POWER_CV"]
                and coasting < 0.05
                and v["MIN_RESERVE"] <= x <= v["MAX_RESERVE"]
                and max(h) - min(h) < v["MAX_HR_SPREAD"]
            ):
                estimates.append(mean_power + (max_hr - mean_hr) / v["SLOPE"])
                start += window
                continue
        start += step
    if len(estimates) < v["MIN_SEGMENTS"]:
        return None
    return {"watts": round(median(estimates), 1), "segments": len(estimates)}


def analyse(streams: dict[str, list[Any]], rest_hr: float, max_hr: float) -> dict[str, Any]:
    """The index fields this module contributes for one activity."""
    time = streams.get("time") or []
    heartrate = streams.get("heartrate") or []
    watts = streams.get("watts") or []
    return {
        "exercise_load": epoc_load(time, heartrate, rest_hr, max_hr),
        "exercise_load_model": MODEL_VERSION,
        "vo2_power": vo2_power(time, watts, heartrate, rest_hr, max_hr),
        # Marks an entry analysed at full resolution. Entries scored from the
        # stored, downsampled samples lack it and can never carry VO2max.
        "vo2_checked": True,
    }
