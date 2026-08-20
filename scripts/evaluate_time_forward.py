#!/usr/bin/env python3
"""Score the rider model the way the application actually uses it: forwards.

evaluate_rider_model.py holds out whole segments, which answers "can this
transfer to a segment never ridden". It cannot answer whether the model should
weight recent riding more heavily, because it scores predictions against efforts
from every year at once -- a model tuned to present fitness is then penalised
for failing to predict the rider of a decade ago.

This splits on time instead. Fit on everything before a cutoff, predict what
came after, and walk the cutoff forward. That is the question the product asks:
given what I know about you up to today, what will you do tomorrow.

Weighting is the same weighted least squares the production fit uses, so what
this measures is what ships.
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

from cycling_analytics.physics import to_sections  # noqa: E402
from cycling_analytics.rider import (  # noqa: E402
    fit_physics,
    fit_rider_model,
    mean_grade,
    predict_time,
)

DATA = REPO / "data" / "training" / "efforts.json"
MIN_ATTEMPTS = 6
ATTEMPT_POWER_FRACTION = 0.85
# Enough history behind each cutoff for a fit, and enough ahead to score.
CUTOFFS = ("2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01", "2024-01-01")
HALF_LIVES = (None, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5)


def label_time(effort: dict) -> float:
    return float(effort.get("moving_time_s") or effort["elapsed_time_s"])


def when(effort: dict) -> datetime:
    return datetime.fromisoformat(effort["start_date"].replace("Z", "+00:00")).astimezone(
        timezone.utc
    )


def attempts_only(efforts: list[dict]) -> list[dict]:
    powered = [e for e in efforts if e.get("device_watts") and e.get("average_watts")]
    if len(powered) < MIN_ATTEMPTS:
        return []
    watts = sorted(e["average_watts"] for e in powered)
    reference = watts[int(0.9 * (len(watts) - 1))]
    return [e for e in powered if e["average_watts"] >= ATTEMPT_POWER_FRACTION * reference]


def weighted(samples: list[tuple[float, float, float, float]], half_life: float | None):
    """Fit, discounting older attempts by a half-life in years."""
    return fit_rider_model(samples, half_life_years=half_life)


def main() -> None:
    if not DATA.exists():
        sys.exit(f"No training data at {DATA}.")
    payload = json.loads(DATA.read_text())
    segments = payload["segments"]

    by_segment: dict[str, list[dict]] = defaultdict(list)
    for e in payload["efforts"]:
        by_segment[str(e["segment_id"])].append(e)

    prepared = {}
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
        prepared[sid] = {
            "name": seg["name"],
            "sections": sections,
            "grade": mean_grade(sections),
            "attempts": attempts,
        }

    print(f"Rolling-origin split over {len(prepared)} segments\n")
    header = f"{'cutoff':<12}{'train':>7}{'test':>6}" + "".join(
        f"{('no weighting' if h is None else f'half-life {h:g}y'):>18}" for h in HALF_LIVES
    )
    print(header)
    print("-" * len(header))

    totals: dict[object, list[float]] = {h: [] for h in HALF_LIVES}
    totals_actual: dict[object, list[float]] = {h: [] for h in HALF_LIVES}

    for cutoff in CUTOFFS:
        edge = datetime.fromisoformat(cutoff).replace(tzinfo=timezone.utc)
        train_samples: list[tuple[float, float, float, float]] = []
        train_obs = []
        test: list[tuple[str, dict]] = []

        for sid, p in prepared.items():
            for e in p["attempts"]:
                if when(e) < edge:
                    age = (edge - when(e)).days / 365.25
                    train_samples.append(
                        (label_time(e), p["grade"], float(e["average_watts"]), age)
                    )
                    train_obs.append(
                        (p["sections"], e["weather"], float(e["average_watts"]), label_time(e))
                    )
                else:
                    test.append((sid, e))

        if len(train_samples) < 20 or len(test) < 10:
            print(f"{cutoff:<12}{len(train_samples):>7}{len(test):>6}   too thin to score")
            continue

        physics = fit_physics(train_obs)
        if not physics:
            continue
        base = physics.rider(0.0)

        row = f"{cutoff:<12}{len(train_samples):>7}{len(test):>6}"
        for half_life in HALF_LIVES:
            model = weighted(train_samples, half_life)
            if not model:
                row += f"{'-':>18}"
                continue
            errors = []
            actuals = []
            for sid, e in test:
                actual = label_time(e)
                errors.append(
                    predict_time(prepared[sid]["sections"], model, e["weather"], base) - actual
                )
                actuals.append(actual)
            totals[half_life].extend(errors)
            totals_actual[half_life].extend(actuals)
            mae = statistics.fmean(abs(x) for x in errors)
            row += f"{mae:>16.0f}s"
        print(row)

    print("\nPooled across every cutoff:")
    for half_life in HALF_LIVES:
        errors = totals[half_life]
        actuals = totals_actual[half_life]
        if not errors:
            continue
        mae = statistics.fmean(abs(x) for x in errors)
        mape = statistics.fmean(abs(e) / a for e, a in zip(errors, actuals)) * 100
        bias = statistics.fmean(errors)
        label = "no weighting" if half_life is None else f"half-life {half_life:g} years"
        print(f"  {label:<26} MAE {mae:6.1f}s   MAPE {mape:5.1f}%   bias {bias:+7.1f}s")


if __name__ == "__main__":
    main()
