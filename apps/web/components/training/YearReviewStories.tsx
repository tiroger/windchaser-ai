"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import {
  formatCalendarDate,
  formatHours,
  formatNumber,
  sportLabel,
} from "@/lib/training/activity-types";
import {
  MONTH_NAMES,
  STREAM_WEEKS,
  weekStart,
  type BigDay,
  type Comparison,
  type CourtChapter,
  type GearRace,
  type PlaceSketch,
  type RingDay,
} from "@/lib/training/metrics/year-review";

import SportIcon from "./SportIcon";
import {
  CountUp,
  KIND_COLOR,
  shortDate,
  smoothPath,
  useInView,
  useReducedMotion,
} from "./YearReviewParts";

// --------------------------------------------------------- biggest days --

type Card = BigDay & { sketch: string | null };

function DayCard({ day, index }: { day: Card; index: number }) {
  const [flipped, setFlipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { activity } = day;

  // A gentle tilt toward the pointer; the card stays flat for touch and
  // reduced motion.
  const tilt = (event: PointerEvent<HTMLDivElement>) => {
    if (reduced || event.pointerType !== "mouse" || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    ref.current.style.setProperty("--rx", `${(-y * 7).toFixed(2)}deg`);
    ref.current.style.setProperty("--ry", `${(x * 9).toFixed(2)}deg`);
    ref.current.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(1)}%`);
    ref.current.style.setProperty("--gy", `${((y + 0.5) * 100).toFixed(1)}%`);
  };
  const settle = () => {
    ref.current?.style.setProperty("--rx", "0deg");
    ref.current?.style.setProperty("--ry", "0deg");
  };

  const stats: Array<[string, string]> = [
    ["Distance", activity.distance >= 0.1 ? `${formatNumber(activity.distance, 1)} mi` : "—"],
    ["Moving time", formatHours(activity.hours)],
    ["Elevation", activity.elevation ? `${formatNumber(activity.elevation)} ft` : "—"],
    ["Average speed", activity.speed ? `${activity.speed.toFixed(1)} mph` : "—"],
    ["Power", activity.watts ? `${formatNumber(activity.watts)} W` : "—"],
    ["Heart rate", activity.heartrate ? `${Math.round(activity.heartrate)} bpm` : "—"],
    ["Relative Effort", activity.effort ? formatNumber(activity.effort) : "—"],
  ];

  return (
    <div
      className={`yr-day-card${flipped ? " is-flipped" : ""}`}
      ref={ref}
      onPointerMove={tilt}
      onPointerLeave={settle}
      style={{ "--i": index, "--tone": KIND_COLOR[activity.kind] } as React.CSSProperties}
      data-reveal
    >
      <div className="yr-day-inner">
        <div className="yr-day-face is-front" aria-hidden={flipped}>
          <span className="yr-mini-label">{day.label}</span>
          <strong className="yr-day-value num">{day.display}</strong>
          <div className="yr-day-sketch">
            {day.sketch ? (
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <path className="yr-day-route-shadow" d={day.sketch} />
                <path className="yr-day-route" d={day.sketch} pathLength={1} />
              </svg>
            ) : (
              <span className="yr-day-icon" aria-hidden="true">
                <SportIcon kind={activity.kind} />
              </span>
            )}
          </div>
          <span className="yr-day-name">{activity.name}</span>
          <span className="yr-day-meta">
            {formatCalendarDate(activity.date, { weekday: "short", month: "short", day: "numeric" })} ·{" "}
            {sportLabel(activity.type)}
          </span>
          <button
            type="button"
            className="yr-flip"
            onClick={() => setFlipped(true)}
            aria-label={`Details for ${day.label.toLowerCase()}: ${activity.name}`}
            tabIndex={flipped ? -1 : 0}
          >
            Details
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h9M9 4.5 12.5 8 9 11.5" />
            </svg>
          </button>
        </div>
        <div className="yr-day-face is-back" aria-hidden={!flipped}>
          <span className="yr-mini-label">{day.label}</span>
          <span className="yr-day-name">{activity.name}</span>
          <dl>
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="num">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="yr-day-actions">
            <Link
              href={`/training/activities/${activity.id}`}
              className="yr-link"
              tabIndex={flipped ? 0 : -1}
            >
              Open activity
            </Link>
            <button
              type="button"
              className="yr-flip"
              onClick={() => setFlipped(false)}
              tabIndex={flipped ? 0 : -1}
            >
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BiggestDays({ days }: { days: Card[] }) {
  return (
    <div className="yr-days">
      {days.map((day, index) => (
        <DayCard key={day.key} day={day} index={index} />
      ))}
    </div>
  );
}

// --------------------------------------------------------------- places --

/** Chapter eight: every local route of the year drawn over the others. */
export function Places({ sketch, ring }: { sketch: PlaceSketch; ring: RingDay[] }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [hot, setHot] = useState<string | null>(null);
  const names = useMemo(() => {
    const map = new Map<string, { name: string; date: string }>();
    for (const day of ring) {
      for (const activity of day.activities) map.set(activity.id, { name: activity.name, date: day.date });
    }
    return map;
  }, [ring]);
  const total = sketch.routes.length;
  const label = hot ? names.get(hot) : null;
  return (
    <div className={`yr-places${inView ? " is-in" : ""}${hot ? " has-hot" : ""}`} ref={ref}>
      <svg
        viewBox={`0 0 ${sketch.width} ${sketch.height}`}
        role="img"
        aria-label={`${total} routes from the year drawn on top of one another, with the first and last 500 metres of each hidden.`}
        onPointerLeave={() => setHot(null)}
      >
        <defs>
          <pattern id="yr-dots" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" />
          </pattern>
        </defs>
        <rect className="yr-places-ground" width={sketch.width} height={sketch.height} fill="url(#yr-dots)" />
        <g className="yr-places-routes">
          {sketch.routes.map((route) => (
            <path
              key={route.id}
              d={route.d}
              pathLength={1}
              className={hot === route.id ? "is-hot" : undefined}
              style={{ "--d": (route.order / Math.max(1, total)).toFixed(3) } as React.CSSProperties}
            />
          ))}
        </g>
        <g className="yr-places-hit">
          {sketch.routes.map((route) => (
            <path key={route.id} d={route.d} onPointerEnter={() => setHot(route.id)} />
          ))}
        </g>
      </svg>
      <div className="yr-places-caption" aria-live="polite">
        {label ? (
          <>
            <strong>{label.name}</strong>
            <span>{shortDate(label.date, true)}</span>
          </>
        ) : (
          <span>Hover a line to name the ride</span>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- gear --

const RACE_MS = 7000;

/** Chapter nine: the year's miles per bike as a bar race, week by week. */
export function GearRaceChart({ race, year }: { race: GearRace; year: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.45);
  const reduced = useReducedMotion();
  const last = STREAM_WEEKS - 1;
  const [week, setWeek] = useState(last);
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  const frame = useRef(0);

  const play = (from = 0) => {
    cancelAnimationFrame(frame.current);
    setPlaying(true);
    const start = performance.now() - (from / last) * RACE_MS;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / RACE_MS);
      setWeek(Math.round(t * last));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!inView || reduced || started.current) return;
    started.current = true;
    play(0);
    // play reads only refs and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, reduced]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const entries = race.entries;
  const max = Math.max(1, ...entries.map((entry) => entry.total));
  const ranked = [...entries].sort((a, b) => b.cumulative[week] - a.cumulative[week]);
  const rank = new Map(ranked.map((entry, index) => [entry.id, index]));
  const leader = ranked[0];
  const month = Number(weekStart(year, week).slice(5, 7)) - 1;

  return (
    <div className="yr-race" ref={ref}>
      <div className="yr-race-stage" style={{ height: entries.length * 58 }}>
        <span
          className="yr-race-month"
          aria-hidden="true"
          style={{ fontSize: `min(${entries.length * 58 * 0.9}px, clamp(4rem, 11vw, 8.5rem))` }}
        >
          {MONTH_NAMES[month].slice(0, 3)}
        </span>
        {entries.map((entry) => {
          const value = entry.cumulative[week];
          const position = rank.get(entry.id) ?? 0;
          return (
            <div
              key={entry.id}
              className={`yr-race-row${entry === leader && value > 0 ? " is-leader" : ""}`}
              style={{ transform: `translateY(${position * 58}px)` }}
            >
              <span className="yr-race-name">
                <strong>{entry.name}</strong>
                {entry.detail && <small>{entry.detail}</small>}
              </span>
              <span className="yr-race-track">
                <span className="yr-race-bar" style={{ width: `${(value / max) * 100}%` }} />
                <span className="yr-race-value num">{formatNumber(value)} mi</span>
              </span>
            </div>
          );
        })}
      </div>
      <div className="yr-race-controls">
        <button
          type="button"
          className="yr-play"
          onClick={() => {
            if (playing) {
              cancelAnimationFrame(frame.current);
              setPlaying(false);
            } else play(week >= last ? 0 : week);
          }}
          aria-label={playing ? "Pause the race" : week >= last ? "Replay the race" : "Play the race"}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5v9M11 3.5v9" />
            </svg>
          ) : week >= last ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.8v2.6h2.6" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6L12.5 8Z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={week}
          onChange={(event) => {
            cancelAnimationFrame(frame.current);
            setPlaying(false);
            setWeek(Number(event.target.value));
          }}
          aria-label="Week of the year"
          aria-valuetext={`Week of ${shortDate(weekStart(year, week))}`}
        />
        <span className="yr-race-week num">{shortDate(weekStart(year, week))}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- court --

/** Chapter ten: every pickleball session as a ball dropped into its month. */
export function Court({ court }: { court: CourtChapter }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const perMonth = Math.max(...court.months);
  const columnWidth = 64;
  const ball = 28;
  const rowHeight = 29;
  const width = columnWidth * 12;
  const height = Math.max(4, perMonth) * rowHeight + 34;
  const stacks = new Array<number>(12).fill(0);
  const longestId = court.longest?.id;
  return (
    <div className={`yr-court${inView ? " is-in" : ""}`} ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${court.sessions} pickleball sessions by month`}>
        <line className="yr-court-floor" x1={0} x2={width} y1={height - 26} y2={height - 26} />
        {court.balls.map((entry, index) => {
          const level = stacks[entry.month]++;
          const r = Math.max(7, Math.min(ball / 2, (ball / 2) * Math.sqrt(entry.hours / 2)));
          const cx = entry.month * columnWidth + columnWidth / 2 + (level % 2 ? 3 : -3);
          const cy = height - 26 - rowHeight / 2 - level * rowHeight;
          return (
            <g
              key={entry.id}
              className={`yr-ball${entry.id === longestId ? " is-longest" : ""}`}
              style={{ "--i": index, "--drop": `${-(cy + 40)}px` } as React.CSSProperties}
            >
              <circle cx={cx} cy={cy} r={r} />
              <circle className="yr-ball-hole" cx={cx - r * 0.3} cy={cy - r * 0.25} r={r * 0.16} />
              <circle className="yr-ball-hole" cx={cx + r * 0.32} cy={cy + r * 0.05} r={r * 0.16} />
              <circle className="yr-ball-hole" cx={cx - r * 0.05} cy={cy + r * 0.4} r={r * 0.16} />
              <title>{`${shortDate(entry.date, true)} · ${formatHours(entry.hours)}`}</title>
            </g>
          );
        })}
        {MONTH_NAMES.map((name, month) => (
          <text
            key={name}
            className={`yr-court-month${month === court.busiestMonth ? " is-top" : ""}`}
            x={month * columnWidth + columnWidth / 2}
            y={height - 6}
            textAnchor="middle"
          >
            {name.slice(0, 3)}
          </text>
        ))}
      </svg>
      <dl className="yr-court-stats">
        <div>
          <dt>Sessions</dt>
          <dd className="num">
            <CountUp value={court.sessions} />
          </dd>
        </div>
        <div>
          <dt>On court</dt>
          <dd className="num">
            <CountUp value={court.hours} format={(v) => `${formatNumber(v, 0)}h`} />
          </dd>
        </div>
        {court.busiestMonth !== null && (
          <div>
            <dt>Busiest month</dt>
            <dd>
              {MONTH_NAMES[court.busiestMonth]}
              <small className="num"> · {court.months[court.busiestMonth]} sessions</small>
            </dd>
          </div>
        )}
        {court.longest && (
          <div>
            <dt>Longest session</dt>
            <dd>
              <Link href={`/training/activities/${court.longest.id}`} className="yr-link">
                {formatHours(court.longest.hours)}
              </Link>
              <small> · {shortDate(court.longest.date)}</small>
            </dd>
          </div>
        )}
        {court.heartrate && (
          <div>
            <dt>Average heart rate</dt>
            <dd className="num">{Math.round(court.heartrate)} bpm</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// --------------------------------------------------------------- versus --

function formatValue(value: number, comparison: Comparison): string {
  if (comparison.key === "hours") return `${formatNumber(value, 0)}h`;
  return `${formatNumber(value, 0)}${comparison.unit && comparison.unit !== "days" ? ` ${comparison.unit}` : ""}`;
}

function Versus({ comparison, year, months }: { comparison: Comparison; year: number; months: number }) {
  const width = 240;
  const height = 92;
  const max = Math.max(1, ...comparison.currentMonthly, ...comparison.previousMonthly);
  const point = (value: number, month: number): [number, number] => [
    (month / 11) * width,
    height - 4 - (value / max) * (height - 12),
  ];
  const current = comparison.currentMonthly.map((value, month) => point(value, month));
  const previous = comparison.previousMonthly.map((value, month) => point(value, month));
  const area = `${smoothPath(current)}L${current[current.length - 1][0]} ${height}L0 ${height}Z`;
  const change = comparison.change;
  const direction = change === null ? "is-new" : change > 0.005 ? "is-up" : change < -0.005 ? "is-down" : "is-flat";
  return (
    <article className={`yr-vs ${direction}`} data-reveal>
      <div className="yr-vs-head">
        <span className="yr-mini-label">{comparison.label}</span>
        <span className="yr-vs-delta num">
          {change === null
            ? "new"
            : `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.round(Math.abs(change) * 100)}%`}
        </span>
      </div>
      <strong className="yr-vs-value num">
        <CountUp value={comparison.current} format={(value) => formatValue(value, comparison)} />
      </strong>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <path className="yr-vs-area" d={area} />
        <path className="yr-vs-prev" d={smoothPath(previous)} />
        <path className="yr-vs-line" d={smoothPath(current)} pathLength={1} />
      </svg>
      <span className="yr-vs-foot">
        <span>
          <i className="is-prev" /> {year - 1}: <b className="num">{formatValue(comparison.previous, comparison)}</b>
        </span>
        <span className="yr-muted">{months < 12 ? `Jan–${MONTH_NAMES[months - 1].slice(0, 3)}` : "Full year"}</span>
      </span>
    </article>
  );
}

export function VersusLastYear({
  comparisons,
  year,
  months,
}: {
  comparisons: Comparison[];
  year: number;
  months: number;
}) {
  return (
    <div className="yr-versus">
      {comparisons.map((comparison) => (
        <Versus key={comparison.key} comparison={comparison} year={year} months={months} />
      ))}
    </div>
  );
}
