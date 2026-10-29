#!/usr/bin/env python3
"""Check the modeling workspace's shared code on synthetic data.

The notebooks need private ride data, so CI only compiles them; everything
they lean on is exercised here instead. Plain assertions, no framework,
matching the other suites.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "modeling"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from windchaser_modeling import charts, data, durability, evaluation, features, pacing, residual  # noqa: E402

from cycling_analytics.physics import Rider  # noqa: E402  (on sys.path via windchaser_modeling)


def run(name: str, fn) -> None:
    fn()
    print(f"  ok  {name}")


# ----------------------------------------------------------------- data --


def test_local_time_is_never_read_as_utc() -> None:
    # start_date_local carries a fake Z. Reading it as UTC would shift every
    # ride by the rider's offset and corrupt every alignment downstream.
    ts = data.parse_local("2024-06-01T07:30:00Z")
    assert ts.tzinfo is None and ts.hour == 7, ts
    assert data.parse_utc("2024-06-01T07:30:00Z").tzinfo is not None


def test_activity_units_are_converted_to_si() -> None:
    raw = [{
        "id": 1, "sport_type": "Ride", "start_date_local": "2024-06-01T07:30:00Z",
        "distance": 10.0, "moving_time": 1.5, "elapsed_time": 1.6,
        "total_elevation_gain": 1000.0, "average_speed": 20.0,
    }]
    frame = data.activities_frame(raw, {"1": {"moving_seconds": 5400, "has_streams": True}})
    row = frame.iloc[0]
    assert abs(row.distance_m - 16093.44) < 0.01
    assert abs(row.elevation_gain_m - 304.8) < 0.01
    assert abs(row.average_speed_ms - 8.9408) < 1e-4
    assert row.moving_s == 5400, "the 1 Hz count beats hours to one decimal"
    frame = data.activities_frame(raw, {})
    assert frame.iloc[0].moving_s == 5400.0, "hours when nothing better exists"


def test_stream_samples_are_converted_to_si() -> None:
    raw = {"samples": {
        "time": [0, 10], "distance": [0.0, 1.0], "altitude": [0.0, 100.0],
        "watts": [200, None], "velocity": [10.0, 20.0], "latlng": [[1, 2], None],
    }}
    s = data.stream_frame(raw)
    assert abs(s.distance_m.iloc[1] - 1609.344) < 1e-6
    assert abs(s.altitude_m.iloc[1] - 30.48) < 1e-6
    assert math.isnan(s.watts.iloc[1]) and math.isnan(s.lat.iloc[1])


# ------------------------------------------------------------- features --


def _stream(n=600, dt=5.0, watts=200.0, pause_at=None, pause_s=0.0):
    t = np.arange(n) * dt
    if pause_at is not None:
        t[pause_at:] += pause_s
    lat = 37.0 + np.arange(n) * 0.0005
    return pd.DataFrame({
        "t_s": t, "distance_m": np.arange(n) * 50.0, "altitude_m": np.zeros(n),
        "watts": np.full(n, watts), "hr": np.nan, "speed_ms": 10.0,
        "lat": lat, "lng": np.full(n, -122.0),
    })


def test_pauses_are_not_counted_as_riding() -> None:
    plain = features.stream_total_kj(_stream())
    paused = features.stream_total_kj(_stream(pause_at=300, pause_s=1800))
    assert abs(plain - 600 * 5 * 200 / 1000) < 1e-6
    # The 30-minute stop becomes one capped gap, not half an hour at 200 W.
    assert paused - plain < 5 * 3 * 200 / 1000 + 1e-6, (plain, paused)


def test_offset_is_recovered_from_the_stream() -> None:
    stream = _stream()
    local_start = pd.Timestamp("2024-07-01 08:00:00")
    # Segment starts at sample 120, 600 s in. Pacific daylight time, UTC-7.
    utc = pd.Timestamp("2024-07-01 15:10:00", tz="UTC")
    found = features.stream_offset(utc, local_start, stream, (stream.lat[120], stream.lng[120]))
    assert found and found["offset_s"] == -7 * 3600, found
    assert abs(found["residual_s"]) < 1, found


def test_learned_zone_reproduces_daylight_saving() -> None:
    obs = [
        (pd.Timestamp("2024-07-01 15:00", tz="UTC"), -7 * 3600.0),
        (pd.Timestamp("2024-01-10 16:00", tz="UTC"), -8 * 3600.0),
    ]
    zone, share = features.learn_zone(obs)
    assert zone == "America/Los_Angeles" and share == 1.0, (zone, share)


def test_work_before_counts_only_the_earlier_part() -> None:
    stream = _stream()
    out = features.work_before(stream, t_effort_s=1000.0)
    assert abs(out["work_before_kj"] - 200 * 5 * 200 / 1000) < 1e-6, out
    assert out["samples_before"] == 200


def test_fatigue_excludes_the_effort_day() -> None:
    days = pd.date_range("2024-01-01", periods=60, freq="D")
    acts = pd.DataFrame({"activity_id": [str(i) for i in range(60)], "start_local": days + pd.Timedelta(hours=8)})
    load = pd.DataFrame({"activity_id": acts.activity_id, "load_kj": [0.0] * 59 + [5000.0]})
    daily = features.ewma_load(acts, load)
    before = features.fatigue_before(daily, days[-1])
    assert before["atl"] == 0.0, "the big ride that day must not leak into its own state"
    after = features.fatigue_before(daily, days[-1] + pd.Timedelta(days=1))
    assert after["atl"] > after["ctl"] > 0


def test_hr_load_fills_rides_without_a_meter() -> None:
    acts = pd.DataFrame({
        "activity_id": ["a", "b", "c", "d"], "sport_type": ["Ride"] * 3 + ["Run"],
        "device_watts": [True, True, False, False],
        "kilojoules": [700.0, 1100.0, np.nan, np.nan], "average_hr": [120.0, 150.0, 135.0, np.nan],
        "moving_s": [3600.0] * 4,
    })
    model = features.fit_hr_load_model(acts)
    assert abs(model.kj_per_hour([135.0])[0] - 900.0) < 1e-6
    load = features.activity_load(acts, model)
    assert list(load.load_source) == ["power", "power", "heart rate", "duration"]


def test_route_sections_match_the_planner_rules() -> None:
    n = 200
    dist = np.arange(n) * 100.0
    alt = np.where(np.arange(n) == 100, 500.0, 0.0)  # a one-point spike
    secs = features.route_sections(dist, alt, 37 + np.arange(n) * 0.0009, np.full(n, -122.0), max_sections=20)
    assert len(secs) <= 21
    assert abs(secs.length_m.sum() - dist[-1]) < 1e-6
    assert secs.grade.abs().max() <= 0.25, "a glitch must not become a wall"
    assert ((secs.bearing_deg < 1) | (secs.bearing_deg > 359)).all(), "heading north"


def test_mmp_by_work_bins_and_matches_constant_power() -> None:
    mm = features.mmp_by_work(_stream(n=1200, dt=5.0, watts=250.0), durations=(300,), bin_kj=500.0)
    assert set(mm.bin) == {0, 1, 2}, mm  # 1,500 kJ over the ride
    assert np.allclose(mm.mmp_w, 250.0)


def test_same_course_is_direction_aware() -> None:
    a = features.track_signature(_stream())
    rev = _stream().iloc[::-1].reset_index(drop=True)
    rev["distance_m"] = np.arange(len(rev)) * 50.0
    b = features.track_signature(rev)
    assert features.same_course(a, a)
    assert not features.same_course(a, b), "the reverse loop is a different course"


# ------------------------------------------------------------ evaluation --


def test_conformal_quantile_is_finite_sample_valid() -> None:
    scores = np.arange(1, 20)  # n = 19
    assert evaluation.conformal_quantile(scores, 0.1) == 18  # ceil(20 * 0.9) = 18th
    assert evaluation.conformal_quantile(scores[:5], 0.1) == float("inf")


def test_split_conformal_covers_on_exchangeable_data() -> None:
    rng = np.random.default_rng(1)
    cover = []
    for _ in range(200):
        cal = rng.standard_t(3, 100)
        test = rng.standard_t(3, 100)
        q = evaluation.split_conformal(cal, 0.1)
        cover.append(np.mean(np.abs(test) <= q))
    assert 0.88 < np.mean(cover) < 0.93, np.mean(cover)


def test_cqr_widens_a_band_that_is_too_narrow() -> None:
    rng = np.random.default_rng(2)
    y = rng.normal(0, 1, 500)
    adj = evaluation.cqr_adjustment(y, np.full(500, -0.5), np.full(500, 0.5), 0.1)
    assert 1.0 < adj < 1.3, adj  # 1.645 - 0.5


def test_yearly_folds_never_train_on_the_future() -> None:
    when = pd.Series(pd.date_range("2015-01-01", "2020-12-31", periods=600, tz="UTC"))
    for f in evaluation.yearly_folds(when, min_train=50):
        assert when.iloc[f.train_idx].max() < when.iloc[f.test_idx].min()
        proper, cal = evaluation.time_ordered_split(f.train_idx, when)
        assert when.iloc[proper].max() <= when.iloc[cal].min()


def test_origins_assign_each_effort_to_an_earlier_calibration() -> None:
    origins = evaluation.quarterly_origins(
        pd.Timestamp("2012-01-15", tz="UTC"), pd.Timestamp("2016-01-01", tz="UTC")
    )
    when = pd.Series(pd.to_datetime(["2013-01-01", "2014-02-14", "2015-07-01"], utc=True))
    got = evaluation.assign_origin(when, origins)
    assert pd.isna(got.iloc[0]), "before the warm-up there is no calibration"
    assert (got.dropna() <= when[got.notna()]).all()


def test_paired_bootstrap_sees_a_real_difference() -> None:
    rng = np.random.default_rng(3)
    a = rng.exponential(40, 300)
    out = evaluation.paired_bootstrap(a * 0.8, a)
    assert out["hi_s"] < 0 and out["p_a_better"] > 0.99, out


def test_physics_sigma_has_the_production_floor() -> None:
    from cycling_analytics.physics import Section

    sections = [Section(500, 0, 0.05)] * 4
    calm = {"wind_speed_ms": 0.0, "wind_from_deg": 0.0, "gust_ms": 0.0,
            "temperature_c": 15, "pressure_hpa": 1013, "humidity_pct": 60}
    s = evaluation.physics_sigma(sections, Rider(250), calm, 400.0, calibrated=True)
    assert abs(s - 400 * math.hypot(0.025, 0.04)) < 1e-9, s


# -------------------------------------------------------------- residual --


def test_residual_models_recover_a_planted_effect_without_peeking() -> None:
    rng = np.random.default_rng(4)
    n = 400
    when = pd.date_range("2015-01-01", periods=n, freq="5D", tz="UTC")
    tail = rng.normal(0, 1.5, n)
    d = pd.DataFrame({
        "effort_id": [str(i) for i in range(n)], "start_utc": when,
        "tailwind_ms": tail, "pred_s": 300.0,
    })
    for c in residual.FORECAST:
        if c not in d:
            d[c] = rng.normal(size=n)
    d["y"] = 0.03 * tail + rng.normal(0, 0.01, n)
    d["moving_s"] = d.pred_s * np.exp(d.y)
    folds = evaluation.yearly_folds(d.start_utc, min_train=60)
    out = residual.run_point_models(d, folds, [s for s in residual.SPECS if s.name in ("none", "ridge_fc", "hgb_fc")])
    mae = out.groupby("model").abs_err_s.mean()
    assert mae["ridge_fc"] < 0.5 * mae["none"], mae
    assert mae["hgb_fc"] < mae["none"], mae


def test_sigma_scale_reports_a_multiplier_per_branch() -> None:
    d = pd.DataFrame({"y": np.linspace(-0.1, 0.1, 50), "rel_sigma": 0.05, "branch": ["segment fit"] * 50})
    out = residual.sigma_scale(d)
    assert set(out) == {"all", "segment fit"}
    assert 1.5 < out["all"]["k_90"] <= 2.0, out


# ------------------------------------------------------------ durability --


def test_envelope_recovers_a_known_decline() -> None:
    rng = np.random.default_rng(5)
    w = rng.uniform(0, 3000, 3000)
    ceiling = 250 * (1 - 0.0001 * w)
    y = ceiling * rng.uniform(0.6, 1.0, len(w)) ** 0.5  # most rides submaximal
    env = durability.fit_envelope(w, y, "linear", tau=0.9)
    assert 0.08 < env.drop_at(1500) < 0.22, env
    flat = durability.fit_envelope(w, y, "flat", tau=0.9)
    assert env.loss < flat.loss
    assert abs(durability.exceedance(y, env.predict(w)) - 0.1) < 0.02


def test_grouped_folds_hold_out_whole_rides() -> None:
    groups = np.repeat(np.arange(20), 4)
    for train, test in durability.grouped_folds(groups, 5):
        assert not set(groups[train]) & set(groups[test])


def test_critical_power_from_a_hyperbolic_curve() -> None:
    bests = {t: 250 + 20000 / t for t in (180, 300, 480, 600, 1200)}
    cp, wp = durability.critical_power(bests)
    assert abs(cp - 250) < 1e-6 and abs(wp - 20000) < 1e-3


# ---------------------------------------------------------------- pacing --


def _hilly_course():
    n = 30
    secs = pd.DataFrame({
        "start_m": np.arange(n) * 500.0, "length_m": 500.0,
        "bearing_deg": 0.0, "grade": np.where(np.arange(n) % 10 < 5, 0.06, -0.06),
        "altitude_m": 0.0, "lat": 37.0, "lng": -122.0,
    })
    return pacing.make_course(secs), secs


def test_skiba_balance_spends_above_cp_and_recovers_below() -> None:
    phys = pacing.Physiology(cp_w=250, w_prime_j=20000)
    bal, _ = pacing.w_balance(np.array([350.0, 150.0]), np.array([100.0, 600.0]), phys)
    assert abs(bal[0] - 10000) < 1e-9
    assert 10000 < bal[1] < 20000


def test_durability_lowers_cp_as_work_accumulates() -> None:
    phys = pacing.Physiology(250, 20000, durability=lambda w: 1 - 0.0001 * np.asarray(w))
    cp = phys.cp_at(np.array([0.0, 1000.0]))
    assert abs(cp[0] - 250) < 1e-9 and abs(cp[1] - 225) < 1e-9


def test_optimiser_is_never_slower_and_pushes_the_climbs() -> None:
    course, _ = _hilly_course()
    table = pacing.SpeedTable(course, Rider(mass_kg=75, cda=0.3), p_max=600)
    phys = pacing.Physiology(cp_w=260, w_prime_j=18000)
    const = pacing.constant_plan(table, 200.0, phys)
    opt = pacing.optimise(table, 200.0, phys, vi_cap=1.05)
    assert opt.total_s <= const.total_s
    assert opt.mean_power_w <= 200.0 * 1.002
    assert pacing.strain_np(opt.power_w, opt.time_s) <= 210.0 * 1.002
    assert opt.w_balance_j.min() >= -1.0
    up = course.grade > 0
    assert opt.power_w[up].mean() > opt.power_w[~up].mean(), "more power uphill"
    flat = pacing.optimise(table, 200.0, phys, vi_cap=1.0)
    assert flat.total_s >= opt.total_s - 1e-6, "less freedom cannot be faster"


def test_speed_table_matches_the_production_solver() -> None:
    from cycling_analytics.physics import section_speed

    course, _ = _hilly_course()
    rider = Rider(mass_kg=75, cda=0.3)
    table = pacing.SpeedTable(course, rider, p_max=600, step=10)
    v, _ = table.speed(np.full(course.n, 205.0))
    exact = section_speed(Rider(205.0, 75, 0.3), 0.0, 0.06, 1.225)
    assert abs(v[0] - exact) / exact < 0.002, (v[0], exact)


# ---------------------------------------------------------------- charts --


def test_theme_registers() -> None:
    charts.enable()
    import altair as alt

    assert alt.theme.active == "windchaser"
    assert charts.theme()["config"]["range"]["category"][:2] == [charts.WIND, charts.EFFORT]


def test_compare_forms_prefers_a_decline_when_there_is_one() -> None:
    rng = np.random.default_rng(6)
    rows = []
    for ride in range(120):
        for b in range(4):
            w = b * 500 + rng.uniform(0, 500)
            ceiling = 1.0 - 0.0001 * w
            rows.append({"activity_id": str(ride), "bin": b, "work_at_kj": w, "relative": ceiling * rng.uniform(0.6, 1.0) ** 0.5})
    frame = pd.DataFrame(rows)
    table, envs = durability.compare_forms(frame, n_splits=4)
    t = table.set_index("form")
    assert t.loc["linear", "cv_pinball"] < t.loc["flat", "cv_pinball"], t
    assert t.loc["flat", "late_exceedance"] < 0.1 < t.loc["flat", "late_exceedance"] + 0.2
    exc = durability.exceedance_by_bin(frame, {"flat": envs["flat"]}, n_splits=4)
    flat = exc.sort_values("bin").exceedance.to_numpy()
    assert flat[0] > flat[-1], "a flat envelope is exceeded more fresh than late"


def test_composition_table_compares_like_with_like() -> None:
    # Short hard rides (only bin 0) and long easy ones: pooled looks like a big
    # decline, the cohort that reaches the late bin shows none.
    rows = [{"activity_id": f"s{i}", "duration_s": 1200, "bin": 0, "mmp_w": 300.0} for i in range(50)]
    for i in range(50):
        rows += [{"activity_id": f"l{i}", "duration_s": 1200, "bin": b, "mmp_w": 200.0} for b in range(3)]
    t = durability.composition_table(pd.DataFrame(rows), 1200, bins=(2,)).iloc[0]
    assert t.pooled_ratio < 0.8 and abs(t.cohort_ratio - 1.0) < 1e-9, t


def test_section_power_is_time_weighted_per_section() -> None:
    stream = _stream(n=200, dt=5.0)
    stream["watts"] = np.where(np.arange(200) < 100, 100.0, 300.0)
    secs = pd.DataFrame({"start_m": [0.0, 5000.0], "length_m": [5000.0, 5000.0]})
    p = features.section_power(stream, secs)
    assert np.allclose(p, [100.0, 300.0]), p


def test_planner_default_power_follows_the_rider_model() -> None:
    _, secs = _hilly_course()
    model = {"cp_w": 200.0, "w_prime_j": 10000.0, "grade_w": 0.0, "grade_min": 0.0, "grade_max": 0.0}
    w = pacing.planner_default_power(secs, model, Rider(mass_kg=75, cda=0.3))
    assert 200.0 < w < 230.0, w  # CP plus W' over a ride of tens of minutes


def main() -> None:
    print("Modeling workspace")
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            run(name[5:].replace("_", " "), fn)
    print("  all passed")


if __name__ == "__main__":
    main()
