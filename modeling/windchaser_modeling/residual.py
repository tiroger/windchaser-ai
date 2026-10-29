"""Experiment 1: learning what the physics misses, and calibrating its intervals.

Target. y = log(actual / production prediction), the multiplicative residual:

  * Segments run from under a minute to half an hour. An additive residual in
    seconds would let a handful of long segments dominate every loss; a ratio
    puts a 3% miss on a two-minute climb and on a thirty-minute one on the same
    footing, which is how the physics errs (a wrong CdA or a power misjudged
    by a few percent scales the whole time).
  * The log makes it symmetric: 10% slow and 10% fast are equal and opposite,
    and a correction exp(y_hat) can never produce a negative time.
  * Intervals carry over directly: [exp(lo), exp(hi)] times the prediction.

Models are scored on the back-transformed time in seconds, the unit the app
shows and the unit the existing backtests report.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import evaluation as E
from .features import FORECAST_FEATURES, IN_RIDE_FEATURES

BASELINE_FEATURES = ["log_pred_s", "segment_fit"]
FORECAST = FORECAST_FEATURES + BASELINE_FEATURES
IN_RIDE = FORECAST + IN_RIDE_FEATURES

# Directions physics argues for, used by the monotonic variant only:
#   tailwind: the reanalysis wind at 10 m overstates what a rider meets on a
#             sheltered road, so more forecast tailwind should mean the physics
#             is more optimistic -> slower than predicted (+1)
#   ctl:      a fitter rider beats a prediction calibrated on the past (-1)
#   work/time before: fatigue within the ride slows the effort (+1)
#   precipitation: wet roads slow cornering and descents (+1)
MONOTONE = {
    "tailwind_ms": 1,
    "ctl": -1,
    "work_before_kj": 1,
    "time_before_min": 1,
    "precip_mm": 1,
}

SEED = 0


def build_dataset(baseline: pd.DataFrame, efforts: pd.DataFrame, features: pd.DataFrame) -> pd.DataFrame:
    """One row per scored attempt: production prediction, outcome, features."""
    d = baseline.merge(
        efforts[["effort_id", "moving_s", "start_utc", "segment_id", "activity_id", "average_watts"]],
        on="effort_id",
    )
    d = d.join(features, on="effort_id")
    d = d.sort_values("start_utc").reset_index(drop=True)
    d["y"] = np.log(d["moving_s"] / d["pred_s"])
    d["log_pred_s"] = np.log(d["pred_s"])
    d["segment_fit"] = (d["branch"] == "segment fit").astype(float)
    d["rel_sigma"] = d["sigma_s"] / d["pred_s"]
    d["year"] = d["start_utc"].dt.year
    return d


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------


def ridge():
    """Median imputation with missingness indicators, so 'no stream for this
    ride' is itself a feature rather than a silently filled zero."""
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True),
        StandardScaler(),
        RidgeCV(alphas=np.logspace(-1, 4, 30)),
    )


def hgb(quantile: float, monotone: list[int] | None = None):
    """Gradient boosting on the pinball loss. Native NaN handling: a missing
    value is routed down whichever branch fits best, learned per split.

    Heavily regularised (depth 3, 15 rows per leaf, 150 rounds at 0.05) because
    the largest training fold has about 250 rows."""
    return HistGradientBoostingRegressor(
        loss="quantile",
        quantile=quantile,
        max_depth=3,
        max_leaf_nodes=8,
        min_samples_leaf=15,
        learning_rate=0.05,
        max_iter=150,
        l2_regularization=1.0,
        monotonic_cst=monotone,
        random_state=SEED,
    )


@dataclass(frozen=True)
class Spec:
    name: str
    kind: str  # none | bias | ridge | hgb | hgb_mono
    features: tuple[str, ...]
    label: str


SPECS = [
    Spec("none", "none", (), "Production physics (no correction)"),
    Spec("bias", "bias", (), "Constant correction (median residual)"),
    Spec("ridge_fc", "ridge", tuple(FORECAST), "Ridge, forecast-time features"),
    Spec("hgb_fc", "hgb", tuple(FORECAST), "Boosted quantile, forecast-time"),
    Spec("hgb_mono", "hgb_mono", tuple(FORECAST), "Boosted quantile, monotone"),
    Spec("ridge_ir", "ridge", tuple(IN_RIDE), "Ridge, + in-ride features"),
    Spec("hgb_ir", "hgb", tuple(IN_RIDE), "Boosted quantile, + in-ride"),
]


def fit_predict(spec: Spec, train: pd.DataFrame, test: pd.DataFrame, quantile: float = 0.5):
    """Fit on train, predict log-residual for test. Returns (pred, model, cols)."""
    y = train["y"].to_numpy()
    if spec.kind == "none":
        return np.zeros(len(test)), None, []
    if spec.kind == "bias":
        return np.full(len(test), float(np.quantile(y, quantile))), None, []
    cols = E.usable_columns(train, list(spec.features))
    if spec.kind == "ridge":
        model = ridge().fit(train[cols], y)
    elif spec.kind == "hgb":
        model = hgb(quantile).fit(train[cols], y)
    elif spec.kind == "hgb_mono":
        model = hgb(quantile, [MONOTONE.get(c, 0) for c in cols]).fit(train[cols], y)
    else:
        raise ValueError(spec.kind)
    return model.predict(test[cols]), model, cols


def run_point_models(d: pd.DataFrame, folds: list[E.Fold], specs=SPECS) -> pd.DataFrame:
    """Out-of-sample prediction for every test row of every fold, long format."""
    rows = []
    for f in folds:
        train, test = d.iloc[f.train_idx], d.iloc[f.test_idx]
        for spec in specs:
            pred, _, cols = fit_predict(spec, train, test)
            rows.append(
                pd.DataFrame(
                    {
                        "effort_id": test["effort_id"].to_numpy(),
                        "fold": f.name,
                        "model": spec.name,
                        "label": spec.label,
                        "y_hat": pred,
                        "pred_s": test["pred_s"].to_numpy() * np.exp(pred),
                        "actual_s": test["moving_s"].to_numpy(),
                        "n_features": len(cols),
                    }
                )
            )
    out = pd.concat(rows, ignore_index=True)
    out["abs_err_s"] = (out["pred_s"] - out["actual_s"]).abs()
    return out


# --------------------------------------------------------------------------
# intervals
# --------------------------------------------------------------------------

LEVELS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95)


def run_intervals(d: pd.DataFrame, folds: list[E.Fold], levels=LEVELS, cal_fraction: float = 0.3) -> pd.DataFrame:
    """Intervals for every test row, every method, every nominal level.

    sigma (production)   t_hat +- z * sigma, the hand-made physics.ts model
    conformal            t_hat * exp(+-q), q from |y| of all earlier efforts
    sigma, conformal     t_hat * exp(+- q * sigma / t_hat), q from
                         |y| / (sigma / t_hat): production's shape,
                         conformally sized (about t_hat +- q * sigma)
    CQR (boosted)        boosted quantile band at (alpha/2, 1 - alpha/2),
                         fitted on the earlier 70% of training and widened by
                         the conformal correction from the most recent 30%

    The first three need no model fit, so every earlier effort calibrates
    them. CQR has to hold out a calibration slice, which costs it data.
    """
    rows = []
    for f in folds:
        train, test = d.iloc[f.train_idx], d.iloc[f.test_idx]
        y_tr = train["y"].to_numpy()
        t_hat = test["pred_s"].to_numpy()
        actual = test["moving_s"].to_numpy()
        proper_idx, cal_idx = E.time_ordered_split(f.train_idx, d["start_utc"], cal_fraction)
        proper, cal = d.iloc[proper_idx], d.iloc[cal_idx]
        cols = E.usable_columns(proper, FORECAST)
        for level in levels:
            alpha = 1 - level
            z = E.normal_z(level)
            bands = {
                "sigma (production)": (t_hat - z * test["sigma_s"].to_numpy(), t_hat + z * test["sigma_s"].to_numpy()),
            }
            q = E.split_conformal(y_tr, alpha)
            bands["conformal"] = (t_hat * np.exp(-q), t_hat * np.exp(q))
            qs = E.scaled_conformal(y_tr, train["rel_sigma"].to_numpy(), alpha)
            rel = test["rel_sigma"].to_numpy()
            bands["sigma, conformal"] = (t_hat * np.exp(-qs * rel), t_hat * np.exp(qs * rel))

            lo_m = hgb(alpha / 2).fit(proper[cols], proper["y"])
            hi_m = hgb(1 - alpha / 2).fit(proper[cols], proper["y"])
            adj = E.cqr_adjustment(cal["y"], lo_m.predict(cal[cols]), hi_m.predict(cal[cols]), alpha)
            lo_t = lo_m.predict(test[cols]) - adj
            hi_t = hi_m.predict(test[cols]) + adj
            bands["CQR (boosted)"] = (t_hat * np.exp(np.minimum(lo_t, hi_t)), t_hat * np.exp(np.maximum(lo_t, hi_t)))

            for method, (lo, hi) in bands.items():
                rows.append(
                    pd.DataFrame(
                        {
                            "effort_id": test["effort_id"].to_numpy(),
                            "fold": f.name,
                            "method": method,
                            "nominal": level,
                            "lo_s": lo,
                            "hi_s": hi,
                            "actual_s": actual,
                            "branch": test["branch"].to_numpy(),
                        }
                    )
                )
    out = pd.concat(rows, ignore_index=True)
    out["inside"] = (out["actual_s"] >= out["lo_s"]) & (out["actual_s"] <= out["hi_s"])
    out["width_pct"] = (out["hi_s"] - out["lo_s"]) / out["actual_s"]
    return out


def sigma_scale(d: pd.DataFrame, levels=(0.8, 0.9)) -> dict:
    """The deployable artefact: how much to scale physics.ts sigma, per branch,
    so that t_hat +- k * sigma covers the nominal share. Fitted on every scored
    effort (the backtest above is what justifies it)."""
    out = {}
    for branch, grp in [("all", d)] + list(d.groupby("branch")):
        entry = {"n": int(len(grp))}
        for level in levels:
            k = E.scaled_conformal(grp["y"].to_numpy(), grp["rel_sigma"].to_numpy(), 1 - level)
            entry[f"k_{int(level * 100)}"] = round(float(k), 3)
            entry[f"z_{int(level * 100)}"] = round(E.normal_z(level), 3)
        out[branch] = entry
    return out


# --------------------------------------------------------------------------
# analysis helpers used by the notebook
# --------------------------------------------------------------------------


def leaderboard(point: pd.DataFrame, d: pd.DataFrame, n_boot: int = 2000) -> pd.DataFrame:
    """Pooled metrics per model, with a ride-level bootstrap CI on the change
    in MAE against no correction, and the number of years each model wins."""
    groups = d.set_index("effort_id")["activity_id"]
    none = point[point.model == "none"].set_index("effort_id")["abs_err_s"]
    base_fold = point[point.model == "none"].groupby("fold")["abs_err_s"].mean()
    rows = []
    for spec in SPECS:
        p = point[point.model == spec.name].set_index("effort_id")
        if p.empty:
            continue
        m = E.point_metrics(p["actual_s"], p["pred_s"])
        if spec.name == "none":
            b = {"diff_s": 0.0, "lo_s": 0.0, "hi_s": 0.0, "p_a_better": float("nan")}
        else:
            b = E.paired_bootstrap(
                p["abs_err_s"].to_numpy(), none.loc[p.index].to_numpy(), groups.loc[p.index].to_numpy(), n_boot=n_boot, seed=SEED
            )
        per_fold = p.groupby("fold")["abs_err_s"].mean()
        rows.append(
            {
                "model": spec.name,
                "label": spec.label,
                **m,
                "delta_mae_s": b["diff_s"],
                "delta_lo_s": b["lo_s"],
                "delta_hi_s": b["hi_s"],
                "p_better": b["p_a_better"],
                "folds_better": int((per_fold < base_fold.loc[per_fold.index] - 1e-9).sum()),
                "folds": int(len(per_fold)),
            }
        )
    return pd.DataFrame(rows)


def permutation_importances(d: pd.DataFrame, folds: list[E.Fold], repeats: int = 20) -> pd.DataFrame:
    """Permutation importance of the boosted forecast-time model on each
    fold's held-out year, averaged with test-size weights. Units: increase in
    mean |log residual|, i.e. roughly a share of the effort's time."""
    from sklearn.inspection import permutation_importance

    rows = []
    for f in folds:
        tr, te = d.iloc[f.train_idx], d.iloc[f.test_idx]
        cols = E.usable_columns(tr, FORECAST)
        model = hgb(0.5).fit(tr[cols], tr["y"])
        r = permutation_importance(
            model, te[cols], te["y"], scoring="neg_mean_absolute_error", n_repeats=repeats, random_state=SEED
        )
        for c, mu in zip(cols, r.importances_mean):
            rows.append({"feature": c, "fold": f.name, "importance": mu, "n": len(te)})
    imp = pd.DataFrame(rows)
    return (
        imp.groupby("feature")
        .apply(
            lambda g: pd.Series(
                {
                    "importance": float(np.average(g["importance"], weights=g["n"])),
                    "folds_positive": int((g["importance"] > 0).sum()),
                    "folds": len(g),
                }
            ),
            include_groups=False,
        )
        .reset_index()
        .sort_values("importance", ascending=False)
        .reset_index(drop=True)
    )


def partial_dependence_curves(d: pd.DataFrame, features: list[str], grid: int = 30) -> pd.DataFrame:
    """Average partial dependence of a boosted model fitted on every scored
    attempt. Descriptive: the shape learned, not an out-of-sample effect."""
    from sklearn.inspection import partial_dependence

    cols = E.usable_columns(d, FORECAST)
    model = hgb(0.5).fit(d[cols], d["y"])
    rows = []
    for f in features:
        if f not in cols:
            continue
        res = partial_dependence(model, d[cols], [cols.index(f)], grid_resolution=grid, percentiles=(0.05, 0.95), kind="average")
        for x, y in zip(res["grid_values"][0], res["average"][0]):
            rows.append({"feature": f, "value": float(x), "effect": float(y)})
    return pd.DataFrame(rows)


def shuffled_target_check(d: pd.DataFrame, folds: list[E.Fold]) -> dict:
    """Train the boosted model on permuted residuals. A leak-free pipeline
    cannot beat the baseline this way."""
    rng = np.random.default_rng(SEED)
    errs, base = [], []
    for f in folds:
        tr = d.iloc[f.train_idx].copy()
        tr["y"] = rng.permutation(tr["y"].to_numpy())
        te = d.iloc[f.test_idx]
        cols = E.usable_columns(tr, FORECAST)
        pred = hgb(0.5).fit(tr[cols], tr["y"]).predict(te[cols])
        errs.append(np.abs(te["pred_s"] * np.exp(pred) - te["moving_s"]))
        base.append(np.abs(te["pred_s"] - te["moving_s"]))
    return {"shuffled_mae_s": float(np.concatenate(errs).mean()), "baseline_mae_s": float(np.concatenate(base).mean())}


def interval_table(intervals: pd.DataFrame, levels=(0.8, 0.9)) -> pd.DataFrame:
    """Coverage, median width and the standard error of coverage, per method
    and level, flat (one row per method and level)."""
    s = intervals[intervals["nominal"].isin(levels)]
    out = (
        s.groupby(["method", "nominal"])
        .agg(coverage=("inside", "mean"), width_pct=("width_pct", "median"), n=("inside", "size"))
        .reset_index()
    )
    out["coverage_se"] = np.sqrt(out["coverage"] * (1 - out["coverage"]) / out["n"])
    return out


MODEL_COLORS = {
    "Production physics (no correction)": "#5c6169",
    "Constant correction (median residual)": "#2f6fa9",
    "Ridge, forecast-time features": "#128857",
    "Boosted quantile, forecast-time": "#c45314",
    "Boosted quantile, monotone": "#9a6510",
    "Ridge, + in-ride features": "#7fa6cf",
    "Boosted quantile, + in-ride": "#b4272c",
}
METHOD_COLORS = {
    "sigma (production)": "#5c6169",
    "conformal": "#2f6fa9",
    "sigma, conformal": "#c45314",
    "CQR (boosted)": "#128857",
}
