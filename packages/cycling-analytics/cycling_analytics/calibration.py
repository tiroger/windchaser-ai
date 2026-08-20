"""Turn an effort history into the calibration the application consumes.

Shared deliberately. This runs both from scripts/build_calibration.py, where a
person rebuilds calibration from a freshly fetched history, and inside the
Strava worker, which rebuilds it unattended as new rides arrive. Two copies of
this would drift, and the failure would be silent: predictions would simply
start disagreeing with the backtest that justified them.

What comes out has two parts. Per segment, power fitted across that segment's
own attempts in their real weather, plus a downsampled elevation profile so
gradient varies along the segment. Above that, the rider-level model, which is
what every segment without enough history of its own falls back to.
"""

from __future__ import annotations

import statistics
import time
from collections import defaultdict

from .physics import Rider, fit_power_from_efforts, to_sections
from .rider import fit_physics, fit_rider_model, mean_grade

MIN_ATTEMPTS = 5
ATTEMPT_POWER_FRACTION = 0.85
PROFILE_POINTS = 120


def attempts_only(efforts: list[dict]) -> list[dict]:
    """Efforts ridden near this rider's hardest on the segment.

    Selected on power, never on time: choosing by result would bias the fit
    toward fast days and reintroduce the optimism this exists to remove.
    """
    powered = [e for e in efforts if e.get("device_watts") and e.get("average_watts")]
    if len(powered) < MIN_ATTEMPTS:
        return []
    watts = sorted(e["average_watts"] for e in powered)
    reference = watts[int(0.9 * (len(watts) - 1))]
    return [e for e in powered if e["average_watts"] >= ATTEMPT_POWER_FRACTION * reference]


def downsample(profile: dict | None) -> dict | None:
    """Enough elevation points for gradient to vary, few enough to ship."""
    if not profile:
        return None
    dist = profile.get("distance_m") or []
    alt = profile.get("altitude_m") or []
    if len(dist) < 2 or len(dist) != len(alt):
        return None
    if len(dist) <= PROFILE_POINTS:
        return {"distance_m": dist, "altitude_m": alt}
    step = len(dist) / PROFILE_POINTS
    idx = [int(i * step) for i in range(PROFILE_POINTS)]
    idx[-1] = len(dist) - 1
    return {
        "distance_m": [round(dist[i], 1) for i in idx],
        "altitude_m": [round(alt[i], 1) for i in idx],
    }


def _labelled(effort: dict) -> float | None:
    """Moving time, which is what the physics predicts. Elapsed includes stops."""
    value = effort.get("moving_time_s") or effort.get("elapsed_time_s")
    return float(value) if value else None


def build_calibration(payload: dict) -> dict:
    """The calibration bundle, from an effort history in the stored shape.

    Efforts without weather are ignored rather than defaulted. Reanalysis lags
    real time by about a week, so a ride that arrived through the webhook this
    morning has no weather yet; treating it as a calm day would quietly teach
    the model that this rider is slow in still air.
    """
    segments = payload.get("segments") or {}
    by_segment: dict[str, list[dict]] = defaultdict(list)
    for effort in payload.get("efforts") or []:
        if effort.get("weather"):
            by_segment[str(effort["segment_id"])].append(effort)

    # Mass and frontal area first. Everything below depends on them: a
    # per-segment power fitted against the wrong constants absorbs their error,
    # which stays invisible until the model is asked about a segment it has
    # never seen.
    observations = []
    curve_samples = []
    for sid, efforts in by_segment.items():
        seg = segments.get(sid)
        if not seg:
            continue
        attempts = attempts_only(efforts)
        if len(attempts) < MIN_ATTEMPTS:
            continue
        sections = to_sections(
            seg["points"], seg["average_grade"], seg.get("elevation_profile")
        )
        if not sections:
            continue
        grade = mean_grade(sections)
        for e in attempts:
            actual = _labelled(e)
            if not actual:
                continue
            watts = float(e["average_watts"])
            observations.append((sections, e["weather"], watts, actual))
            curve_samples.append((actual, grade, watts))

    physics = fit_physics(observations)
    rider_curve = fit_rider_model(curve_samples)
    base = physics.rider(0.0) if physics else Rider()

    out: dict[str, dict] = {}
    for sid, efforts in by_segment.items():
        seg = segments.get(sid)
        if not seg:
            continue
        profile = downsample(seg.get("elevation_profile"))
        attempts = attempts_only(efforts)

        # Strava's record is elapsed time and includes stops. The model predicts
        # moving time, so comparing against elapsed flatters every prediction,
        # badly on urban segments with traffic lights.
        moving = [int(e["moving_time_s"]) for e in efforts if e.get("moving_time_s")]
        best_moving = min(moving) if moving else None

        if len(attempts) < MIN_ATTEMPTS:
            # Ship the profile anyway: better gradient helps even when power
            # comes from the rider model rather than this segment.
            if profile:
                out[sid] = {
                    "segment_id": int(sid),
                    "name": seg["name"],
                    "power_w": None,
                    "attempt_count": len(attempts),
                    "best_moving_time_s": best_moving,
                    "pr_elapsed_time_s": seg.get("pr_elapsed_time"),
                    "elevation_profile": profile,
                }
            continue

        sections = to_sections(
            seg["points"], seg["average_grade"], seg.get("elevation_profile")
        )
        if not sections:
            continue
        power = fit_power_from_efforts(sections, attempts, base)
        measured = [e["average_watts"] for e in attempts]

        out[sid] = {
            "segment_id": int(sid),
            "name": seg["name"],
            "power_w": round(power, 1),
            "attempt_count": len(attempts),
            "best_moving_time_s": best_moving,
            "pr_elapsed_time_s": seg.get("pr_elapsed_time"),
            "measured_watts_median": round(statistics.median(measured), 1),
            "fastest_attempt_s": min(
                int(e.get("moving_time_s") or e["elapsed_time_s"]) for e in attempts
            ),
            "first_attempt": min(e["start_date"] for e in attempts),
            "last_attempt": max(e["start_date"] for e in attempts),
            "elevation_profile": profile,
        }

    bundle = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "power fitted across attempts in reanalysis weather",
        "min_attempts": MIN_ATTEMPTS,
        "segments": out,
    }

    # What every segment without its own fit falls back to. Backtested by
    # holding out whole segments in scripts/evaluate_rider_model.py: 83s MAE
    # against the single-record fallback's 98s, and -3s bias against its -96s.
    if physics and rider_curve:
        bundle["rider"] = {
            "cp_w": round(rider_curve.cp_w, 1),
            "w_prime_j": round(rider_curve.w_prime_j, 0),
            "grade_w": round(rider_curve.grade_w, 1),
            # The gradient term describes this rider on the gradients they have
            # ridden. Beyond that range it is an extrapolation of behaviour, so
            # it is clamped rather than continued.
            "grade_min": round(rider_curve.grade_min, 5),
            "grade_max": round(rider_curve.grade_max, 5),
            "mass_kg": round(physics.mass_kg, 2),
            "cda": round(physics.cda, 4),
            "attempt_count": rider_curve.sample_count,
        }
    return bundle
