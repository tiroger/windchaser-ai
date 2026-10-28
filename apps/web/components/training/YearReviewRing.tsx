"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { formatHours, formatNumber } from "@/lib/training/activity-types";
import {
  dateAtIndex,
  MONTH_NAMES,
  type DayRun,
  type ReviewWindow,
  type RingDay,
} from "@/lib/training/metrics/year-review";

import {
  arcPath,
  dateRange,
  KIND_COLOR,
  polar,
  shortDate,
  useInView,
  wedgePath,
} from "./YearReviewParts";

const TAU = Math.PI * 2;

export type RingGeometry = { size: number; inner: number; length: number };

const MONTH_STARTS = (year: number) =>
  Array.from({ length: 12 }, (_, month) => {
    const start = Date.UTC(year, month, 1);
    return (start - Date.UTC(year, 0, 1)) / 86_400_000;
  });

/**
 * The year's days as bars around a circle, each stacked by sport and as long
 * as the square root of its hours, so a two-hour pickleball evening still
 * shows beside a seven-hour fondo. Shared by the chapter and the share card.
 */
export function RingBars({
  days,
  window,
  geometry,
  hot,
}: {
  days: RingDay[];
  window: ReviewWindow;
  geometry: RingGeometry;
  hot?: number | null;
}) {
  const { size, inner, length } = geometry;
  const c = size / 2;
  const max = Math.max(1, ...days.map((day) => day.hours));
  const step = TAU / window.days;
  const gap = Math.min(step * 0.16, 0.004);
  return (
    <g className="yr-ring-days">
      {days.map((day) => {
        const from = day.index * step + gap;
        const to = (day.index + 1) * step - gap;
        const total = Math.max(length * 0.06, length * Math.sqrt(day.hours / max));
        let radius = inner;
        return (
          <g
            key={day.index}
            className={`yr-ring-day${hot === day.index ? " is-hot" : ""}`}
            style={{ "--a": (day.index / window.days).toFixed(3) } as React.CSSProperties}
          >
            {day.segments.map((segment) => {
              const span = day.hours > 0 ? (segment.hours / day.hours) * total : total;
              const path = wedgePath(c, c, radius, radius + span, from, to);
              radius += span;
              return <path key={segment.kind} d={path} style={{ fill: KIND_COLOR[segment.kind] }} />;
            })}
          </g>
        );
      })}
    </g>
  );
}

function hoursLabel(hours: number) {
  return hours >= 1 ? `${formatNumber(hours, hours < 10 ? 1 : 0)}h` : `${Math.round(hours * 60)}m`;
}

/**
 * Chapter four: the year as a ring. Hover, tap or arrow through the days;
 * the centre and the panel beside it name what happened.
 */
export default function YearRing({
  days,
  window,
  streak,
  rest,
}: {
  days: RingDay[];
  window: ReviewWindow;
  streak: DayRun | null;
  rest: DayRun | null;
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const geometry: RingGeometry = { size: 1000, inner: 214, length: 214 };
  const { size, inner, length } = geometry;
  const c = size / 2;
  const step = TAU / window.days;
  const byIndex = useMemo(() => new Map(days.map((day) => [day.index, day])), [days]);
  const max = Math.max(1, ...days.map((day) => day.hours));
  const active = hover ?? pinned;
  const activeDay = active !== null ? byIndex.get(active) : undefined;

  const guides = [1, 2, 4, 8]
    .filter((hours) => hours <= max)
    .map((hours) => ({ hours, radius: inner + length * Math.sqrt(hours / max) }));

  const indexAt = (event: PointerEvent<SVGSVGElement>): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const scale = size / box.width;
    const x = (event.clientX - box.left) * scale - c;
    const y = (event.clientY - box.top) * scale - c;
    const distance = Math.hypot(x, y);
    if (distance < inner - 40 || distance > inner + length + 70) return null;
    const angle = (Math.atan2(x, -y) + TAU) % TAU;
    const index = Math.floor(angle / step);
    return index <= window.lastIndex ? index : null;
  };

  const sorted = days.map((day) => day.index);
  const move = (direction: 1 | -1) => {
    if (!sorted.length) return;
    const from = active ?? (direction === 1 ? -1 : window.days);
    const next =
      direction === 1
        ? (sorted.find((index) => index > from) ?? sorted[0])
        : ([...sorted].reverse().find((index) => index < from) ?? sorted[sorted.length - 1]);
    setPinned(next);
    setHover(null);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(-1);
    else if (event.key === "Home") setPinned(sorted[0] ?? null);
    else if (event.key === "End") setPinned(sorted[sorted.length - 1] ?? null);
    else if (event.key === "Escape") setPinned(null);
    else return;
    event.preventDefault();
  };

  const months = MONTH_STARTS(window.year);
  const restDays = window.lastIndex + 1 - days.length;
  const remaining = window.partial ? window.days - window.lastIndex - 1 : 0;
  const cursorAngle = active !== null ? (active + 0.5) * step : null;

  return (
    <div className="yr-ring-wrap">
      <div
        className={`yr-ring${inView ? " is-in" : ""}${active !== null ? " has-hot" : ""}`}
        ref={ref}
        tabIndex={0}
        role="group"
        aria-roledescription="Radial calendar"
        aria-label={`${window.year} as a ring of ${window.days} days, ${days.length} of them active. Use the arrow keys to step through active days.`}
        onKeyDown={onKey}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          onPointerMove={(event) => setHover(indexAt(event))}
          onPointerLeave={() => setHover(null)}
          onClick={(event) => {
            const index = indexAt(event as unknown as PointerEvent<SVGSVGElement>);
            setPinned(index === pinned ? null : index);
          }}
        >
          <circle className="yr-ring-disc" cx={c} cy={c} r={inner - 34} />
          {guides.map((guide) => (
            <g key={guide.hours} className="yr-ring-guide">
              <circle cx={c} cy={c} r={guide.radius} />
              <text x={c + 6} y={c - guide.radius - 5}>
                {guide.hours}h
              </text>
            </g>
          ))}
          {months.map((start, month) => {
            const angle = start * step;
            const mid = (start + (months[month + 1] ?? window.days)) / 2;
            const [x1, y1] = polar(c, c, inner - 18, angle);
            const [x2, y2] = polar(c, c, inner + length + 22, angle);
            const [lx, ly] = polar(c, c, inner + length + 54, mid * step);
            return (
              <g key={month} className="yr-ring-month">
                <line x1={x1} y1={y1} x2={x2} y2={y2} />
                <text x={lx} y={ly} dominantBaseline="middle" textAnchor="middle">
                  {MONTH_NAMES[month].slice(0, 3)}
                </text>
              </g>
            );
          })}
          {/* Every day of the year as a dot inside the bars: rest days show as gaps. */}
          <g className="yr-ring-dots">
            {Array.from({ length: window.days }, (_, index) => {
              const [x, y] = polar(c, c, inner - 9, (index + 0.5) * step);
              const future = index > window.lastIndex;
              return (
                <circle
                  key={index}
                  cx={x.toFixed(1)}
                  cy={y.toFixed(1)}
                  r={byIndex.has(index) ? 2.6 : 1.5}
                  className={byIndex.has(index) ? "is-active" : future ? "is-future" : undefined}
                />
              );
            })}
          </g>
          {rest && rest.length > 3 && (
            <path
              className="yr-ring-rest"
              d={arcPath(c, c, inner - 26, rest.startIndex * step, (rest.endIndex + 1) * step)}
            />
          )}
          {streak && streak.length > 1 && (
            <path
              className="yr-ring-streak"
              pathLength={1}
              d={arcPath(c, c, inner - 26, streak.startIndex * step, (streak.endIndex + 1) * step)}
            />
          )}
          <RingBars days={days} window={window} geometry={geometry} hot={active} />
          {window.partial && (
            <g className="yr-ring-today">
              <line
                x1={polar(c, c, inner - 30, (window.lastIndex + 1) * step)[0]}
                y1={polar(c, c, inner - 30, (window.lastIndex + 1) * step)[1]}
                x2={polar(c, c, inner + length + 18, (window.lastIndex + 1) * step)[0]}
                y2={polar(c, c, inner + length + 18, (window.lastIndex + 1) * step)[1]}
              />
            </g>
          )}
          {cursorAngle !== null && (
            <line
              className="yr-ring-cursor"
              x1={polar(c, c, inner - 30, cursorAngle)[0]}
              y1={polar(c, c, inner - 30, cursorAngle)[1]}
              x2={polar(c, c, inner + length + 26, cursorAngle)[0]}
              y2={polar(c, c, inner + length + 26, cursorAngle)[1]}
            />
          )}
          <line className="yr-ring-sweep" x1={c} y1={c} x2={c} y2={c - inner - length - 20} />
        </svg>
        <div className="yr-ring-centre" aria-live="polite">
          {active !== null ? (
            <>
              <span className="yr-ring-date">{shortDate(dateAtIndex(window.year, active), true)}</span>
              <strong className="num">{activeDay ? hoursLabel(activeDay.hours) : "Rest"}</strong>
              <span className="yr-ring-sub">
                {activeDay
                  ? `${activeDay.activities.length} ${activeDay.activities.length === 1 ? "activity" : "activities"}`
                  : "day"}
              </span>
            </>
          ) : (
            <>
              <span className="yr-ring-date">{window.partial ? "So far" : "Active days"}</span>
              <strong className="num">{formatNumber(days.length)}</strong>
              <span className="yr-ring-sub">of {formatNumber(window.lastIndex + 1)}</span>
            </>
          )}
        </div>
      </div>

      <div className="yr-ring-side">
        <div className="yr-ring-detail">
          {activeDay ? (
            <>
              <span className="yr-mini-label">{shortDate(activeDay.date, true)}</span>
              <ul className="yr-day-list">
                {activeDay.activities.map((activity) => (
                  <li key={activity.id}>
                    <i style={{ background: KIND_COLOR[activity.kind] }} />
                    <Link href={`/training/activities/${activity.id}`}>{activity.name}</Link>
                    <span className="num">
                      {activity.distance >= 0.5
                        ? `${formatNumber(activity.distance, 1)} mi`
                        : formatHours(activity.hours)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : active !== null ? (
            <>
              <span className="yr-mini-label">{shortDate(dateAtIndex(window.year, active), true)}</span>
              <p className="yr-muted">A rest day.</p>
            </>
          ) : (
            <p className="yr-muted">
              Hover or tap a day to see what happened. With the ring focused, the arrow keys step
              from one active day to the next.
            </p>
          )}
        </div>
        <dl className="yr-ring-facts">
          {streak && (
            <div>
              <dt>
                <i className="yr-key-streak" /> Longest streak
              </dt>
              <dd>
                <strong className="num">{streak.length} days</strong>
                <span>{dateRange(streak.start, streak.end)}</span>
              </dd>
            </div>
          )}
          {rest && rest.length > 3 && (
            <div>
              <dt>
                <i className="yr-key-rest" /> Longest break
              </dt>
              <dd>
                <strong className="num">{rest.length} days</strong>
                <span>{dateRange(rest.start, rest.end)}</span>
              </dd>
            </div>
          )}
          <div>
            <dt>Rest days</dt>
            <dd>
              <strong className="num">{formatNumber(restDays)}</strong>
              <span>{remaining ? `${remaining} still to come` : "the gaps in the ring"}</span>
            </dd>
          </div>
        </dl>
      </div>

      <table className="sr-only">
        <caption>Active days and hours by month, {window.year}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Active days</th>
            <th scope="col">Hours</th>
          </tr>
        </thead>
        <tbody>
          {MONTH_NAMES.map((name, month) => {
            const inMonth = days.filter((day) => Number(day.date.slice(5, 7)) - 1 === month);
            return (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{inMonth.length}</td>
                <td>{formatNumber(inMonth.reduce((sum, day) => sum + day.hours, 0), 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

