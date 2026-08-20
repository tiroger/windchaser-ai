"""Deterministic cycling physics, shared by analysis scripts and Lambda workers.

This is the Python counterpart of apps/web/lib/physics.ts and implements the
same section 9 contract: resolve wind per section, solve for speed at constant
power, and sum section times. Never average wind and convert once.

Kept dependency-free so it runs anywhere, including a small Lambda.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

G = 9.80665
R_DRY = 287.058
R_VAPOUR = 461.495
RHO_REFERENCE = 1.225
EARTH_R = 6371000.0


@dataclass(frozen=True)
class Rider:
    power_w: float = 250.0
    mass_kg: float = 80.0
    cda: float = 0.32
    crr: float = 0.005
    drivetrain_efficiency: float = 0.97


@dataclass(frozen=True)
class Section:
    distance_m: float
    bearing_deg: float
    grade: float


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(h))


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_delta(a: float, b: float) -> float:
    """Shortest signed difference a - b, within (-180, 180]."""
    return ((a - b) % 360 + 540) % 360 - 180


def _grade_at(profile: dict | None, start_m: float, end_m: float) -> float | None:
    """Local gradient between two distances along a segment, from its profile."""
    if not profile:
        return None
    dist = profile.get("distance_m") or []
    alt = profile.get("altitude_m") or []
    if len(dist) < 2 or len(dist) != len(alt):
        return None

    def interp(target: float) -> float:
        if target <= dist[0]:
            return alt[0]
        if target >= dist[-1]:
            return alt[-1]
        lo, hi = 0, len(dist) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if dist[mid] <= target:
                lo = mid
            else:
                hi = mid
        span = dist[hi] - dist[lo]
        if span <= 0:
            return alt[lo]
        t = (target - dist[lo]) / span
        return alt[lo] + (alt[hi] - alt[lo]) * t

    run = end_m - start_m
    if run <= 0:
        return None
    return (interp(end_m) - interp(start_m)) / run


def to_sections(
    points: list[list[float]],
    average_grade: float,
    profile: dict | None = None,
    target_len: float = 80.0,
) -> list[Section]:
    """Resample a polyline into sections of roughly constant bearing and grade.

    Gradient comes from the real elevation profile when one is available, and
    falls back to the segment's average otherwise. A single average grade is a
    poor description of a rolling segment, which is why the profile matters.
    """
    sections: list[Section] = []
    if len(points) < 2:
        return sections

    anchor = points[0]
    accum = 0.0
    travelled = 0.0

    for i in range(1, len(points)):
        d = haversine_m(tuple(points[i - 1]), tuple(points[i]))
        if not math.isfinite(d) or d == 0:
            continue
        accum += d
        if accum >= target_len or i == len(points) - 1:
            grade = _grade_at(profile, travelled, travelled + accum)
            sections.append(
                Section(
                    distance_m=accum,
                    bearing_deg=bearing_deg(tuple(anchor), tuple(points[i])),
                    grade=average_grade / 100.0 if grade is None else grade,
                )
            )
            travelled += accum
            anchor = points[i]
            accum = 0.0
    return sections


# --------------------------------------------------------------------------
# atmosphere
# --------------------------------------------------------------------------

def air_density(temp_c: float, pressure_hpa: float, humidity_pct: float) -> float:
    t = temp_c + 273.15
    saturation = 610.78 * math.exp((17.27 * temp_c) / (temp_c + 237.3))
    pv = (humidity_pct / 100.0) * saturation
    pd = pressure_hpa * 100.0 - pv
    return pd / (R_DRY * t) + pv / (R_VAPOUR * t)


def wind_at_rider_height(v10: float, roughness: float = 0.05) -> float:
    """Logarithmic profile from the 10 m forecast height down to about 1.5 m."""
    return v10 * math.log(1.5 / roughness) / math.log(10.0 / roughness)


# --------------------------------------------------------------------------
# speed and time
# --------------------------------------------------------------------------

def section_speed(
    rider: Rider, headwind_ms: float, grade: float, rho: float
) -> float:
    """Ground speed at constant power. Monotonic in v, so bisection is stable."""
    theta = math.atan(grade)
    roll = rider.crr * rider.mass_kg * G * math.cos(theta)
    grav = rider.mass_kg * G * math.sin(theta)

    lo, hi = 0.05, 32.0
    for _ in range(30):
        v = (lo + hi) / 2
        va = v + headwind_ms
        drag = 0.5 * rho * rider.cda * va * abs(va)
        required = v * (drag + roll + grav) / rider.drivetrain_efficiency
        if required < rider.power_w:
            lo = v
        else:
            hi = v
    return (lo + hi) / 2


def ride_time(
    sections: list[Section],
    rider: Rider,
    rho: float,
    wind_from_deg: float,
    wind_speed_ms: float,
) -> float:
    """Sum of per-section times under a given wind."""
    wind_to = (wind_from_deg + 180.0) % 360.0
    speed = wind_at_rider_height(wind_speed_ms)
    total = 0.0
    for s in sections:
        delta = math.radians(angle_delta(wind_to, s.bearing_deg))
        tail = speed * math.cos(delta)
        total += s.distance_m / section_speed(rider, -tail, s.grade, rho)
    return total


def effective_tailwind(
    sections: list[Section], wind_from_deg: float, wind_speed_ms: float
) -> float:
    """Distance-weighted mean tailwind. Presentational only, never a model input."""
    wind_to = (wind_from_deg + 180.0) % 360.0
    speed = wind_at_rider_height(wind_speed_ms)
    total_d = sum(s.distance_m for s in sections)
    if total_d <= 0:
        return 0.0
    acc = sum(
        speed * math.cos(math.radians(angle_delta(wind_to, s.bearing_deg)))
        * s.distance_m
        for s in sections
    )
    return acc / total_d


# --------------------------------------------------------------------------
# calibration
# --------------------------------------------------------------------------

def fit_power_still_air(
    sections: list[Section], target_time_s: float, base: Rider = Rider()
) -> float:
    """Power that reproduces a time assuming still air at reference density.

    This is what a single-PR calibration does. It attributes any wind help the
    rider had that day to their legs, which biases power upward.
    """
    lo, hi = 40.0, 900.0
    for _ in range(40):
        mid = (lo + hi) / 2
        t = ride_time(
            sections,
            Rider(mid, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency),
            RHO_REFERENCE,
            0.0,
            0.0,
        )
        if t > target_time_s:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _age_weights(efforts: list[dict], half_life_years: float | None) -> list[float]:
    """Discount older attempts, measured back from the newest one on record.

    Relative to the newest rather than to today, so a backtest fitting on a
    training window weights that window the same way a fit run at its end would.
    """
    if not half_life_years or half_life_years <= 0:
        return [1.0] * len(efforts)

    stamps: list[float] = []
    for effort in efforts:
        raw = effort.get("start_date")
        try:
            when = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            stamps.append(when.timestamp())
        except (TypeError, ValueError):
            stamps.append(0.0)
    newest = max(stamps) if stamps else 0.0
    seconds = 365.25 * 24 * 3600
    return [
        0.5 ** (max(newest - t, 0.0) / seconds / half_life_years) for t in stamps
    ]


def fit_power_from_efforts(
    sections: list[Section],
    efforts: list[dict],
    base: Rider = Rider(),
    half_life_years: float | None = None,
) -> float:
    """Power minimising squared time error across efforts in their real weather.

    Because the efforts span many wind directions and speeds, wind no longer
    correlates with the fitted power, which is the whole point of collecting
    effort history.

    Older attempts can be discounted by a half-life. A segment ridden across
    several seasons otherwise fits the average of the rider across all of them,
    and this rider has gained roughly 10 percent on the same climb in four
    years.
    """
    if not efforts:
        return base.power_w

    weights = _age_weights(efforts, half_life_years)

    def cost(power: float) -> float:
        rider = Rider(
            power, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency
        )
        total = 0.0
        for e, age_weight in zip(efforts, weights):
            w = e["weather"]
            rho = air_density(
                w.get("temperature_c") or 15.0,
                w.get("pressure_hpa") or 1013.0,
                w.get("humidity_pct") or 60.0,
            )
            predicted = ride_time(
                sections, rider, rho, w["wind_from_deg"], w["wind_speed_ms"]
            )
            actual = float(e.get("moving_time_s") or e["elapsed_time_s"])
            total += age_weight * (predicted - actual) ** 2
        return total

    # Cost is unimodal in power; ternary search avoids needing a derivative.
    lo, hi = 40.0, 900.0
    for _ in range(80):
        a = lo + (hi - lo) / 3
        b = hi - (hi - lo) / 3
        if cost(a) < cost(b):
            hi = b
        else:
            lo = a
    return (lo + hi) / 2
