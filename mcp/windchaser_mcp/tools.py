"""The questions this model can answer, and the answers it gives.

Every number returned comes from the same engine the web application runs and
the same calibration the worker rebuilds. Nothing here re-implements physics,
because a second implementation is a second set of answers.

Answers are prose, not JSON. The caller is a language model that will read them
aloud, and a table it can quote from is more useful than a structure it has to
describe. Where a number carries a caveat -- a segment with no fitted power, a
gradient beyond what the rider model was fitted on -- the caveat is in the text
rather than left for the reader to infer.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "packages" / "cycling-analytics"))

from cycling_analytics.physics import (  # noqa: E402
    Rider,
    air_density,
    angle_delta,
    effective_tailwind,
    ride_time,
    section_speed,
    to_sections,
    wind_at_rider_height,
)
from cycling_analytics.rider import RiderModel, mean_grade  # noqa: E402

from . import data  # noqa: E402

# Matches lib/physics.ts: uncertainty is the only channel through which
# confidence reaches the score, and this is its floor.
MODEL_SIGMA_S = 12.0


def _rider_model(seg: dict) -> RiderModel | None:
    raw = seg.get("rider_model")
    if not raw:
        return None
    return RiderModel(
        cp_w=raw["cp_w"],
        w_prime_j=raw["w_prime_j"],
        grade_w=raw["grade_w"],
        sample_count=raw.get("attempt_count", 0),
        grade_min=raw.get("grade_min", 0.0),
        grade_max=raw.get("grade_max", 0.0),
    )


def _sections(seg: dict):
    return to_sections(
        seg["points"], seg.get("average_grade") or 0.0, seg.get("elevation_profile")
    )


def _base_rider(seg: dict) -> Rider:
    """Mass and frontal area as fitted, not as assumed.

    These live beside the curve in the calibration rather than on the curve
    itself: RiderModel describes what this rider can hold, RiderPhysics what
    they and the bike weigh and push through the air. Getting them from the
    fitted values rather than the defaults is the difference between predicting
    a flat segment right and predicting it fifteen percent slow.
    """
    raw = seg.get("rider_model") or {}
    default = Rider()
    return Rider(
        default.power_w,
        float(raw.get("mass_kg") or default.mass_kg),
        float(raw.get("cda") or default.cda),
        default.crr,
        default.drivetrain_efficiency,
    )


def _power(seg: dict, sections) -> tuple[float, str]:
    """Power and where it came from, mirroring calibratedPower in the web app."""
    fitted = seg.get("calibrated_power_w")
    if fitted:
        return float(fitted), f"fitted across {seg.get('attempt_count') or 0} of your attempts"

    model = _rider_model(seg)
    base = _base_rider(seg)
    if model:
        grade = mean_grade(sections)
        clamped = min(max(grade, model.grade_min), model.grade_max)
        estimate = ride_time(
            sections, Rider(model.power_at(3600.0, clamped), base.mass_kg, base.cda,
                            base.crr, base.drivetrain_efficiency), 1.225, 0.0, 0.0)
        for _ in range(12):
            nxt = ride_time(
                sections,
                Rider(model.power_at(estimate, clamped), base.mass_kg, base.cda,
                      base.crr, base.drivetrain_efficiency),
                1.225, 0.0, 0.0)
            if abs(nxt - estimate) < 0.25:
                estimate = nxt
                break
            estimate = nxt
        note = "from your rider model (no attempt history on this segment)"
        if grade > model.grade_max + 1e-9:
            note += (
                f"; its {grade * 100:.1f}% gradient is steeper than anything the model "
                f"was fitted on ({model.grade_max * 100:.1f}%), so the gradient term is clamped"
            )
        return model.power_at(estimate, clamped), note
    return base.power_w, "a generic rider — no calibration at all"


def _target(seg: dict) -> tuple[float | None, str]:
    best = seg.get("best_moving_time_s")
    if best:
        return float(best), "your best moving time"
    pr = seg.get("pr_elapsed_time")
    if pr:
        return float(pr), "your Strava record (elapsed, so it may include stops)"
    return None, "no record on file"


def _evaluate(seg: dict, cell: dict, index: int) -> dict:
    sections = _sections(seg)
    if not sections:
        raise ValueError(f"{seg.get('name')} has no usable geometry")
    weather = data.weather_at(cell, index)
    power, source = _power(seg, sections)
    base = _base_rider(seg)
    rider = Rider(power, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
    rho = air_density(weather["temperature_c"], weather["pressure_hpa"], weather["humidity_pct"])

    predicted = ride_time(sections, rider, rho, weather["wind_from_deg"], weather["wind_speed_ms"])
    still = ride_time(sections, rider, rho, 0.0, 0.0)
    target, target_source = _target(seg)

    # Gust headroom stands in for forecast spread, as in the web application.
    spread = max(0.0, weather["gust_ms"] - weather["wind_speed_ms"])
    sigma = MODEL_SIGMA_S + spread * 4.0
    chance = None
    if target:
        chance = data.normal_cdf((target - predicted) / sigma)

    return {
        "segment": seg,
        "when": (cell.get("time") or [])[index] if index < len(cell.get("time") or []) else "",
        "predicted_s": predicted,
        "still_air_s": still,
        "power_w": power,
        "power_source": source,
        "target_s": target,
        "target_source": target_source,
        "chance": chance,
        "weather": weather,
        "tailwind_ms": effective_tailwind(sections, weather["wind_from_deg"], weather["wind_speed_ms"]),
        "sections": sections,
    }


def _hour_index(cell: dict, when: str | None) -> int:
    times = cell.get("time") or []
    if not times:
        raise ValueError("the forecast returned no hours")
    if not when:
        now = datetime.now().strftime("%Y-%m-%dT%H:00")
        for i, stamp in enumerate(times):
            if stamp >= now:
                return i
        return 0
    for i, stamp in enumerate(times):
        if stamp.startswith(when):
            return i
    raise ValueError(
        f"no forecast hour matching {when!r}; the forecast covers "
        f"{times[0]} to {times[-1]} in local time"
    )


def _weekday(stamp: str) -> str:
    """Weekday and hour. An hour alone does not say which of seven days it is."""
    try:
        return datetime.fromisoformat(stamp).strftime("%a %H:%M")
    except ValueError:
        return stamp[-5:]


def _caveat(result: dict) -> str:
    """A short mark for an answer resting on thin evidence.

    Without this the table reads as though every row is equally well founded. A
    hundred percent chance against a five-year-old record set on two attempts,
    with power from the rider model rather than the segment, deserves to look
    different from the same number on a segment with forty-five attempts behind
    it.
    """
    marks = []
    if not result["segment"].get("calibrated_power_w"):
        marks.append("~")
    if not result["segment"].get("best_moving_time_s") and result["target_s"]:
        marks.append("!")
    return "".join(marks)


def _one_line(result: dict) -> str:
    seg = result["segment"]
    target = result["target_s"]
    against = data.delta(result["predicted_s"] - target) if target else "—"
    chance = "—" if result["chance"] is None else f"{result['chance'] * 100:.0f}%"
    w = result["weather"]
    return (
        f"{seg['name'][:28]:<29}{_caveat(result):<3}"
        f"{_weekday(result['when']):>10}"
        f"{data.duration(result['predicted_s']):>10}"
        f"{against:>10}{chance:>8}"
        f"{w['wind_speed_ms']:>6.1f} {data.compass(w['wind_from_deg']):<4}"
        f"{result['tailwind_ms']:>+6.1f}"
    )


HEADER = (
    f"{'segment':<29}{'':<3}{'when':>10}{'predicted':>10}{'vs best':>10}"
    f"{'chance':>8}{'wind':>11}{'tail':>6}"
)

FOOTNOTE = (
    "\n~ power from the rider model, not this segment's own attempts"
    "\n! compared against a Strava elapsed record, which may be old or include stops"
)


def _with_footnote(lines: list[str], results: list[dict]) -> str:
    marks = {mark for r in results for mark in _caveat(r)}
    text = "\n".join(lines)
    if not marks:
        return text
    notes = [line for line in FOOTNOTE.split("\n") if line and line[0] in marks]
    return text + "\n" + "\n".join(notes)


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------

def list_segments(calibrated_only: bool = False, search: str | None = None) -> str:
    known = list(data.segments().values())
    if search:
        known = data.find(search)
    if calibrated_only:
        known = [s for s in known if s.get("calibrated_power_w")]
    if not known:
        return "No segments match."

    known.sort(key=lambda s: (-(s.get("calibrated_power_w") or 0), s.get("name") or ""))
    lines = [
        f"{len(known)} segments"
        + (f" matching {search!r}" if search else "")
        + (" with their own fitted power" if calibrated_only else ""),
        "",
        f"{'segment':<34}{'km':>6}{'grade':>7}{'record':>9}{'power':>8}  basis",
    ]
    for seg in known:
        target, _ = _target(seg)
        power = seg.get("calibrated_power_w")
        basis = (
            f"{seg.get('attempt_count') or 0} attempts"
            if power else "rider model"
        )
        lines.append(
            f"{(seg.get('name') or '?')[:33]:<34}"
            f"{(seg.get('distance_m') or 0) / 1000:>6.1f}"
            f"{seg.get('average_grade') or 0:>6.1f}%"
            f"{(data.duration(target) if target else '—'):>9}"
            f"{(f'{power:.0f}W' if power else '—'):>8}  {basis}"
        )
    return "\n".join(lines)


def predict_segment_time(segment: str, when: str | None = None) -> str:
    matches = data.find(segment)
    if not matches:
        return f"No segment matching {segment!r}. Try list_segments to see what is known."
    seg = matches[0]
    cell = data.forecast_for(seg)
    index = _hour_index(cell, when)
    result = _evaluate(seg, cell, index)

    w = result["weather"]
    target = result["target_s"]
    lines = [
        f"{seg['name']} — {(seg.get('distance_m') or 0) / 1000:.2f} km at "
        f"{seg.get('average_grade') or 0:.1f}% average",
        f"at {result['when']} ({cell.get('timezone')})",
        "",
        f"  predicted      {data.duration(result['predicted_s'])}",
        f"  still air      {data.duration(result['still_air_s'])}   "
        f"(wind is worth {data.delta(result['predicted_s'] - result['still_air_s'])})",
        f"  power          {result['power_w']:.0f} W, {result['power_source']}",
    ]
    if target:
        lines.append(
            f"  your record    {data.duration(target)} — {result['target_source']}"
        )
        lines.append(
            f"  difference     {data.delta(result['predicted_s'] - target)}"
            + (f", about a {result['chance'] * 100:.0f}% chance of beating it"
               if result["chance"] is not None else "")
        )
    else:
        lines.append(f"  your record    {result['target_source']}")
    lines += [
        "",
        f"  wind           {w['wind_speed_ms']:.1f} m/s from {data.compass(w['wind_from_deg'])}, "
        f"gusting {w['gust_ms']:.1f}",
        f"  along the road {result['tailwind_ms']:+.1f} m/s net "
        + ("tailwind" if result["tailwind_ms"] >= 0 else "headwind"),
        f"  conditions     {w['temperature_c']:.0f}°C, {w['precip_prob']:.0f}% chance of rain",
    ]
    return "\n".join(lines)


def find_best_window(segment: str, hours_ahead: int = 168) -> str:
    matches = data.find(segment)
    if not matches:
        return f"No segment matching {segment!r}."
    seg = matches[0]
    cell = data.forecast_for(seg)
    start = _hour_index(cell, None)
    horizon = min(len(cell.get("time") or []), start + max(1, hours_ahead))

    scored = []
    for index in range(start, horizon):
        try:
            scored.append(_evaluate(seg, cell, index))
        except ValueError:
            continue
    if not scored:
        return f"No forecast hours available for {seg['name']}."

    scored.sort(key=lambda r: r["predicted_s"])
    best = scored[0]
    worst = scored[-1]
    lines = [
        f"{seg['name']} over the next {horizon - start} hours ({cell.get('timezone')})",
        "",
        HEADER,
    ]
    lines += [_one_line(r) for r in scored[:8]]
    lines += [
        "",
        f"Best is {_weekday(best['when'])} at {data.duration(best['predicted_s'])}; "
        f"worst is {_weekday(worst['when'])} at {data.duration(worst['predicted_s'])}. "
        f"Wind is worth {data.delta(worst['predicted_s'] - best['predicted_s'])} "
        "between them.",
    ]
    return _with_footnote(lines, scored[:8])


def compare_segments(segments: list[str], when: str | None = None) -> str:
    results = []
    misses = []
    for query in segments:
        matches = data.find(query)
        if not matches:
            misses.append(query)
            continue
        seg = matches[0]
        cell = data.forecast_for(seg)
        try:
            index = _hour_index(cell, when)
            results.append(_evaluate(seg, cell, index))
        except ValueError as exc:
            misses.append(f"{query} ({exc})")

    if not results:
        return "Nothing to compare: " + ", ".join(misses)

    # Ranked by chance where there is a record to beat, then by how much the
    # wind helps. A segment with no record cannot be ranked on probability, and
    # pretending otherwise would put it arbitrarily among ones that can.
    results.sort(key=lambda r: (-(r["chance"] or -1), -r["tailwind_ms"]))
    lines = [f"Compared at {_weekday(results[0]['when'])}", "", HEADER]
    lines += [_one_line(r) for r in results]
    if misses:
        lines += ["", "Not found: " + ", ".join(misses)]
    return _with_footnote(lines, results)


def explain_prediction(segment: str, when: str | None = None) -> str:
    matches = data.find(segment)
    if not matches:
        return f"No segment matching {segment!r}."
    seg = matches[0]
    cell = data.forecast_for(seg)
    index = _hour_index(cell, when)
    result = _evaluate(seg, cell, index)

    w = result["weather"]
    sections = result["sections"]
    base = _base_rider(seg)
    rider = Rider(result["power_w"], base.mass_kg, base.cda, base.crr,
                  base.drivetrain_efficiency)
    rho = air_density(w["temperature_c"], w["pressure_hpa"], w["humidity_pct"])
    wind_to = (w["wind_from_deg"] + 180.0) % 360.0
    at_rider = wind_at_rider_height(w["wind_speed_ms"])

    # Grouped into roughly ten stretches. Eighty-metre sections are what the
    # model actually solves; a hundred rows of them is not an explanation.
    buckets = max(1, len(sections) // 10)
    rows = []
    travelled = 0.0
    for start in range(0, len(sections), buckets):
        chunk = sections[start:start + buckets]
        distance = sum(s.distance_m for s in chunk)
        if distance <= 0:
            continue
        grade = sum(s.grade * s.distance_m for s in chunk) / distance
        def tail_of(section) -> float:
            return at_rider * math.cos(
                math.radians(angle_delta(wind_to, section.bearing_deg))
            )

        tail = sum(tail_of(s) * s.distance_m for s in chunk) / distance
        seconds = sum(
            s.distance_m / section_speed(rider, -tail_of(s), s.grade, rho)
            for s in chunk
        )
        rows.append((travelled, distance, grade, tail, seconds, distance / seconds))
        travelled += distance

    lines = [
        f"How {seg['name']} at {result['when']} comes to "
        f"{data.duration(result['predicted_s'])}",
        "",
        f"Power is {result['power_w']:.0f} W, {result['power_source']}.",
        f"Rider and bike {base.mass_kg:.1f} kg, frontal area {base.cda:.3f} m², "
        f"both fitted from efforts where power was measured.",
        f"Air density {rho:.3f} kg/m³ at {w['temperature_c']:.0f}°C and "
        f"{w['pressure_hpa']:.0f} hPa.",
        f"Wind {w['wind_speed_ms']:.1f} m/s from {data.compass(w['wind_from_deg'])} at ten metres, "
        f"{at_rider:.1f} m/s at riding height.",
        "",
        f"The segment is solved in {len(sections)} sections of about eighty metres, "
        "each at constant power against the wind it actually meets. Grouped into "
        f"{len(rows)} stretches:",
        "",
        f"  {'from':>7}{'length':>8}{'grade':>7}{'tail':>7}{'speed':>8}{'time':>8}",
    ]
    for start, distance, grade, tail, seconds, speed in rows:
        lines.append(
            f"  {start / 1000:>6.1f}k{distance:>7.0f}m{grade * 100:>6.1f}%"
            f"{tail:>+6.1f}{speed * 3.6:>7.1f}{data.duration(seconds):>8}"
        )
    lines += [
        "",
        f"Sum of the sections: {data.duration(result['predicted_s'])}. "
        f"In still air the same power gives {data.duration(result['still_air_s'])}, "
        f"so today's wind is worth {data.delta(result['predicted_s'] - result['still_air_s'])}.",
        "",
        "Note the times are summed, never the wind. A loop averages to no wind "
        "at all while still costing you minutes, because the headwind half is "
        "slower for longer than the tailwind half is quicker.",
    ]
    return "\n".join(lines)
