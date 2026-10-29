"""Time-forward evaluation: production baseline, splits, metrics, conformal.

The baseline is production, replayed. For each rolling origin the calibration
is rebuilt by cycling_analytics.calibration.build_calibration from the efforts
recorded before that date and nothing else, and later efforts are predicted
the way apps/web/lib/physics.ts predicts them:

    per-segment fitted power      when the segment has enough attempts
    rider model (CP, W', grade)   otherwise, by fixed point
    still-air record fit          when there is no rider model either

Uncertainty is the same hand-made sigma physics.ts computes (wind spread from
gust headroom plus percentage priors for model and effort), ported here so its
intervals can be scored against the learned ones.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from statistics import NormalDist

import numpy as np
import pandas as pd

from . import MODELING_DIR  # noqa: F401  (puts cycling_analytics on sys.path)
from cycling_analytics.calibration import attempts_only, build_calibration
from cycling_analytics.physics import Rider, fit_power_still_air, ride_time, to_sections
from cycling_analytics.rider import RiderModel, mean_grade, predict_time, rho_of

from .data import CACHE_DIR, parse_utc

BASELINE_VERSION = "baseline-v1"


# --------------------------------------------------------------------------
# rolling origins
# --------------------------------------------------------------------------


def quarterly_origins(first: pd.Timestamp, last: pd.Timestamp, warmup_years: float = 2.0) -> list[pd.Timestamp]:
    """Quarter starts from `warmup_years` after the first effort to the last.

    Production rebuilds calibration on every scheduled run; a quarterly refit
    is a compromise between that and the cost of a refit (seconds each).
    """
    start = (first + pd.DateOffset(years=int(warmup_years))).to_period("Q").start_time
    start = start.tz_localize("UTC") if start.tzinfo is None else start
    out = []
    t = start
    while t <= last:
        out.append(t)
        t = t + pd.DateOffset(months=3)
    return out


def assign_origin(when: pd.Series, origins: list[pd.Timestamp]) -> pd.Series:
    """The latest origin at or before each timestamp (NaT if before the first)."""
    edges = pd.DatetimeIndex(origins)
    pos = edges.searchsorted(when, side="right") - 1
    return pd.Series([edges[p] if p >= 0 else pd.NaT for p in pos], index=when.index)


# --------------------------------------------------------------------------
# production prediction
# --------------------------------------------------------------------------


def _weather(row) -> dict:
    return {
        "wind_from_deg": float(row["wind_from_deg"]),
        "wind_speed_ms": float(row["wind_speed_ms"]),
        "gust_ms": float(row["gust_ms"]),
        "temperature_c": float(row["temperature_c"]),
        "pressure_hpa": float(row["pressure_hpa"]),
        "humidity_pct": float(row["humidity_pct"]),
    }


def production_sections(bundle: dict, segment: dict, sid: str):
    """Sections as the app builds them: the calibration's downsampled profile
    when it ships one, the segment's own otherwise."""
    shipped = (bundle.get("segments") or {}).get(sid) or {}
    profile = shipped.get("elevation_profile") or segment.get("elevation_profile")
    return to_sections(segment["points"], segment["average_grade"], profile)


def production_predict(bundle: dict, segment: dict, sid: str, weather: dict, record_s: float | None):
    """Predicted moving time, the branch that produced it, and the rider used."""
    sections = production_sections(bundle, segment, sid)
    if not sections:
        return float("nan"), "none", None, sections
    rm = bundle.get("rider")
    base = Rider(mass_kg=rm["mass_kg"], cda=rm["cda"]) if rm else Rider()
    shipped = (bundle.get("segments") or {}).get(sid) or {}
    rho = rho_of(weather)
    if shipped.get("power_w"):
        rider = Rider(shipped["power_w"], base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
        return ride_time(sections, rider, rho, weather["wind_from_deg"], weather["wind_speed_ms"]), "segment fit", rider, sections
    if rm:
        model = RiderModel(
            cp_w=rm["cp_w"],
            w_prime_j=rm["w_prime_j"],
            grade_w=rm["grade_w"],
            sample_count=rm.get("attempt_count", 0),
            grade_min=rm.get("grade_min", 0.0),
            grade_max=rm.get("grade_max", 0.0),
        )
        t = predict_time(sections, model, weather, base)
        # Recover the power the fixed point settled on, for the sigma below.
        power = model.power_at(t, mean_grade(sections))
        rider = Rider(power, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
        return t, "rider model", rider, sections
    if record_s:
        power = fit_power_still_air(sections, record_s, base)
        rider = Rider(power, base.mass_kg, base.cda, base.crr, base.drivetrain_efficiency)
        return ride_time(sections, rider, rho, weather["wind_from_deg"], weather["wind_speed_ms"]), "record fit", rider, sections
    return float("nan"), "none", None, sections


def physics_sigma(sections, rider: Rider, weather: dict, t_hat: float, calibrated: bool) -> float:
    """physics.ts evaluate(): wind spread from gust headroom, plus priors.

        windSigma   = 0.5 * max(0, gust - wind) + 0.12 * wind   (10 m, m/s)
        windTime    = |t(wind + windSigma) - t(wind - windSigma)| / 2
        model       = t * (0.025 calibrated | 0.03 otherwise)
        effort      = t * (0.04  calibrated | 0.05 otherwise)
        sigma       = sqrt(windTime^2 + model^2 + effort^2)

    physics.ts scales the 10 m wind to rider height before adding the spread;
    the log profile is linear, so adding at 10 m and letting ride_time scale is
    the same thing.
    """
    w = weather["wind_speed_ms"]
    headroom = max(0.0, weather.get("gust_ms", w) - w)
    spread = headroom * 0.5 + w * 0.12
    rho = rho_of(weather)
    hi = ride_time(sections, rider, rho, weather["wind_from_deg"], w + spread)
    lo = ride_time(sections, rider, rho, weather["wind_from_deg"], max(0.0, w - spread))
    wind_t = abs(hi - lo) / 2
    model = t_hat * (0.025 if calibrated else 0.03)
    effort = t_hat * (0.04 if calibrated else 0.05)
    return math.sqrt(wind_t**2 + model**2 + effort**2)


def _payload_before(payload: dict, origin: pd.Timestamp) -> dict:
    keep = [e for e in payload["efforts"] if parse_utc(e.get("start_date")) < origin]
    return {"segments": payload["segments"], "efforts": keep}


def _predict_block(args) -> list[dict]:
    """Rebuild calibration at one origin and predict that block's efforts."""
    payload, origin_iso, test_ids = args
    origin = pd.Timestamp(origin_iso)
    train = _payload_before(payload, origin)
    bundle = build_calibration(train)
    by_id = {str(e["effort_id"]): e for e in payload["efforts"]}
    out = []
    for eid in test_ids:
        e = by_id[eid]
        sid = str(e["segment_id"])
        seg = payload["segments"].get(sid)
        if not seg or not e.get("weather"):
            continue
        prior = [
            float(x.get("moving_time_s") or x["elapsed_time_s"])
            for x in train["efforts"]
            if str(x["segment_id"]) == sid
        ]
        record = min(prior) if prior else None
        weather = {**e["weather"]}
        weather.setdefault("gust_ms", weather.get("wind_speed_ms", 0.0))
        t_hat, branch, rider, sections = production_predict(bundle, seg, sid, weather, record)
        if not np.isfinite(t_hat):
            continue
        sigma = physics_sigma(sections, rider, weather, t_hat, branch == "segment fit")
        rm = bundle.get("rider") or {}
        out.append(
            {
                "effort_id": eid,
                "origin": origin_iso,
                "pred_s": t_hat,
                "branch": branch,
                "power_w": rider.power_w,
                "sigma_s": sigma,
                "train_efforts": len(train["efforts"]),
                "rider_cp_w": rm.get("cp_w"),
                "rider_mass_kg": rm.get("mass_kg"),
                "rider_cda": rm.get("cda"),
            }
        )
    return out


def evaluation_population(payload: dict) -> list[dict]:
    """Attempts: efforts ridden near this rider's hardest on the segment.

    Exactly the selection the existing backtests and the production fit use
    (calibration.attempts_only): on measured power, never on time, so it does
    not select on the outcome being predicted.
    """
    by_seg: dict[str, list[dict]] = {}
    for e in payload["efforts"]:
        if e.get("weather"):
            by_seg.setdefault(str(e["segment_id"]), []).append(e)
    return [a for effs in by_seg.values() for a in attempts_only(effs)]


def _cache_key(payload: dict, origins: list[pd.Timestamp]) -> str:
    h = hashlib.sha256()
    h.update(BASELINE_VERSION.encode())
    h.update(json.dumps([o.isoformat() for o in origins]).encode())
    for e in sorted(payload["efforts"], key=lambda e: str(e["effort_id"])):
        h.update(f"{e['effort_id']}|{e.get('moving_time_s')}|{e.get('start_date')}".encode())
    return h.hexdigest()[:16]


def baseline_predictions(
    payload: dict,
    origins: list[pd.Timestamp],
    refresh: bool = False,
    workers: int | None = None,
) -> pd.DataFrame:
    """Production predictions for every attempt, each from the calibration
    rebuilt at the latest origin before it. Cached by data and code version,
    because each rebuild takes seconds."""
    key = _cache_key(payload, origins)
    path = Path(CACHE_DIR) / "baseline" / f"{key}.json"
    if path.exists() and not refresh:
        return pd.DataFrame(json.loads(path.read_text()))

    attempts = evaluation_population(payload)
    frame = pd.DataFrame(
        {
            "effort_id": [str(a["effort_id"]) for a in attempts],
            "start_utc": [parse_utc(a["start_date"]) for a in attempts],
        }
    )
    frame["origin"] = assign_origin(frame["start_utc"], origins)
    frame = frame.dropna(subset=["origin"])
    jobs = [
        (payload, origin.isoformat(), grp["effort_id"].tolist())
        for origin, grp in frame.groupby("origin")
    ]
    # Biggest training sets first so the pool finishes evenly.
    jobs.sort(key=lambda j: j[1], reverse=True)
    workers = workers or max(1, min(8, (os.cpu_count() or 2) - 1))
    rows: list[dict] = []
    try:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for block in pool.map(_predict_block, jobs):
                rows.extend(block)
    except Exception:  # noqa: BLE001  (e.g. no process spawning in this host)
        rows = [r for job in jobs for r in _predict_block(job)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------


def point_metrics(actual: np.ndarray, pred: np.ndarray) -> dict:
    actual = np.asarray(actual, float)
    pred = np.asarray(pred, float)
    err = pred - actual
    return {
        "n": int(len(err)),
        "mae_s": float(np.mean(np.abs(err))),
        "mape": float(np.mean(np.abs(err) / actual)),
        "bias_s": float(np.mean(err)),
        "rmse_s": float(np.sqrt(np.mean(err**2))),
        "median_ae_s": float(np.median(np.abs(err))),
    }


def interval_metrics(actual, lo, hi) -> dict:
    actual, lo, hi = (np.asarray(x, float) for x in (actual, lo, hi))
    inside = (actual >= lo) & (actual <= hi)
    return {
        "coverage": float(inside.mean()),
        "width_s": float(np.median(hi - lo)),
        "rel_width": float(np.median((hi - lo) / actual)),
        "below": float((actual < lo).mean()),
        "above": float((actual > hi).mean()),
    }


def pinball(y, q_pred, tau: float) -> float:
    d = np.asarray(y, float) - np.asarray(q_pred, float)
    return float(np.mean(np.maximum(tau * d, (tau - 1) * d)))


def paired_bootstrap(
    abs_err_a: np.ndarray,
    abs_err_b: np.ndarray,
    groups: np.ndarray | None = None,
    n_boot: int = 2000,
    seed: int = 0,
) -> dict:
    """CI on MAE(a) - MAE(b), resampling whole groups (e.g. rides) so that
    efforts sharing a day's weather and legs are not treated as independent."""
    rng = np.random.default_rng(seed)
    a, b = np.asarray(abs_err_a, float), np.asarray(abs_err_b, float)
    if groups is None:
        groups = np.arange(len(a))
    labels, inv = np.unique(groups, return_inverse=True)
    sa = np.bincount(inv, weights=a)
    sb = np.bincount(inv, weights=b)
    cnt = np.bincount(inv)
    diffs = np.empty(n_boot)
    for i in range(n_boot):
        pick = rng.integers(0, len(labels), len(labels))
        diffs[i] = (sa[pick].sum() - sb[pick].sum()) / cnt[pick].sum()
    return {
        "diff_s": float(a.mean() - b.mean()),
        "lo_s": float(np.quantile(diffs, 0.025)),
        "hi_s": float(np.quantile(diffs, 0.975)),
        "p_a_better": float((diffs < 0).mean()),
    }


# --------------------------------------------------------------------------
# conformal prediction
# --------------------------------------------------------------------------


def conformal_quantile(scores: np.ndarray, alpha: float) -> float:
    """The finite-sample-valid (1 - alpha) quantile of calibration scores:
    the ceil((n + 1)(1 - alpha))-th smallest. Infinite when n is too small to
    promise that coverage at all."""
    s = np.sort(np.asarray(scores, float))
    n = len(s)
    k = math.ceil((n + 1) * (1 - alpha))
    if n == 0 or k > n:
        return float("inf")
    return float(s[k - 1])


def split_conformal(cal_resid: np.ndarray, alpha: float) -> float:
    """Half-width for a symmetric interval y_hat +- q, from |residuals|."""
    return conformal_quantile(np.abs(cal_resid), alpha)


def scaled_conformal(cal_resid: np.ndarray, cal_scale: np.ndarray, alpha: float) -> float:
    """Normalised (locally weighted) conformal: scores |r| / scale. The
    interval is y_hat +- q * scale, so a good difficulty estimate (here, the
    production sigma) shapes the width and the conformal step sets its size."""
    return conformal_quantile(np.abs(cal_resid) / np.asarray(cal_scale, float), alpha)


def cqr_adjustment(y_cal, lo_cal, hi_cal, alpha: float) -> float:
    """Conformalized quantile regression (Romano et al. 2019): how far to widen
    (or narrow, if negative) a quantile band so it covers 1 - alpha."""
    y, lo, hi = (np.asarray(x, float) for x in (y_cal, lo_cal, hi_cal))
    return conformal_quantile(np.maximum(lo - y, y - hi), alpha)


def normal_z(level: float) -> float:
    return NormalDist().inv_cdf(0.5 + level / 2)


# --------------------------------------------------------------------------
# outer folds for the residual model
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Fold:
    name: str
    test_start: pd.Timestamp
    test_end: pd.Timestamp
    train_idx: np.ndarray
    test_idx: np.ndarray


def yearly_folds(when: pd.Series, min_train: int = 60, min_test: int = 5) -> list[Fold]:
    """Expanding window, one calendar year of test at a time.

    Train on every residual before 1 January, test on that year. Every
    residual in training is itself out of sample (a production prediction from
    an earlier origin), so the model learns what production gets wrong going
    forwards, not how well it fits its own training data.
    """
    when = pd.to_datetime(when, utc=True)
    folds = []
    for year in sorted(when.dt.year.unique()):
        start = pd.Timestamp(f"{year}-01-01", tz="UTC")
        end = pd.Timestamp(f"{year + 1}-01-01", tz="UTC")
        train = np.flatnonzero((when < start).to_numpy())
        test = np.flatnonzero(((when >= start) & (when < end)).to_numpy())
        if len(train) >= min_train and len(test) >= min_test:
            folds.append(Fold(str(year), start, end, train, test))
    return folds


def time_ordered_split(idx: np.ndarray, when: pd.Series, cal_fraction: float = 0.3) -> tuple[np.ndarray, np.ndarray]:
    """Proper-training and calibration parts of a training set, by time: the
    most recent `cal_fraction` calibrates, which is the part most like the
    future the intervals will face."""
    order = idx[np.argsort(pd.to_datetime(when.iloc[idx], utc=True).to_numpy())]
    cut = int(round(len(order) * (1 - cal_fraction)))
    return order[:cut], order[cut:]


def usable_columns(frame: pd.DataFrame, cols: list[str], min_present: int = 20) -> list[str]:
    """Columns a model can learn from in this training window: present on at
    least `min_present` rows and not constant. Streams only start in later
    years, so early folds legitimately lose the in-ride features."""
    keep = []
    for c in cols:
        s = frame[c]
        if s.notna().sum() >= min_present and s.nunique(dropna=True) > 1:
            keep.append(c)
    return keep
