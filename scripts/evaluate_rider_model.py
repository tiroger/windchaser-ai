#!/usr/bin/env python3
"""Backtest the rider-level model on segments it has never seen.

The per-segment calibration is scored in evaluate_calibration.py by holding out
later efforts on the same segment. That answers "how well does this transfer
through time", which is the right question for the twelve segments that have
enough history to be calibrated at all. It says nothing about the thirty-odd
segments the application shows that have none, and those fall back to fitting
power from a single personal record in still air.

So the split here is by segment, not by effort. Every segment in turn is held
out completely: the model is fitted on efforts from the others and then asked
to predict a segment it has no history for whatsoever. That is exactly the
situation a discovered segment presents, and it is a deliberately harsh test --
the incumbent it is measured against still gets to see the held-out segment's
personal record, which the rider model never does.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))

from cycling_analytics.physics import (  # noqa: E402
    RHO_REFERENCE,
    Rider,
    fit_power_still_air,
    ride_time,
    to_sections,
)
from cycling_analytics.rider import (  # noqa: E402
    fit_physics,
    fit_rider_model,
    mean_grade,
    predict_time,
    rho_of,
)

DATA = REPO / "data" / "training" / "efforts.json"
MIN_ATTEMPTS = 6
ATTEMPT_POWER_FRACTION = 0.85


def label_time(effort: dict) -> float:
    return float(effort.get("moving_time_s") or effort["elapsed_time_s"])


def attempts_only(efforts: list[dict]) -> list[dict]:
    powered = [e for e in efforts if e.get("device_watts") and e.get("average_watts")]
    if len(powered) < MIN_ATTEMPTS:
        return []
    watts = sorted(e["average_watts"] for e in powered)
    reference = watts[int(0.9 * (len(watts) - 1))]
    return [e for e in powered if e["average_watts"] >= ATTEMPT_POWER_FRACTION * reference]


def summarise(label: str, errors: list[float], actuals: list[float]) -> str:
    mae = statistics.fmean(abs(x) for x in errors)
    bias = statistics.fmean(errors)
    rmse = (statistics.fmean(x * x for x in errors)) ** 0.5
    mape = statistics.fmean(abs(e) / a for e, a in zip(errors, actuals)) * 100
    return f"{label:<44} MAE {mae:6.1f}s  MAPE {mape:5.1f}%  bias {bias:+7.1f}s  RMSE {rmse:6.1f}s"


def main() -> None:
    if not DATA.exists():
        sys.exit(f"No training data at {DATA}. Run scripts/fetch_effort_history.py.")
    payload = json.loads(DATA.read_text())
    segments = payload["segments"]

    by_segment: dict[str, list[dict]] = defaultdict(list)
    for e in payload["efforts"]:
        by_segment[str(e["segment_id"])].append(e)

    # Sections and attempts per segment, for those with enough history.
    prepared: dict[str, dict] = {}
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
        prepared[sid] = {"seg": seg, "attempts": attempts, "sections": sections}

    if len(prepared) < 3:
        sys.exit("Not enough segments with history to hold one out.")

    # Power is measured on these efforts, so the curve is fitted on what the
    # rider actually produced rather than on power inferred through the very
    # physics the prediction will use.
    for p in prepared.values():
        # The same distance-weighted gradient the prediction will use, so the
        # curve is fitted against the quantity it is later asked about.
        grade = mean_grade(p["sections"])
        # Ages measured back from the newest attempt on record, so the backtest
        # weights history the same way a fit run today would.
        newest = max(
            datetime.fromisoformat(e["start_date"].replace("Z", "+00:00"))
            for e in p["attempts"]
        ).astimezone(timezone.utc)
        p["samples"] = [
            (
                label_time(e),
                grade,
                float(e["average_watts"]),
                max(
                    (
                        newest
                        - datetime.fromisoformat(
                            e["start_date"].replace("Z", "+00:00")
                        ).astimezone(timezone.utc)
                    ).days
                    / 365.25,
                    0.0,
                ),
            )
            for e in p["attempts"]
        ]
        p["observations"] = [
            (p["sections"], e["weather"], float(e["average_watts"]), label_time(e))
            for e in p["attempts"]
        ]

    rows = []
    err_a, err_pr, err_d, err_s, actuals = [], [], [], [], []

    for held in prepared:
        pool = [s for sid, p in prepared.items() if sid != held for s in p["samples"]]
        seen = [
            o for sid, p in prepared.items() if sid != held for o in p["observations"]
        ]
        model = fit_rider_model(pool)
        physics = fit_physics(seen)
        if model is None or physics is None:
            continue
        base = physics.rider(0.0)

        p = prepared[held]
        seg, sections = p["seg"], p["sections"]

        # Incumbent: power fitted from the record, in still air. Two variants,
        # because what the app has depends on whether calibration reached it.
        best_moving = min(label_time(e) for e in p["attempts"])
        pr_elapsed = seg.get("pr_elapsed_time")
        power_best = fit_power_still_air(sections, best_moving)
        power_pr = fit_power_still_air(sections, float(pr_elapsed)) if pr_elapsed else None

        # What the application can actually do: power is chosen once per
        # segment and cached, with no forecast in hand, so the duration driving
        # the curve is a still-air estimate. Scored separately here rather than
        # assumed equivalent -- W' is small enough that a 10% duration error
        # moves power by about a watt, but that is a claim worth checking.
        still = {"wind_from_deg": 0.0, "wind_speed_ms": 0.0}
        power_still = model.power_at(
            predict_time(sections, model, still, base), mean_grade(sections)
        )

        ea, epr, ed, es, act = [], [], [], [], []
        for e in p["attempts"]:
            actual = label_time(e)
            w = e["weather"]
            rho = rho_of(w)

            ea.append(
                ride_time(sections, Rider(power_best), rho, w["wind_from_deg"], w["wind_speed_ms"])
                - actual
            )
            if power_pr is not None:
                epr.append(
                    ride_time(sections, Rider(power_pr), rho, w["wind_from_deg"], w["wind_speed_ms"])
                    - actual
                )
            ed.append(predict_time(sections, model, w, base) - actual)
            es.append(
                ride_time(
                    sections,
                    physics.rider(power_still),
                    rho,
                    w["wind_from_deg"],
                    w["wind_speed_ms"],
                )
                - actual
            )
            act.append(actual)

        err_a.extend(ea)
        err_d.extend(ed)
        err_s.extend(es)
        err_pr.extend(epr)
        actuals.extend(act)

        rows.append(
            {
                "name": seg["name"][:32],
                "n": len(p["attempts"]),
                "cp": model.cp_w,
                "wp": model.w_prime_j,
                "kg_w": model.grade_w,
                "mass": physics.mass_kg,
                "cda": physics.cda,
                "mae_a": statistics.fmean(abs(x) for x in ea),
                "mae_d": statistics.fmean(abs(x) for x in ed),
                "bias_d": statistics.fmean(ed),
                "mape_d": statistics.fmean(abs(x) / a for x, a in zip(ed, act)) * 100,
            }
        )

    print(f"\nLeave-one-segment-out over {len(rows)} segments, "
          f"{len(actuals)} attempts\n")
    print(f"{'held-out segment':<30}{'n':>4}{'CP':>7}{'W/grade':>10}{'mass':>7}"
          f"{'CdA':>7}{'MAE PR':>9}{'MAE rider':>11}{'MAPE':>7}{'bias':>8}")
    print("-" * 100)
    for r in sorted(rows, key=lambda x: -x["n"]):
        print(
            f"{r['name'][:29]:<30}{r['n']:>4}{r['cp']:>6.0f}W{r['kg_w']:>9.0f}W"
            f"{r['mass']:>6.1f}kg{r['cda']:>7.3f}"
            f"{r['mae_a']:>8.0f}s{r['mae_d']:>10.0f}s{r['mape_d']:>6.1f}%{r['bias_d']:>+7.0f}s"
        )

    print("\n" + "=" * 93)
    print(summarise("incumbent: best moving time, still air", err_a, actuals))
    if err_pr:
        print(summarise("incumbent: Strava PR elapsed, still air", err_pr, actuals[: len(err_pr)]))
    print(summarise("rider model: never saw this segment", err_d, actuals))
    print(summarise("  same, power from still-air duration", err_s, actuals))

    everything = fit_physics(
        [o for p in prepared.values() for o in p["observations"]]
    )
    if everything:
        print(
            f"\nFitted physics over {everything.sample_count} attempts: "
            f"mass {everything.mass_kg:.1f} kg, CdA {everything.cda:.3f} "
            f"(defaults were {Rider().mass_kg:.0f} kg, {Rider().cda:.2f})"
        )

    full = fit_rider_model([s for p in prepared.values() for s in p["samples"]])
    if full:
        print(
            f"\nFitted on everything: CP {full.cp_w:.0f} W, "
            f"W' {full.w_prime_j/1000:.1f} kJ, {full.grade_w:+.0f} W per unit grade, "
            f"over {full.sample_count} attempts"
        )
        print(f"  {'':>16}{'flat':>9}{'at 3%':>9}{'at 6%':>9}")
        for minutes in (2, 5, 10, 20, 40):
            print(
                f"  for {minutes:>2} min:     "
                f"{full.power_at(minutes*60, 0.0):>8.0f}W"
                f"{full.power_at(minutes*60, 0.03):>8.0f}W"
                f"{full.power_at(minutes*60, 0.06):>8.0f}W"
            )


if __name__ == "__main__":
    main()
