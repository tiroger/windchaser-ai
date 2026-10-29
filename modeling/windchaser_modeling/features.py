"""Features for the residual model and the durability analysis.

Every feature here is stamped with when it becomes known, because the residual
model is only honest if nothing derived from an effort's own outcome feeds its
own prediction:

    forecast-time   known before the ride: segment geometry, the forecast
                    weather, the calendar, training load up to the day before
    in-ride         known only once the ride is under way: work done before
                    the segment, earlier efforts in the same ride

The production app can use the first group today. The second would need either
a live ride or a ride plan, and the notebooks score the two groups separately.

Physics (sections, wind at rider height, implied power) is imported from
cycling_analytics, never re-derived.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from cycling_analytics.physics import (
    Rider,
    Section,
    angle_delta,
    bearing_deg,
    effective_tailwind,
    haversine_m,
    to_sections,
    wind_at_rider_height,
)
from cycling_analytics.rider import mean_grade, power_for_time

EARTH_R = 6371000.0

FORECAST_FEATURES = [
    "gust_ms",
    "gust_excess_ms",
    "wind_speed_ms",
    "tailwind_ms",
    "crosswind_ms",
    "temperature_c",
    "humidity_pct",
    "precip_mm",
    "length_m",
    "mean_grade",
    "grade_sd",
    "max_grade",
    "local_hour",
    "season_sin",
    "season_cos",
    "years_since_start",
    "effort_number",
    "days_since_last",
    "ctl",
    "atl",
    "tsb",
]
IN_RIDE_FEATURES = [
    "work_before_kj",
    "time_before_min",
    "prior_efforts_in_ride",
    "prior_power_gap",
]


# --------------------------------------------------------------------------
# geometry helpers (vectorised; scalar versions live in cycling_analytics)
# --------------------------------------------------------------------------


def haversine_vec(lat: np.ndarray, lng: np.ndarray, at: tuple[float, float]) -> np.ndarray:
    """Distance in metres from every (lat, lng) to one point. Same formula as
    cycling_analytics.physics.haversine_m, vectorised for whole streams."""
    p1 = np.radians(lat)
    p2 = math.radians(at[0])
    dp = p2 - p1
    dl = math.radians(at[1]) - np.radians(lng)
    h = np.sin(dp / 2) ** 2 + np.cos(p1) * math.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


# --------------------------------------------------------------------------
# segments
# --------------------------------------------------------------------------


def segment_sections(segment: dict) -> list[Section]:
    return to_sections(
        segment["points"], segment["average_grade"], segment.get("elevation_profile")
    )


def segment_kind(grade: float, grade_sd: float) -> str:
    """A coarse label for slicing errors. Thresholds are conventional, not fitted."""
    if grade >= 0.03:
        return "climb"
    if grade <= -0.02:
        return "descent"
    if grade_sd >= 0.02:
        return "rolling"
    return "flat"


def segment_table(segments: dict[str, dict]) -> pd.DataFrame:
    rows = []
    for sid, seg in segments.items():
        sections = segment_sections(seg)
        if not sections:
            continue
        d = np.array([s.distance_m for s in sections])
        g = np.array([s.grade for s in sections])
        mg = mean_grade(sections)
        sd = float(np.sqrt(np.average((g - mg) ** 2, weights=d)))
        rows.append(
            {
                "segment_id": str(sid),
                "segment_name": (seg.get("name") or "").strip(),
                "length_m": float(d.sum()),
                "mean_grade": mg,
                "grade_sd": sd,
                "max_grade": float(g.max()),
                "climb_m": float(np.sum(np.clip(g, 0, None) * d)),
                "n_sections": len(sections),
                "has_profile": bool(seg.get("elevation_profile")),
                "kind": segment_kind(mg, sd),
                "start_lat": seg["points"][0][0],
                "start_lng": seg["points"][0][1],
            }
        )
    return pd.DataFrame(rows)


def wind_features(sections: list[Section], wind_from_deg: float, wind_speed_ms: float) -> dict:
    """Wind as the rider meets it, at rider height and per section.

    The tailwind is what the physics already uses; the crosswind is what it
    ignores, and is the candidate for a learned correction (side gusts make a
    rider sit up and lose aero, which no constant CdA describes).
    """
    if not sections or not np.isfinite(wind_speed_ms) or not np.isfinite(wind_from_deg):
        return {"tailwind_ms": np.nan, "crosswind_ms": np.nan, "crosswind_share": np.nan}
    wind_to = (wind_from_deg + 180.0) % 360.0
    v = wind_at_rider_height(wind_speed_ms)
    d = np.array([s.distance_m for s in sections])
    delta = np.radians([angle_delta(wind_to, s.bearing_deg) for s in sections])
    cross = np.abs(np.sin(delta))
    return {
        "tailwind_ms": effective_tailwind(sections, wind_from_deg, wind_speed_ms),
        "crosswind_ms": float(np.average(cross, weights=d) * v),
        "crosswind_share": float(np.average(cross, weights=d)),
    }


# --------------------------------------------------------------------------
# training load
# --------------------------------------------------------------------------

CYCLING = {"Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide"}


@dataclass(frozen=True)
class HrLoadModel:
    """kJ per hour as a straight line in average heart rate, fitted on rides
    that have both a power meter and a heart-rate strap."""

    intercept: float
    slope: float
    r: float
    n: int

    def kj_per_hour(self, hr: np.ndarray) -> np.ndarray:
        return np.clip(self.intercept + self.slope * np.asarray(hr, float), 0, None)


def fit_hr_load_model(acts: pd.DataFrame) -> HrLoadModel:
    m = (
        acts["device_watts"]
        & acts["sport_type"].isin(CYCLING)
        & np.isfinite(acts["average_hr"])
        & np.isfinite(acts["kilojoules"])
        & (acts["moving_s"] >= 1200)
    )
    sub = acts[m]
    x = sub["average_hr"].to_numpy()
    y = sub["kilojoules"].to_numpy() / (sub["moving_s"].to_numpy() / 3600.0)
    slope, intercept = np.polyfit(x, y, 1)
    r = float(np.corrcoef(x, y)[0, 1]) if len(x) > 2 else float("nan")
    return HrLoadModel(float(intercept), float(slope), r, int(len(x)))


def activity_load(acts: pd.DataFrame, hr_model: HrLoadModel) -> pd.DataFrame:
    """A kJ-equivalent load per activity, from the best evidence available.

    1. Measured work (kJ) where a power meter recorded the ride.
    2. Otherwise heart rate, converted to kJ through the rider's own
       power-to-heart-rate line (HrLoadModel). This puts runs and pickleball
       on the same scale as rides, crudely: it assumes a beat costs the same
       whatever the sport.
    3. Otherwise duration times the median rate for that sport.

    kJ rather than TSS because TSS needs an FTP at every date, which this
    history does not have before power meters; kJ needs nothing but the meter.
    """
    hours = acts["moving_s"].to_numpy() / 3600.0
    load = np.full(len(acts), np.nan)
    source = np.array(["none"] * len(acts), dtype=object)

    power = acts["device_watts"].to_numpy() & np.isfinite(acts["kilojoules"].to_numpy())
    load[power] = acts["kilojoules"].to_numpy()[power]
    source[power] = "power"

    hr = ~power & np.isfinite(acts["average_hr"].to_numpy())
    load[hr] = hr_model.kj_per_hour(acts["average_hr"].to_numpy()[hr]) * hours[hr]
    source[hr] = "heart rate"

    rest = ~power & ~hr & np.isfinite(hours)
    rates = pd.Series(load / np.where(hours > 0, hours, np.nan)).groupby(
        acts["sport_type"].to_numpy()
    ).median()
    overall = float(np.nanmedian(load / np.where(hours > 0, hours, np.nan)))
    for i in np.flatnonzero(rest):
        rate = rates.get(acts["sport_type"].iloc[i], np.nan)
        load[i] = (rate if np.isfinite(rate) else overall) * hours[i]
        source[i] = "duration"
    return pd.DataFrame(
        {"activity_id": acts["activity_id"].to_numpy(), "load_kj": load, "load_source": source}
    )


def ewma_load(acts: pd.DataFrame, load: pd.DataFrame, chronic: int = 42, acute: int = 7) -> pd.DataFrame:
    """Daily chronic (CTL-like) and acute (ATL-like) load, end of each local day.

    The usual impulse-response form: L_t = L_{t-1} + (x_t - L_{t-1})(1 - e^{-1/tau}).
    Units are kJ per day.
    """
    merged = acts[["activity_id", "start_local"]].merge(load, on="activity_id")
    merged["day"] = merged["start_local"].dt.normalize()
    daily = merged.groupby("day")["load_kj"].sum()
    days = pd.date_range(daily.index.min(), daily.index.max() + pd.Timedelta(days=1), freq="D")
    x = daily.reindex(days, fill_value=0.0).to_numpy()
    ka, kc = 1 - math.exp(-1 / acute), 1 - math.exp(-1 / chronic)
    atl = np.zeros_like(x)
    ctl = np.zeros_like(x)
    a = c = 0.0
    for i, v in enumerate(x):
        a += (v - a) * ka
        c += (v - c) * kc
        atl[i], ctl[i] = a, c
    return pd.DataFrame({"daily_kj": x, "ctl": ctl, "atl": atl, "tsb": ctl - atl}, index=days)


def fatigue_before(daily: pd.DataFrame, local_day: pd.Timestamp) -> dict:
    """State at the end of the previous day. The effort's own ride, whose work
    depends on the effort, is never included."""
    prev = pd.Timestamp(local_day).normalize() - pd.Timedelta(days=1)
    if prev < daily.index[0]:
        return {"ctl": np.nan, "atl": np.nan, "tsb": np.nan}
    row = daily.loc[min(prev, daily.index[-1])]
    return {"ctl": float(row.ctl), "atl": float(row.atl), "tsb": float(row.tsb)}


# --------------------------------------------------------------------------
# aligning an effort (UTC) with its ride (local wall clock)
# --------------------------------------------------------------------------

QUARTER_HOUR = 900.0
MATCH_RADIUS_M = 250.0


def moving_dt(t_s: np.ndarray, cap_factor: float = 3.0) -> np.ndarray:
    """Seconds each stored sample stands for, with pauses removed.

    Samples are picked evenly by index from the recording, so in steady riding
    each one stands for the same number of recorded seconds. A pause shows up
    as one long gap; capping every gap at a few times the median keeps a cafe
    stop from being counted as riding.
    """
    t = np.asarray(t_s, float)
    if len(t) < 2:
        return np.zeros_like(t)
    dt = np.diff(t)
    med = float(np.median(dt[dt > 0])) if np.any(dt > 0) else 1.0
    dt = np.append(dt, med)
    return np.clip(dt, 0, cap_factor * med)


def stream_offset(
    effort_utc: pd.Timestamp,
    local_start: pd.Timestamp,
    stream: pd.DataFrame,
    seg_start: tuple[float, float],
) -> dict | None:
    """The ride's UTC offset, from where the stream passes the segment start.

    effort_utc is a true instant; local_start is wall-clock. If the stream is
    at the segment start t seconds into the ride, then
        offset = local - utc = (local_start + t) - effort_utc,
    and a real offset is a whole number of quarter hours. Each pass of the
    stream near the start gives a candidate; the true one lands on a quarter
    hour to within the sample spacing, a wrong pass (an earlier lap) almost
    never does.
    """
    if stream is None or stream["lat"].isna().all():
        return None
    lat, lng, t = stream["lat"].to_numpy(), stream["lng"].to_numpy(), stream["t_s"].to_numpy()
    d = haversine_vec(lat, lng, seg_start)
    d = np.where(np.isfinite(d), d, np.inf)
    near = np.flatnonzero(d < MATCH_RADIUS_M)
    if len(near) == 0:
        return None
    # Local minima only: one candidate per pass.
    cands = [
        i
        for i in near
        if (i == 0 or d[i] <= d[i - 1]) and (i == len(d) - 1 or d[i] <= d[i + 1])
    ]
    gap = (effort_utc.tz_convert("UTC").tz_localize(None) - local_start).total_seconds()
    best = None
    for i in cands:
        implied = t[i] - gap
        q = round(implied / QUARTER_HOUR) * QUARTER_HOUR
        if abs(q) > 14 * 3600:
            continue
        resid = implied - q
        if best is None or abs(resid) < abs(best["residual_s"]):
            best = {"offset_s": q, "residual_s": resid, "match_m": float(d[i]), "t_match_s": float(t[i])}
    return best


# Preferred names when several zones share every offset; only cosmetic.
PREFERRED_ZONES = (
    "America/Los_Angeles",
    "America/Denver",
    "America/Phoenix",
    "America/Chicago",
    "America/New_York",
    "Europe/London",
    "Europe/Madrid",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Australia/Sydney",
)


def zone_offset_s(zone: str, utc: pd.Timestamp) -> float:
    off = utc.tz_convert(ZoneInfo(zone)).utcoffset()
    return off.total_seconds() if off is not None else float("nan")


def learn_zone(observations: list[tuple[pd.Timestamp, float]]) -> tuple[str | None, float]:
    """The IANA zone whose offsets (DST included) reproduce stream-derived ones.

    Returns the zone and the share of observations it reproduces exactly.
    """
    if not observations:
        return None, float("nan")
    best, score = None, -1.0
    for zone in PREFERRED_ZONES:
        hits = sum(1 for utc, off in observations if zone_offset_s(zone, utc) == off)
        share = hits / len(observations)
        if share > score:
            best, score = zone, share
    return best, score


# --------------------------------------------------------------------------
# work before an effort, from the stream
# --------------------------------------------------------------------------


def work_before(stream: pd.DataFrame, t_effort_s: float) -> dict:
    """Work and moving time in the ride before the segment starts.

    Each stored sample's power is held for the seconds it stands for
    (moving_dt). With samples picked by index this is an unbiased estimate of
    the work done; its noise averages out over the hundreds of samples that
    precede a typical effort.
    """
    t = stream["t_s"].to_numpy()
    dt = moving_dt(t)
    before = t < t_effort_s
    w = stream["watts"].to_numpy()
    has_power = np.isfinite(w).any() and np.nansum(w) > 0
    kj = float(np.nansum(np.where(before, np.nan_to_num(w) * dt, 0.0)) / 1000.0) if has_power else np.nan
    return {
        "work_before_kj": kj,
        "time_before_min": float(np.sum(dt[before]) / 60.0),
        "samples_before": int(before.sum()),
    }


def stream_total_kj(stream: pd.DataFrame) -> float:
    w = stream["watts"].to_numpy()
    if not np.isfinite(w).any():
        return float("nan")
    return float(np.nansum(np.nan_to_num(w) * moving_dt(stream["t_s"].to_numpy())) / 1000.0)


# --------------------------------------------------------------------------
# the effort feature table
# --------------------------------------------------------------------------


def align_efforts(
    efforts: pd.DataFrame,
    acts: pd.DataFrame,
    segtab: pd.DataFrame,
    load_stream,
) -> pd.DataFrame:
    """Local time and stream position for every effort.

    Two sources, in order of evidence:
      1. The stream: where it passes the segment start fixes the offset to the
         second (stream_offset), and per activity the most common offset
         across its efforts is kept.
      2. Location: for each segment's region, the IANA zone that reproduces
         the stream-derived offsets of rides there, DST included (learn_zone).
         This fills in efforts whose ride has no stored stream.
    """
    local_start = acts.set_index("activity_id")["start_local"]
    seg_start = segtab.set_index("segment_id")[["start_lat", "start_lng"]]
    rows = []
    for e in efforts.itertuples():
        ls = local_start.get(e.activity_id, pd.NaT)
        stream = load_stream(e.activity_id) if pd.notna(ls) else None
        found = None
        if stream is not None and e.segment_id in seg_start.index:
            p = seg_start.loc[e.segment_id]
            found = stream_offset(e.start_utc, ls, stream, (p.start_lat, p.start_lng))
        rows.append(
            {
                "effort_id": e.effort_id,
                "activity_id": e.activity_id,
                "segment_id": e.segment_id,
                "start_utc": e.start_utc,
                "local_start": ls,
                "stream_offset_s": found["offset_s"] if found else np.nan,
                "stream_residual_s": found["residual_s"] if found else np.nan,
                "match_m": found["match_m"] if found else np.nan,
            }
        )
    out = pd.DataFrame(rows)

    # Per activity, the consensus of its efforts.
    good = out[np.abs(out["stream_residual_s"]) <= 60]
    consensus = good.groupby("activity_id")["stream_offset_s"].agg(lambda s: s.mode().iloc[0])
    out["activity_offset_s"] = out["activity_id"].map(consensus)

    # Per region (rounded segment start), the zone that explains them.
    out = out.merge(segtab[["segment_id", "start_lat", "start_lng"]], on="segment_id", how="left")
    out["region"] = out["start_lat"].round(0).astype(str) + "," + out["start_lng"].round(0).astype(str)
    zones: dict[str, tuple[str | None, float]] = {}
    for region, grp in out.groupby("region"):
        obs = [
            (r.start_utc, r.activity_offset_s)
            for r in grp.itertuples()
            if np.isfinite(r.activity_offset_s)
        ]
        zones[region] = learn_zone(obs)
    # Regions with no stream evidence borrow the nearest region that has some.
    known = {k: v for k, v in zones.items() if v[0]}
    for region, (zone, _) in list(zones.items()):
        if zone or not known:
            continue
        la, lo = map(float, region.split(","))
        nearest = min(known, key=lambda k: haversine_m((la, lo), tuple(map(float, k.split(",")))))
        dist = haversine_m((la, lo), tuple(map(float, nearest.split(","))))
        zones[region] = (known[nearest][0], float("nan")) if dist < 500_000 else (None, float("nan"))

    out["zone"] = out["region"].map(lambda r: zones[r][0])
    out["zone_offset_s"] = [
        zone_offset_s(z, u) if z else np.nan for z, u in zip(out["zone"], out["start_utc"])
    ]
    out["offset_s"] = out["activity_offset_s"].fillna(out["zone_offset_s"])
    # Last resort: solar time from longitude, no DST. Flagged.
    nominal = (out["start_lng"] / 15.0).round() * 3600.0
    out["offset_source"] = np.where(
        out["activity_offset_s"].notna(),
        "stream",
        np.where(out["zone_offset_s"].notna(), "zone", "longitude"),
    )
    out["offset_s"] = out["offset_s"].fillna(nominal)
    out["local_time"] = out["start_utc"].dt.tz_localize(None) + pd.to_timedelta(out["offset_s"], unit="s")
    out["t_in_ride_s"] = (out["local_time"] - out["local_start"]).dt.total_seconds()
    out["zone_agrees"] = np.where(
        out["activity_offset_s"].notna() & out["zone_offset_s"].notna(),
        out["activity_offset_s"] == out["zone_offset_s"],
        np.nan,
    )
    return out.drop(columns=["start_lat", "start_lng"])


def prior_power_gaps(efforts: pd.DataFrame, segments: dict[str, dict], base: Rider = Rider()) -> pd.Series:
    """For each effort: implied over measured power on earlier efforts in the
    same ride, as a log ratio. A rider sitting in a group goes faster than their
    watts explain, so a positive gap earlier in the ride hints at a draft now.

    Only efforts that had finished before this one started are used, so the
    feature never sees the effort's own time. Implied power comes from the
    production physics (rider.power_for_time) at a default rider, which is
    fine for a ratio whose level the model learns anyway.
    """
    implied: dict[str, float] = {}
    sections_cache: dict[str, list[Section]] = {}
    for e in efforts.itertuples():
        if not (e.device_watts and e.average_watts > 0 and e.has_weather):
            continue
        seg = segments.get(e.segment_id)
        if not seg:
            continue
        if e.segment_id not in sections_cache:
            sections_cache[e.segment_id] = segment_sections(seg)
        sections = sections_cache[e.segment_id]
        if not sections:
            continue
        weather = {
            "wind_from_deg": e.wind_from_deg,
            "wind_speed_ms": e.wind_speed_ms,
            "temperature_c": e.temperature_c,
            "pressure_hpa": e.pressure_hpa,
            "humidity_pct": e.humidity_pct,
        }
        p = power_for_time(sections, e.moving_s, weather, base)
        implied[e.effort_id] = math.log(p / e.average_watts)

    out = {}
    count = {}
    ends = efforts["start_utc"] + pd.to_timedelta(efforts["elapsed_s"], unit="s")
    frame = efforts.assign(end_utc=ends)
    for _, grp in frame.groupby("activity_id"):
        for e in grp.itertuples():
            earlier = grp[grp["end_utc"] <= e.start_utc]
            count[e.effort_id] = len(earlier)
            gaps = [implied[i] for i in earlier["effort_id"] if i in implied]
            out[e.effort_id] = float(np.median(gaps)) if gaps else np.nan
    return pd.DataFrame({"prior_power_gap": pd.Series(out), "prior_efforts_in_ride": pd.Series(count)})


def effort_features(
    efforts: pd.DataFrame,
    segments: dict[str, dict],
    segtab: pd.DataFrame,
    alignment: pd.DataFrame,
    daily: pd.DataFrame,
    load_stream,
) -> pd.DataFrame:
    """One row per effort, every feature, indexed by effort_id."""
    seg = segtab.set_index("segment_id")
    align = alignment.set_index("effort_id")
    sections_cache = {sid: segment_sections(s) for sid, s in segments.items()}
    first = efforts["start_utc"].min()
    gaps = prior_power_gaps(efforts, segments)

    rows = []
    for e in efforts.itertuples():
        a = align.loc[e.effort_id]
        s = seg.loc[e.segment_id] if e.segment_id in seg.index else None
        local = a.local_time
        doy = local.dayofyear if pd.notna(local) else np.nan
        prior = efforts[(efforts["segment_id"] == e.segment_id) & (efforts["start_utc"] < e.start_utc)]
        row = {
            "effort_id": e.effort_id,
            "gust_ms": e.gust_ms,
            "gust_excess_ms": e.gust_ms - e.wind_speed_ms,
            "wind_speed_ms": e.wind_speed_ms,
            "temperature_c": e.temperature_c,
            "humidity_pct": e.humidity_pct,
            "precip_mm": e.precip_mm,
            "local_hour": local.hour + local.minute / 60 if pd.notna(local) else np.nan,
            "season_sin": math.sin(2 * math.pi * doy / 365.25) if np.isfinite(doy) else np.nan,
            "season_cos": math.cos(2 * math.pi * doy / 365.25) if np.isfinite(doy) else np.nan,
            "years_since_start": (e.start_utc - first).days / 365.25,
            "effort_number": len(prior),
            "days_since_last": (e.start_utc - prior["start_utc"].max()).days if len(prior) else np.nan,
            "offset_source": a.offset_source,
        }
        row.update(wind_features(sections_cache.get(e.segment_id, []), e.wind_from_deg, e.wind_speed_ms))
        if s is not None:
            row.update(
                {k: s[k] for k in ("length_m", "mean_grade", "grade_sd", "max_grade", "kind", "segment_name")}
            )
        day = a.local_start if pd.notna(a.local_start) else local
        row.update(fatigue_before(daily, day) if pd.notna(day) else {"ctl": np.nan, "atl": np.nan, "tsb": np.nan})

        stream = load_stream(e.activity_id) if pd.notna(a.local_start) else None
        if stream is not None and np.isfinite(a.t_in_ride_s) and a.offset_source == "stream":
            row.update(work_before(stream, a.t_in_ride_s))
            row["has_stream"] = True
        else:
            row.update({"work_before_kj": np.nan, "time_before_min": np.nan, "samples_before": 0})
            row["has_stream"] = False
        g = gaps.loc[e.effort_id] if e.effort_id in gaps.index else None
        row["prior_power_gap"] = g["prior_power_gap"] if g is not None else np.nan
        row["prior_efforts_in_ride"] = g["prior_efforts_in_ride"] if g is not None else 0
        rows.append(row)
    return pd.DataFrame(rows).set_index("effort_id")


# --------------------------------------------------------------------------
# routes: sections the way the planner builds them
# --------------------------------------------------------------------------


def route_sections(
    distance_m: np.ndarray,
    altitude_m: np.ndarray,
    lat: np.ndarray,
    lng: np.ndarray,
    max_sections: int = 300,
    min_section_m: float = 150.0,
) -> pd.DataFrame:
    """Python port of buildSections in apps/web/lib/training/route-forecast.ts.

    Same rules: merge points until a section reaches total/max_sections (never
    under min_section_m), bearing from end points, grade clamped to +-25% so a
    profile glitch never becomes a wall, a short tail merged into the section
    before it. Returns start_m, length_m, bearing_deg, grade, lat, lng.
    """
    pts = [
        (float(d), float(a), (float(la), float(lo)))
        for d, a, la, lo in zip(distance_m, altitude_m, lat, lng)
        if np.isfinite(d) and np.isfinite(a) and np.isfinite(la) and np.isfinite(lo)
    ]
    clean = []
    for p in pts:
        if clean and p[0] < clean[-1][0]:
            continue
        clean.append(p)
    if len(clean) < 2:
        return pd.DataFrame(columns=["start_m", "length_m", "bearing_deg", "grade", "lat", "lng"])
    total = clean[-1][0] - clean[0][0]
    target = max(min_section_m, total / max(1, max_sections))
    out = []
    start = 0
    last_bearing = 0.0
    for i in range(1, len(clean)):
        length = clean[i][0] - clean[start][0]
        last = i == len(clean) - 1
        if length < target * 0.99 and not last:
            continue
        if length <= 0:
            continue
        a, b = clean[start], clean[i]
        moved = haversine_m(a[2], b[2])
        bearing = bearing_deg(a[2], b[2]) if moved > 1 else last_bearing
        last_bearing = bearing
        mid = clean[(start + i) >> 1][2]
        out.append(
            {
                "start_m": a[0] - clean[0][0],
                "length_m": length,
                "bearing_deg": bearing,
                "grade": max(-0.25, min(0.25, (b[1] - a[1]) / length)),
                "altitude_m": a[1],
                "lat": mid[0],
                "lng": mid[1],
            }
        )
        start = i
    if len(out) > 1 and out[-1]["length_m"] < target * 0.25:
        tail = out.pop()
        prev = out[-1]
        length = prev["length_m"] + tail["length_m"]
        prev["grade"] = (prev["grade"] * prev["length_m"] + tail["grade"] * tail["length_m"]) / length
        prev["length_m"] = length
    return pd.DataFrame(out)


def as_sections(frame: pd.DataFrame) -> list[Section]:
    return [
        Section(distance_m=float(r.length_m), bearing_deg=float(r.bearing_deg), grade=float(r.grade))
        for r in frame.itertuples()
    ]


# --------------------------------------------------------------------------
# mean-maximal power by work already done
# --------------------------------------------------------------------------


def moving_energy(stream: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, float]:
    """Cumulative moving seconds and joules at each stored sample, plus the
    median sample spacing. Power is sample-and-hold between samples."""
    t = stream["t_s"].to_numpy()
    dt = moving_dt(t)
    w = np.nan_to_num(stream["watts"].to_numpy())
    tm = np.concatenate([[0.0], np.cumsum(dt)[:-1]])
    energy = np.concatenate([[0.0], np.cumsum(w * dt)[:-1]])
    spacing = float(np.median(np.diff(t))) if len(t) > 1 else float("nan")
    return tm, energy, spacing


def window_means(tm: np.ndarray, energy: np.ndarray, duration_s: float) -> tuple[np.ndarray, np.ndarray]:
    """Mean power over every window [tm_i, tm_i + D) that fits in the ride,
    and the work done before each window started (J)."""
    end = tm + duration_s
    ok = end <= tm[-1]
    if not ok.any():
        return np.array([]), np.array([])
    e_end = np.interp(end[ok], tm, energy)
    return (e_end - energy[ok]) / duration_s, energy[ok]


def mmp_by_work(
    stream: pd.DataFrame,
    durations: tuple[int, ...] = (300, 1200),
    bin_kj: float = 500.0,
) -> pd.DataFrame:
    """Best mean power for each duration among windows *starting* in each bin
    of work already done (0-500 kJ, 500-1000 kJ, ...)."""
    tm, energy, spacing = moving_energy(stream)
    rows = []
    for d in durations:
        means, before = window_means(tm, energy, d)
        if len(means) == 0:
            continue
        bins = np.floor(before / 1000.0 / bin_kj).astype(int)
        for b in np.unique(bins):
            m = np.flatnonzero(bins == b)
            best = m[np.argmax(means[m])]
            rows.append(
                {
                    "duration_s": d,
                    "bin": int(b),
                    "work_lo_kj": b * bin_kj,
                    "work_mid_kj": (b + 0.5) * bin_kj,
                    # Work done before the best window itself started, which
                    # is what a durability curve is a function of.
                    "work_at_kj": float(before[best] / 1000.0),
                    "mmp_w": float(means[best]),
                    "samples_per_window": d / spacing if spacing > 0 else np.nan,
                }
            )
    return pd.DataFrame(rows)


def downsampled_bests(stream: pd.DataFrame, durations: tuple[int, ...]) -> dict[int, float]:
    """Whole-ride mean-maximal power from the stored samples, for comparison
    with the 1 Hz bests the sync computed before downsampling."""
    tm, energy, _ = moving_energy(stream)
    out = {}
    for d in durations:
        means, _ = window_means(tm, energy, d)
        out[d] = float(means.max()) if len(means) else float("nan")
    return out



# --------------------------------------------------------------------------
# repeated loops
# --------------------------------------------------------------------------


def track_signature(stream: pd.DataFrame, points: int = 60) -> dict | None:
    """Start, end, length and an evenly resampled track, for matching rides
    that follow the same course (the rule the Training section uses)."""
    ok = stream["lat"].notna() & stream["distance_m"].notna()
    s = stream[ok]
    if len(s) < 10:
        return None
    d = s["distance_m"].to_numpy()
    if d[-1] - d[0] < 1000:
        return None
    grid = np.linspace(d[0], d[-1], points)
    return {
        "start": (float(s["lat"].iloc[0]), float(s["lng"].iloc[0])),
        "end": (float(s["lat"].iloc[-1]), float(s["lng"].iloc[-1])),
        "length_m": float(d[-1] - d[0]),
        "lat": np.interp(grid, d, s["lat"].to_numpy()),
        "lng": np.interp(grid, d, s["lng"].to_numpy()),
    }


def _overlap(a: dict, b: dict, radius_m: float) -> float:
    """Share of a's resampled points within radius of some point of b."""
    hits = 0
    for la, lo in zip(a["lat"], a["lng"]):
        if np.min(haversine_vec(b["lat"], b["lng"], (la, lo))) <= radius_m:
            hits += 1
    return hits / len(a["lat"])


def same_course(a: dict, b: dict, end_m: float = 500.0, length_tol: float = 0.10,
                radius_m: float = 150.0, share: float = 0.85) -> bool:
    """Same start and finish within 500 m, length within 10%, and 85% of each
    track within 150 m of the other, checked both ways. Direction-aware
    because the start of one must match the start of the other."""
    if haversine_m(a["start"], b["start"]) > end_m or haversine_m(a["end"], b["end"]) > end_m:
        return False
    if abs(a["length_m"] - b["length_m"]) > length_tol * max(a["length_m"], b["length_m"]):
        return False
    return _overlap(a, b, radius_m) >= share and _overlap(b, a, radius_m) >= share


def group_courses(signatures: dict[str, dict], min_rides: int = 5) -> dict[str, list[str]]:
    """Greedy clustering: each ride joins the first group whose founding ride
    it matches. Returns groups with at least `min_rides` rides, keyed by the
    founding ride's id."""
    groups: dict[str, list[str]] = {}
    for aid, sig in signatures.items():
        for founder in groups:
            if same_course(signatures[founder], sig):
                groups[founder].append(aid)
                break
        else:
            groups[aid] = [aid]
    return {k: v for k, v in groups.items() if len(v) >= min_rides}


def section_power(stream: pd.DataFrame, sections: pd.DataFrame) -> np.ndarray:
    """Mean recorded power over each section of a ride's own course, time
    weighted with pauses removed, from the stored samples."""
    d = stream["distance_m"].to_numpy()
    w = np.nan_to_num(stream["watts"].to_numpy())
    dt = moving_dt(stream["t_s"].to_numpy())
    edges = np.append(sections["start_m"].to_numpy(), sections["start_m"].iloc[-1] + sections["length_m"].iloc[-1])
    edges = edges + (np.nanmin(d) if np.isfinite(d).any() else 0.0)
    idx = np.clip(np.searchsorted(edges, d, side="right") - 1, 0, len(sections) - 1)
    energy = np.bincount(idx, weights=w * dt, minlength=len(sections))
    secs = np.bincount(idx, weights=dt, minlength=len(sections))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = energy / secs
    # A section with no sample inside (shorter than the spacing) borrows its
    # neighbours' value.
    s = pd.Series(out).replace([np.inf, -np.inf], np.nan).interpolate(limit_direction="both")
    return s.to_numpy()
