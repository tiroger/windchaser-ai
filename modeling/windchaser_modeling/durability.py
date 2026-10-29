"""Durability: how sustainable power falls as work accumulates within a ride.

Data are, per ride and per bin of work already done, the best mean power over
a fixed duration (features.mmp_by_work). Most rides are not maximal, so a
mean through those points describes how hard the rider chose to ride, not
what they could. The models here are therefore upper envelopes: fitted by
pinball (quantile) loss at a high quantile tau, they describe the level a
ride exceeds only (1 - tau) of the time.

Forms compared, with W the work done in kJ:

    flat          P(W) = P0                         (no durability effect)
    linear        P(W) = P0 * (1 - k W)
    exponential   P(W) = P0 * exp(-k W)
    hinge         P(W) = P0 * (1 - k * max(0, W - W0))

All are multiplicative in P0, so a durability factor f(W) = P(W) / P0 can be
moved onto any other fitness measure (the pacing optimiser applies it to CP).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

FORMS = ("flat", "linear", "exponential", "hinge")


def factor(form: str, params: np.ndarray, w_kj: np.ndarray) -> np.ndarray:
    """f(W), the share of fresh power available after W kJ."""
    w = np.asarray(w_kj, float)
    if form == "flat":
        return np.ones_like(w)
    if form == "linear":
        return np.clip(1.0 - params[0] * w, 0.05, None)
    if form == "exponential":
        return np.exp(-params[0] * w)
    if form == "hinge":
        k, w0 = params
        return np.clip(1.0 - k * np.maximum(0.0, w - w0), 0.05, None)
    raise ValueError(form)


def _pinball(y: np.ndarray, q: np.ndarray, tau: float) -> float:
    d = y - q
    return float(np.mean(np.maximum(tau * d, (tau - 1) * d)))


@dataclass(frozen=True)
class Envelope:
    form: str
    tau: float
    p0: float
    params: tuple[float, ...]
    n: int
    loss: float

    def predict(self, w_kj) -> np.ndarray:
        return self.p0 * factor(self.form, np.array(self.params), w_kj)

    def factor(self, w_kj) -> np.ndarray:
        return factor(self.form, np.array(self.params), w_kj)

    def drop_at(self, w_kj: float) -> float:
        """Fractional loss of power after w_kj, e.g. 0.06 = 6% lower."""
        return float(1.0 - self.factor(np.array([w_kj]))[0])


def fit_envelope(w_kj, power_w, form: str, tau: float = 0.9) -> Envelope:
    """Quantile fit of one form. Parameters are searched in a scaled space
    (k per 1000 kJ, W0 in 1000 kJ) so the optimiser sees comparable units."""
    w = np.asarray(w_kj, float)
    y = np.asarray(power_w, float)
    p_init = float(np.quantile(y, tau))

    def unpack(theta):
        p0 = theta[0]
        if form == "flat":
            return p0, ()
        if form in ("linear", "exponential"):
            return p0, (theta[1] / 1000.0,)
        return p0, (theta[1] / 1000.0, theta[2] * 1000.0)

    def loss(theta):
        p0, params = unpack(theta)
        return _pinball(y, p0 * factor(form, np.array(params), w), tau)

    starts = {
        "flat": [[p_init]],
        "linear": [[p_init, 0.05], [p_init, 0.0]],
        "exponential": [[p_init, 0.05], [p_init, 0.0]],
        "hinge": [[p_init, 0.08, 0.5], [p_init, 0.08, 1.0], [p_init, 0.05, 1.5]],
    }[form]
    bounds = {
        "flat": [(1e-3, 1e4)],
        "linear": [(1e-3, 1e4), (-0.5, 0.5)],
        "exponential": [(1e-3, 1e4), (-0.5, 0.5)],
        "hinge": [(1e-3, 1e4), (-0.5, 0.5), (0.0, 3.0)],
    }[form]
    best = None
    for x0 in starts:
        # Pinball loss is piecewise linear: a derivative-free method is the
        # robust choice, and with at most three parameters it is cheap.
        res = minimize(loss, np.array(x0, float), method="Nelder-Mead",
                       options={"xatol": 1e-4, "fatol": 1e-6, "maxiter": 4000})
        x = np.clip(res.x, [b[0] for b in bounds], [b[1] for b in bounds])
        val = loss(x)
        if best is None or val < best[1]:
            best = (x, val)
    p0, params = unpack(best[0])
    return Envelope(form, tau, float(p0), tuple(float(p) for p in params), len(y), float(best[1]))


def exceedance(y, q) -> float:
    """Share of observations above the envelope; (1 - tau) when calibrated."""
    return float(np.mean(np.asarray(y, float) > np.asarray(q, float)))


def grouped_folds(groups, n_splits: int = 5, seed: int = 0) -> list[tuple[np.ndarray, np.ndarray]]:
    """Whole rides held out together, so a ride's early bins never train the
    model that is scored on its late ones."""
    groups = np.asarray(groups)
    labels = np.unique(groups)
    rng = np.random.default_rng(seed)
    rng.shuffle(labels)
    out = []
    for chunk in np.array_split(labels, n_splits):
        test = np.isin(groups, chunk)
        out.append((np.flatnonzero(~test), np.flatnonzero(test)))
    return out


def bootstrap_drop(
    frame,
    w_col: str,
    y_col: str,
    group_col: str,
    form: str,
    at_kj: float,
    tau: float = 0.9,
    n_boot: int = 200,
    seed: int = 0,
) -> np.ndarray:
    """Bootstrap distribution of the fitted drop at `at_kj`, resampling rides."""
    rng = np.random.default_rng(seed)
    groups = frame[group_col].to_numpy()
    labels = np.unique(groups)
    index = {g: np.flatnonzero(groups == g) for g in labels}
    w = frame[w_col].to_numpy()
    y = frame[y_col].to_numpy()
    out = np.empty(n_boot)
    for b in range(n_boot):
        pick = rng.choice(labels, len(labels), replace=True)
        idx = np.concatenate([index[g] for g in pick])
        out[b] = fit_envelope(w[idx], y[idx], form, tau).drop_at(at_kj)
    return out


def critical_power(bests: dict[int, float], durations=(180, 300, 480, 600, 1200)) -> tuple[float, float]:
    """CP and W' from the linear work-time model W = CP * t + W', on 3-20 min
    mean-maximal power, the same fit the Training metrics use."""
    t = np.array([d for d in durations if d in bests and np.isfinite(bests[d])], float)
    if len(t) < 2:
        return float("nan"), float("nan")
    work = np.array([bests[int(d)] * d for d in t])
    cp, w_prime = np.polyfit(t, work, 1)
    return float(cp), float(max(w_prime, 0.0))


# --------------------------------------------------------------------------
# data assembly
# --------------------------------------------------------------------------

POWER_SPORTS = ("Ride", "VirtualRide", "GravelRide")
MAX_ZERO_SHARE = 0.35


def zero_share(stream) -> float:
    """Share of stored samples at exactly 0 W. Coasting outdoors is typically
    10-30%; far above that is a power meter that dropped out mid-ride."""
    w = np.nan_to_num(stream["watts"].to_numpy())
    return float(np.mean(w == 0)) if len(w) else float("nan")


def ride_mmp_table(acts, load_stream, durations=(300, 1200), bin_kj: float = 500.0):
    """Per ride and work bin, mean-maximal power, for rides with a power meter
    and a stored stream. Rides whose stream is mostly zeros are dropped."""
    import pandas as pd

    from .features import mmp_by_work, stream_total_kj

    keep = acts[acts["has_stream"] & acts["device_watts"] & acts["sport_type"].isin(POWER_SPORTS)]
    rows = []
    for a in keep.itertuples():
        st = load_stream(a.activity_id)
        if st is None or not np.isfinite(st["watts"]).any():
            continue
        zs = zero_share(st)
        if zs > MAX_ZERO_SHARE:
            continue
        mm = mmp_by_work(st, durations, bin_kj)
        if mm.empty:
            continue
        mm["activity_id"] = a.activity_id
        mm["start_local"] = a.start_local
        mm["sport_type"] = a.sport_type
        mm["total_kj"] = stream_total_kj(st)
        mm["zero_share"] = zs
        rows.append(mm)
    return pd.concat(rows, ignore_index=True)


def fitness_reference(acts, when, duration_s: int, days: int = 90) -> float:
    """Best full-resolution power for a duration in the `days` before `when`,
    from the 1 Hz bests the sync stored (never from the ride itself)."""
    window = acts[(acts["start_local"] < when) & (acts["start_local"] >= when - np.timedelta64(days, "D"))]
    vals = [pb.get(str(duration_s)) for pb in window["power_bests"] if pb and pb.get(str(duration_s))]
    return float(max(vals)) if vals else float("nan")


def recent_bests(acts, until, days: int = 365) -> dict[int, float]:
    window = acts[(acts["start_local"] <= until) & (acts["start_local"] > until - np.timedelta64(days, "D"))]
    out: dict[int, float] = {}
    for pb in window["power_bests"]:
        for k, v in (pb or {}).items():
            out[int(k)] = max(out.get(int(k), 0.0), float(v))
    return out


# --------------------------------------------------------------------------
# analysis helpers used by notebook 02
# --------------------------------------------------------------------------


def add_fitness_reference(mm, acts, days: int = 90):
    """Relative power: each ride-bin MMP over the best 1 Hz power for that
    duration in the `days` before the ride. Removes the slow drift of fitness
    across years, so rides from different seasons share one scale."""
    out = mm.copy()
    keys = out[["start_local", "duration_s"]].drop_duplicates()
    ref = {
        (r.start_local, r.duration_s): fitness_reference(acts, r.start_local, int(r.duration_s), days)
        for r in keys.itertuples()
    }
    out["reference_w"] = [ref[(t, d)] for t, d in zip(out["start_local"], out["duration_s"])]
    out["relative"] = out["mmp_w"] / out["reference_w"]
    return out


def composition_table(mm, duration_s: int, bins=(1, 2, 3, 4), tau: float = 0.9):
    """Upper quantile of MMP in the fresh bin against a later bin, two ways:
    across every ride, and within the cohort of rides that reached the later
    bin. The gap between the two is the composition bias of pooling."""
    import pandas as pd

    sub = mm[mm["duration_s"] == duration_s]
    reach = sub.groupby("activity_id")["bin"].transform("max")
    rows = []
    for b in bins:
        cohort = sub[reach >= b]
        fresh_all = sub[sub["bin"] == 0]["mmp_w"].quantile(tau)
        late_all = sub[sub["bin"] == b]["mmp_w"].quantile(tau)
        fresh_c = cohort[cohort["bin"] == 0]["mmp_w"].quantile(tau)
        late_c = cohort[cohort["bin"] == b]["mmp_w"].quantile(tau)
        rows.append(
            {
                "bin": b,
                "work_from_kj": b * 500,
                "rides_reaching": int(cohort["activity_id"].nunique()),
                "pooled_ratio": late_all / fresh_all,
                "cohort_ratio": late_c / fresh_c,
            }
        )
    return pd.DataFrame(rows)


def compare_forms(frame, y_col: str = "relative", tau: float = 0.9, n_splits: int = 5, late_kj: float = 1000.0, seed: int = 0):
    """Each envelope form fitted on all rides, and scored on held-out rides:
    pinball loss overall and exceedance of the envelope on late windows."""
    import pandas as pd

    rows, envs = [], {}
    w = frame["work_at_kj"].to_numpy()
    y = frame[y_col].to_numpy()
    folds = grouped_folds(frame["activity_id"].to_numpy(), n_splits, seed)
    for form in FORMS:
        env = fit_envelope(w, y, form, tau)
        envs[form] = env
        loss = 0.0
        exc = [0, 0]
        for tr, te in folds:
            e = fit_envelope(w[tr], y[tr], form, tau)
            q = e.predict(w[te])
            loss += _pinball(y[te], q, tau) * len(te)
            late = w[te] >= late_kj
            exc[0] += int(np.sum(y[te][late] > q[late]))
            exc[1] += int(late.sum())
        rows.append(
            {
                "form": form,
                "cv_pinball": loss / len(y),
                "late_exceedance": exc[0] / max(exc[1], 1),
                "late_n": exc[1],
                "drop_at_1500": env.drop_at(1500.0),
                "params": ", ".join(f"{p:.3g}" for p in env.params) or "-",
            }
        )
    return pd.DataFrame(rows), envs


def exceedance_by_bin(frame, envs: dict, y_col: str = "relative", n_splits: int = 5, seed: int = 0):
    """Held-out exceedance per work bin and form: a calibrated envelope sits
    near (1 - tau) in every bin, a wrong shape drifts with work."""
    import pandas as pd

    w = frame["work_at_kj"].to_numpy()
    y = frame[y_col].to_numpy()
    b = frame["bin"].to_numpy()
    rows = []
    folds = grouped_folds(frame["activity_id"].to_numpy(), n_splits, seed)
    for form, env in envs.items():
        above = np.zeros(len(y), bool)
        for tr, te in folds:
            e = fit_envelope(w[tr], y[tr], form, env.tau)
            above[te] = y[te] > e.predict(w[te])
        for k in np.unique(b):
            m = b == k
            rows.append({"form": form, "bin": int(k), "work_from_kj": int(k) * 500, "exceedance": float(above[m].mean()), "n": int(m.sum())})
    return pd.DataFrame(rows)


def within_ride_slope(mm, duration_s: int) -> tuple[float, int]:
    """Fixed-effects (within-ride) slope of log MMP on work done, per 1000 kJ:
    the average decline in how hard the rider *does* go, not how hard they can."""
    sub = mm[(mm["duration_s"] == duration_s)].copy()
    sub = sub[sub.groupby("activity_id")["bin"].transform("size") >= 2]
    ly = np.log(sub["mmp_w"])
    ly_d = ly - ly.groupby(sub["activity_id"]).transform("mean")
    w_d = sub["work_at_kj"] - sub.groupby("activity_id")["work_at_kj"].transform("mean")
    return float(np.sum(ly_d * w_d) / np.sum(w_d**2) * 1000.0), int(sub["activity_id"].nunique())
