"""A rider-level model that transfers to segments with no attempt history.

The per-segment calibration in build_calibration.py is accurate where it
applies and silent everywhere else: it needs roughly six power-metered attempts
on a segment before it can say anything. The application shows every starred and
discovered segment nearby, so most of what a rider sees falls back to fitting
power from a single personal record assumed to have been set in still air --
the model the backtest scores at 94.5 s MAE with an 81 s optimistic bias.

This module learns from every effort at once instead. Two observations make that
possible:

  * What a rider can hold depends mostly on how long they hold it. Across the
    recorded history, effort durations span roughly two minutes to an hour,
    which is enough to fit the classic two-parameter critical power curve
    P(t) = CP + W'/t.

  * Power is not measured here but derived: it is the power that reproduces an
    effort's real time in that effort's real weather. That means it carries
    whatever the physics gets wrong about this rider -- frontal area, rolling
    resistance, mass -- as a systematic offset. Prediction runs through the same
    physics, so the offset cancels rather than accumulating, which is why no
    separate aerodynamic correction is fitted here. The gap is visible and worth
    knowing (derived power runs about 17 W above this rider's power meter) but
    correcting it would change nothing except the units the curve is stated in.

Prediction is implicit: the power a rider can hold depends on the duration, and
the duration depends on the power. Solved by fixed point, which converges
quickly because longer predicted times lower the power, which lengthens them
again by less each round.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .physics import Rider, Section, air_density, ride_time

# Enough bisection to place power within a small fraction of a watt across the
# whole plausible range; more is wasted work inside an outer loop.
_POWER_LO = 40.0
_POWER_HI = 900.0
_POWER_STEPS = 26

# The fixed point below settles well inside this; the cap only bounds the
# pathological case where a segment cannot be ridden at any power in range.
_FIXED_POINT_STEPS = 12
_FIXED_POINT_TOLERANCE_S = 0.25


def rho_of(weather: dict) -> float:
    """Air density for an effort, defaulting to a temperate sea-level day."""
    return air_density(
        weather.get("temperature_c") if weather.get("temperature_c") is not None else 15.0,
        weather.get("pressure_hpa") if weather.get("pressure_hpa") is not None else 1013.0,
        weather.get("humidity_pct") if weather.get("humidity_pct") is not None else 60.0,
    )


def power_for_time(
    sections: list[Section],
    target_time_s: float,
    weather: dict,
    base: Rider = Rider(),
) -> float:
    """Power that reproduces a time in the weather the effort actually had.

    The still-air equivalent attributes a day's tailwind to the rider's legs.
    This does not, which is what makes the resulting points comparable across
    efforts ridden in different conditions.
    """
    rho = rho_of(weather)
    lo, hi = _POWER_LO, _POWER_HI
    for _ in range(_POWER_STEPS):
        mid = (lo + hi) / 2
        rider = Rider(mid, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
        if ride_time(
            sections, rider, rho, weather["wind_from_deg"], weather["wind_speed_ms"]
        ) > target_time_s:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


@dataclass(frozen=True)
class RiderModel:
    """Critical power, the finite work above it, and a gradient term.

    The two-parameter curve alone explains under half of this rider's power
    variance across their recorded attempts, and what it misses is not noise:
    the residual tracks gradient at r = +0.49. They hold roughly 35 W more on a
    climb than on a flat of the same duration, which is unsurprising -- a climb
    forces a steady effort where a flat allows coasting, drafting, and simply
    not committing to a segment that happens to fall inside a longer ride.

    Duration alone therefore cannot carry a model between a climb and a flat,
    which is precisely what transferring to an unridden segment demands.
    """

    cp_w: float
    w_prime_j: float
    grade_w: float
    sample_count: int

    def power_at(self, duration_s: float, grade: float = 0.0) -> float:
        if duration_s <= 0:
            return self.cp_w + self.grade_w * grade
        return self.cp_w + self.w_prime_j / duration_s + self.grade_w * grade


def _solve(rows: list[list[float]], targets: list[float]) -> list[float] | None:
    """Least squares by normal equations, Gaussian elimination with pivoting."""
    width = len(rows[0])
    a = [[sum(r[i] * r[j] for r in rows) for j in range(width)] for i in range(width)]
    b = [sum(r[i] * t for r, t in zip(rows, targets)) for i in range(width)]

    for col in range(width):
        pivot = max(range(col, width), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        b[col], b[pivot] = b[pivot], b[col]
        for row in range(col + 1, width):
            factor = a[row][col] / a[col][col]
            for k in range(col, width):
                a[row][k] -= factor * a[col][k]
            b[row] -= factor * b[col]

    out = [0.0] * width
    for i in reversed(range(width)):
        out[i] = (b[i] - sum(a[i][j] * out[j] for j in range(i + 1, width))) / a[i][i]
    return out


def fit_rider_model(samples: list[tuple[float, float, float]]) -> RiderModel | None:
    """Least squares P = CP + W'/t + k*grade over recorded attempts.

    Samples are (duration_s, grade, measured_power_w), with grade as a fraction
    rather than a percentage so the coefficient stays in ordinary watts.

    One trimming pass follows the first fit. A few recorded efforts are not what
    they appear -- a segment ridden in a group, a GPS artefact shortening the
    distance -- and a single such point moves a three-parameter fit noticeably.
    Trimming at two and a half standard deviations removes them without anyone
    choosing which, and the fit is reported over what survived.
    """
    usable = [
        (t, g, p)
        for t, g, p in samples
        if t > 0 and math.isfinite(p) and math.isfinite(g)
    ]
    if len(usable) < 6:
        return None

    def solve(points):
        rows = [[1.0, 1.0 / t, g] for t, g, _ in points]
        return _solve(rows, [p for _, _, p in points])

    first = solve(usable)
    if first is None:
        return None
    cp, w_prime, grade_w = first

    residuals = [p - (cp + w_prime / t + grade_w * g) for t, g, p in usable]
    mean = sum(residuals) / len(residuals)
    spread = (sum((r - mean) ** 2 for r in residuals) / len(residuals)) ** 0.5
    if spread > 0:
        kept = [
            s for s, r in zip(usable, residuals) if abs(r - mean) <= 2.5 * spread
        ]
        if len(kept) >= 6:
            refit = solve(kept)
            if refit is not None:
                cp, w_prime, grade_w = refit
                usable = kept

    # A negative W' would mean this rider goes harder the longer they ride.
    # Clamping degrades the curve to a sustainable power plus a gradient term,
    # which is the right behaviour when the durations on offer are too alike to
    # separate the two.
    return RiderModel(
        cp_w=max(cp, 1.0),
        w_prime_j=max(w_prime, 0.0),
        grade_w=grade_w,
        sample_count=len(usable),
    )


def mean_grade(sections: list[Section]) -> float:
    """Distance-weighted gradient, matching what the curve was fitted against."""
    total = sum(s.distance_m for s in sections)
    if total <= 0:
        return 0.0
    return sum(s.grade * s.distance_m for s in sections) / total


def predict_time(
    sections: list[Section],
    model: RiderModel,
    weather: dict,
    base: Rider = Rider(),
) -> float:
    """Time for a segment under a forecast, with power set by the segment.

    Implicit: the power a rider can hold depends on how long they hold it, and
    how long depends on the power. Solved by fixed point, which settles quickly
    because a longer predicted time lowers the power, which lengthens it again
    by less each round.
    """
    rho = rho_of(weather)
    grade = mean_grade(sections)

    def time_at(power: float) -> float:
        rider = Rider(power, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
        return ride_time(
            sections, rider, rho, weather["wind_from_deg"], weather["wind_speed_ms"]
        )

    # Start from critical power, which is the longest-duration end of the curve
    # and therefore always an underestimate of the power actually available.
    estimate = time_at(model.power_at(3600.0, grade))
    for _ in range(_FIXED_POINT_STEPS):
        nxt = time_at(model.power_at(estimate, grade))
        if abs(nxt - estimate) < _FIXED_POINT_TOLERANCE_S:
            return nxt
        estimate = nxt
    return estimate

# --------------------------------------------------------------------------
# global physics
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class RiderPhysics:
    """Mass and frontal area for this rider, fitted rather than assumed."""

    mass_kg: float
    cda: float
    sample_count: int

    def rider(self, power_w: float, base: Rider = Rider()) -> Rider:
        return Rider(power_w, self.mass_kg, self.cda, base.crr, base.drivetrain_efficiency)


# Bounds are physical rather than statistical: a rider plus bike and kit, and a
# frontal area between a low tuck and sitting up on the hoods. A fit that wants
# to leave these is describing something other than the rider.
_MASS_BOUNDS = (55.0, 110.0)
_CDA_BOUNDS = (0.18, 0.45)
_SWEEPS = 5
_TERNARY_STEPS = 24


def _ternary(cost, lo: float, hi: float) -> float:
    for _ in range(_TERNARY_STEPS):
        a = lo + (hi - lo) / 3
        b = hi - (hi - lo) / 3
        if cost(a) < cost(b):
            hi = b
        else:
            lo = a
    return (lo + hi) / 2


def fit_physics(
    observations: list[tuple[list[Section], dict, float, float]],
    base: Rider = Rider(),
) -> RiderPhysics | None:
    """Fit mass and frontal area from efforts where power was measured.

    Both time and power are known for these efforts, so the physics connecting
    them is over-determined and its constants can be recovered instead of
    assumed. That matters because the two constants fail in different places:
    mass dominates a climb and frontal area dominates a flat, so a single
    fitted power per segment hides the error while a model meant to transfer
    between segments cannot.

    Rolling resistance and drivetrain efficiency stay fixed. They trade off
    against these two almost exactly over the gradients in one rider's history,
    and freeing them buys a better fit that means less.

    Cost is relative rather than absolute so that an hour-long segment does not
    outweigh a five-minute climb purely by being longer.
    """
    usable = [
        (sections, weather, power, actual)
        for sections, weather, power, actual in observations
        if sections and power and actual and actual > 0
    ]
    if len(usable) < 8:
        return None

    def cost(mass: float, cda: float) -> float:
        total = 0.0
        for sections, weather, power, actual in usable:
            rider = Rider(power, mass, cda, base.crr, base.drivetrain_efficiency)
            predicted = ride_time(
                sections, rider, rho_of(weather), weather["wind_from_deg"], weather["wind_speed_ms"]
            )
            total += ((predicted - actual) / actual) ** 2
        return total

    mass = base.mass_kg
    cda = base.cda
    for _ in range(_SWEEPS):
        mass = _ternary(lambda m: cost(m, cda), *_MASS_BOUNDS)
        cda = _ternary(lambda c: cost(mass, c), *_CDA_BOUNDS)

    return RiderPhysics(mass_kg=mass, cda=cda, sample_count=len(usable))
