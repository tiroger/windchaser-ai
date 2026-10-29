import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium", app_title="01 · Learning what the physics misses")


@app.cell(hide_code=True)
def _():
    import sys
    import json
    import warnings

    import marimo as mo

    _root = mo.notebook_dir().parent
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    warnings.filterwarnings("ignore", category=UserWarning)

    import altair as alt
    import numpy as np
    import pandas as pd

    from windchaser_modeling import charts as C
    from windchaser_modeling import data as D
    from windchaser_modeling import evaluation as E
    from windchaser_modeling import features as F
    from windchaser_modeling import residual as R

    C.enable()
    SEED = 0
    np.random.seed(SEED)
    return C, D, E, F, R, SEED, alt, json, mo, np, pd


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # Learning what the physics misses

    **Experiment 1 of the WindChaser modeling workspace.** Can a learned model
    correct the physics that predicts segment times, and can it replace the
    hand-made uncertainty with intervals that are honest about their coverage?

    Every number in the prose below is computed when the notebook runs, from the
    rider's own data. Nothing here is hard-coded; re-run on a newer snapshot and
    the conclusions rewrite themselves, including which way they go.
    """)
    return


@app.cell(hide_code=True)
def _(headline, mo):
    mo.callout(mo.md(headline), kind="info")
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 1. The problem

    For every segment and forecast hour, production predicts a **moving time**:
    power from the best available evidence, run through the physics
    (`packages/cycling-analytics`, mirrored by `apps/web/lib/physics.ts`):

    1. a **per-segment power** fitted across the rider's attempts on that
       segment in their real (ERA5) weather, when there are enough;
    2. otherwise the **rider model** `P = CP + W′/t + k·grade`, solved by
       fixed point for the segment's duration;
    3. otherwise power fitted to the segment record in still air.

    Around that point prediction, `physics.ts` builds a **σ** from three
    hand-set terms: a wind spread from gust headroom, plus 2.5–3% "model" and
    4–5% "effort" priors. That σ feeds `P(beat record) = Φ((target − t̂)/σ)`,
    so if it is too narrow the app is overconfident about records.

    Two questions:

    * **Point:** does a model of the *residual* (what the physics gets wrong)
      lower the error on future efforts?
    * **Interval:** do conformal methods give intervals whose stated coverage
      is their real coverage, and at what width compared with σ?
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    refresh = mo.ui.run_button(label="Refresh data from S3", kind="neutral")
    mo.vstack([
        mo.md("""
    ## 2. Data

    Read-only from the app data bucket (`APP_DATA_BUCKET`), cached under
    `modeling/.cache/` (gitignored). Re-runs use the cache and make no network
    call; in an interactive session the button re-lists the bucket and
    downloads whatever changed.
    """),
        refresh,
    ])
    return (refresh,)


@app.cell
def _(D, refresh):
    snapshot = D.sync(refresh=refresh.value)
    efforts_data = D.load_efforts()
    activities = D.load_activities()
    efforts = efforts_data.efforts
    segments = efforts_data.segments
    return activities, efforts, efforts_data, segments, snapshot


@app.cell(hide_code=True)
def _(activities, efforts, mo, segments, snapshot):
    _t = snapshot.table()
    mo.vstack([
        mo.md(f"""
    **Snapshot.** {len(efforts):,} segment efforts on {len(segments)} tracked
    segments, from {efforts.start_utc.min():%Y-%m} to {efforts.start_utc.max():%Y-%m};
    {len(activities):,} activities; {int(activities.has_stream.sum()):,} stored
    streams. Upstream modification times:
    """),
        mo.ui.table(_t, selection=None, show_column_summaries=False),
    ])
    return


@app.cell
def _(E, efforts, efforts_data):
    # Rolling origins: one calibration rebuild per quarter, starting two years
    # in so the first rebuild has something to fit.
    origins = E.quarterly_origins(efforts.start_utc.min(), efforts.start_utc.max())
    baseline = E.baseline_predictions(efforts_data.payload, origins)
    return baseline, origins


@app.cell
def _(D, F, activities, efforts, segments):
    # Feature engineering. Everything here is stamped with when it is known.
    segtab = F.segment_table(segments)
    hr_model = F.fit_hr_load_model(activities)
    loads = F.activity_load(activities, hr_model)
    daily = F.ewma_load(activities, loads)
    alignment = F.align_efforts(efforts, activities, segtab, D.load_stream)
    feats = F.effort_features(efforts, segments, segtab, alignment, daily, D.load_stream)
    return alignment, daily, feats, hr_model, loads, segtab


@app.cell
def _(E, R, baseline, efforts, feats):
    dataset = R.build_dataset(baseline, efforts, feats)
    folds = E.yearly_folds(dataset["start_utc"], min_train=60)
    return dataset, folds


@app.cell(hide_code=True)
def _(alignment, baseline, dataset, folds, hr_model, loads, mo, origins, pd):
    _src = loads.load_source.value_counts()
    _stream = alignment[alignment.offset_source == "stream"]
    _agree = alignment.zone_agrees.dropna()
    _n_test = int(sum(len(f.test_idx) for f in folds))
    mo.md(f"""
    ### What is scored

    **Population.** Production predicts what the rider does when they *attack*
    a segment, so the population is *attempts*: efforts ridden at ≥ 85% of the
    rider's 90th-percentile power on that segment
    (`calibration.attempts_only`, the selection every existing backtest uses).
    Selecting on measured power rather than time means the selection never
    looks at the outcome being predicted. That leaves **{len(baseline)}**
    attempts with a production prediction, from **{len(origins)}** quarterly
    calibration rebuilds.

    **Folds.** Calendar years, expanding window: train on every attempt before
    1 January, test on that year. A year needs 60 earlier attempts to train on,
    which gives **{len(folds)}** folds and **{_n_test}** held-out efforts
    ({", ".join(f.name for f in folds)}).

    **Aligning efforts with rides.** Efforts carry UTC instants; activities carry
    wall-clock times with a fake `Z`. The offset comes from the stream: where
    the ride passes the segment start fixes `local − UTC` to within the sample
    spacing, and a real offset is a whole number of quarter hours. Of the
    {len(_stream)} efforts whose ride has a stored stream, the implied offset
    landed within ±{_stream.stream_residual_s.abs().max():.0f} s of a quarter
    hour (median {_stream.stream_residual_s.abs().median():.0f} s). From those,
    each region's IANA zone was learned; it reproduces
    **{_agree.mean():.0%}** of the stream-derived offsets, daylight saving
    included, and supplies local time for the {int((alignment.offset_source == "zone").sum())}
    efforts without a stream. *Why not the zone alone?* The stream also gives
    the effort's position in the ride, which "work done before" needs, and it
    checks the zone rather than assuming it.

    **Training load.** A kJ-equivalent per activity: measured work where a
    power meter recorded it ({_src.get("power", 0)} activities), otherwise
    heart rate through the rider's own kJ/h ≈ {hr_model.intercept:.0f} +
    {hr_model.slope:.2f}·HR line (r = {hr_model.r:.2f} over {hr_model.n} rides;
    {_src.get("heart rate", 0)} activities), otherwise duration × the sport's
    median rate ({_src.get("duration", 0)}). Chronic and acute load are 42- and
    7-day exponentially weighted averages, taken **at the end of the previous
    day** so the effort's own ride never feeds its own state.
    """)
    return


@app.cell(hide_code=True)
def _(F, R, dataset, mo, pd):
    _timing = {c: "forecast-time" for c in F.FORECAST_FEATURES + R.BASELINE_FEATURES}
    _timing.update({c: "in-ride" for c in F.IN_RIDE_FEATURES})
    _why = {
        "gust_ms": "ERA5 gust; side gusts cost aero the physics' constant CdA ignores",
        "gust_excess_ms": "gust minus mean wind: turbulence, the σ's wind term",
        "wind_speed_ms": "mean 10 m wind",
        "tailwind_ms": "distance-weighted tailwind at rider height (what physics already uses)",
        "crosswind_ms": "distance-weighted crosswind at rider height (what physics ignores)",
        "temperature_c": "heat and cold affect output; density is already in the physics",
        "humidity_pct": "heat stress with temperature",
        "precip_mm": "wet roads: cornering, descending",
        "length_m": "segment length",
        "mean_grade": "distance-weighted gradient",
        "grade_sd": "gradient variability: steady power is a worse description of a rolling road",
        "max_grade": "steepest section",
        "local_hour": "time of day (traffic, light, warm-up)",
        "season_sin": "season, cyclic",
        "season_cos": "season, cyclic",
        "years_since_start": "slow drift not caught by recalibration",
        "effort_number": "earlier efforts on this segment: familiarity",
        "days_since_last": "days since this segment was last ridden",
        "ctl": "chronic load (42 d), end of the previous day",
        "atl": "acute load (7 d), end of the previous day",
        "tsb": "chronic minus acute: freshness",
        "log_pred_s": "the prediction itself (scale)",
        "segment_fit": "1 if a per-segment fit made the prediction, 0 for the rider model",
        "work_before_kj": "work done in the ride before the segment, from the stream",
        "time_before_min": "moving time in the ride before the segment",
        "prior_efforts_in_ride": "tracked segments already ridden in this ride",
        "prior_power_gap": "implied ÷ measured power on earlier efforts this ride: drafting hint",
    }
    _rows = [
        {
            "feature": c,
            "known": _timing[c],
            "present": float(dataset[c].notna().mean()),
            "meaning": _why.get(c, ""),
        }
        for c in R.IN_RIDE
    ]
    feature_table = pd.DataFrame(_rows)
    _missing = feature_table[(feature_table.known == "in-ride") & (feature_table.present < 0.99)]
    mo.vstack([
        mo.md(f"""
    ### Features and missingness

    Forecast-time features are known before the ride, so production could use
    them today. In-ride features need a live ride or a ride plan. Streams start
    in {dataset.loc[dataset.has_stream.astype(bool), "start_utc"].min():%Y}, so
    {", ".join(f"`{r.feature}` is present on {r.present:.0%}" for r in _missing.itertuples())}
    of scored efforts. The boosted models route missing values natively; ridge
    gets median imputation plus a missingness indicator, so "no stream" is a
    signal rather than a silent zero.

    **Deliberately excluded:** the effort's own measured power (it *is* the
    outcome: power sets time) and any implied power computed from the effort's
    own time. The drafting hint uses only efforts in the same ride that
    *finished before* this one started.
    """),
        mo.ui.table(
            feature_table.assign(present=lambda f: (f.present * 100).round(0).astype(int).astype(str) + "%"),
            selection=None,
            show_column_summaries=False,
            page_size=30,
        ),
    ])
    return (feature_table,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 3. Methodology

    **A fair baseline is production, replayed.** For each quarter, the
    calibration is rebuilt with `cycling_analytics.calibration.build_calibration`
    from the efforts recorded *before* that quarter, nothing later, and each
    attempt in the quarter is predicted exactly as `physics.ts` would: the same
    branch order, fitted mass and CdA, the calibration's downsampled elevation
    profile, the effort's real weather. The σ is `physics.ts`'s, ported
    line for line. Each attempt therefore has an out-of-sample production
    prediction, and the residual models learn from *those*: what production gets
    wrong going forward, not how well it fits its own training data.

    **Target:** $y = \log(t_\text{actual} / \hat t_\text{physics})$, the
    multiplicative residual. Segments run from under a minute to half an hour;
    a residual in seconds would let a few long segments dominate every loss,
    while the physics errs multiplicatively (a CdA or power off by a few
    percent scales the whole time). The log is symmetric, can never produce a
    negative time, and turns a band on $y$ into a band on time by `exp`. Every
    model is scored back in seconds.

    **Models**, all against "no correction":

    | Model | Definition |
    |:---|:---|
    | Constant | the median training residual (a pure bias fix) |
    | Ridge | standardised forecast-time features, α by generalised CV |
    | Boosted quantile | `HistGradientBoostingRegressor`, pinball loss, q = 0.5 (and 0.05/0.95, 0.1/0.9 … for intervals), depth 3, ≥ 15 rows per leaf |
    | Boosted, monotone | the same, constrained where physics argues a direction: tailwind ↑, CTL ↓, work before ↑, rain ↑ |
    | + in-ride | ridge and boosted with the stream features added |

    **Intervals**, each scored on the same held-out efforts at nominal
    50–95%:

    | Method | Interval |
    |:---|:---|
    | σ (production) | $\hat t \pm z\,\sigma$ |
    | Conformal | $\hat t\,e^{\pm q}$, with q the finite-sample conformal quantile of $\lvert y\rvert$ over every earlier attempt |
    | σ, conformal | $\hat t\,e^{\pm k\,\sigma/\hat t}$, k the conformal quantile of $\lvert y\rvert/(\sigma/\hat t)$: production's σ sets the *shape*, conformal sets the *size* |
    | CQR | conformalized quantile regression: boosted (α/2, 1−α/2) quantiles fitted on the earlier 70% of training, widened by the conformal correction from the most recent 30% |

    Conformal guarantees coverage when calibration and test residuals are
    exchangeable. Over years of fitness change they are not exactly, which is
    why the calibration data always precede the test year and why coverage is
    *measured* here rather than assumed.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 4. Results

    ### 4.1 The baseline, reproduced
    """)
    return


@app.cell
def _(E, dataset, pd):
    baseline_metrics = pd.DataFrame(
        [{"branch": "all", **E.point_metrics(dataset.moving_s, dataset.pred_s)}]
        + [
            {"branch": b, **E.point_metrics(g.moving_s, g.pred_s)}
            for b, g in dataset.groupby("branch")
        ]
    )
    return (baseline_metrics,)


@app.cell
def _(E, efforts_data):
    # The README's per-segment protocol (evaluate_calibration.py, model C),
    # re-run on this snapshot as a sanity check on the replay.
    reference_protocol = E.reference_protocol(efforts_data.payload)
    return (reference_protocol,)


@app.cell(hide_code=True)
def _(C, alt, baseline_metrics, dataset, mo, reference_protocol):
    _all = baseline_metrics.iloc[0]
    _sf = baseline_metrics.set_index("branch").loc["segment fit"] if "segment fit" in set(baseline_metrics.branch) else None
    _rm = baseline_metrics.set_index("branch").loc["rider model"] if "rider model" in set(baseline_metrics.branch) else None
    _pct = dataset.assign(err_pct=lambda d: (d.pred_s - d.moving_s) / d.moving_s)
    _chart = (
        alt.Chart(_pct)
        .mark_tick(thickness=2, size=18, opacity=0.6)
        .encode(
            x=alt.X("err_pct:Q", title="Prediction error (predicted − actual) / actual", axis=alt.Axis(format="%"), scale=alt.Scale(domain=[-0.35, 0.35], clamp=True)),
            y=alt.Y("branch:N", title=None),
            color=alt.Color("branch:N", legend=None),
            tooltip=["segment_name:N", alt.Tooltip("start_utc:T", format="%Y-%m-%d"), alt.Tooltip("moving_s:Q", title="actual s", format=".0f"), alt.Tooltip("pred_s:Q", title="predicted s", format=".0f"), alt.Tooltip("err_pct:Q", format="+.1%")],
        )
        .properties(width=560, height=150, title=C.titled("Production errors on future efforts, by branch", "Each tick is one attempt predicted from the calibration rebuilt before its quarter"))
    )
    _close = abs(_sf.mae_s - reference_protocol["mae_s"]) / reference_protocol["mae_s"] < 0.3 if _sf is not None else False
    mo.vstack([
        mo.md(f"""
    Replayed time-forward, production predicts the **{int(_all.n)}** scored
    attempts with **MAE {_all.mae_s:.1f} s** (MAPE {_all.mape:.1%}, bias
    {_all.bias_s:+.1f} s, where positive means the prediction was slower than
    the rider). By branch: per-segment fits **{_sf.mae_s:.1f} s** on {int(_sf.n)}
    attempts{f", the rider model **{_rm.mae_s:.1f} s** on {int(_rm.n)}" if _rm is not None else ""}.

    **Check against the known figures.** Re-running the README's own
    per-segment protocol (70/30 time-ordered split within each segment) on this
    snapshot gives **{reference_protocol["mae_s"]:.1f} s** on
    {reference_protocol["n"]} held-out attempts. The replay's per-segment branch
    is {"close to" if _close else "noticeably different from"} that
    ({_sf.mae_s:.1f} s){" and somewhat lower, as expected: production refits every quarter here, so each prediction is made from more recent data than a single 70/30 cut allows" if _sf.mae_s < reference_protocol["mae_s"] else ""}.
    The rider-model branch should be compared with the README's
    leave-one-segment-out figure only loosely: there it predicts segments it
    has never seen; here, mostly segments with too few attempts of their own.
    """),
        _chart,
        mo.ui.table(baseline_metrics.round(3), selection=None, show_column_summaries=False),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.2 Is there anything left to learn?

    Before fitting anything: does the residual move with any feature at all? Each
    panel is the log residual of production (positive = slower than predicted)
    against one feature, with a LOESS smooth. A flat smooth means the physics
    already has it.
    """)
    return


@app.cell
def _(R, dataset, np, pd):
    _rows = []
    for _c in R.IN_RIDE:
        _m = dataset[_c].notna()
        if _m.sum() < 20 or dataset.loc[_m, _c].nunique() < 2:
            continue
        _x = dataset.loc[_m, _c].to_numpy(float)
        _y = dataset.loc[_m, "y"].to_numpy()
        _r = float(np.corrcoef(_x, _y)[0, 1])
        _rs = float(pd.Series(_x).rank().corr(pd.Series(_y).rank()))
        _rows.append({"feature": _c, "n": int(_m.sum()), "pearson_r": _r, "spearman_r": _rs})
    signal = pd.DataFrame(_rows).sort_values("spearman_r", key=np.abs, ascending=False).reset_index(drop=True)
    return (signal,)


@app.cell(hide_code=True)
def _(C, alt, dataset, mo, np, signal):
    _top = signal.head(6).feature.tolist()
    _panels = [
        C.loess_scatter(
            dataset.dropna(subset=[_f]),
            _f,
            "y",
            _f,
            "log(actual / predicted)",
            f"{_f}  (ρ = {signal.set_index('feature').loc[_f, 'spearman_r']:+.2f})",
            tooltip=["segment_name:N", alt.Tooltip(f"{_f}:Q", format=".2f"), alt.Tooltip("y:Q", format="+.3f")],
            width=250,
            height=170,
        )
        for _f in _top
    ]
    _grid = alt.vconcat(*[alt.hconcat(*_panels[i : i + 3]) for i in range(0, len(_panels), 3)])
    _n = len(dataset)
    _crit = 1.96 / np.sqrt(_n)
    _strong = signal[signal.spearman_r.abs() > 2 * _crit]
    _first = signal.iloc[0]
    _tw = signal.set_index("feature").loc["tailwind_ms"] if "tailwind_ms" in set(signal.feature) else None
    mo.vstack([
        _grid,
        mo.md(f"""
    The strongest rank correlation is **{_first.feature}** (ρ = {_first.spearman_r:+.2f}
    over {_first.n} efforts). With {_n} efforts, |ρ| above roughly {_crit:.2f}
    is distinguishable from zero at 5% *for one pre-chosen feature*; with
    {len(signal)} features tested, about one would cross that line by chance.
    {len(_strong)} feature(s) clear twice that bar: {", ".join(f"`{f}`" for f in _strong.feature) or "none"}.

    {f"The tailwind relationship is the most interpretable: ρ = {_tw.spearman_r:+.2f}, so **the more tailwind the forecast promised, the slower the rider was than predicted**. The physics gives the rider the full ERA5 10 m wind scaled to rider height on every section; trees, buildings and terrain shelter real roads, so the model over-credits a tailwind and over-penalises a headwind. That is a structural error a residual model can learn, and also one that could be fixed inside the physics (see Next steps)." if _tw is not None and _tw.spearman_r > 2 * _crit else ""}
    Everything else is weak. Signal this small is easily swamped by the
    variance a flexible model adds, which is what the next section tests.
    """),
        mo.ui.table(signal.round(3), selection=None, show_column_summaries=False, page_size=10),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.3 Point models, fold by fold
    """)
    return


@app.cell
def _(R, dataset, folds):
    point = R.run_point_models(dataset, folds)
    return (point,)


@app.cell
def _(R, dataset, point):
    leaderboard = R.leaderboard(point, dataset)
    return (leaderboard,)


@app.cell(hide_code=True)
def _(C, R, alt, leaderboard, mo, pd, point):
    _fold = point.groupby(["fold", "model", "label"]).abs_err_s.mean().reset_index()
    _keep = ["none", "bias", "ridge_fc", "hgb_fc", "hgb_ir"]
    _lines = (
        alt.Chart(_fold[_fold.model.isin(_keep)])
        .mark_line(point=True)
        .encode(
            x=alt.X("fold:O", title="Test year"),
            y=alt.Y("abs_err_s:Q", title="MAE on that year's attempts (s)", scale=alt.Scale(zero=False)),
            color=alt.Color("label:N", title=None, scale=C.fixed_scale(R.MODEL_COLORS, _fold.label)),
            strokeDash=alt.StrokeDash("label:N", title=None, legend=None),
            tooltip=["fold:O", "label:N", alt.Tooltip("abs_err_s:Q", title="MAE s", format=".1f")],
        )
        .properties(width=640, height=280, title=C.titled("Fold-by-fold error", "Expanding window: each year predicted from models trained only on earlier years"))
    )
    _lb = leaderboard.copy()
    _lb["verdict"] = ["better" if h < 0 else ("worse" if l > 0 else "inconclusive") for l, h in zip(_lb.delta_lo_s, _lb.delta_hi_s)]
    _bars = alt.Chart(_lb[_lb.model != "none"]).encode(
        y=alt.Y("label:N", title=None, sort=None, axis=alt.Axis(labelLimit=320, labelFont=C.FONT)),
    )
    _ci = _bars.mark_rule(strokeWidth=2, color=C.INK_2).encode(
        x=alt.X("delta_lo_s:Q", title="Change in MAE against no correction (s), 95% CI by ride bootstrap"),
        x2="delta_hi_s:Q",
    )
    _pt = _bars.mark_point(filled=True, size=80).encode(
        x="delta_mae_s:Q",
        color=alt.Color("verdict:N", title=None, scale=alt.Scale(domain=["better", "inconclusive", "worse"], range=[C.OPEN, C.WIND, C.ALERT])),
        shape=alt.Shape("verdict:N", title=None, scale=alt.Scale(domain=["better", "inconclusive", "worse"], range=["circle", "diamond", "square"])),
        tooltip=["label:N", alt.Tooltip("mae_s:Q", format=".1f"), alt.Tooltip("delta_mae_s:Q", format="+.1f"), alt.Tooltip("delta_lo_s:Q", format="+.1f"), alt.Tooltip("delta_hi_s:Q", format="+.1f"), "folds_better:Q"],
    )
    _zero = alt.Chart(pd.DataFrame({"x": [0.0]})).mark_rule(color=C.INK_3, strokeDash=[4, 4]).encode(x="x:Q")
    _forest = alt.layer(_zero, _ci, _pt).properties(
        width=480, height=210, title=C.titled("Does any model beat the physics?", "Left of zero is better; the verdict is whether the whole 95% interval clears zero")
    )
    mo.vstack([_lines, _forest, mo.ui.table(leaderboard.drop(columns=["model"]).round(3), selection=None, show_column_summaries=False)])
    return


@app.cell(hide_code=True)
def _(leaderboard, mo):
    _base = leaderboard.set_index("model").loc["none"]
    _cand = leaderboard[leaderboard.model != "none"].sort_values("mae_s")
    _best = _cand.iloc[0]
    _sig = _cand[_cand.delta_hi_s < 0]
    _worse = _cand[_cand.delta_lo_s > 0]
    _ir = leaderboard.set_index("model").loc["hgb_ir"]
    _fc = leaderboard.set_index("model").loc["hgb_fc"]
    mo.md(f"""
    **Reading it.** With no correction, production scores **MAE
    {_base.mae_s:.1f} s** on {int(_base.n)} held-out attempts. The best
    candidate is *{_best.label}* at **{_best.mae_s:.1f} s**
    ({_best.delta_mae_s:+.1f} s, 95% CI {_best.delta_lo_s:+.1f} to
    {_best.delta_hi_s:+.1f} s){f", better in {_best.folds_better} of {_best.folds} years but by margins of a second or two" if _best.folds_better >= 0.75 * _best.folds and _best.delta_hi_s >= 0 else f", better in {_best.folds_better} of {_best.folds} years"}.
    {"**No model's improvement is distinguishable from zero**: every confidence interval crosses it." if _sig.empty else f"{len(_sig)} model(s) improve with an interval entirely below zero: {', '.join(_sig.label)}."}
    {f"{len(_worse)} model(s) are reliably *worse* than doing nothing: {', '.join(_worse.label)}." if len(_worse) else ""}

    Adding the in-ride features {"helps" if _ir.mae_s < _fc.mae_s else "does not help"}
    the boosted model ({_fc.mae_s:.1f} s → {_ir.mae_s:.1f} s). The stream
    features are only present for later years, so in the early folds there is
    nothing to learn them from, and in the later ones they add variance faster
    than signal. A constant shift ({leaderboard.set_index("model").loc["bias", "mae_s"]:.1f} s)
    is the simplest correction and a useful yardstick: anything more complex
    has to beat it, not just the uncorrected physics.
    """)
    return


@app.cell(hide_code=True)
def _(folds, mo):
    _largest = max(folds, key=lambda f: len(f.test_idx)).name if folds else None
    fold_pick = mo.ui.dropdown(options=[f.name for f in folds], value=_largest, label="Test year")
    model_pick = mo.ui.dropdown(
        options={"Constant correction": "bias", "Ridge": "ridge_fc", "Boosted": "hgb_fc", "Boosted, monotone": "hgb_mono", "Boosted + in-ride": "hgb_ir"},
        value="Boosted",
        label="Compare with",
    )
    mo.md(f"""
    #### Explore one fold

    {fold_pick} {model_pick}
    """)
    return fold_pick, model_pick


@app.cell(hide_code=True)
def _(C, R, alt, dataset, fold_pick, mo, model_pick, point):
    _sel = point[(point.fold == fold_pick.value) & point.model.isin(["none", model_pick.value])]
    _sel = _sel.merge(dataset[["effort_id", "segment_name", "branch"]], on="effort_id")
    _lo, _hi = float(_sel.actual_s.min()) * 0.9, float(_sel.actual_s.max()) * 1.1
    _sc = (
        alt.Chart(_sel)
        .mark_point(filled=True, size=50, opacity=0.75)
        .encode(
            x=alt.X("actual_s:Q", title="Actual moving time (s)", scale=alt.Scale(type="log", domain=[_lo, _hi])),
            y=alt.Y("pred_s:Q", title="Predicted (s)", scale=alt.Scale(type="log", domain=[_lo, _hi])),
            color=alt.Color("label:N", title=None, scale=C.fixed_scale(R.MODEL_COLORS, _sel.label)),
            shape=alt.Shape("label:N", title=None),
            detail="effort_id:N",
            tooltip=["segment_name:N", "branch:N", "label:N", alt.Tooltip("actual_s:Q", format=".0f"), alt.Tooltip("pred_s:Q", format=".0f"), alt.Tooltip("abs_err_s:Q", format=".0f")],
        )
    )
    _pairs = alt.Chart(_sel).mark_line(color=C.INK_3, strokeWidth=0.8, opacity=0.6).encode(x="actual_s:Q", y="pred_s:Q", detail="effort_id:N")
    _summary = _sel.groupby("label").abs_err_s.mean()
    mo.vstack([
        alt.layer(C.identity_line(_lo, _hi), _pairs, _sc).properties(width=480, height=380, title=C.titled(f"Predicted against actual, {fold_pick.value}", "Grey segments join the two predictions of the same effort; on the dashed line is perfect")),
        mo.md(" · ".join(f"**{k}** MAE {v:.1f} s" for k, v in _summary.items()) + f" on {_sel.effort_id.nunique()} attempts."),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.4 Where the error is

    Pooled held-out errors sliced by segment type, by production branch and by
    whether the ride had a stored stream (which decides whether the in-ride
    features exist).
    """)
    return


@app.cell(hide_code=True)
def _(C, R, alt, dataset, mo, point):
    _p = point[point.model.isin(["none", "bias", "hgb_fc", "hgb_ir"])].merge(
        dataset[["effort_id", "kind", "branch", "has_stream", "length_m"]], on="effort_id"
    )
    _p["stream"] = _p.has_stream.map({True: "stream", False: "no stream"})
    _charts = []
    for _by, _title in [("kind", "Segment type"), ("branch", "Production branch"), ("stream", "Stream available")]:
        _g = _p.groupby([_by, "label"]).agg(mae=("abs_err_s", "mean"), n=("abs_err_s", "size")).reset_index()
        _charts.append(
            alt.Chart(_g)
            .mark_bar()
            .encode(
                y=alt.Y(f"{_by}:N", title=None),
                yOffset=alt.YOffset("label:N"),
                x=alt.X("mae:Q", title="MAE (s)"),
                color=alt.Color("label:N", title=None, scale=C.fixed_scale(R.MODEL_COLORS, _g.label)),
                tooltip=[f"{_by}:N", "label:N", alt.Tooltip("mae:Q", format=".1f"), "n:Q"],
            )
            .properties(width=250, height=150, title=_title)
        )
    _base = _p[_p.model == "none"]
    _k = _base.groupby("kind").agg(mean=("abs_err_s", "mean"), size=("abs_err_s", "size"), length=("length_m", "median"))
    _k["mape"] = _base.assign(ape=_base.abs_err_s / _base.actual_s).groupby("kind").ape.mean()
    _worst = _k["mean"].idxmax()
    _longest = _k["length"].idxmax()
    _s = _base.groupby("stream").abs_err_s.mean()
    _gap = abs(_s.get("stream", 0) - _s.get("no stream", 0))
    mo.vstack([
        alt.hconcat(*_charts).resolve_scale(x="independent"),
        mo.md(f"""
    Production's largest absolute error is on **{_worst}** segments
    ({_k.loc[_worst, "mean"]:.0f} s over {int(_k.loc[_worst, "size"])} attempts,
    median length {_k.loc[_worst, "length"] / 1000:.1f} km).
    {"They are also the longest, so in relative terms the gap is smaller: " if _worst == _longest else "They are not the longest segments, so this is not just scale: "}
    {", ".join(f"{k} {r.mape:.1%}" for k, r in _k.iterrows())} mean absolute
    percentage error. Efforts from rides with a stored stream score
    {_s.get("stream", float("nan")):.0f} s against {_s.get("no stream", float("nan")):.0f} s
    without{": practically the same, so the in-ride features have no obvious gap to close" if _gap < 5 else "; part of that is era, since streams exist only for recent years"}.
    No correction changes the picture in any slice by more than a few seconds.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.5 What the models use

    Permutation importance of the boosted forecast-time model, measured on each
    fold's *held-out* year and averaged across folds (weighted by test size), so
    it reflects what generalises rather than what was memorised. Partial
    dependence is fitted on all scored attempts and is **descriptive only**:
    it shows the shape the model learned, not an out-of-sample effect.
    """)
    return


@app.cell
def _(R, dataset, folds):
    importance = R.permutation_importances(dataset, folds)
    partial = R.partial_dependence_curves(dataset, importance.feature.head(3).tolist())
    return importance, partial


@app.cell(hide_code=True)
def _(C, alt, importance, mo, np, partial):
    _imp_chart = (
        alt.Chart(importance.head(12).assign(pp=lambda d: d.importance * 100))
        .mark_bar(color=C.WIND)
        .encode(
            y=alt.Y("feature:N", sort="-x", title=None),
            x=alt.X("pp:Q", title="Held-out error added when shuffled (% of effort time)"),
            tooltip=["feature:N", alt.Tooltip("pp:Q", title="% of time", format=".3f"), "folds_positive:Q", "folds:Q"],
        )
        .properties(width=380, height=260, title="Permutation importance (held-out)")
    )
    _pdp = (
        alt.Chart(partial.assign(effect_pct=lambda d: np.expm1(d.effect)))
        .mark_line(color=C.EFFORT, strokeWidth=2.5)
        .encode(
            x=alt.X("value:Q", title=None, scale=alt.Scale(zero=False)),
            y=alt.Y("effect_pct:Q", title="Predicted time vs physics", axis=alt.Axis(format="+%")),
            tooltip=[alt.Tooltip("value:Q", format=".2f"), alt.Tooltip("effect_pct:Q", format="+.1%")],
        )
        .properties(width=200, height=160)
        .facet(column=alt.Column("feature:N", title=None, sort=importance.feature.head(3).tolist()), title="Partial dependence of the three most important features (descriptive)")
        .resolve_scale(x="independent")
    )
    _pos = importance[importance.importance > 0]
    _top = importance.iloc[0]
    _pd_tw = partial[partial.feature == "tailwind_ms"]
    mo.vstack([
        _imp_chart,
        _pdp,
        mo.md(f"""
    Only {len(_pos)} of {len(importance)} features raise held-out error when
    shuffled; the rest are, on average, noise the model would be better
    without. The most useful is **{_top.feature}**, positive in
    {int(_top.folds_positive)} of {int(_top.folds)} folds, and shuffling it costs
    only {_top.importance * 100:.2f}% of an effort's time.
    {f"Its learned shape agrees with the residual chart: from the weakest to the strongest forecast tailwind the model adds {np.expm1(_pd_tw.effect.iloc[-1]) - np.expm1(_pd_tw.effect.iloc[0]):+.1%} to the predicted time." if len(_pd_tw) else ""}
    Importances this small, and this unstable across folds, are what a model
    with almost nothing to learn looks like.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.6 Intervals: does stated coverage match real coverage?
    """)
    return


@app.cell
def _(R, dataset, folds):
    intervals = R.run_intervals(dataset, folds)
    return (intervals,)


@app.cell(hide_code=True)
def _(C, R, alt, intervals, mo):
    _rel = intervals.groupby(["method", "nominal"]).agg(coverage=("inside", "mean"), width_pct=("width_pct", "median"), n=("inside", "size")).reset_index()
    _chart = C.reliability_chart(_rel, "Interval reliability on held-out attempts", "On the dashed diagonal, stated coverage is real coverage; below it, too narrow", colors=R.METHOD_COLORS)
    _wc = _rel[_rel.nominal.isin([0.8, 0.9])]
    _dots = (
        alt.Chart(_wc.assign(level=lambda d: (d.nominal * 100).astype(int).astype(str) + "%"))
        .mark_point(filled=True, size=90)
        .encode(
            x=alt.X("width_pct:Q", title="Median interval width (share of actual time)", axis=alt.Axis(format="%")),
            y=alt.Y("coverage:Q", title="Empirical coverage", axis=alt.Axis(format="%"), scale=alt.Scale(zero=False)),
            color=alt.Color("method:N", title=None, scale=C.fixed_scale(R.METHOD_COLORS, _wc.method)),
            shape=alt.Shape("level:N", title="Nominal"),
            tooltip=["method:N", "level:N", alt.Tooltip("coverage:Q", format=".1%"), alt.Tooltip("width_pct:Q", format=".1%")],
        )
        .properties(width=380, height=300, title=C.titled("Coverage against width at 80% and 90%", "Up is safer, left is sharper"))
    )
    _rules = alt.Chart(_wc.drop_duplicates("nominal")).mark_rule(strokeDash=[3, 3], color=C.INK_3).encode(y="nominal:Q")
    mo.hstack([_chart, alt.layer(_rules, _dots)], widths="equal")
    return


@app.cell
def _(R, intervals):
    interval_summary = R.interval_table(intervals)
    interval_by_branch = (
        intervals[intervals.nominal.isin([0.8, 0.9])]
        .groupby(["branch", "method", "nominal"])
        .inside.mean()
        .unstack("nominal")
        .rename(columns=lambda c: f"{int(c * 100)}%")
    )
    return interval_by_branch, interval_summary


@app.cell(hide_code=True)
def _(interval_by_branch, interval_summary, mo):
    _t = interval_summary.set_index(["method", "nominal"])
    _cov = lambda m, l: _t.loc[(m, l), "coverage"]
    _wid = lambda m, l: _t.loc[(m, l), "width_pct"]
    _se = float(_t.loc[("sigma (production)", 0.9), "coverage_se"])
    _miss = {m: abs(_cov(m, 0.8) - 0.8) + abs(_cov(m, 0.9) - 0.9) for m in _t.index.get_level_values(0).unique()}
    _best = min(_miss, key=_miss.get)
    _sc, _cq = "sigma, conformal", "CQR (boosted)"
    _tie = abs(_cov(_sc, 0.9) - _cov(_cq, 0.9)) < 2 * _se and abs(_cov(_sc, 0.8) - _cov(_cq, 0.8)) < 2 * _se
    _s90 = _cov("sigma (production)", 0.9)
    mo.vstack([
        mo.md(f"""
    **Production's σ is {"too narrow" if _s90 < 0.9 - 2 * _se else ("too wide" if _s90 > 0.9 + 2 * _se else "about right")}.**
    Its nominal 80% intervals contain **{_cov("sigma (production)", 0.8):.0%}** of
    held-out attempts and its 90% intervals **{_s90:.0%}** (each ± about
    {_se:.0%} from sampling alone). Because `P(beat record)` is computed from the
    same σ, the app's record probabilities are
    {"overconfident: too sure in both directions" if _s90 < 0.9 - 2 * _se else "roughly calibrated"}.

    Closest to nominal at both levels is **{_best}**: {_cov(_best, 0.8):.0%} at
    80% and {_cov(_best, 0.9):.0%} at 90%, with a median 90% interval
    {_wid(_best, 0.9):.1%} of the effort's time wide against σ's
    {_wid("sigma (production)", 0.9):.1%}.
    {"Wider, which is the price of being right: σ's narrowness was false precision." if _wid(_best, 0.9) > _wid("sigma (production)", 0.9) else "Narrower as well."}

    {f"CQR, which uses the boosted quantile models, is statistically indistinguishable from σ-conformal ({_cov(_cq, 0.8):.0%} / {_cov(_cq, 0.9):.0%} coverage, {_wid(_cq, 0.9):.1%} wide at 90%). With equal performance the simpler method wins: σ-conformal is one number per level on top of what production already computes, CQR is two models per level to train, ship and monitor." if _tie else f"CQR, which uses the boosted quantile models, covers {_cov(_cq, 0.8):.0%} / {_cov(_cq, 0.9):.0%} at {_wid(_cq, 0.9):.1%} width; it pays for holding out 30% of each training window to calibrate."}
    The plain conformal band (no σ shape) covers {_cov("conformal", 0.8):.0%} /
    {_cov("conformal", 0.9):.0%} at {_wid("conformal", 0.9):.1%} width:
    {"wider than σ-conformal for similar or worse calibration, so production's σ carries real information about which efforts are uncertain (windy days, rider-model segments)." if _wid("conformal", 0.9) > _wid(_sc, 0.9) else "as sharp as σ-conformal, so σ's shape adds little."}
    """),
        mo.ui.table(interval_summary.round(3), selection=None, show_column_summaries=False),
        mo.md("Coverage by production branch (one shared conformal factor; a per-branch factor is the obvious refinement):"),
        mo.ui.table(interval_by_branch.round(3).reset_index(), selection=None, show_column_summaries=False),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.7 Leakage checks

    * **Time.** Every model, calibration and conformal quantile for a test year
      is fitted only on efforts before 1 January of that year (asserted below),
      and every training residual is itself an out-of-sample production
      prediction.
    * **Same-day state.** Training load is read at the end of the previous
      day; the effort's own ride never contributes (unit-tested in
      `scripts/test_modeling.py`).
    * **Same-ride information.** Work-before is integrated strictly before the
      effort's start in the stream; the drafting hint uses only efforts that had
      already finished.
    * **Shuffled target.** If the pipeline leaked, a model trained on shuffled
      residuals could still beat the baseline. It should not.
    """)
    return


@app.cell
def _(R, dataset, folds):
    for _f in folds:
        assert dataset.start_utc.iloc[_f.train_idx].max() < dataset.start_utc.iloc[_f.test_idx].min()
    shuffle_check = R.shuffled_target_check(dataset, folds)
    return (shuffle_check,)


@app.cell(hide_code=True)
def _(leaderboard, mo, shuffle_check):
    _real = leaderboard.set_index("model").loc["hgb_fc", "mae_s"]
    mo.md(f"""
    Time ordering holds on every fold. Trained on shuffled residuals, the boosted
    model scores **{shuffle_check["shuffled_mae_s"]:.1f} s** against the
    baseline's {shuffle_check["baseline_mae_s"]:.1f} s and the real model's
    {_real:.1f} s. {"Shuffling makes it worse than the baseline, as it should: there is no leak for it to exploit." if shuffle_check["shuffled_mae_s"] >= shuffle_check["baseline_mae_s"] else "Shuffling does not make it worse than the baseline, which means the baseline itself is beatable by noise-level adjustments (for example a bias shift absorbed through the intercept); the comparison to the real model is what matters."}
    {"The real model is no better than the shuffled one, which is the clearest evidence that its features carry no generalisable signal here." if _real >= shuffle_check["shuffled_mae_s"] - 0.5 else "The real model beats the shuffled one, so its features carry some signal, even if not enough to clear the baseline reliably."}
    """)
    return


@app.cell(hide_code=True)
def _(interval_summary, leaderboard, mo):
    _base = leaderboard.set_index("model").loc["none"]
    _cand = leaderboard[leaderboard.model != "none"].sort_values("mae_s").iloc[0]
    _point_ok = _cand.delta_hi_s < 0 and _cand.folds_better >= 0.75 * _cand.folds
    _t = interval_summary.set_index(["method", "nominal"]).coverage
    _int_ok = abs(_t[("sigma, conformal", 0.8)] - 0.8) <= 0.05 and abs(_t[("sigma, conformal", 0.9)] - 0.9) <= 0.04
    mo.md(f"""
    ## 5. Does it beat the physics?

    **Point correction: {"yes" if _point_ok else "no"}.** {"The best model lowers MAE from " + f"{_base.mae_s:.1f} s to {_cand.mae_s:.1f} s" + " with a confidence interval below zero and in most folds." if _point_ok else f"The best candidate, *{_cand.label}*, moves MAE from {_base.mae_s:.1f} s to {_cand.mae_s:.1f} s ({_cand.delta_mae_s / _base.mae_s:+.1%}), with a 95% interval of {_cand.delta_lo_s:+.1f} to {_cand.delta_hi_s:+.1f} s that {'crosses zero' if _cand.delta_hi_s >= 0 else 'excludes zero'}, winning {_cand.folds_better} of {_cand.folds} years by small margins. That is not evidence of an improvement worth changing production for. That a constant beats every model with features is itself the finding: at this sample size the features add variance faster than signal."}

    **Intervals: {"yes" if _int_ok else "partly"}.** Re-sizing production's own σ
    by a conformal factor turns {_t[("sigma (production)", 0.9)]:.0%}
    real coverage at a stated 90% into {_t[("sigma, conformal", 0.9)]:.0%}
    (and {_t[("sigma (production)", 0.8)]:.0%} into {_t[("sigma, conformal", 0.8)]:.0%} at 80%). It needs no new features and no
    model, only one number per level fitted from history, so it is cheap to ship
    and easy to monitor.

    **Caveats that bound these conclusions.**

    * **Sample size.** {int(_base.n)} held-out attempts over {leaderboard.folds.max()} years, on
      a few dozen segments, clustered in rides that share weather and legs. The
      bootstrap resamples whole rides for that reason. An improvement of a
      couple of seconds would need several times this data to detect.
    * **Non-stationarity.** Fitness and equipment change across years.
      Conformal coverage is exact only for exchangeable data, so the measured
      coverage above, not the theorem, is the evidence.
    * **One rider.** Everything here is personal calibration; nothing transfers
      to another rider without refitting.

    **What would have to be true to deploy a point correction:** an improvement
    whose confidence interval excludes zero, better in at least three quarters
    of the years, with the same sign of effect in each, on features available
    at forecast time. The tailwind effect is the one candidate that might get
    there, but the better home for it is the physics itself (a wind-exposure
    factor fitted inside calibration) rather than a learned layer on top.
    """)
    return


@app.cell
def _(D, R, dataset, json, snapshot):
    sigma_artefact = {
        "version": "sigma-conformal-1",
        "method": "normalised split conformal on log(actual / predicted), scores |y| / (sigma / t_hat)",
        "fitted_on_attempts": int(len(dataset)),
        "data_snapshot": snapshot.last_modified("efforts.json"),
        "usage": "replace z in t_hat +- z * sigma by k, or use t_hat * exp(+- k * sigma / t_hat)",
        "scale": R.sigma_scale(dataset),
    }
    _out = D.MODELING_DIR / "exports" / "sigma_conformal.json"
    _out.parent.mkdir(parents=True, exist_ok=True)
    _out.write_text(json.dumps(sigma_artefact, indent=2))
    artefact_path = _out
    return artefact_path, sigma_artefact


@app.cell(hide_code=True)
def _(artefact_path, json, mo, sigma_artefact):
    _all = sigma_artefact["scale"]["all"]
    mo.md(f"""
    ## 6. Path to production

    The point correction does not earn a place. The interval correction does, and
    it is small enough to ship as data:

    ```json
    {json.dumps(sigma_artefact["scale"], indent=2)}
    ```

    Written to `{artefact_path.relative_to(artefact_path.parents[2])}` (gitignored: it is
    fitted on personal data). In words: where production uses $z = 1.28$ for 80%
    it should use $k = {_all["k_80"]:.2f}$, and $k = {_all["k_90"]:.2f}$ instead of
    $1.64$ for 90%.

    **Plan.**

    1. **Fit where calibration is fitted.** Add the conformal step to
       `cycling_analytics.calibration.build_calibration`, which already runs in
       the Strava worker on every scheduled refresh. It needs out-of-sample
       residuals, which the worker can produce by replaying the last two years
       of attempts against calibrations rebuilt quarterly (this notebook's
       baseline, at a few seconds per rebuild).
    2. **Ship in `calibration.json`** as `sigma_scale: {{k_80, k_90, per_branch}}`
       next to the rider model, so the web app needs no new fetch.
    3. **Use in `physics.ts`.** `P(beat) = Φ((target − t̂)/σ)` assumes a
       normal; with conformal scales, use the implied σ′ = σ·k₉₀/1.645 so the
       90% band is right, and report the band itself in the breakdown.
    4. **Guard.** Fall back to today's σ when fewer than 50 scored attempts
       exist (k is then too noisy), and log empirical coverage of the last
       year in the worker so drift shows up before users notice it.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 7. Limitations

    * **Attempts only.** The population is efforts ridden near the rider's
      hardest, as in production. Casual efforts are far slower than any
      "attack" prediction and would dominate a residual model with a question
      production never asks.
    * **Weather is reanalysis.** The effort weather is ERA5 for the hour and
      0.1° cell, not a forecast. At prediction time production has a forecast,
      whose error would widen every interval here somewhat; the conformal
      factor should be refitted on forecast-time weather once enough forecasts
      are archived.
    * **Downsampled streams.** Work-before is integrated from ≤ 1,200 stored
      samples per ride; summed over a ride it matches the activity's kJ closely
      (see notebook 02), but short spikes are invisible.
    * **Group riding** is only hinted at (the earlier-effort power gap); nothing
      records who the rider was with.

    ## 8. Next steps

    1. **Wind exposure inside the physics.** Fit a per-segment (or per-road
       class) factor on the ERA5 wind inside `fit_power_from_efforts`, with
       shrinkage to a global value. The tailwind correlation says the physics
       over-credits wind; this is where to fix it.
    2. **Per-branch conformal factors**, and a separate factor for forecast
       lead time once forecasts are archived.
    3. **More efforts per segment.** The per-segment fit is the strongest
       predictor; tracking the most-ridden untracked segments (already
       backfilled by the worker) grows the scored set fastest.
    """)
    return


@app.cell(hide_code=True)
def _(interval_summary, leaderboard):
    _base = leaderboard.set_index("model").loc["none"]
    _cand = leaderboard[leaderboard.model != "none"].sort_values("mae_s").iloc[0]
    _t = interval_summary.set_index(["method", "nominal"]).coverage
    headline = (
        f"**Findings.** On {int(_base.n)} future attempts, production physics scores MAE "
        f"**{_base.mae_s:.1f} s**. The best learned correction scores {_cand.mae_s:.1f} s "
        f"({_cand.delta_mae_s:+.1f} s, 95% CI {_cand.delta_lo_s:+.1f} to {_cand.delta_hi_s:+.1f} s): "
        + ("**a real improvement**." if _cand.delta_hi_s < 0 else "**not distinguishable from no correction**.")
        + f" Production's σ covers {_t[('sigma (production)', 0.8)]:.0%} at a stated 80% and "
        f"{_t[('sigma (production)', 0.9)]:.0%} at 90%; re-sized conformally it covers "
        f"**{_t[('sigma, conformal', 0.8)]:.0%}** and **{_t[('sigma, conformal', 0.9)]:.0%}**."
        + (" Ship the interval fix, not the model." if _cand.delta_hi_s >= 0 else " Both the correction and the interval fix earn a place.")
    )
    return (headline,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ---
    *Reproducibility.* Seeds are fixed (`SEED = 0`) for every model and
    bootstrap. The production baseline is cached under
    `modeling/.cache/baseline/`, keyed by the efforts and the code version, and
    recomputed when either changes. Snapshot times are in section 2.
    """)
    return


if __name__ == "__main__":
    app.run()
