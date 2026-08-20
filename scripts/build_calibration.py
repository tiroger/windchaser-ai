#!/usr/bin/env python3
"""Emit the per-segment calibration the web app consumes, from local history.

The work itself lives in cycling_analytics.calibration, because the Strava
worker rebuilds the same artefact unattended as new rides arrive and two
implementations would drift apart silently. This is the operator's entry point:
read the effort history from the working copy, build, write, and report what
came out.

Backtested in scripts/evaluate_calibration.py and scripts/evaluate_rider_model.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))

from cycling_analytics.calibration import (  # noqa: E402
    MIN_ATTEMPTS,
    build_calibration,
)

DATA = REPO / "data" / "training" / "efforts.json"
OUT = REPO / "apps" / "web" / "fixtures" / "calibration.json"


def main() -> None:
    if not DATA.exists():
        sys.exit(f"No effort history at {DATA}. Run scripts/fetch_effort_history.py.")

    bundle = build_calibration(json.loads(DATA.read_text()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle, indent=1))

    entries = bundle["segments"]
    fitted = [v for v in entries.values() if v.get("power_w")]
    print(
        f"Wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size / 1024:.0f} KB)\n"
        f"  {len(fitted)} segments with fitted power, "
        f"{len(entries)} with an elevation profile"
    )

    rider = bundle.get("rider")
    if rider:
        print(
            f"  rider model: CP {rider['cp_w']:.0f} W, "
            f"W' {rider['w_prime_j'] / 1000:.1f} kJ, "
            f"{rider['grade_w']:+.0f} W per unit grade\n"
            f"               mass {rider['mass_kg']:.1f} kg, "
            f"CdA {rider['cda']:.3f}, from {rider['attempt_count']} attempts"
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
                f"{(f'{bm // 60}:{bm % 60:02d}' if bm else '-'):>13}"
                f"{(f'{pr // 60}:{pr % 60:02d}' if pr else '-'):>12}"
            )

    profile_only = [v for v in entries.values() if not v.get("power_w")]
    if profile_only:
        print(
            f"\n  {len(profile_only)} segments below {MIN_ATTEMPTS} attempts, "
            "profile only: "
            + ", ".join(v["name"][:24] for v in profile_only[:6])
        )


if __name__ == "__main__":
    main()
