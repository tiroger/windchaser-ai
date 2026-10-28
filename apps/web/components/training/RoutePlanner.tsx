"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import "@/app/training/planner.css";
import { compassLabel } from "@/lib/geo";
import { formatHours, formatNumber } from "@/lib/training/activity-types";
import { mix, type ChartPalette } from "@/lib/training/color";
import { gradeColor, GRADE_SCALE, type RouteProfile } from "@/lib/training/metrics/route-profile";
import {
  bestWindows,
  daylightFlag,
  describeWindow,
  nowIndex,
  predictWeek,
  sectionTailwinds,
  windPhrase,
  windowLabel,
  type Daylight,
  type RouteForecast,
  type Window,
} from "@/lib/training/route-forecast";

import { useChartPalette } from "./Chart";
import { useTrackAnalysis } from "./RouteAnalysis";

const PlannerMap = dynamic(() => import("./PlannerMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading" style={{ height: 380 }}>Loading map…</div>,
});

const MPH = 2.236936;
const WATTS_MIN = 60;
const WATTS_MAX = 450;
const HOUR_MARKS = [0, 6, 12, 18];

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: RouteForecast };

/**
 * When to ride a saved route: the predicted moving time for every hour of the
 * coming week at a chosen power, the windows worth taking, and the wind each
 * stretch of the route meets in the hour picked.
 *
 * The server sends the forecast and the route's sections once. Moving the
 * power or picking an hour reruns the same model here, so both are instant.
 */
export default function RoutePlanner({ routeId, profile }: { routeId: string; profile: RouteProfile }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/training/route-forecast?id=${encodeURIComponent(routeId)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
        return body as RouteForecast;
      })
      .then((data) => !cancelled && setLoad({ status: "ready", data }))
      .catch((error: Error) => !cancelled && setLoad({ status: "error", message: error.message }));
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  return (
    <article className="panel t-planner" aria-busy={load.status === "loading"}>
      <div className="t-card-head">
        <div>
          <span className="label">Ride planner · next 7 days</span>
          <h2 className="t-card-title">When to ride it</h2>
        </div>
      </div>
      {load.status === "loading" && <div className="t-map is-loading">Reading the forecast along the route…</div>}
      {load.status === "error" && (
        <p className="t-empty">
          {load.message === "Forecast unavailable"
            ? "The forecast is unavailable right now. Try again in a few minutes."
            : `The planner could not run for this route: ${load.message}.`}
        </p>
      )}
      {load.status === "ready" && <Planner data={load.data} profile={profile} />}
    </article>
  );
}

function Planner({ data, profile }: { data: RouteForecast; profile: RouteProfile }) {
  const palette = useChartPalette();
  const [wattsChoice, setWattsChoice] = useState<number | null>(null);
  const [hourChoice, setHourChoice] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [mapMode, setMapMode] = useState<"wind" | "gradient">("wind");
  // The clock lives in state and ticks, so a page left open moves on with it.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const defaultWatts = data.power.default.watts;
  const watts = useDeferredValue(wattsChoice ?? defaultWatts);
  const rider = useMemo(() => ({ ...data.rider, power_w: watts }), [data.rider, watts]);
  const assignment = useMemo(() => data.sections.map((s) => s.cell), [data.sections]);

  const week = useMemo(
    () =>
      watts === data.power.watts
        ? { times: data.times, calm: data.calm }
        : predictWeek(data.sections, assignment, data.cells, rider, data.hours.length),
    [watts, data, assignment, rider],
  );

  const dayOf = useMemo(() => data.hours.map((h) => h.slice(0, 10)), [data.hours]);
  const sun = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data.days]);
  const daylight = useMemo<Daylight[]>(
    () =>
      data.hours.map((local, i) => {
        const day = sun.get(local.slice(0, 10));
        if (!day || day.sunrise === null || day.sunset === null) return 2;
        return daylightFlag(data.epochs[i], week.times[i] ?? 3600, { sunrise: day.sunrise, sunset: day.sunset });
      }),
    [data.hours, data.epochs, sun, week.times],
  );

  const from = nowIndex(data.epochs, nowMs / 1000);
  const today = useMemo(() => localDate(nowMs, data.timezone), [nowMs, data.timezone]);
  const best = useMemo(
    () => bestWindows(week.times, week.calm, { from, days: dayOf, daylight, precip: data.weather.precip_prob }),
    [week, from, dayOf, daylight, data.weather.precip_prob],
  );

  const playable = (i: number) => i >= from && i < data.hours.length && week.times[i] !== null;
  const hour =
    hourChoice !== null && playable(hourChoice) ? hourChoice : (best[0]?.hour ?? (playable(from) ? from : null));

  const tail = useMemo(
    () => (hour === null ? null : sectionTailwinds(data.sections, assignment, data.cells, hour, rider)),
    [hour, data.sections, assignment, data.cells, rider],
  );
  const bestTails = useMemo(
    () => best.map((w) => sectionTailwinds(data.sections, assignment, data.cells, w.hour, rider) ?? []),
    [best, data.sections, assignment, data.cells, rider],
  );

  const windowAt = (i: number): Window | null => {
    const time = week.times[i];
    const calm = week.calm[i];
    return time === null || calm === null ? null : { hour: i, time_s: time, calm_s: calm, saved_s: calm - time };
  };
  const selected = hour === null ? null : windowAt(hour);

  return (
    <>
      <PowerControl
        watts={wattsChoice ?? defaultWatts}
        defaultWatts={defaultWatts}
        defaultLabel={data.power.default.label}
        onChange={setWattsChoice}
      />

      {best.length ? (
        <div className="t-plan-best">
          <p className="t-plan-headline">
            <span className="t-plan-kicker">Best window</span>
            {describeWindow(best[0], data.hours[best[0].hour], windPhrase(data.sections, bestTails[0]), today)}
          </p>
          {best.length > 1 && (
            <div className="t-plan-windows" role="group" aria-label="Best windows">
              {best.map((w) => (
                <button
                  key={w.hour}
                  type="button"
                  className="t-plan-window"
                  aria-pressed={w.hour === hour}
                  onClick={() => setHourChoice(w.hour)}
                >
                  <span>{windowLabel(data.hours[w.hour], today)}</span>
                  <strong className="num">{formatHours(w.time_s / 3600)}</strong>
                  <small className={`num ${w.saved_s >= 0 ? "is-faster" : "is-slower"}`}>{minutesVsCalm(w.saved_s)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="t-empty">No start time left in this forecast lets the ride finish before it ends.</p>
      )}

      <Matrix
        data={data}
        times={week.times}
        calm={week.calm}
        daylight={daylight}
        from={from}
        best={best}
        hour={hour}
        hovered={hovered}
        today={today}
        onHover={setHovered}
        onSelect={setHourChoice}
        windowAt={windowAt}
      />

      <div className="t-plan-body">
        <div className="t-plan-map">
          <div className="t-card-head">
            <div>
              <span className="label">Map · {hour === null ? "—" : windowLabel(data.hours[hour], today)}</span>
              <h3 className="t-plan-subtitle">
                {mapMode === "wind" ? "Coloured by the wind you meet" : "Coloured by gradient"}
              </h3>
            </div>
            <div className="chip-row" role="group" aria-label="Colour the route by">
              {(["wind", "gradient"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="chip"
                  aria-pressed={mapMode === mode}
                  onClick={() => setMapMode(mode)}
                >
                  {mode === "wind" ? "Wind" : "Gradient"}
                </button>
              ))}
            </div>
          </div>
          <RouteColours
            data={data}
            profile={profile}
            tail={tail}
            mode={mapMode}
            palette={palette}
            wind={hour === null ? null : meanWind(data, hour)}
          />
        </div>
        {selected && hour !== null && tail ? (
          <HourDetail
            data={data}
            window={selected}
            tail={tail}
            daylight={daylight[hour]}
            today={today}
            watts={watts}
          />
        ) : (
          <p className="t-empty">Pick an hour to see the ride.</p>
        )}
      </div>

      <p className="t-note">
        Moving time at a steady {watts} W for a {formatNumber(data.rider.mass_kg, 1)} kg rider and bike (
        {data.rider.mass_source === "settings"
          ? "your weight plus 9 kg"
          : data.rider.mass_source === "calibration"
            ? "fitted"
            : "assumed"}
        ), CdA {data.rider.cda.toFixed(3)}, Crr {data.rider.crr}. Each of {data.sections.length} sections is ridden on
        its own bearing and gradient in the forecast for the moment you reach it, from {data.cells.length} forecast{" "}
        {data.cells.length === 1 ? "point" : "points"} along the route. Calm air is the same ride with no wind. Forecast
        from Open-Meteo, {formatClock(Date.parse(data.issued_at) / 1000, data.timezone)}.
      </p>
    </>
  );
}

// ------------------------------------------------------------ controls --

function PowerControl({
  watts,
  defaultWatts,
  defaultLabel,
  onChange,
}: {
  watts: number;
  defaultWatts: number;
  defaultLabel: string;
  onChange: (watts: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (value: number) => {
    const clamped = Math.round(Math.min(WATTS_MAX, Math.max(WATTS_MIN, value)));
    onChange(clamped === defaultWatts ? null : clamped);
  };
  return (
    <div className="t-plan-power">
      <label className="t-plan-power-label" htmlFor="planner-watts">
        Power
      </label>
      <input
        id="planner-watts"
        type="range"
        min={WATTS_MIN}
        max={WATTS_MAX}
        step={1}
        value={watts}
        aria-valuetext={`${watts} watts`}
        onChange={(event) => commit(Number(event.target.value))}
      />
      <span className="t-plan-power-number">
        <input
          className="t-input num"
          type="number"
          inputMode="numeric"
          min={WATTS_MIN}
          max={WATTS_MAX}
          aria-label="Power in watts"
          value={draft ?? String(watts)}
          onChange={(event) => {
            setDraft(event.target.value);
            const value = Number(event.target.value);
            if (event.target.value && value >= WATTS_MIN && value <= WATTS_MAX) commit(value);
          }}
          onBlur={() => setDraft(null)}
        />
        <span aria-hidden="true">W</span>
      </span>
      <p className="t-plan-power-note">
        {watts === defaultWatts ? (
          <>
            Default {defaultWatts} W: {defaultLabel.charAt(0).toLowerCase() + defaultLabel.slice(1)}.
          </>
        ) : (
          <>
            {watts > defaultWatts ? "+" : "−"}
            {Math.abs(watts - defaultWatts)} W on your default.{" "}
            <button type="button" className="t-link" onClick={() => onChange(null)}>
              Reset to {defaultWatts} W
            </button>
          </>
        )}
      </p>
    </div>
  );
}

// -------------------------------------------------------------- matrix --

/** Diverging fill: faster than calm toward the open hue, slower toward effort. */
function savedFill(saved: number, scale: number): string {
  if (Math.abs(saved) < 15) return "var(--surface-3)";
  const step = Math.min(3, Math.floor((Math.abs(saved) / scale) * 4));
  const strength = [30, 50, 72, 100][step];
  return `color-mix(in srgb, ${saved > 0 ? "var(--data-open)" : "var(--data-effort)"} ${strength}%, var(--surface-2))`;
}

function Matrix({
  data,
  times,
  calm,
  daylight,
  from,
  best,
  hour,
  hovered,
  today,
  onHover,
  onSelect,
  windowAt,
}: {
  data: RouteForecast;
  times: Array<number | null>;
  calm: Array<number | null>;
  daylight: Daylight[];
  from: number;
  best: Window[];
  hour: number | null;
  hovered: number | null;
  today: string;
  onHover: (hour: number | null) => void;
  onSelect: (hour: number) => void;
  windowAt: (hour: number) => Window | null;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const byDay = new Map<string, Array<number | null>>();
    data.hours.forEach((local, index) => {
      const day = local.slice(0, 10);
      const slot = Number(local.slice(11, 13));
      if (!byDay.has(day)) byDay.set(day, Array(24).fill(null));
      const row = byDay.get(day)!;
      if (row[slot] === null) row[slot] = index;
    });
    return [...byDay.entries()];
  }, [data.hours]);

  const scale = useMemo(() => {
    let max = 60;
    times.forEach((time, i) => {
      if (i >= from && time !== null && calm[i] !== null) max = Math.max(max, Math.abs(calm[i]! - time));
    });
    return max;
  }, [times, calm, from]);

  const bestHours = new Set(best.map((w) => w.hour));
  const playable = (i: number) => i >= from && i < times.length && times[i] !== null;

  const move = (delta: number) => {
    if (hour === null) return;
    let next = hour + delta;
    while (next >= 0 && next < times.length && !playable(next)) next += Math.sign(delta);
    if (playable(next)) {
      onSelect(next);
      grid.current?.querySelector<HTMLButtonElement>(`[data-hour="${next}"]`)?.focus();
    }
  };

  const focus = hovered ?? hour;
  const focusWindow = focus === null ? null : windowAt(focus);

  return (
    <div className="t-plan-matrix-wrap">
      <p className="t-plan-readout" aria-live="polite">
        {focus !== null && focusWindow ? (
          <>
            <strong>{windowLabel(data.hours[focus], today)}</strong>
            <span className="num">{formatHours(focusWindow.time_s / 3600)}</span>
            <span className={`num ${focusWindow.saved_s >= 0 ? "is-faster" : "is-slower"}`}>
              {minutesVsCalm(focusWindow.saved_s)}
            </span>
            <span>{["after dark", "partly in the dark", "in daylight"][daylight[focus]]}</span>
            {data.weather.precip_prob[focus] >= 30 && <span>{data.weather.precip_prob[focus]}% rain</span>}
          </>
        ) : (
          <span>Pick a start time.</span>
        )}
      </p>
      <div
        ref={grid}
        className="t-plan-matrix"
        role="grid"
        aria-label="Predicted moving time by start hour, compared with calm air"
        onMouseLeave={() => onHover(null)}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -24, ArrowDown: 24 }[event.key];
          if (delta) {
            event.preventDefault();
            move(delta);
          }
        }}
      >
        <div className="t-plan-hours" role="row" aria-hidden="true">
          <span />
          {HOUR_MARKS.map((mark) => (
            <span key={mark} style={{ gridColumn: `${mark + 2} / span 6` }}>
              {mark === 0 ? "12a" : mark === 12 ? "12p" : mark < 12 ? `${mark}a` : `${mark - 12}p`}
            </span>
          ))}
        </div>
        {rows.map(([day, slots]) => (
          <div className="t-plan-row" role="row" key={day}>
            <span className="t-plan-day" role="rowheader">
              {dayLabel(day, today)}
            </span>
            {slots.map((index, slot) => {
              if (index === null) return <span key={slot} className="t-plan-cell is-empty" role="gridcell" />;
              const time = times[index];
              const live = playable(index);
              const saved = time !== null && calm[index] !== null ? calm[index]! - time : 0;
              const label = live
                ? `${windowLabel(data.hours[index], today)}: ${formatHours(time! / 3600)}, ${minutesVsCalm(saved)}${
                    bestHours.has(index) ? ", best window" : ""
                  }`
                : `${windowLabel(data.hours[index], today)}: ${index < from ? "past" : "beyond the forecast"}`;
              return (
                <span key={slot} role="gridcell" className="t-plan-gridcell">
                  <button
                    type="button"
                    data-hour={index}
                    className="t-plan-cell"
                    data-daylight={daylight[index]}
                    data-best={bestHours.has(index) || undefined}
                    disabled={!live}
                    tabIndex={index === hour ? 0 : -1}
                    aria-pressed={index === hour}
                    aria-label={label}
                    style={live ? { backgroundColor: savedFill(saved, scale) } : undefined}
                    onClick={() => onSelect(index)}
                    onMouseEnter={() => onHover(live ? index : null)}
                    onFocus={() => onHover(null)}
                  />
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="t-plan-legend" aria-hidden="true">
        <span className="t-plan-ramp">
          <small>Slower than calm</small>
          {[100, 50].map((s) => (
            <i key={`e${s}`} style={{ background: `color-mix(in srgb, var(--data-effort) ${s}%, var(--surface-2))` }} />
          ))}
          <i style={{ background: "var(--surface-3)" }} />
          {[50, 100].map((s) => (
            <i key={`o${s}`} style={{ background: `color-mix(in srgb, var(--data-open) ${s}%, var(--surface-2))` }} />
          ))}
          <small>Faster · up to {Math.round(scale / 60)} min</small>
        </span>
        <span>
          <i className="t-plan-swatch is-night" />
          Dark for part or all of the ride
        </span>
        <span>
          <i className="t-plan-swatch is-best" />
          Best window
        </span>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- map --

/** Wind colours: tail toward the open hue, head toward effort, grey when it barely matters. */
function windColour(componentMs: number, palette: ChartPalette): string {
  const mph = Math.abs(componentMs) * MPH;
  if (mph < 2) return palette.ink3;
  const strength = mph < 5 ? 0.45 : mph < 10 ? 0.72 : 1;
  return mix(palette.ink3, componentMs > 0 ? palette.open : palette.effort, strength);
}

const WIND_LEGEND: Array<[string, number]> = [
  ["10+ head", -5],
  ["5–10", -3],
  ["2–5", -1.5],
  ["Cross or calm", 0],
  ["2–5", 1.5],
  ["5–10", 3],
  ["10+ tail", 5],
];

function RouteColours({
  data,
  profile,
  tail,
  mode,
  palette,
  wind,
}: {
  data: RouteForecast;
  profile: RouteProfile;
  tail: number[] | null;
  mode: "wind" | "gradient";
  palette: ChartPalette;
  wind: { speed: number; from: number } | null;
}) {
  const { grades } = useTrackAnalysis(profile);
  const sectionOfPoint = useMemo(() => {
    const out: number[] = [];
    let cursor = 0;
    const start = (profile.distance[0] ?? 0) * 1609.344;
    for (const miles of profile.distance) {
      const metres = miles * 1609.344 - start;
      while (
        cursor < data.sections.length - 1 &&
        metres >= data.sections[cursor].start_m + data.sections[cursor].length_m
      ) {
        cursor++;
      }
      out.push(cursor);
    }
    return out;
  }, [profile.distance, data.sections]);

  const colors = useMemo(
    () =>
      mode === "gradient" || !tail
        ? grades.map((grade) => gradeColor(grade, palette.theme))
        : sectionOfPoint.map((section) => windColour(tail[section] ?? 0, palette)),
    [mode, tail, grades, sectionOfPoint, palette],
  );
  const hasTrack = profile.latlng.some(Boolean);

  return (
    <>
      <div className="t-plan-map-frame">
        {hasTrack ? (
          <PlannerMap
            latlng={profile.latlng}
            colors={colors}
            theme={palette.theme}
            ink={palette.ink}
            ground={palette.ground}
            label={
              mode === "wind"
                ? "Route map coloured by headwind and tailwind for the selected hour"
                : "Route map coloured by gradient"
            }
          />
        ) : (
          <div className="t-map is-loading">No GPS track for this route.</div>
        )}
        {mode === "wind" && wind && wind.speed * MPH >= 1 && (
          <div className="t-plan-compass" aria-label={`Wind from ${compassLabel(wind.from)}`} role="img">
            <svg viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="18" />
              <g transform={`rotate(${(wind.from + 180) % 360} 20 20)`}>
                <path d="M20 8 L26 22 L20 19 L14 22 Z" />
                <line x1="20" y1="19" x2="20" y2="32" />
              </g>
            </svg>
            <span className="num">
              {Math.round(wind.speed * MPH)} mph
              <br />
              from {compassLabel(wind.from)}
            </span>
          </div>
        )}
      </div>
      {mode === "wind" ? (
        <div className="t-grade-legend" aria-label="Wind colours, in miles per hour along the route">
          {WIND_LEGEND.map(([label, value], index) => (
            <span key={index}>
              <i style={{ background: windColour(value, palette) }} />
              {label}
            </span>
          ))}
        </div>
      ) : (
        <div className="t-grade-legend" aria-label="Gradient colours">
          {GRADE_SCALE.map((band) => (
            <span key={band.label}>
              <i style={{ background: band[palette.theme] }} />
              {band.label}
            </span>
          ))}
        </div>
      )}
      <p className="t-note">The first and last 500 m are hidden to keep home private.</p>
    </>
  );
}

// -------------------------------------------------------------- detail --

function HourDetail({
  data,
  window,
  tail,
  daylight,
  today,
  watts,
}: {
  data: RouteForecast;
  window: Window;
  tail: number[];
  daylight: Daylight;
  today: string;
  watts: number;
}) {
  const hour = window.hour;
  const wind = meanWind(data, hour);
  const total = data.distance_m;
  const net = data.sections.reduce((sum, s, i) => sum + tail[i] * s.length_m, 0) / Math.max(1, total);
  const day = data.days.find((d) => d.date === data.hours[hour].slice(0, 10));
  const finish = data.epochs[hour] + window.time_s;
  const phrase = windPhrase(data.sections, tail);
  const tempF = data.weather.temperature_c[hour] * 1.8 + 32;

  return (
    <div className="t-plan-detail">
      <span className="label">{windowLabel(data.hours[hour], today)} start</span>
      <div className="hero-number">
        <span className="big">{formatHours(window.time_s / 3600)}</span>
        <span className="unit">moving</span>
      </div>
      <p className="t-plan-phrase">
        <span className={window.saved_s >= 0 ? "is-faster" : "is-slower"}>{minutesVsCalm(window.saved_s)}</span>
        {phrase ? `, ${phrase}` : ""}.
      </p>
      <div className="stat-row">
        <span className="k">Calm-air time</span>
        <span className="v">{formatHours(window.calm_s / 3600)}</span>
      </div>
      <div className="stat-row">
        <span className="k">Average speed</span>
        <span className="v">{((total / window.time_s) * MPH).toFixed(1)} mph</span>
      </div>
      <div className="stat-row">
        <span className="k">Wind</span>
        <span className="v">
          {Math.round(wind.speed * MPH)} mph from {compassLabel(wind.from)}, gusts{" "}
          {Math.round(data.weather.gust_ms[hour] * MPH)}
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Net tailwind on route</span>
        <span className={`v ${net > 0.2 ? "is-faster" : net < -0.2 ? "is-slower" : ""}`}>
          {net >= 0 ? "+" : "−"}
          {(Math.abs(net) * MPH).toFixed(1)} mph
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Temperature · rain</span>
        <span className="v">
          {Math.round(tempF)}°F · {data.weather.precip_prob[hour]}%
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Back by</span>
        <span className="v">
          {formatClock(finish, data.timezone)}
          {day?.sunset ? ` · sunset ${formatClock(day.sunset, data.timezone)}` : ""}
        </span>
      </div>
      {daylight < 2 && (
        <p className="t-plan-warning">
          {daylight === 0 ? "This ride is in the dark." : "Part of this ride is in the dark."} Bring lights.
        </p>
      )}
      <TailStrip data={data} tail={tail} watts={watts} />
    </div>
  );
}

/** Tailwind along the route for the chosen hour, above and below a calm line. */
function TailStrip({ data, tail, watts }: { data: RouteForecast; tail: number[]; watts: number }) {
  const total = Math.max(1, data.distance_m);
  const max = Math.max(2, ...tail.map((t) => Math.abs(t)));
  return (
    <div className="t-plan-strip">
      <span className="label">Wind along the route at {watts} W</span>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tailwind from ${(Math.min(...tail) * MPH).toFixed(0)} to ${(Math.max(...tail) * MPH).toFixed(
          0,
        )} mph along the route`}
      >
        <line x1="0" y1="20" x2="100" y2="20" stroke="var(--line)" strokeWidth="0.4" />
        {data.sections.map((s, i) => {
          const h = (Math.abs(tail[i]) / max) * 18;
          const up = tail[i] >= 0;
          return (
            <rect
              key={i}
              x={(s.start_m / total) * 100}
              y={up ? 20 - h : 20}
              width={Math.max(0.3, (s.length_m / total) * 100)}
              height={h}
              fill={up ? "var(--data-open)" : "var(--data-effort)"}
            />
          );
        })}
      </svg>
      <div className="t-plan-strip-axis num">
        <span>tailwind ↑ · headwind ↓</span>
        <span>{formatNumber(data.distance_m / 1609.344, 0)} mi</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- helpers --

/** Route-mean wind at 10 m for an hour, averaged as vectors across the cells. */
function meanWind(data: RouteForecast, hour: number): { speed: number; from: number } {
  let u = 0;
  let v = 0;
  for (const cell of data.cells) {
    const r = (cell.from[hour] * Math.PI) / 180;
    u += cell.speed[hour] * Math.sin(r);
    v += cell.speed[hour] * Math.cos(r);
  }
  const n = Math.max(1, data.cells.length);
  const scalar = data.cells.reduce((s, c) => s + c.speed[hour], 0) / n;
  return { speed: scalar, from: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 };
}

function minutesVsCalm(saved: number): string {
  const minutes = Math.round(Math.abs(saved) / 60);
  if (minutes === 0) return "same as calm air";
  return `${minutes} min ${saved > 0 ? "faster" : "slower"} than calm`;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function formatIn(timeZone: string, options: Intl.DateTimeFormatOptions, locale = "en-US") {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat(locale, options);
    }
    dateFormats.set(key, format);
  }
  return format;
}

function localDate(epochMs: number, timeZone: string): string {
  return formatIn(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(epochMs);
}

function formatClock(epochS: number, timeZone: string): string {
  return formatIn(timeZone, { hour: "numeric", minute: "2-digit" }).format(epochS * 1000);
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${at.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${d}`;
}
