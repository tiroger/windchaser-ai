#!/usr/bin/env python3
"""Backtest calibration strategies against recorded efforts.

Answers one question with data rather than argument: does fitting power from a
single PR, assuming still air, bias the model optimistic, and does fitting from
many efforts in their real weather fix it?

Three models, evaluated on the same held-out efforts:

  A  single PR, still air, average grade      (what the app shipped)
  B  multi-effort fit, real weather, average grade
  C  multi-effort fit, real weather, real elevation profile

Splits are time-aware, per section 13: the model only ever sees efforts that
happened before the ones it is scored on, because fitness trends over a season.

Two data decisions matter more than the model choice:

  * The label is moving time, not elapsed time. Elapsed includes traffic lights.
    One Central Park "effort" ran 18,895 seconds against a 1,148 second best.

  * Only genuine attempts count. Most recorded efforts are casual rides, and
    fitting their mean produces casual-pace power that cannot answer "what will
    I do if I attack this". Attempts are selected on power, never on time --
    selecting on the outcome would bias the model toward fast results.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "packages" / "cycling-analytics"))

from cycling_analytics.physics import (  # noqa: E402
    RHO_REFERENCE,
    Rider,
    air_density,
    effective_tailwind,
    fit_power_from_efforts,
    fit_power_still_air,
    ride_time,
    to_sections,
)

DATA = REPO / "data" / "training" / "efforts.json"
TRAIN_FRACTION = 0.7
MIN_TEST = 3
MIN_ATTEMPTS = 6
# An attempt is an effort ridden near the hardest this rider has ridden the
# segment. Chosen on power so the selection is independent of elapsed time.
ATTEMPT_POWER_FRACTION = 0.85


def label_time(effort: dict) -> float:
    """Moving time is what the physics predicts; elapsed includes stops."""
    return float(effort.get("moving_time_s") or effort["elapsed_time_s"])


def attempts_only(efforts: list[dict]) -> list[dict]:
    powered = [
        e for e in efforts if e.get("device_watts") and e.get("average_watts")
    ]
    if len(powered) < MIN_ATTEMPTS:
        return []
    watts = sorted(e["average_watts"] for e in powered)
    reference = watts[int(0.9 * (len(watts) - 1))]
    threshold = ATTEMPT_POWER_FRACTION * reference
    return [e for e in powered if e["average_watts"] >= threshold]


def predict(sections, power: float, weather: dict) -> float:
    rho = air_density(
        weather.get("temperature_c") or 15.0,
        weather.get("pressure_hpa") or 1013.0,
        weather.get("humidity_pct") or 60.0,
    )
    return ride_time(
        sections,
        Rider(power_w=power),
        rho,
        weather["wind_from_deg"],
        weather["wind_speed_ms"],
    )


def main() -> None:
    if not DATA.exists():
        sys.exit(f"No training data at {DATA}. Run scripts/fetch_effort_history.py.")
    payload = json.loads(DATA.read_text())
    segments = payload["segments"]

    by_segment: dict[str, list[dict]] = defaultdict(list)
    for e in payload["efforts"]:
        by_segment[str(e["segment_id"])].append(e)

    rows = []
    all_err = {"A": [], "B": [], "C": [], "D": []}
    measured_pairs = []

    for sid, efforts in sorted(by_segment.items(), key=lambda kv: -len(kv[1])):
        seg = segments.get(sid)
        if not seg:
            continue
        efforts = attempts_only(efforts)
        if len(efforts) < MIN_ATTEMPTS:
            continue
        efforts.sort(key=lambda e: e["start_date"])

        cut = int(len(efforts) * TRAIN_FRACTION)
        train, test = efforts[:cut], efforts[cut:]
        if len(test) < MIN_TEST:
            continue

        flat = to_sections(seg["points"], seg["average_grade"], None)
        profiled = to_sections(
            seg["points"], seg["average_grade"], seg.get("elevation_profile")
        )
        if not flat:
            continue

        # A: what the app does today. Best time in the training window, still air.
        best_train = min(label_time(e) for e in train)
        power_a = fit_power_still_air(flat, best_train)

        # B and C: fit across the training efforts in their real weather.
        power_b = fit_power_from_efforts(flat, train)
        power_c = fit_power_from_efforts(profiled, train)
        # D: same as C, discounting older attempts. The split here is already
        # time-ordered, so this measures what it claims to.
        power_d = fit_power_from_efforts(profiled, train, half_life_years=2.0)

        err = {"A": [], "B": [], "C": [], "D": []}
        for e in test:
            actual = label_time(e)
            err["A"].append(predict(flat, power_a, e["weather"]) - actual)
            err["B"].append(predict(flat, power_b, e["weather"]) - actual)
            err["C"].append(predict(profiled, power_c, e["weather"]) - actual)
            err["D"].append(predict(profiled, power_d, e["weather"]) - actual)

        for k in err:
            all_err[k].extend(err[k])

        watts = [
            e["average_watts"]
            for e in train
            if e.get("average_watts") and e.get("device_watts")
        ]
        measured = statistics.median(watts) if watts else None
        if measured:
            measured_pairs.append((power_a, power_c, measured))

        rows.append(
            {
                "name": seg["name"][:34],
                "n": len(efforts),
                "power_a": power_a,
                "power_b": power_b,
                "power_c": power_c,
                "measured": measured,
                "mae_a": statistics.fmean(abs(x) for x in err["A"]),
                "mae_b": statistics.fmean(abs(x) for x in err["B"]),
                "mae_c": statistics.fmean(abs(x) for x in err["C"]),
                "bias_a": statistics.fmean(err["A"]),
                "bias_c": statistics.fmean(err["C"]),
            }
        )

    if not rows:
        sys.exit("Not enough efforts per segment to backtest.")

    print(f"Backtest on {len(rows)} segments, "
          f"{len(all_err['A'])} held-out efforts, {int(TRAIN_FRACTION*100)}/"
          f"{100-int(TRAIN_FRACTION*100)} time-ordered split\n")

    print(f"{'segment':<34}{'n':>4}{'fitted W (A/B/C)':>22}{'meas':>7}"
          f"{'MAE A':>8}{'MAE B':>8}{'MAE C':>8}")
    print("-" * 91)
    for r in rows:
        meas = f"{r['measured']:.0f}" if r["measured"] else "  -"
        print(
            f"{r['name']:<34}{r['n']:>4}"
            f"{r['power_a']:>7.0f}/{r['power_b']:>6.0f}/{r['power_c']:>6.0f}"
            f"{meas:>7}"
            f"{r['mae_a']:>7.0f}s{r['mae_b']:>7.0f}s{r['mae_c']:>7.0f}s"
        )

    print("\n" + "=" * 91)
    for key, label in [
        ("A", "A  single PR, still air, average grade"),
        ("B", "B  multi-effort fit, real weather, average grade"),
        ("C", "C  multi-effort fit, real weather, real elevation"),
        ("D", "D  same, discounting attempts older than two years"),
    ]:
        e = all_err[key]
        mae = statistics.fmean(abs(x) for x in e)
        bias = statistics.fmean(e)
        rmse = (statistics.fmean(x * x for x in e)) ** 0.5
        print(f"{label:<52} MAE {mae:6.1f}s   bias {bias:+7.1f}s   RMSE {rmse:6.1f}s")

    if measured_pairs:
        over_a = statistics.fmean(a - m for a, _, m in measured_pairs)
        over_c = statistics.fmean(c - m for _, c, m in measured_pairs)
        print(
            f"\nFitted power vs power-meter median, across "
            f"{len(measured_pairs)} segments with device watts:"
        )
        print(f"  A overestimates by {over_a:+.0f} W")
        print(f"  C overestimates by {over_c:+.0f} W")

    # Does the surviving error correlate with wind? If it does, a learned
    # residual has something real to learn. If not, the physics already has it.
    resid = []
    for sid, efforts in by_segment.items():
        seg = segments.get(sid)
        if not seg:
            continue
        profiled = to_sections(
            seg["points"], seg["average_grade"], seg.get("elevation_profile")
        )
        if not profiled:
            continue
        efforts = attempts_only(efforts)
        if len(efforts) < MIN_ATTEMPTS:
            continue
        efforts.sort(key=lambda e: e["start_date"])
        cut = int(len(efforts) * TRAIN_FRACTION)
        power = fit_power_from_efforts(profiled, efforts[:cut])
        for e in efforts[cut:]:
            w = e["weather"]
            resid.append(
                (
                    effective_tailwind(profiled, w["wind_from_deg"], w["wind_speed_ms"]),
                    (predict(profiled, power, w) - label_time(e)) / label_time(e),
                )
            )
    if len(resid) > 10:
        xs = [x for x, _ in resid]
        ys = [y for _, y in resid]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        num = sum((x - mx) * (y - my) for x, y in resid)
        den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
        r = num / den if den else 0.0
        print(
            f"\nResidual vs effective tailwind: r = {r:+.3f} over {len(resid)} efforts"
        )
        print(
            "  Near zero means the wind term is already doing its job and a learned\n"
            "  model should target something else (fitness drift, pacing, surface)."
        )


if __name__ == "__main__":
    main()
