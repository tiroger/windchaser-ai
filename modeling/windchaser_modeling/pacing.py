"""Variable-power pacing over a route: the physics at per-section power, W'
balance with durability, and an optimiser that minimises total time.

Forward model. Each section's speed at a given power comes from
cycling_analytics.physics.section_speed, the same solver production uses for
constant power. Because a section's time depends only on its own power, the
solver is tabulated once per section on a power grid and interpolated, which
makes the optimiser's many evaluations cheap without changing the physics.

Physiology. Skiba's differential W' balance: above CP, W' is spent at P - CP;
below, it recovers toward full at a rate proportional to the deficit,

    dW'/dt = -(P - CP)                       if P > CP
    dW'/dt = (CP - P) (W'0 - W') / W'0       otherwise,

integrated exactly over each constant-power section. Durability lowers CP as
work accumulates: CP(W) = CP0 * f(W) with f from durability.Envelope.

Optimisation. Minimise T(P) = sum t_i(P_i) subject to
    mean power      sum P_i t_i <= Pbar * sum t_i       (same average)
    strain          sum P_i^4 t_i <= (VI * Pbar)^4 * sum t_i
    W' balance      W'_i >= 0 after every section
    bounds          0 <= P_i <= P_max
solved by SLSQP with analytic gradients for time, mean power and strain; the
W' constraints use finite differences (cheap: one pass is a short loop).

The strain constraint is what keeps the answer physiological. With mean power
alone, a Skiba model below CP is free, and the optimiser rides every climb at
CP and coasts every descent: fast on paper, and not what the same legs do for
four hours. The fourth-power mean is the section-level analogue of normalised
power, so VI (NP over mean power) states how much variability the rider
accepts. VI = 1 forces constant power; the notebooks take the default from the
rider's own rides.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize

from . import MODELING_DIR  # noqa: F401
from cycling_analytics.physics import Rider, angle_delta, section_speed, wind_at_rider_height


@dataclass
class Course:
    """Sections with the wind already resolved onto each one."""

    length_m: np.ndarray
    grade: np.ndarray
    bearing_deg: np.ndarray
    headwind_ms: np.ndarray  # at rider height, positive into the rider
    rho: float
    start_m: np.ndarray = field(default_factory=lambda: np.array([]))
    altitude_m: np.ndarray = field(default_factory=lambda: np.array([]))

    @property
    def n(self) -> int:
        return len(self.length_m)


def make_course(sections, wind_from_deg: float = 0.0, wind_speed_ms: float = 0.0, rho: float = 1.225) -> Course:
    """From a features.route_sections frame and a single wind (10 m)."""
    wind_to = (wind_from_deg + 180.0) % 360.0
    v = wind_at_rider_height(max(0.0, wind_speed_ms))
    tail = np.array([v * math.cos(math.radians(angle_delta(wind_to, b))) for b in sections["bearing_deg"]])
    return Course(
        length_m=sections["length_m"].to_numpy(float),
        grade=sections["grade"].to_numpy(float),
        bearing_deg=sections["bearing_deg"].to_numpy(float),
        headwind_ms=-tail,
        rho=rho,
        start_m=sections["start_m"].to_numpy(float),
        altitude_m=sections["altitude_m"].to_numpy(float) if "altitude_m" in sections else np.zeros(len(sections)),
    )


class SpeedTable:
    """Speed per section on a power grid, from the production solver."""

    def __init__(self, course: Course, rider: Rider, p_max: float = 800.0, step: float = 10.0):
        self.course = course
        self.step = step
        self.grid = np.arange(0.0, p_max + step, step)
        v = np.empty((course.n, len(self.grid)))
        for i in range(course.n):
            for j, p in enumerate(self.grid):
                r = Rider(max(p, 1e-6), rider.mass_kg, rider.cda, rider.crr, rider.drivetrain_efficiency)
                v[i, j] = section_speed(r, float(course.headwind_ms[i]), float(course.grade[i]), course.rho)
        self.v = v
        self._rows = np.arange(course.n)

    def speed(self, power: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Speed and dv/dP per section, linear between grid points."""
        p = np.clip(np.asarray(power, float), self.grid[0], self.grid[-1] - 1e-9)
        j = np.floor(p / self.step).astype(int)
        frac = (p - self.grid[j]) / self.step
        v0 = self.v[self._rows, j]
        v1 = self.v[self._rows, j + 1]
        return v0 + frac * (v1 - v0), (v1 - v0) / self.step

    def times(self, power: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        v, dv = self.speed(power)
        t = self.course.length_m / v
        return t, -self.course.length_m * dv / v**2


@dataclass(frozen=True)
class Physiology:
    cp_w: float
    w_prime_j: float
    # f(W kJ) -> share of CP left; identity when durability is ignored.
    durability: object = None
    work_before_kj: float = 0.0

    def cp_at(self, work_kj: np.ndarray) -> np.ndarray:
        w = np.asarray(work_kj, float) + self.work_before_kj
        if self.durability is None:
            return np.full_like(w, self.cp_w)
        return self.cp_w * np.asarray(self.durability(w), float)


def w_balance(power: np.ndarray, times: np.ndarray, phys: Physiology) -> tuple[np.ndarray, np.ndarray]:
    """W' remaining after each section (J), and CP in force on each."""
    power = np.asarray(power, float)
    work_before = np.concatenate([[0.0], np.cumsum(power * times)[:-1]]) / 1000.0
    cp = phys.cp_at(work_before)
    wp0 = phys.w_prime_j
    bal = np.empty(len(power))
    w = wp0
    for i, (p, t, c) in enumerate(zip(power, times, cp)):
        if p > c:
            w -= (p - c) * t
        else:
            w = wp0 - (wp0 - w) * math.exp(-(c - p) * t / wp0)
        bal[i] = w
    return bal, cp


@dataclass
class Plan:
    power_w: np.ndarray
    time_s: np.ndarray
    total_s: float
    mean_power_w: float
    w_balance_j: np.ndarray
    cp_w: np.ndarray
    feasible: bool
    message: str = ""


def evaluate_plan(table: SpeedTable, power: np.ndarray, phys: Physiology, label: str = "") -> Plan:
    t, _ = table.times(power)
    bal, cp = w_balance(power, t, phys)
    return Plan(
        power_w=np.asarray(power, float),
        time_s=t,
        total_s=float(t.sum()),
        mean_power_w=float(np.sum(power * t) / t.sum()),
        w_balance_j=bal,
        cp_w=cp,
        feasible=bool(bal.min() >= -1.0),
        message=label,
    )


def constant_plan(table: SpeedTable, mean_power_w: float, phys: Physiology) -> Plan:
    return evaluate_plan(table, np.full(table.course.n, mean_power_w), phys, "constant")


def strain_np(power: np.ndarray, times: np.ndarray) -> float:
    """Section-level normalised power: the time-weighted fourth-power mean."""
    p = np.asarray(power, float)
    t = np.asarray(times, float)
    return float((np.sum(t * p**4) / t.sum()) ** 0.25)


def optimise(
    table: SpeedTable,
    mean_power_w: float,
    phys: Physiology,
    vi_cap: float = 1.05,
    p_max: float | None = None,
    p_min: float = 0.0,
    maxiter: int = 500,
) -> Plan:
    """Fastest plan at the same time-weighted mean power and at most
    `vi_cap` times that as section-level normalised power."""
    n = table.course.n
    p_hi = min(p_max or table.grid[-1] - table.step, table.grid[-1] - table.step)
    x0 = np.full(n, mean_power_w)
    t0 = float(table.times(x0)[0].sum())
    cap4 = (vi_cap * mean_power_w) ** 4

    # Everything scaled to order one so SLSQP's tolerances mean the same on a
    # ten-minute loop and a five-hour route.
    def objective(p):
        t, dt = table.times(p)
        return t.sum() / t0, dt / t0

    def mean_cons(p):
        t, _ = table.times(p)
        return (mean_power_w * t.sum() - np.sum(p * t)) / (mean_power_w * t0)

    def mean_jac(p):
        t, dt = table.times(p)
        return (mean_power_w * dt - (t + p * dt)) / (mean_power_w * t0)

    def strain_cons(p):
        t, _ = table.times(p)
        return (cap4 * t.sum() - np.sum(t * p**4)) / (cap4 * t0)

    def strain_jac(p):
        t, dt = table.times(p)
        return (cap4 * dt - (dt * p**4 + 4 * t * p**3)) / (cap4 * t0)

    def wbal_cons(p):
        t, _ = table.times(p)
        bal, _ = w_balance(p, t, phys)
        return bal / phys.w_prime_j

    res = minimize(
        objective,
        x0,
        jac=True,
        method="SLSQP",
        bounds=[(p_min, p_hi)] * n,
        constraints=[
            {"type": "ineq", "fun": mean_cons, "jac": mean_jac},
            {"type": "ineq", "fun": strain_cons, "jac": strain_jac},
            {"type": "ineq", "fun": wbal_cons},
        ],
        options={"maxiter": maxiter, "ftol": 1e-9},
    )
    plan = evaluate_plan(table, res.x, phys, res.message)
    np_ = strain_np(plan.power_w, plan.time_s)
    plan.feasible = (
        plan.feasible
        and plan.mean_power_w <= mean_power_w * 1.002
        and np_ <= vi_cap * mean_power_w * 1.002
    )
    # Never report a plan slower than the constant one it started from.
    base = evaluate_plan(table, x0, phys, "constant")
    if not plan.feasible or plan.total_s > base.total_s:
        if base.feasible:
            base.message = f"kept constant ({res.message})"
            return base
    return plan


def faded_plan(table: SpeedTable, mean_power_w: float, phys: Physiology) -> Plan:
    """Constant *effort* rather than constant power: power proportional to the
    CP still available, scaled so the mean matches. What a rider who simply
    rides by feel through fatigue would do."""
    p = np.full(table.course.n, mean_power_w)
    for _ in range(20):
        t, _ = table.times(p)
        work = np.concatenate([[0.0], np.cumsum(p * t)[:-1]]) / 1000.0
        shape = phys.cp_at(work) / phys.cp_w
        scale = mean_power_w / (np.sum(shape * t) / t.sum())
        p_new = shape * scale
        if np.max(np.abs(p_new - p)) < 0.05:
            p = p_new
            break
        p = p_new
    return evaluate_plan(table, p, phys, "faded")


def coarsen(sections, max_sections: int = 100):
    """Merge neighbouring sections so the optimiser has at most max_sections
    variables. Lengths add; bearing and grade are length-weighted (bearing as
    a vector mean so 350 and 10 degrees average to 0, not 180)."""
    import pandas as pd

    n = len(sections)
    if n <= max_sections:
        return sections.reset_index(drop=True)
    groups = np.floor(np.arange(n) * max_sections / n).astype(int)
    rows = []
    for g, chunk in sections.groupby(groups):
        L = chunk["length_m"].to_numpy()
        b = np.radians(chunk["bearing_deg"].to_numpy())
        bearing = (math.degrees(math.atan2(np.sum(L * np.sin(b)), np.sum(L * np.cos(b)))) + 360) % 360
        rows.append(
            {
                "start_m": float(chunk["start_m"].iloc[0]),
                "length_m": float(L.sum()),
                "bearing_deg": bearing,
                "grade": float(np.sum(chunk["grade"].to_numpy() * L) / L.sum()),
                "altitude_m": float(chunk["altitude_m"].iloc[0]) if "altitude_m" in chunk else 0.0,
                "lat": float(chunk["lat"].iloc[len(chunk) // 2]),
                "lng": float(chunk["lng"].iloc[len(chunk) // 2]),
            }
        )
    return pd.DataFrame(rows)
