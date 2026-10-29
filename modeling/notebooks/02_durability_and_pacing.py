import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium", app_title="02 · Durability and pacing")


@app.cell(hide_code=True)
def _():
    import sys
    import math
    import warnings

    import marimo as mo

    _root = mo.notebook_dir().parent
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))
    warnings.filterwarnings("ignore", category=UserWarning)
    warnings.filterwarnings("ignore", category=RuntimeWarning)

    import altair as alt
    import numpy as np
    import pandas as pd
    from scipy.stats import theilslopes

    from windchaser_modeling import charts as C
    from windchaser_modeling import data as D
    from windchaser_modeling import durability as Du
    from windchaser_modeling import features as F
    from windchaser_modeling import pacing as P

    # On sys.path once windchaser_modeling is imported.
    from cycling_analytics.physics import Rider
    from cycling_analytics.rider import rho_of

    C.enable()
    SEED = 0
    np.random.seed(SEED)
    return C, D, Du, F, P, Rider, SEED, alt, math, mo, np, pd, rho_of, theilslopes


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    # Durability and pacing

    **Experiment 2 of the WindChaser modeling workspace.** How much does this
    rider's sustainable power fall as work accumulates within a ride, and what
    would a route plan gain by spending power where it buys the most time,
    instead of holding it constant?

    Every number in the prose is computed when the notebook runs.
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

    The route planner (`apps/web/lib/training/route-forecast.ts`) predicts a ride
    at **one constant power** for its whole length: by default the fitted rider
    model's power for a ride that long. Two things that matter for real rides are
    missing:

    * **Durability.** Power available after three hours is not the power
      available fresh. A model that ignores this overstates what a long ride can
      sustain late, and cannot say *when* to spend effort.
    * **Pacing.** At equal average power, riding harder up hills and into
      headwinds and easier down hills and with the wind is faster, because
      aerodynamic drag grows with the cube of air speed while climbing cost is
      linear in ground speed. Constant power leaves that time on the table.

    This notebook measures the first from the rider's own streams, turns it into
    a fatigue model, and uses both in a pacing optimiser on saved routes and on
    rides the rider has actually done.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    refresh = mo.ui.run_button(label="Refresh data from S3", kind="neutral")
    mo.vstack([
        mo.md("""
    ## 2. Data

    Same read-only cache as notebook 01 (`modeling/.cache/`, gitignored).
    """),
        refresh,
    ])
    return (refresh,)


@app.cell
def _(D, refresh):
    snapshot = D.sync(refresh=refresh.value)
    activities = D.load_activities()
    efforts_data = D.load_efforts()
    calibration = D.load_calibration()
    settings = D.load_settings()
    routes = D.load_routes()
    return activities, calibration, efforts_data, routes, settings, snapshot


@app.cell
def _(D, Du, F, activities, np, pd):
    # Rides with a power meter and a stored stream. For each: mean-maximal power
    # per work bin, and the downsampling check against the 1 Hz bests.
    mmp = Du.ride_mmp_table(activities, D.load_stream, durations=(60, 300, 1200))
    _checks = []
    _rides = activities[activities.activity_id.isin(mmp.activity_id.unique())]
    for _a in _rides.itertuples():
        _st = D.load_stream(_a.activity_id)
        _ds = F.downsampled_bests(_st, (60, 300, 1200, 3600))
        _spacing = float(np.median(np.diff(_st.t_s)))
        for _d, _v in _ds.items():
            _full = (_a.power_bests or {}).get(str(_d))
            if _full and np.isfinite(_v):
                _checks.append({"activity_id": _a.activity_id, "duration_s": _d, "downsampled_w": _v, "full_w": float(_full), "samples_per_window": _d / _spacing})
        _checks.append({"activity_id": _a.activity_id, "duration_s": 0, "downsampled_w": F.stream_total_kj(_st), "full_w": _a.kilojoules, "samples_per_window": np.nan})
    sampling_check = pd.DataFrame(_checks)
    sampling_check["ratio"] = sampling_check.downsampled_w / sampling_check.full_w
    return mmp, sampling_check


@app.cell(hide_code=True)
def _(C, Du, activities, alt, mmp, mo, np, sampling_check, snapshot):
    _dur = sampling_check[sampling_check.duration_s > 0].copy()
    _dur["window"] = _dur.duration_s.map({60: "1 min", 300: "5 min", 1200: "20 min", 3600: "60 min"})
    _q = _dur.groupby("window").ratio.describe(percentiles=[0.1, 0.5, 0.9])
    _kjf = sampling_check[sampling_check.duration_s == 0].dropna(subset=["downsampled_w", "full_w"])
    _kjf = _kjf[_kjf.full_w > 0]
    _kj = _kjf.ratio
    _kj_r = float(np.corrcoef(_kjf.downsampled_w, _kjf.full_w)[0, 1])
    _box = (
        alt.Chart(_dur)
        .mark_boxplot(extent=1.5, size=26, color=C.WIND, outliers=False, median=alt.MarkConfig(color=C.EFFORT, strokeWidth=2))
        .encode(
            x=alt.X("window:N", sort=["1 min", "5 min", "20 min", "60 min"], title="Window"),
            y=alt.Y("ratio:Q", title="Downsampled best ÷ 1 Hz best", scale=alt.Scale(domain=[0.92, 1.1], zero=False, clamp=True)),
        )
    )
    _band = C.hrule(1.0)
    _box_chart = alt.layer(_band, _box).properties(width=340, height=240, title=C.titled("Is the stored stream good enough?", "Per ride: best power from ≤ 1,200 stored samples against the 1 Hz best from the sync"))
    _spw = _dur[_dur.duration_s == 60].assign(spw=lambda d: d.samples_per_window.clip(upper=60))
    _scatter = (
        alt.Chart(_spw)
        .mark_circle(size=18, opacity=0.4, color=C.WIND)
        .encode(
            x=alt.X("spw:Q", title="Stored samples per 1-minute window"),
            y=alt.Y("ratio:Q", title="Downsampled ÷ 1 Hz (1 min)", scale=alt.Scale(domain=[0.8, 1.6], clamp=True)),
            tooltip=[alt.Tooltip("samples_per_window:Q", format=".1f"), alt.Tooltip("ratio:Q", format=".3f")],
        )
        .properties(width=300, height=240, title=C.titled("Why 1 minute fails", "Few samples per window: the maximum picks up noise"))
    )
    _hi = lambda w, p: _q.loc[w, p]
    mo.vstack([
        mo.md(f"""
    **Rides.** {mmp.activity_id.nunique()} rides with a power meter and a stored
    stream (outdoor and virtual), from {activities.loc[activities.activity_id.isin(mmp.activity_id), "start_local"].min():%Y-%m}
    to {activities.loc[activities.activity_id.isin(mmp.activity_id), "start_local"].max():%Y-%m}.
    Rides whose stream is more than {Du.MAX_ZERO_SHARE:.0%} exact zeros are
    dropped as power-meter dropouts. Activities snapshot: {snapshot.last_modified("activities.json")};
    streams: {snapshot.table().iloc[6].last_modified_utc}.

    **The downsampling limit.** Streams are stored as at most 1,200 samples
    *picked* from the 1 Hz recording, not averaged, so a 4-hour ride keeps one
    sample every 12 s or so. A window's mean over the samples inside it is
    unbiased, but its *maximum* over many windows is biased upward by noise, and
    more so the fewer samples a window holds. The sync computed 1 Hz bests before
    downsampling, which gives a direct check:
    """),
        alt.hconcat(_box_chart, _scatter),
        mo.md(f"""
    | Window | median ratio | 10th–90th percentile |
    |:---|---:|---:|
    {chr(10).join(f"| {w} | {_hi(w, '50%'):.3f} | {_hi(w, '10%'):.3f}–{_hi(w, '90%'):.3f} |" for w in ["1 min", "5 min", "20 min", "60 min"] if w in _q.index)}

    Five- and twenty-minute bests from the stored samples match the 1 Hz bests
    to within a couple of percent on most rides; one-minute bests do not (the
    90th percentile is {_hi("1 min", "90%") - 1:.0%} high, and the worst rides are
    far worse). **Durability is therefore measured at 5 and 20 minutes only.**
    Total work integrated from the samples matches Strava's kJ with a median
    ratio of {_kj.median():.3f} (r = {_kj_r:.4f} over {len(_kjf)} rides),
    so the work-done axis itself is sound.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 3. Methodology

    **Measurement.** For each ride and each window length (5, 20 min), slide a
    window along the ride's *moving* time (pauses capped, as in notebook 01) and
    record its mean power and the work done before it started. Within each
    500 kJ bin of work-before, keep the best window. That is mean-maximal power
    as a function of fatigue.

    **Two biases to remove before fitting anything.**

    1. *Composition.* Every ride contributes a fresh bin; only long rides
       reach 2,000 kJ. Fresh bins therefore include short races and interval
       sessions, late bins only endurance rides, and a pooled comparison
       measures ride type as much as fatigue. Fix: fit on the **long-ride
       cohort** (rides with at least 1,000 kJ), so every ride contributes to both
       ends.
    2. *Fitness drift.* Six years of riding span different fitness. Fix: express
       each value as a fraction of the rider's **best 1 Hz power for that window
       in the 90 days before the ride** (never including the ride itself).

    **Model.** Most rides are not maximal, so a mean through the points
    describes intent, not capacity. The model is an **upper envelope**: fitted by
    pinball loss at τ = 0.9, the level a ride exceeds 10% of the time. Forms, with
    W in kJ:

    | Form | $P(W)/P_0$ |
    |:---|:---|
    | flat | 1 (no durability effect; the null) |
    | linear | $1 - kW$ |
    | exponential | $e^{-kW}$ |
    | hinge | $1 - k\max(0, W - W_0)$ |

    **Validation.** Five folds holding out **whole rides**: the envelope is
    fitted on four fifths of the rides and scored on the rest, by pinball loss
    and by how often held-out late windows (≥ 1,000 kJ) exceed it. A calibrated
    envelope is exceeded about 10% of the time in every work bin; a model that
    ignores durability is exceeded too often fresh and too rarely late.
    Uncertainty on the headline metric comes from a bootstrap over rides.

    **Pacing optimiser.** For a route split into sections $i$ (the planner's own
    sectioning, coarsened to ≤ 100 for the optimiser), choose power $P_i$ to

    $$\min_P\; T(P) = \sum_i t_i(P_i)$$

    subject to

    * **same average:** $\sum_i P_i t_i \le \bar P \sum_i t_i$;
    * **bounded strain:** $\left(\sum_i P_i^4 t_i / \sum_i t_i\right)^{1/4} \le \mathrm{VI}\cdot\bar P$, a
      section-level normalised power. Without it a Skiba model treats every
      watt below CP as free, and the optimiser rides every climb at CP and
      coasts every descent, which the same legs would not do for four hours;
    * **W′ balance never negative**, Skiba's differential model, with CP
      lowered by the durability envelope as work accumulates;
    * $0 \le P_i \le P_\max$.

    $t_i(P_i)$ comes from `cycling_analytics.physics.section_speed`, the
    production solver, tabulated per section on a 10 W grid. SLSQP gets analytic
    gradients for time, mean power and strain. Optimised plans are never reported
    slower than the constant plan they start from.

    **Is the physics right about pacing at all?** Every optimiser gain rests on
    the physics' sensitivity of time to power. The rider's recorded rides test
    it: replay each ride through the physics at its *constant* mean power and at
    the power it *actually rode* on each section. If the physics is right,
    rides it says were well paced (as-ridden faster than constant) should
    really have been faster than the constant-power prediction, by the same
    amount.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 4. Results

    ### 4.1 Composition: why pooling every ride hides durability
    """)
    return


@app.cell(hide_code=True)
def _(C, Du, alt, mmp, mo, pd):
    _tabs = []
    for _d, _name in [(300, "5 min"), (1200, "20 min")]:
        _t = Du.composition_table(mmp, _d)
        _t["window"] = _name
        _tabs.append(_t)
    composition = pd.concat(_tabs, ignore_index=True)
    _long = composition.melt(id_vars=["window", "work_from_kj", "rides_reaching"], value_vars=["pooled_ratio", "cohort_ratio"], var_name="comparison", value_name="ratio")
    _long["comparison"] = _long.comparison.map({"pooled_ratio": "every ride pooled", "cohort_ratio": "rides that reached the bin"})
    _chart = (
        alt.Chart(_long)
        .mark_line(point=True)
        .encode(
            x=alt.X("work_from_kj:Q", title="Work done before the window (kJ, bin start)"),
            y=alt.Y("ratio:Q", title="90th-percentile power ÷ fresh", axis=alt.Axis(format="%"), scale=alt.Scale(zero=False)),
            color=alt.Color("comparison:N", title=None),
            strokeDash=alt.StrokeDash("comparison:N", title=None),
            tooltip=["window:N", "comparison:N", "work_from_kj:Q", alt.Tooltip("ratio:Q", format=".1%"), "rides_reaching:Q"],
        )
        .properties(width=300, height=230)
        .facet(column=alt.Column("window:N", title=None, sort=["5 min", "20 min"]), title=C.titled("Late power relative to fresh, two ways", "Same quantile; the only difference is which rides are compared"))
    )
    _c20 = composition[(composition.window == "20 min") & (composition.bin == 3)].iloc[0]
    mo.vstack([
        _chart,
        mo.md(f"""
    Pooling every ride, 20-minute power after 1,500 kJ looks
    {1 - _c20.pooled_ratio:.0%} below fresh. Comparing only the
    {_c20.rides_reaching} rides that actually reached 1,500 kJ, it is
    {1 - _c20.cohort_ratio:.0%} below. {"The pooled view understates durability loss" if _c20.cohort_ratio < _c20.pooled_ratio else "The two agree here"}: fresh
    bins pooled across every ride include short, hard sessions that long rides
    never contain, and those are a different population, not a fresher rider.
    The models below are fitted on the long-ride cohort.
    """),
    ])
    return (composition,)


@app.cell
def _(Du, activities, mmp):
    # Long-ride cohort, relative to recent fitness.
    MIN_RIDE_KJ = 1000.0
    TAU = 0.9
    _long = mmp[(mmp.total_kj >= MIN_RIDE_KJ) & mmp.duration_s.isin([300, 1200])]
    cohort = Du.add_fitness_reference(_long, activities).dropna(subset=["relative"])
    cohort = cohort[cohort.relative.between(0.2, 1.5)]
    return MIN_RIDE_KJ, TAU, cohort


@app.cell
def _(Du, TAU, cohort):
    form_tables, envelopes = {}, {}
    for _d in (300, 1200):
        _t, _e = Du.compare_forms(cohort[cohort.duration_s == _d], tau=TAU)
        form_tables[_d] = _t
        envelopes[_d] = _e
    # Among decline forms within 2% of the best held-out loss, take the
    # simplest: extrapolating past the data, fewer parameters is safer.
    _simplicity = ["linear", "exponential", "hinge"]
    best_form = {}
    for _d, _t in form_tables.items():
        _decl = _t[_t.form != "flat"].set_index("form").cv_pinball
        _ok = _decl[_decl <= _decl.min() * 1.02].index
        best_form[_d] = next(f for f in _simplicity if f in _ok)
    return best_form, envelopes, form_tables


@app.cell
def _(Du, SEED, TAU, best_form, cohort, np):
    # Bootstrap over rides for the headline metric: % drop after 1,500 kJ.
    drop_boot = {
        _d: Du.bootstrap_drop(cohort[cohort.duration_s == _d], "work_at_kj", "relative", "activity_id", best_form[_d], 1500.0, tau=TAU, n_boot=200, seed=SEED)
        for _d in (300, 1200)
    }
    drop_ci = {_d: (float(np.quantile(_b, 0.025)), float(np.median(_b)), float(np.quantile(_b, 0.975))) for _d, _b in drop_boot.items()}
    return (drop_ci,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.2 Durability envelopes, validated on held-out rides
    """)
    return


@app.cell(hide_code=True)
def _(MIN_RIDE_KJ, best_form, cohort, form_tables, mo, pd):
    _rows = []
    for _d, _t in form_tables.items():
        _rows.append(_t.assign(window=f"{_d // 60} min"))
    form_summary = pd.concat(_rows, ignore_index=True)[["window", "form", "cv_pinball", "late_exceedance", "late_n", "drop_at_1500", "params"]]
    _t20 = form_tables[1200].set_index("form")
    _b20 = best_form[1200]
    mo.vstack([
        mo.md(f"""
    Cohort: {cohort.activity_id.nunique()} rides of at least {MIN_RIDE_KJ:,.0f} kJ,
    {len(cohort)} ride-bin points. Held-out pinball loss (lower is better) and
    late-window exceedance (target 10%):
    """),
        mo.ui.table(form_summary.round(4), selection=None, show_column_summaries=False),
        mo.md(f"""
    For 20 minutes the chosen form is **{_b20}** (pinball
    {_t20.loc[_b20, "cv_pinball"]:.4f} against {_t20.loc["flat", "cv_pinball"]:.4f}
    for no durability, {(_t20.loc["flat", "cv_pinball"] - _t20.loc[_b20, "cv_pinball"]) / _t20.loc["flat", "cv_pinball"]:.0%} lower).
    The flat envelope is exceeded by only {_t20.loc["flat", "late_exceedance"]:.0%}
    of held-out late windows, against the {1 - 0.9:.0%} it promises: it is
    too high late in rides, which is what durability loss looks like. The
    {_b20} envelope is exceeded {_t20.loc[_b20, "late_exceedance"]:.0%} of the time
    late. The three decline forms are within
    {(_t20.drop("flat").cv_pinball.max() / _t20.drop("flat").cv_pinball.min() - 1):.1%} of
    each other in held-out loss, which the data cannot separate; the rule is to
    take the simplest decline form within 2% of the best, because a planner
    will extrapolate it to longer rides than most of the data covers.
    """),
    ])
    return (form_summary,)


@app.cell(hide_code=True)
def _(C, Du, alt, best_form, cohort, envelopes, mo):
    _d = 1200
    _sub = cohort[cohort.duration_s == _d]
    _exc = Du.exceedance_by_bin(_sub, {k: envelopes[_d][k] for k in ("flat", best_form[_d])})
    _exc = _exc[_exc.n >= 15]
    _chart = (
        alt.Chart(_exc)
        .mark_line(point=True)
        .encode(
            x=alt.X("work_from_kj:Q", title="Work done before the window (kJ, bin start)"),
            y=alt.Y("exceedance:Q", title="Held-out windows above the envelope", axis=alt.Axis(format="%")),
            color=alt.Color("form:N", title="Envelope"),
            strokeDash=alt.StrokeDash("form:N", title="Envelope"),
            tooltip=["form:N", "work_from_kj:Q", alt.Tooltip("exceedance:Q", format=".1%"), "n:Q"],
        )
    )
    _target = C.hrule(0.1, color=C.INK_3)
    mo.vstack([
        alt.layer(_target, _chart).properties(width=520, height=240, title=C.titled("Calibration by work done (20 min, held-out rides)", "A calibrated envelope sits on the 10% line in every bin; bins with fewer than 15 points omitted")),
        mo.md(f"""
    The flat envelope drifts from {_exc[(_exc.form == "flat")].exceedance.iloc[0]:.0%}
    exceedance fresh to {_exc[(_exc.form == "flat")].exceedance.iloc[-1]:.0%} in the
    last bin shown: it is set by fresh efforts and too generous late. The
    {best_form[_d]} envelope stays {"closer to the line throughout" if (_exc[_exc.form == best_form[_d]].exceedance - 0.1).abs().mean() < (_exc[_exc.form == "flat"].exceedance - 0.1).abs().mean() else "no closer to the line"}.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(C, alt, best_form, cohort, drop_ci, envelopes, mo, np, pd):
    _curves = []
    _grid = np.linspace(0, 3500, 71)
    for _d in (300, 1200):
        for _form in ("flat", best_form[_d]):
            _e = envelopes[_d][_form]
            _curves.append(pd.DataFrame({"work_kj": _grid, "relative": _e.predict(_grid), "form": _form, "window": f"{_d // 60} min"}))
    _curves = pd.concat(_curves)
    _pts = cohort.assign(window=lambda d: (d.duration_s // 60).astype(str) + " min")
    _scatter = alt.Chart(_pts).mark_circle(size=14, opacity=0.3, color=C.INK_3).encode(
        x=alt.X("work_at_kj:Q", title="Work done before the window (kJ)", scale=alt.Scale(domain=[0, 3500], clamp=True)),
        y=alt.Y("relative:Q", title="Power ÷ 90-day best for that window", axis=alt.Axis(format="%"), scale=alt.Scale(domain=[0.3, 1.2], clamp=True)),
        tooltip=[alt.Tooltip("work_at_kj:Q", format=".0f"), alt.Tooltip("relative:Q", format=".1%"), alt.Tooltip("mmp_w:Q", title="watts", format=".0f"), alt.Tooltip("start_local:T", format="%Y-%m-%d")],
    )
    _lines = alt.Chart(_curves).mark_line(strokeWidth=3).encode(
        x="work_kj:Q", y="relative:Q",
        color=alt.Color("form:N", title="Envelope (τ = 0.9)", scale=alt.Scale(domain=["flat", best_form[1200], best_form[300]], range=[C.INK_2, C.EFFORT, C.EFFORT])),
        strokeDash=alt.StrokeDash("form:N", title="Envelope (τ = 0.9)"),
    )
    _chart = alt.hconcat(*[
        alt.layer(_scatter.transform_filter(alt.datum.window == w), _lines.transform_filter(alt.datum.window == w)).properties(width=300, height=260, title=f"{w} power")
        for w in ("5 min", "20 min")
    ])
    _lo5, _m5, _hi5 = drop_ci[300]
    _lo20, _m20, _hi20 = drop_ci[1200]
    mo.vstack([
        _chart.properties(title=C.titled("The durability curve", "Each point: one ride's best window in one 500 kJ bin, relative to recent fitness. Lines: fitted upper envelopes")),
        mo.md(f"""
    **Durability metric.** After 1,500 kJ, the rider's 20-minute ceiling is
    **{_m20:.0%} lower** than fresh (95% bootstrap interval over rides:
    {_lo20:.0%} to {_hi20:.0%}); the 5-minute ceiling is {_m5:.0%} lower
    ({_lo5:.0%} to {_hi5:.0%}). For scale, 1,500 kJ is roughly
    {1500 / (cohort.mmp_w.median() * 3.6):.1f} hours at this cohort's typical
    working power.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(Du, cohort, drop_ci, mmp, mo, np):
    _slope, _n = Du.within_ride_slope(mmp[mmp.total_kj >= 1000], 1200)
    mo.md(f"""
    **Capacity against behaviour.** A within-ride (fixed-effects) regression of
    log 20-minute power on work done, over {_n} long rides, falls
    {1 - np.exp(_slope * 1.5):.0%} per 1,500 kJ: the average ride's best late
    effort is that much below its best early effort. That is
    {"much larger than" if 1 - np.exp(_slope * 1.5) > 1.5 * drop_ci[1200][1] else "similar to"} the
    envelope's {drop_ci[1200][1]:.0%}, and the gap is intent: late in a typical ride
    the rider is not trying to set a 20-minute best. The envelope is the right
    input for a planner that asks what *can* be held; the within-ride figure
    describes what usually *is*.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.3 The rider in the optimiser
    """)
    return


@app.cell
def _(Du, P, Rider, activities, best_form, calibration, envelopes, settings):
    # Physiology: CP and W' from the 1 Hz bests of the last 365 days, and the
    # 20-minute durability envelope as the factor on CP.
    bests = Du.recent_bests(activities, activities.start_local.max(), days=365)
    cp_w, w_prime_j = Du.critical_power(bests)
    _env = envelopes[1200][best_form[1200]]
    _f0 = float(_env.factor([0.0])[0])
    durability_factor = lambda w: _env.factor(w) / _f0  # noqa: E731
    physiology = P.Physiology(cp_w=cp_w, w_prime_j=w_prime_j, durability=durability_factor)
    physiology_fresh = P.Physiology(cp_w=cp_w, w_prime_j=w_prime_j)
    rider_model = calibration["rider"]
    _weight = (settings.get("athlete") or {}).get("weightKg")
    planner_rider = Rider(mass_kg=(_weight + 9.0) if _weight else rider_model["mass_kg"], cda=rider_model["cda"])
    P_MAX = float(bests.get(60, cp_w * 1.6))
    return P_MAX, bests, cp_w, physiology, physiology_fresh, planner_rider, rider_model, w_prime_j


@app.cell(hide_code=True)
def _(P_MAX, bests, cp_w, mo, planner_rider, w_prime_j):
    mo.md(f"""
    From the best 1 Hz power over 3–20 minutes in the last year,
    `W = CP·t + W′` gives **CP {cp_w:.0f} W** and **W′ {w_prime_j / 1000:.1f} kJ**
    (20-minute best {bests.get(1200, float("nan")):.0f} W). The optimiser caps any
    section at the one-minute best, {P_MAX:.0f} W. The physics uses the planner's
    rider: mass {planner_rider.mass_kg:.1f} kg (athlete weight plus 9 kg of bike
    and kit, as `plannerRider` does) and the calibrated CdA
    {planner_rider.cda:.3f} m².
    """)
    return


@app.cell(hide_code=True)
def _(efforts_data, mo, np, routes):
    # Prevailing wind from the efforts' reanalysis weather: a data-driven
    # "typical day" for the route survey below.
    _w = efforts_data.efforts.dropna(subset=["wind_from_deg"])
    _ang = np.radians(_w.wind_from_deg.to_numpy())
    prevailing_from = float((np.degrees(np.arctan2(np.sin(_ang).mean(), np.cos(_ang).mean())) + 360) % 360)
    prevailing_speed = float(_w.wind_speed_ms.median())
    _options = {f"{r.name} ({r.distance_m / 1000:.0f} km)": r.route_id for r in routes[routes.has_profile].sort_values("name").itertuples()}
    _default = max(_options, key=lambda k: routes.set_index("route_id").loc[_options[k], "elevation_gain_m"] / max(routes.set_index("route_id").loc[_options[k], "distance_m"], 1)) if _options else None
    route_pick = mo.ui.dropdown(options=_options, value=_default, label="Route", searchable=True)
    wind_from = mo.ui.slider(0, 345, step=15, value=int(round(prevailing_from / 15) * 15) % 360, label="Wind from (°)", show_value=True)
    wind_speed = mo.ui.slider(0.0, 10.0, step=0.5, value=round(prevailing_speed * 2) / 2, label="Wind at 10 m (m/s)", show_value=True)
    power_scale = mo.ui.slider(0.8, 1.2, step=0.02, value=1.0, label="Power budget × planner default", show_value=True)
    vi_cap = mo.ui.slider(1.0, 1.15, step=0.01, value=1.05, label="Allowed variability (NP ÷ mean)", show_value=True)
    mo.vstack([
        mo.md("""
    ### 4.4 Pacing one route

    Pick a saved route and a wind. The power budget starts at the planner's own
    default for that route (the rider model's power for a ride that long). The
    variability slider is the strain cap: 1.00 forces constant power.
    """),
        mo.hstack([route_pick, wind_from, wind_speed], justify="start", gap=1.5),
        mo.hstack([power_scale, vi_cap], justify="start", gap=1.5),
    ])
    return power_scale, prevailing_from, prevailing_speed, route_pick, vi_cap, wind_from, wind_speed


@app.cell
def _(D, F, P, P_MAX, physiology, physiology_fresh, planner_rider, power_scale, rider_model, route_pick, vi_cap, wind_from, wind_speed):
    _prof = D.load_route_profile(route_pick.value)
    route_sections = P.coarsen(F.route_sections(_prof.distance_m, _prof.altitude_m, _prof.lat, _prof.lng), 100)
    route_default_w = P.planner_default_power(route_sections, rider_model, planner_rider)
    route_budget_w = route_default_w * power_scale.value
    route_plans = P.compare_plans(route_sections, planner_rider, physiology, route_budget_w, vi_cap.value, wind_from.value, wind_speed.value, p_max=P_MAX)
    route_plans_fresh = P.optimise(route_plans["table"], route_budget_w, physiology_fresh, vi_cap=vi_cap.value, p_max=P_MAX)
    return route_budget_w, route_default_w, route_plans, route_plans_fresh, route_sections


@app.cell(hide_code=True)
def _(C, P, alt, mo, np, pd, route_budget_w, route_default_w, route_plans, route_plans_fresh, route_sections):
    _c, _o, _co = route_plans["constant"], route_plans["optimised"], route_plans["course"]
    _df = pd.DataFrame({
        "km": (route_sections.start_m + route_sections.length_m / 2) / 1000,
        "altitude_m": route_sections.altitude_m,
        "grade_pct": route_sections.grade * 100,
        "headwind_ms": _co.headwind_ms,
        "constant_w": _c.power_w,
        "optimised_w": _o.power_w,
        "cp_w": _o.cp_w,
        "wbal_kj": _o.w_balance_j / 1000,
    })
    _x = alt.X("km:Q", title="Distance (km)", scale=alt.Scale(domain=[0, float((route_sections.start_m + route_sections.length_m).max() / 1000)], nice=False))
    _elev = alt.Chart(_df).mark_area(color=C.LINE, opacity=0.9, line={"color": C.INK_3, "strokeWidth": 1}).encode(
        x=_x, y=alt.Y("altitude_m:Q", title="Elevation (m)"), tooltip=[alt.Tooltip("km:Q", format=".1f"), alt.Tooltip("grade_pct:Q", title="grade %", format=".1f")]
    ).properties(width=680, height=110, title=C.titled("Power along the route", "Elevation; power per plan, with CP as fatigue lowers it; headwind (orange) or tailwind (blue) per section; W′ balance"))
    _pw = _df.melt(id_vars=["km"], value_vars=["constant_w", "optimised_w", "cp_w"], var_name="series", value_name="watts")
    _pw["series"] = _pw.series.map({"constant_w": "constant (planner today)", "optimised_w": "optimised", "cp_w": "CP after fatigue"})
    _power = alt.Chart(_pw).mark_line(interpolate="step-after").encode(
        x=_x, y=alt.Y("watts:Q", title="Power (W)"),
        color=alt.Color("series:N", title=None, scale=alt.Scale(domain=["constant (planner today)", "optimised", "CP after fatigue"], range=[C.INK_2, C.EFFORT, C.WIND])),
        strokeDash=alt.StrokeDash("series:N", title=None, scale=alt.Scale(domain=["constant (planner today)", "optimised", "CP after fatigue"], range=[[1, 0], [1, 0], [4, 3]])),
        tooltip=[alt.Tooltip("km:Q", format=".1f"), "series:N", alt.Tooltip("watts:Q", format=".0f")],
    ).properties(width=680, height=200)
    _wind = alt.Chart(_df).mark_bar(width=3).encode(
        x=_x, y=alt.Y("headwind_ms:Q", title="Headwind (m/s)"),
        color=alt.condition("datum.headwind_ms > 0", alt.value(C.EFFORT), alt.value(C.WIND)),
        tooltip=[alt.Tooltip("km:Q", format=".1f"), alt.Tooltip("headwind_ms:Q", format="+.1f")],
    ).properties(width=680, height=80)
    _wb = alt.Chart(_df).mark_line(color=C.OPEN).encode(x=_x, y=alt.Y("wbal_kj:Q", title="W′ left (kJ)", scale=alt.Scale(zero=True))).properties(width=680, height=80)
    _gain = _c.total_s - _o.total_s
    _np = P.strain_np(_o.power_w, _o.time_s)
    _up = route_sections.grade.to_numpy() > 0.02
    _dp = _o.power_w - _c.power_w
    _fresh_gain = _c.total_s - route_plans_fresh.total_s
    _fmt = lambda s: f"{int(s // 3600)}:{int(s % 3600 // 60):02d}:{int(s % 60):02d}"
    mo.vstack([
        alt.vconcat(_elev, _power, _wind, _wb).resolve_scale(x="shared"),
        mo.md(f"""
    At **{route_budget_w:.0f} W** average (the planner default is
    {route_default_w:.0f} W), constant power takes **{_fmt(_c.total_s)}**. The
    optimised plan, at the same average ({_o.mean_power_w:.0f} W) and a
    normalised power of {_np:.0f} W, takes **{_fmt(_o.total_s)}**:
    **{_gain / 60:.1f} minutes faster ({_gain / _c.total_s:.1%})**. It rides the
    sections steeper than 2% at {(_o.power_w[_up].mean() if _up.any() else float("nan")):.0f} W on
    average and the rest at {(_o.power_w[~_up].mean() if (~_up).any() else float("nan")):.0f} W;
    power added correlates with gradient at r = {np.corrcoef(_dp, route_sections.grade)[0, 1]:+.2f}
    {f"and with headwind at r = {np.corrcoef(_dp, _co.headwind_ms)[0, 1]:+.2f}" if np.std(_co.headwind_ms) > 0 else "(no wind set)"}.
    {f"W′ is never drawn on (the plan never exceeds CP), so the binding constraints are the average and the variability cap ({_o.message})." if _o.w_balance_j.min() > 0.98 * _o.w_balance_j.max() else f"W′ bottoms out at {_o.w_balance_j.min() / 1000:.1f} kJ, so the hardest climbs are limited by it ({_o.message})."}
    Ignoring durability, the optimiser would claim {_fresh_gain / 60:.1f} minutes:
    {"fatigue costs the plan time because late climbs meet a lower CP" if _fresh_gain > _gain + 1 else "on this route and budget durability barely binds, because the plan rarely goes above the lowered CP"}.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(mo, prevailing_from, prevailing_speed):
    mo.md(f"""
    ### 4.5 Every saved route

    The same comparison over every saved route with a profile, at the planner's
    default power and an allowed variability of 1.05, in calm air and in the
    rider's prevailing wind (from {prevailing_from:.0f}° at
    {prevailing_speed:.1f} m/s, the circular mean direction and median speed
    of the reanalysis weather on their recorded efforts).
    """)
    return


@app.cell
def _(D, F, P, P_MAX, np, pd, physiology, planner_rider, prevailing_from, prevailing_speed, rider_model, routes):
    _rows, _sections = [], []
    for _r in routes[routes.has_profile].itertuples():
        _prof = D.load_route_profile(_r.route_id)
        _secs = P.coarsen(F.route_sections(_prof.distance_m, _prof.altitude_m, _prof.lat, _prof.lng), 100)
        if len(_secs) < 5:
            continue
        _w = P.planner_default_power(_secs, rider_model, planner_rider)
        for _case, (_from, _spd) in {"calm": (0.0, 0.0), "prevailing wind": (prevailing_from, prevailing_speed)}.items():
            _p = P.compare_plans(_secs, planner_rider, physiology, _w, 1.05, _from, _spd, p_max=P_MAX)
            _c, _o = _p["constant"], _p["optimised"]
            _rows.append({
                "route_id": _r.route_id, "route": _r.name, "case": _case, "km": _secs.length_m.sum() / 1000,
                "climb_m_per_km": float(np.sum(np.clip(_secs.grade, 0, None) * _secs.length_m) / _secs.length_m.sum() * 1000),
                "power_w": _w, "constant_s": _c.total_s, "optimised_s": _o.total_s,
                "gain_s": _c.total_s - _o.total_s, "gain_pct": (_c.total_s - _o.total_s) / _c.total_s, "converged": "success" in _o.message.lower() or "terminated" in _o.message.lower(),
            })
            _sections.append(pd.DataFrame({
                "route_id": _r.route_id, "case": _case, "grade": _secs.grade.to_numpy(), "headwind_ms": _p["course"].headwind_ms,
                "delta_w": _o.power_w - _c.power_w, "time_saved_s": _c.time_s - _o.time_s,
            }))
    route_survey = pd.DataFrame(_rows)
    route_sections_all = pd.concat(_sections, ignore_index=True)
    return route_sections_all, route_survey


@app.cell(hide_code=True)
def _(C, alt, mo, route_survey):
    _chart = (
        alt.Chart(route_survey)
        .mark_circle(size=55, opacity=0.75)
        .encode(
            x=alt.X("climb_m_per_km:Q", title="Climbing (m per km)"),
            y=alt.Y("gain_pct:Q", title="Time saved by optimised pacing", axis=alt.Axis(format="%")),
            color=alt.Color("case:N", title=None, scale=alt.Scale(domain=["calm", "prevailing wind"], range=[C.WIND, C.EFFORT])),
            shape=alt.Shape("case:N", title=None),
            tooltip=["route:N", "case:N", alt.Tooltip("km:Q", format=".0f"), alt.Tooltip("climb_m_per_km:Q", format=".1f"), alt.Tooltip("power_w:Q", format=".0f"), alt.Tooltip("gain_s:Q", title="saved s", format=".0f"), alt.Tooltip("gain_pct:Q", format=".1%")],
        )
        .properties(width=560, height=300, title=C.titled("Pacing gain across saved routes", "Planner-default power, same average power, variability ≤ 1.05"))
    )
    _s = route_survey.groupby("case").agg(median=("gain_pct", "median"), p10=("gain_pct", lambda s: s.quantile(0.1)), p90=("gain_pct", lambda s: s.quantile(0.9)), minutes=("gain_s", lambda s: s.median() / 60), n=("gain_pct", "size"))
    _r = route_survey[route_survey.case == "calm"]
    _corr = _r[["climb_m_per_km", "gain_pct"]].corr().iloc[0, 1]
    mo.vstack([
        _chart,
        mo.md(f"""
    Across {int(_s.loc["calm", "n"])} saved routes the median gain is
    **{_s.loc["calm", "median"]:.1%}** in calm air ({_s.loc["calm", "minutes"]:.1f} minutes;
    10th–90th percentile {_s.loc["calm", "p10"]:.1%}–{_s.loc["calm", "p90"]:.1%}) and
    **{_s.loc["prevailing wind", "median"]:.1%}** in the prevailing wind. Gain
    tracks climbing (r = {_corr:+.2f} with metres climbed per km): flat routes
    leave little to redistribute, hilly ones a lot.
    {int((~route_survey.converged).sum())} of {len(route_survey)} optimisations
    stopped on an iteration limit rather than converging; those keep the best
    feasible plan found, never one slower than constant.
    """),
    ])
    return


@app.cell(hide_code=True)
def _(C, alt, mo, np, pd, route_sections_all):
    _s = route_sections_all.copy()
    _s["grade_bin"] = pd.cut(_s.grade * 100, [-30, -6, -4, -2, 0, 2, 4, 6, 8, 30], labels=["< −6", "−6…−4", "−4…−2", "−2…0", "0…2", "2…4", "4…6", "6…8", "> 8"])
    _g = _s[_s.case == "calm"].groupby("grade_bin", observed=True).agg(delta_w=("delta_w", "mean"), saved_min=("time_saved_s", lambda x: x.sum() / 60), n=("delta_w", "size")).reset_index()
    _g["share"] = _g.saved_min / _g.saved_min.sum()
    _bars = alt.Chart(_g).mark_bar().encode(
        x=alt.X("grade_bin:N", title="Section gradient (%)", sort=None, axis=alt.Axis(labelAngle=0)),
        y=alt.Y("delta_w:Q", title="Optimised − constant power (W)"),
        color=alt.condition("datum.delta_w > 0", alt.value(C.EFFORT), alt.value(C.WIND)),
        tooltip=["grade_bin:N", alt.Tooltip("delta_w:Q", format="+.0f"), alt.Tooltip("share:Q", title="share of time saved", format=".0%"), "n:Q"],
    ).properties(width=330, height=230, title=C.titled("Where power goes (calm)", "Mean change in power by gradient"))
    _w = _s[(_s.case == "prevailing wind") & (_s.grade.abs() < 0.02)].copy()
    _w["head_bin"] = pd.cut(_w.headwind_ms, [-10, -2, -1, 0, 1, 2, 10], labels=["< −2", "−2…−1", "−1…0", "0…1", "1…2", "> 2"])
    _h = _w.groupby("head_bin", observed=True).agg(delta_w=("delta_w", "mean"), n=("delta_w", "size")).reset_index()
    _hb = alt.Chart(_h).mark_bar().encode(
        x=alt.X("head_bin:N", title="Headwind on flat sections (m/s)", sort=None, axis=alt.Axis(labelAngle=0)),
        y=alt.Y("delta_w:Q", title="Optimised − constant power (W)"),
        color=alt.condition("datum.delta_w > 0", alt.value(C.EFFORT), alt.value(C.WIND)),
        tooltip=["head_bin:N", alt.Tooltip("delta_w:Q", format="+.0f"), "n:Q"],
    ).properties(width=300, height=230, title=C.titled("…and into the wind", "Flat sections (|grade| < 2%), prevailing wind"))
    _climbs = _g.grade_bin.astype(str).isin(["2…4", "4…6", "6…8", "> 8"])
    _won = _g[_climbs].saved_min.sum()
    _lost = -_g[~_climbs].saved_min.sum()
    _routes = route_sections_all[route_sections_all.case == "calm"].route_id.nunique()
    _r_head = np.corrcoef(_w.delta_w, _w.headwind_ms)[0, 1] if len(_w) > 2 else float("nan")
    mo.vstack([
        alt.hconcat(_bars, _hb),
        mo.md(f"""
    **Where the time is gained.** In calm air the optimiser moves power from
    descents and flats to climbs. Summed over the {_routes} routes, sections
    steeper than 2% gain **{_won:.0f} minutes**{f", and the rest give back {_lost:.0f} by being ridden easier, a net {_won - _lost:.0f}" if _lost > 0 else f", and the rest a further {-_lost:.0f}"}. On a climb
    speed is low and drag small, so nearly every extra watt goes into going up;
    on a descent the same watt mostly fights air, so taking it away costs little.
    On flat sections in the prevailing wind, the change in power correlates
    with headwind at r = {_r_head:+.2f}:
    {("flat sections as a group give power up to the climbs, but those into the wind give up less" if (_h.delta_w < 0).all() else "more power into the wind and less with it") + (", for the same reason." if _r_head > 0.3 else "; the effect is in the right direction but weak, because at a median wind this light the climbs dominate where the power goes.")}
    """),
    ])
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ### 4.6 Checking against rides that happened

    Optimiser gains are only as good as the physics' sensitivity of time to
    power. Every outdoor ride with power is replayed through the physics on its
    own course, in the reanalysis wind of a tracked segment ridden that day
    where there is one (calm otherwise): at its mean power held constant, and at
    the power it actually rode on each section.
    """)
    return


@app.cell
def _(D, Du, P, activities, efforts_data, pd, physiology, planner_rider, rho_of):
    _weather = efforts_data.efforts.dropna(subset=["wind_speed_ms"]).groupby("activity_id").first()
    _out = activities[activities.has_stream & activities.device_watts & (activities.sport_type == "Ride")]
    _rows = []
    for _a in _out.itertuples():
        _st = D.load_stream(_a.activity_id)
        if _st is None or Du.zero_share(_st) > Du.MAX_ZERO_SHARE or _a.moving_s < 1200:
            continue
        _secs = P.ride_course(_st)
        if len(_secs) < 5:
            continue
        _w = _weather.loc[_a.activity_id] if _a.activity_id in _weather.index else None
        _kw = {"wind_from_deg": float(_w.wind_from_deg), "wind_speed_ms": float(_w.wind_speed_ms), "rho": rho_of(_w.to_dict())} if _w is not None else {}
        _rep = P.replay_ride(_st, _secs, planner_rider, physiology, **_kw)
        _rows.append({
            "activity_id": _a.activity_id, "name": _a.name, "start_local": _a.start_local, "km": _secs.length_m.sum() / 1000,
            "actual_s": _a.moving_s, "const_s": _rep["const_s"], "as_ridden_s": _rep["as_ridden_s"],
            "mean_power_w": _rep["mean_power_w"], "np_w": _rep["as_ridden_np_w"], "weather": "reanalysis" if _w is not None else "calm",
        })
    replays = pd.DataFrame(_rows)
    return (replays,)


@app.cell
def _(np, replays, theilslopes):
    _r = replays.copy()
    _r["x"] = np.log(_r.as_ridden_s / _r.const_s)
    _r["y"] = np.log(_r.actual_s / _r.const_s)
    # Steady-state physics cannot describe a section ridden at almost no power
    # on the flat (momentum carries the rider); those replays blow up.
    replay_fit = _r[np.isfinite(_r.x) & (_r.x.abs() < 0.5)].copy()
    _ts = theilslopes(replay_fit.y, replay_fit.x)
    pacing_slope = {"slope": float(_ts.slope), "lo": float(_ts.low_slope), "hi": float(_ts.high_slope), "intercept": float(_ts.intercept),
                    "r": float(np.corrcoef(replay_fit.x, replay_fit.y)[0, 1]), "n": int(len(replay_fit)), "dropped": int(len(_r) - len(replay_fit))}
    return pacing_slope, replay_fit


@app.cell(hide_code=True)
def _(C, alt, mo, np, pacing_slope, pd, replay_fit):
    _sc = alt.Chart(replay_fit).mark_circle(size=22, opacity=0.5).encode(
        x=alt.X("x:Q", title="Physics: as-ridden vs constant, log(time ratio)"),
        y=alt.Y("y:Q", title="Reality: actual vs constant prediction, log"),
        color=alt.Color("weather:N", title="Wind used", scale=alt.Scale(domain=["reanalysis", "calm"], range=[C.EFFORT, C.WIND])),
        tooltip=["name:N", alt.Tooltip("start_local:T", format="%Y-%m-%d"), alt.Tooltip("km:Q", format=".0f"), alt.Tooltip("mean_power_w:Q", format=".0f"), alt.Tooltip("x:Q", format="+.3f"), alt.Tooltip("y:Q", format="+.3f")],
    )
    _xs = np.linspace(replay_fit.x.min(), replay_fit.x.max(), 2)
    _fit = alt.Chart(pd.DataFrame({"x": _xs, "y": pacing_slope["intercept"] + pacing_slope["slope"] * _xs})).mark_line(color=C.INK, strokeWidth=2).encode(x="x:Q", y="y:Q")
    _one = alt.Chart(pd.DataFrame({"x": _xs, "y": pacing_slope["intercept"] + _xs})).mark_line(color=C.INK_3, strokeDash=[4, 4]).encode(x="x:Q", y="y:Q")
    _pv = replay_fit.melt(id_vars=["activity_id", "actual_s", "weather"], value_vars=["const_s", "as_ridden_s"], var_name="prediction", value_name="pred_s")
    _pv["prediction"] = _pv.prediction.map({"const_s": "constant power", "as_ridden_s": "as ridden"})
    _lim = [float(replay_fit.actual_s.min() / 60 * 0.9), float(replay_fit.actual_s.max() / 60 * 1.05)]
    _pa = alt.Chart(_pv.assign(actual_min=lambda d: d.actual_s / 60, pred_min=lambda d: d.pred_s / 60)).mark_circle(size=16, opacity=0.45).encode(
        x=alt.X("actual_min:Q", title="Actual moving time (min)", scale=alt.Scale(domain=_lim)),
        y=alt.Y("pred_min:Q", title="Physics prediction (min)", scale=alt.Scale(domain=_lim)),
        color=alt.Color("prediction:N", title=None, scale=alt.Scale(domain=["constant power", "as ridden"], range=[C.INK_2, C.EFFORT])),
        tooltip=["prediction:N", alt.Tooltip("actual_min:Q", format=".0f"), alt.Tooltip("pred_min:Q", format=".0f")],
    )
    _err = replay_fit.assign(ec=lambda d: (d.const_s - d.actual_s) / d.actual_s, ea=lambda d: (d.as_ridden_s - d.actual_s) / d.actual_s)
    mo.vstack([
        alt.hconcat(
            alt.layer(_one, _sc, _fit).properties(width=340, height=300, title=C.titled("Does the physics get pacing right?", "Solid: Theil–Sen fit. Dashed: slope 1 (physics exactly right)")),
            alt.layer(C.identity_line(*_lim), _pa).properties(width=300, height=300, title=C.titled("Predicted against actual", "Each recorded outdoor ride, two predictions")),
        ),
        mo.md(f"""
    Over {pacing_slope["n"]} outdoor rides ({pacing_slope["dropped"]} dropped
    where a near-zero-power section on the flat breaks steady-state physics),
    rides the physics says were paced better than constant really were faster
    than the constant prediction: slope **{pacing_slope["slope"]:.2f}** (95% CI
    {pacing_slope["lo"]:.2f}–{pacing_slope["hi"]:.2f}, r = {pacing_slope["r"]:.2f}).
    {"A slope near 1 would mean the physics is exactly right about pacing; this one is " + ("below 1 with confidence: the physics overstates how much pacing matters by about " + f"{1 - pacing_slope['slope']:.0%}" + ", so optimiser gains should be discounted accordingly." if pacing_slope["hi"] < 1 else "consistent with 1.") if pacing_slope["lo"] > 0 else "The slope is not distinguishable from zero: the physics' pacing sensitivity is not supported by these rides, and optimiser gains should not be trusted."}

    In absolute terms the physics is optimistic: at constant power it predicts
    a median {(-_err.ec.median()):.0%} faster than the rider's real moving time,
    and as ridden {(-_err.ea.median()):.0%} faster. Stops, slowing at junctions,
    acceleration and rough surfaces cost time no steady-state model sees;
    drafting in groups, which would push the other way, is evidently the
    smaller effect.
    This is why the planner states times from the rider model, which is fitted
    on real efforts, rather than from raw physics; and why the pacing result
    is reported as a relative gain.
    """),
    ])
    return


@app.cell
def _(D, F, P, activities, pd, physiology, planner_rider, replays):
    # Repeated loops: the same course ridden on several days.
    _cand = activities[activities.activity_id.isin(replays.activity_id)]
    _sigs = {}
    for _a in _cand.itertuples():
        _s = F.track_signature(D.load_stream(_a.activity_id))
        if _s:
            _sigs[_a.activity_id] = _s
    _groups = F.group_courses(_sigs, min_rides=3)
    _rows = []
    _rep = replays.set_index("activity_id")
    for _gi, (_founder, _members) in enumerate(sorted(_groups.items(), key=lambda kv: -len(kv[1]))):
        for _aid in _members:
            _st = D.load_stream(_aid)
            _secs = P.ride_course(_st)
            _r = _rep.loc[_aid]
            _vi = max(1.0, _r.np_w / _r.mean_power_w)
            _p = P.compare_plans(_secs, planner_rider, physiology, _r.mean_power_w, _vi)
            _rows.append({
                "course": f"Course {_gi + 1} ({_sigs[_founder]['length_m'] / 1000:.0f} km)", "activity_id": _aid, "name": _r["name"],
                "actual_s": _r.actual_s, "const_s": _r.const_s, "as_ridden_s": _r.as_ridden_s, "optimised_s": _p["optimised"].total_s,
                "mean_power_w": _r.mean_power_w, "vi": _vi,
            })
    loops = pd.DataFrame(_rows)
    return (loops,)


@app.cell(hide_code=True)
def _(C, alt, loops, mo, pacing_slope):
    if loops.empty:
        _out = mo.md("No course was ridden three or more times with power; nothing to compare.")
    else:
        _l = loops.assign(
            actual_min=lambda d: d.actual_s / 60,
            const_min=lambda d: d.const_s / 60,
            ridden_min=lambda d: d.as_ridden_s / 60,
            opt_min=lambda d: d.optimised_s / 60,
            gain_pct=lambda d: (d.as_ridden_s - d.optimised_s) / d.as_ridden_s,
        )
        _long = _l.melt(id_vars=["course", "activity_id", "name", "actual_min"], value_vars=["const_min", "ridden_min", "opt_min"], var_name="plan", value_name="pred_min")
        _long["plan"] = _long.plan.map({"const_min": "constant power", "ridden_min": "as ridden", "opt_min": "optimised (same mean & NP)"})
        _chart = alt.Chart(_long).mark_point(filled=True, size=55, opacity=0.8).encode(
            x=alt.X("actual_min:Q", title="Actual moving time (min)", scale=alt.Scale(zero=False)),
            y=alt.Y("pred_min:Q", title="Physics time (min)", scale=alt.Scale(zero=False)),
            color=alt.Color("plan:N", title=None, scale=alt.Scale(domain=["constant power", "as ridden", "optimised (same mean & NP)"], range=[C.INK_2, C.WIND, C.EFFORT])),
            shape=alt.Shape("plan:N", title=None),
            tooltip=["course:N", "name:N", "plan:N", alt.Tooltip("actual_min:Q", format=".1f"), alt.Tooltip("pred_min:Q", format=".1f")],
        ).properties(width=200, height=200).facet(facet=alt.Facet("course:N", title=None), columns=3).resolve_scale(x="independent", y="independent")
        _g = _l.groupby("course").agg(rides=("activity_id", "size"), actual_sd=("actual_min", "std"), gain=("gain_pct", "median"))
        _out = mo.vstack([
            mo.md(f"""
    **Repeated loops.** {len(_g)} courses were ridden at least three times with
    power ({len(_l)} rides, matched by GPS track as the Training section does:
    same start and finish, length within 10%, 85% of each track near the
    other). Few, and many look like group rides by their names, so they test
    the physics under drafting it does not model. On these rides an optimised
    plan at the *same mean and normalised power the rider actually produced*
    would have been a median **{_l.gain_pct.median():.1%}** faster than as
    ridden in the physics, or about {_l.gain_pct.median() * pacing_slope["slope"]:.1%}
    after the discount above.
    """),
            _chart.properties(title=C.titled("Same course, different days", "Each panel one course; on the diagonal the physics matches reality")),
        ])
    _out
    return


@app.cell(hide_code=True)
def _(drop_ci, mo, pacing_slope, route_survey):
    _calm = route_survey[route_survey.case == "calm"].gain_pct.median()
    _wind = route_survey[route_survey.case == "prevailing wind"].gain_pct.median()
    _disc = pacing_slope["slope"]
    mo.md(f"""
    ## 5. Interpretation

    * **Durability is real and measurable for this rider.** The 20-minute
      ceiling falls about {drop_ci[1200][1]:.0%} by 1,500 kJ
      ({drop_ci[1200][0]:.0%}–{drop_ci[1200][2]:.0%}), and an envelope that knows
      this beats a flat one on held-out rides. It is moderate, which matters
      for how it is used: it shifts *when* hard efforts are affordable more than
      it changes what a ride costs.
    * **Pacing is worth minutes, mostly on hills.** At the planner's own power
      and a modest allowed variability, a plan that pushes climbs and headwinds
      saves a median {_calm:.1%} in calm air and {_wind:.1%} in the prevailing
      wind. After discounting by the physics' measured over-sensitivity
      (slope {_disc:.2f}), expect roughly {_calm * _disc:.1%} in practice.
    * **The physics is right about direction, not about absolute times.** It is
      consistently optimistic about real moving time (stops, traffic, surface),
      which is why gains should be stated relative to the constant plan, never
      as an absolute finish time from raw physics.

    ## 6. Limitations

    * **Downsampled streams** restrict durability to windows of five minutes
      and longer; one-minute power and sprints are out of reach until 1 Hz
      streams are kept for some rides.
    * **Capacity is inferred, not tested.** The envelope's 90th percentile
      assumes that one ride in ten near a given fatigue was close to maximal.
      If the rider rarely goes hard late, the envelope understates late
      capacity and durability looks worse than it is.
    * **Weather in replays** is one reanalysis hour from one segment, or calm.
      Wind varies over a three-hour ride, which adds noise to the pacing check
      (and dilutes its slope toward zero, so the discount is if anything
      conservative).
    * **The strain cap is a modelling choice.** The gain scales with the
      variability allowed; 1.05 is conservative next to the section-level
      variability the rider actually rides with. Below the cap, the Skiba
      model treats CP as free, which is optimistic for multi-hour efforts;
      durability partly corrects for that.
    * **No drafting, no traffic.** Group rides and junctions are outside the
      model; repeated loops are few and mostly social.

    ## 7. Path to production

    How the route planner (`route-forecast.ts`) would use this:

    1. **Ship parameters, not a model.** Add `durability: {{form, k, w0}}` (the
       envelope's relative shape) and `cp_w`, `w_prime_j` from 1 Hz bests to
       the Training metrics the sync already computes weekly. Nothing here
       needs Python at request time.
    2. **Port the optimiser to TypeScript**, reusing `sectionSpeed` exactly as
       the planner does. The problem is small (≤ 100 sections) and smooth; a
       projected-gradient or augmented-Lagrangian loop over the same
       constraints runs in milliseconds in the browser, so the power slider
       stays live.
    3. **Present it as advice on top of the forecast**, not as the forecast:
       "hold {{x}} W on the climbs and {{y}} W elsewhere to save about {{n}} min",
       with the saving discounted by the replay slope and the default
       variability cap at 1.05.
    4. **Monitor** by replaying each new ride (as section 4.6 does) and
       tracking the slope; if it drifts toward zero, switch the advice off.
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## 8. Next steps

    1. **Keep 1 Hz streams for recent rides** (or store per-ride MMP by work
       bin at sync time, computed before downsampling) to extend durability to
       short durations without the sampling bias.
    2. **Time-varying weather in the replays**: interpolate hourly reanalysis
       along each ride, as the planner already does with forecasts, to tighten
       the pacing check.
    3. **A durability-aware rider model**: let `P = CP + W′/t + k·grade` take
       the work done before a segment, which would let notebook 01's
       within-ride fatigue feature enter through the physics rather than as a
       residual.
    """)
    return


@app.cell(hide_code=True)
def _(drop_ci, pacing_slope, route_survey):
    _calm = route_survey[route_survey.case == "calm"].gain_pct.median()
    headline = (
        f"**Findings.** After 1,500 kJ the rider's 20-minute power ceiling is **{drop_ci[1200][1]:.0%} lower** "
        f"(95% CI {drop_ci[1200][0]:.0%}–{drop_ci[1200][2]:.0%}), and a durability envelope beats a flat one on held-out rides. "
        f"Optimised pacing at the same average power saves a median **{_calm:.1%}** on saved routes in calm air, mostly on climbs. "
        f"Replaying {pacing_slope['n']} real rides, the physics' pacing sensitivity holds with slope {pacing_slope['slope']:.2f} "
        f"({pacing_slope['lo']:.2f}–{pacing_slope['hi']:.2f}), so expect about {_calm * pacing_slope['slope']:.1%} in practice."
    )
    return (headline,)


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ---
    *Reproducibility.* Seeds are fixed (`SEED = 0`) for the bootstrap and the
    held-out folds. Every quantity is recomputed from the cached snapshot; the
    snapshot times are in section 2.
    """)
    return


if __name__ == "__main__":
    app.run()
