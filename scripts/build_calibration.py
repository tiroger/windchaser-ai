#!/usr/bin/env python3
"""Emit the per-segment calibration the web app consumes.

Turns the effort history into two things the interface needs and cannot derive
on its own:

  * sustainable power fitted across many attempts in their real weather, rather
    than inferred from one PR assumed to have happened in still air;
  * a downsampled elevation profile, so gradient varies along the segment
    instead of being a single average.

Backtested in scripts/evaluate_calibration.py: this cuts prediction MAE roughly
in half and removes the optimism bias that pinned probabilities near 100 percent.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))

from cycling_analytics.physics import (  # noqa: E402
    Rider,
    fit_power_from_efforts,
    to_sections,
)
from cycling_analytics.rider import (  # noqa: E402
    fit_physics,
    fit_rider_model,
    mean_grade,
)

DATA = REPO / "data" / "training" / "efforts.json"
OUT = REPO / "apps" / "web" / "fixtures" / "calibration.json"

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


def main() -> None:
    if not DATA.exists():
        sys.exit(f"No effort history at {DATA}. Run scripts/fetch_effort_history.py.")
    payload = json.loads(DATA.read_text())
    segments = payload["segments"]

    by_segment: dict[str, list[dict]] = defaultdict(list)
    for e in payload["efforts"]:
        by_segment[str(e["segment_id"])].append(e)

    # Mass and frontal area first, fitted from the efforts where power was
    # measured. Everything below depends on them: a per-segment power fitted
    # against the wrong constants absorbs their error, which is invisible until
    # the model is asked about a segment it has never seen.
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
            actual = float(e.get("moving_time_s") or e["elapsed_time_s"])
            watts = float(e["average_watts"])
            observations.append((sections, e["weather"], watts, actual))
            curve_samples.append((actual, grade, watts))

    physics = fit_physics(observations)
    rider_curve = fit_rider_model(curve_samples)
    base = physics.rider(0.0) if physics else Rider()

    out: dict[str, dict] = {}
    skipped: list[str] = []

    for sid, efforts in by_segment.items():
        seg = segments.get(sid)
        if not seg:
            continue
        profile = downsample(seg.get("elevation_profile"))
        attempts = attempts_only(efforts)

        # Strava's PR is elapsed time and includes stops. The model predicts
        # moving time, so comparing against elapsed flatters every prediction --
        # badly on urban segments with traffic lights. Use the best moving time
        # as the like-for-like target instead.
        moving = [
            int(e["moving_time_s"]) for e in efforts if e.get("moving_time_s")
        ]
        best_moving = min(moving) if moving else None

        if len(attempts) < MIN_ATTEMPTS:
            # Not enough attempts to fit. Ship the profile anyway: better
            # gradient helps even when power still comes from the PR.
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
            skipped.append(seg["name"])
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

    fitted = [v for v in out.values() if v.get("power_w")]
    bundle = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "power fitted across attempts in reanalysis weather",
        "min_attempts": MIN_ATTEMPTS,
        "segments": out,
    }

    # The rider-level model, which is what every segment without its own fit
    # falls back to. Backtested by holding out whole segments in
    # scripts/evaluate_rider_model.py: MAE 83s against the single-record
    # fallback's 98s, and bias -3s against its -96s.
    if physics and rider_curve:
        bundle["rider"] = {
            "cp_w": round(rider_curve.cp_w, 1),
            "w_prime_j": round(rider_curve.w_prime_j, 0),
            "grade_w": round(rider_curve.grade_w, 1),
            "mass_kg": round(physics.mass_kg, 2),
            "cda": round(physics.cda, 4),
            "attempt_count": rider_curve.sample_count,
        }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle, indent=1))

    print(
        f"Wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size / 1024:.0f} KB)\n"
        f"  {len(fitted)} segments with fitted power, "
        f"{len(out)} with an elevation profile"
    )
    if physics and rider_curve:
        r = bundle["rider"]
        print(
            f"  rider model: CP {r['cp_w']:.0f} W, W' {r['w_prime_j']/1000:.1f} kJ, "
            f"{r['grade_w']:+.0f} W per unit grade\n"
            f"               mass {r['mass_kg']:.1f} kg, CdA {r['cda']:.3f}, "
            f"from {r['attempt_count']} attempts"
        )
    if fitted:
        print(
            f"\n  {'segment':<34}{'fitted W':>9}{'meas':>6}{'best moving':>13}"
            f"{'PR elapsed':>12}"
        )
        for v in sorted(fitted, key=lambda x: -x["attempt_count"]):
            bm = v.get("best_moving_time_s")
            pr = v.get("pr_elapsed_time_s")
            print(
                f"  {v['name'][:33]:<34}{v['power_w']:>9.0f}"
                f"{v['measured_watts_median']:>6.0f}"
                f"{(f'{bm//60}:{bm%60:02d}' if bm else '-'):>13}"
                f"{(f'{pr//60}:{pr%60:02d}' if pr else '-'):>12}"
            )
    if skipped:
        print(f"\n  {len(skipped)} segments below {MIN_ATTEMPTS} attempts, "
              "profile only: " + ", ".join(s[:24] for s in skipped[:6]))


if __name__ == "__main__":
    main()
