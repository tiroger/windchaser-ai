"use client";

import { useMemo, useState, type KeyboardEvent } from "react";

import { formatNumber, type SportKind } from "@/lib/training/activity-types";
import {
  DIABLO_FT,
  EARTH_CIRCUMFERENCE_MI,
  EVEREST_FT,
  hourLabel,
  MONTH_NAMES,
  STREAM_WEEKS,
  streamLayers,
  weekStart,
  type ClockData,
  type ReviewWindow,
  type RingDay,
  type WeekdayEntry,
  type WeeklyStream,
} from "@/lib/training/metrics/year-review";

import {
  CountUp,
  easeInOut,
  KIND_COLOR,
  KIND_NAMES,
  polar,
  sectorPath,
  shortDate,
  smoothPath,
  useInView,
  useTween,
  useWidth,
} from "./YearReviewParts";

const TAU = Math.PI * 2;

// ------------------------------------------------------------- barcode --

/** The opening's strip: every day of the year as one thin bar. */
export function YearBarcode({ days, window }: { days: RingDay[]; window: ReviewWindow }) {
  const [ref, width] = useWidth<HTMLDivElement>(1200);
  const height = 92;
  const max = Math.max(1, ...days.map((day) => day.hours));
  const step = width / window.days;
  const bar = Math.max(1, step * 0.62);
  const months = Array.from({ length: 12 }, (_, month) =>
    Math.round((Date.UTC(window.year, month, 1) - Date.UTC(window.year, 0, 1)) / 86_400_000),
  );
  return (
    <div className="yr-barcode" ref={ref} aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height + 22}`} width={width} height={height + 22}>
        <line className="yr-barcode-base" x1={0} x2={width} y1={height + 0.5} y2={height + 0.5} />
        {window.partial && (
          <rect
            className="yr-barcode-future"
            x={(window.lastIndex + 1) * step}
            y={height - 6}
            width={width - (window.lastIndex + 1) * step}
            height={6}
          />
        )}
        {days.map((day) => {
          const total = Math.max(4, height * Math.sqrt(day.hours / max));
          let y = height;
          return (
            <g
              key={day.index}
              className="yr-barcode-day"
              style={{ "--a": (day.index / window.days).toFixed(3) } as React.CSSProperties}
            >
              {day.segments.map((segment) => {
                const h = (segment.hours / day.hours || 1) * total;
                y -= h;
                return (
                  <rect
                    key={segment.kind}
                    x={day.index * step + (step - bar) / 2}
                    y={y}
                    width={bar}
                    height={h}
                    rx={Math.min(bar / 2, 1.5)}
                    style={{ fill: KIND_COLOR[segment.kind] }}
                  />
                );
              })}
            </g>
          );
        })}
        {months.map((start, month) => (
          <text key={month} className="yr-barcode-month" x={start * step + 2} y={height + 17}>
            {width < 600 ? MONTH_NAMES[month][0] : MONTH_NAMES[month].slice(0, 3)}
          </text>
        ))}
      </svg>
    </div>
  );
}

// --------------------------------------------------------------- globe --

const GLOBE = { size: 640, radius: 210, tilt: 0.3 };

/**
 * Points along the globe's equator from `from` to `to` (in turns), split into
 * runs that face the viewer and runs behind the globe.
 */
function equatorRuns(from: number, to: number) {
  const c = GLOBE.size / 2;
  const rx = GLOBE.radius * 1.0;
  const ry = GLOBE.radius * GLOBE.tilt;
  const steps = Math.max(2, Math.ceil((to - from) * 240));
  const front: Array<Array<[number, number]>> = [];
  const back: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  let facing: boolean | null = null;
  for (let index = 0; index <= steps; index++) {
    const turn = from + ((to - from) * index) / steps;
    // Start at the left limb and travel across the front.
    const theta = Math.PI - turn * TAU;
    const point: [number, number] = [c + rx * Math.cos(theta), c + ry * Math.sin(theta)];
    const isFront = Math.sin(theta) >= 0;
    if (facing !== null && isFront !== facing) {
      run.push(point);
      (facing ? front : back).push(run);
      run = [point];
    } else run.push(point);
    facing = isFront;
  }
  if (run.length > 1 && facing !== null) (facing ? front : back).push(run);
  const head = run[run.length - 1];
  return { front, back, head, headFront: facing ?? true };
}

/**
 * A dot sphere: points on a 10° grid, seen from above the equator at the same
 * tilt as the equator's ellipse, sized and faded by how directly they face
 * the viewer. Only the near hemisphere is drawn.
 */
function globeDots(): Array<{ x: number; y: number; r: number; o: number }> {
  const c = GLOBE.size / 2;
  const sinA = GLOBE.tilt;
  const cosA = Math.sqrt(1 - sinA * sinA);
  const dots: Array<{ x: number; y: number; r: number; o: number }> = [];
  for (let lat = -80; lat <= 80; lat += 10) {
    const phi = (lat * Math.PI) / 180;
    const count = Math.max(6, Math.round(36 * Math.cos(phi)));
    for (let index = 0; index < count; index++) {
      const lambda = (index / count) * TAU + (lat % 20 ? Math.PI / count : 0);
      const x = Math.cos(phi) * Math.sin(lambda);
      const y = Math.sin(phi);
      const z = Math.cos(phi) * Math.cos(lambda);
      const depth = y * sinA + z * cosA;
      if (depth <= 0.05) continue;
      const screenY = y * cosA - z * sinA;
      dots.push({
        x: c + GLOBE.radius * x,
        y: c - GLOBE.radius * screenY,
        r: 0.8 + depth * 1.6,
        o: 0.2 + depth * 0.65,
      });
    }
  }
  return dots;
}

const GLOBE_DOTS = globeDots();

const line = (points: Array<[number, number]>) =>
  points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

/** Chapter two: the year's distance drawn around the equator of a wireframe globe. */
export function AroundTheWorld({ distance }: { distance: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.35);
  const progress = useTween(inView, 2600, { ease: easeInOut, delay: 200 });
  const fraction = distance / EARTH_CIRCUMFERENCE_MI;
  const shown = fraction * progress;
  const laps = Math.floor(shown);
  const c = GLOBE.size / 2;
  const R = GLOBE.radius;
  const full = equatorRuns(0, 1);
  const travelled = equatorRuns(0, shown - laps || (laps ? 1 : 0));
  const lapRuns = laps > 0 ? full : null;
  const meridians = [15, 45, 75].map((deg) => R * Math.cos((deg * Math.PI) / 180));
  const parallels = [-60, -30, 30, 60].map((deg) => ({
    y: c - R * Math.sin((deg * Math.PI) / 180),
    rx: R * Math.cos((deg * Math.PI) / 180),
  }));

  return (
    <div className="yr-globe" ref={ref}>
      <svg viewBox={`0 0 ${GLOBE.size} ${GLOBE.size}`} role="img" aria-label={`${(fraction * 100).toFixed(1)} percent of the Earth's circumference`}>
        <defs>
          <radialGradient id="yr-globe-shade" cx="38%" cy="32%" r="75%">
            <stop offset="0%" style={{ stopColor: "var(--surface)" }} />
            <stop offset="100%" style={{ stopColor: "var(--surface-3)" }} />
          </radialGradient>
          <radialGradient id="yr-globe-glow" cx="50%" cy="50%" r="50%">
            <stop offset="60%" style={{ stopColor: "var(--accent)", stopOpacity: 0.16 }} />
            <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c} r={R * 1.45} fill="url(#yr-globe-glow)" />
        {/* Behind the globe. */}
        {full.back.map((run, index) => (
          <path key={`b${index}`} className="yr-equator is-back" d={line(run)} />
        ))}
        {(lapRuns ?? travelled).back.map((run, index) => (
          <path key={`tb${index}`} className="yr-equator-run is-back" d={line(run)} />
        ))}
        <circle className="yr-globe-disc" cx={c} cy={c} r={R} fill="url(#yr-globe-shade)" />
        <g className="yr-globe-dots">
          {GLOBE_DOTS.map((dot, index) => (
            <circle key={index} cx={dot.x.toFixed(1)} cy={dot.y.toFixed(1)} r={dot.r.toFixed(2)} opacity={dot.o.toFixed(2)} />
          ))}
        </g>
        <g className="yr-globe-grid">
          {meridians.map((rx) => (
            <ellipse key={rx} cx={c} cy={c} rx={rx} ry={R} />
          ))}
          <line x1={c} y1={c - R} x2={c} y2={c + R} />
          {parallels.map(({ y, rx }) => (
            <ellipse key={y} cx={c} cy={y} rx={rx} ry={rx * GLOBE.tilt} />
          ))}
        </g>
        {/* In front. */}
        {full.front.map((run, index) => (
          <path key={`f${index}`} className="yr-equator" d={line(run)} />
        ))}
        {lapRuns?.front.map((run, index) => (
          <path key={`lf${index}`} className="yr-equator-run is-lap" d={line(run)} />
        ))}
        {travelled.front.map((run, index) => (
          <path key={`tf${index}`} className="yr-equator-run" d={line(run)} />
        ))}
        {shown > 0.001 && (
          <g className={`yr-rider${travelled.headFront ? "" : " is-back"}`}>
            <circle cx={travelled.head[0]} cy={travelled.head[1]} r={16} className="yr-rider-halo" />
            <circle cx={travelled.head[0]} cy={travelled.head[1]} r={6.5} className="yr-rider-dot" />
          </g>
        )}
        <circle className="yr-start" cx={c - R} cy={c} r={4.5} />
      </svg>
      <div className="yr-globe-readout">
        <strong className="num">{(shown * 100).toFixed(1)}%</strong>
        <span>of the equator{laps ? ` · ${laps}× around` : ""}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ climbing --

const PEAKS = {
  everest: {
    label: "Everests",
    single: "Everest",
    feet: EVEREST_FT,
    note: "29,032 ft above sea level",
    path: "M0 100 L18 70 L26 76 L38 48 L46 54 L58 18 L64 26 L70 14 L80 40 L86 36 L100 100 Z",
    snow: "M51 34 L58 18 L64 26 L70 14 L76 30 L70 28 L64 34 L58 28 Z",
  },
  diablo: {
    label: "Mount Diablos",
    single: "Mount Diablo",
    feet: DIABLO_FT,
    note: "3,849 ft, the Bay Area's benchmark climb",
    path: "M0 100 C14 86 22 70 34 58 C42 50 46 44 52 40 C56 37 60 40 63 44 C68 38 72 36 76 40 C86 54 92 76 100 100 Z",
    snow: "",
  },
} as const;

type PeakKey = keyof typeof PEAKS;

/** Chapter three: elevation as a range of mountains that fill as you scroll. */
export function Climbing({ elevation }: { elevation: number }) {
  const [unit, setUnit] = useState<PeakKey>("everest");
  const peak = PEAKS[unit];
  const count = elevation / peak.feet;
  const whole = Math.floor(count);
  const shown = Math.min(Math.ceil(count), 60);
  const columns = shown <= 8 ? Math.max(shown, 1) : Math.min(12, Math.ceil(Math.sqrt(shown * 2.4)));
  const rows = Math.ceil(shown / columns);
  const w = 100;
  const h = 100;
  const gap = 8;
  const width = columns * w + (columns - 1) * gap;
  const height = rows * h + (rows - 1) * gap * 1.6;
  return (
    <div className="yr-climb">
      <div className="chip-row" role="group" aria-label="Measure the climbing in">
        {(Object.keys(PEAKS) as PeakKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className="chip"
            aria-pressed={unit === key}
            onClick={() => setUnit(key)}
          >
            {PEAKS[key].label}
          </button>
        ))}
      </div>
      <div className="yr-climb-count">
        <strong className="num">
          <CountUp key={unit} value={count} digits={1} duration={1400} />
        </strong>
        <span>
          {count >= 1.05 || count < 0.95 ? peak.label : peak.single}
          <small>{peak.note}</small>
        </span>
      </div>
      <svg
        className={`yr-peaks is-${unit}`}
        viewBox={`-4 -4 ${width + 8} ${height + 8}`}
        role="img"
        aria-label={`${formatNumber(elevation)} feet of climbing is ${count.toFixed(1)} ${peak.label}`}
        style={{ maxWidth: `${Math.min(1, columns / 6) * 100}%` }}
        key={unit}
      >
        <defs>
          <linearGradient id="yr-peak-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" style={{ stopColor: "var(--data-effort)" }} />
            <stop offset="100%" style={{ stopColor: "color-mix(in srgb, var(--data-effort) 55%, var(--warn))" }} />
          </linearGradient>
        </defs>
        {Array.from({ length: shown }, (_, index) => {
          const x = (index % columns) * (w + gap);
          const y = Math.floor(index / columns) * (h + gap * 1.6);
          const fill = index < whole ? 1 : count - whole;
          const id = `yr-peak-${unit}-${index}`;
          return (
            <g
              key={index}
              transform={`translate(${x} ${y})`}
              className="yr-peak"
              style={{ "--i": index, "--f": fill.toFixed(3) } as React.CSSProperties}
            >
              <clipPath id={id}>
                <path d={peak.path} />
              </clipPath>
              <path className="yr-peak-outline" d={peak.path} />
              <g clipPath={`url(#${id})`}>
                <rect className="yr-peak-fill" x={0} y={0} width={100} height={100} fill="url(#yr-peak-fill)" />
                {peak.snow && <path className="yr-peak-snow" d={peak.snow} />}
              </g>
            </g>
          );
        })}
      </svg>
      {shown < Math.ceil(count) && (
        <p className="yr-muted">Showing the first {shown} of {Math.ceil(count)}.</p>
      )}
    </div>
  );
}

// --------------------------------------------------------------- clock --

/** Chapter five, left: a 24-hour dial of where the moving time sat. */
export function Clock({ clock }: { clock: ClockData }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.35);
  const grow = useTween(inView, 1400, { ease: easeInOut });
  const size = 440;
  const c = size / 2;
  const inner = 74;
  const length = 118;
  const max = Math.max(0.0001, ...clock.total);
  const step = TAU / 24;
  const [hot, setHot] = useState<number | null>(null);
  const shown = hot ?? clock.peakHour;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") setHot(((shown ?? -1) + 1) % 24);
    else if (event.key === "ArrowLeft") setHot(((shown ?? 1) + 23) % 24);
    else if (event.key === "Escape") setHot(null);
    else return;
    event.preventDefault();
  };
  return (
    <div
      className="yr-clock"
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label="24-hour clock of moving time. Arrow keys move between hours."
      onKeyDown={onKey}
    >
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" onPointerLeave={() => setHot(null)}>
        {/* The dial's rim: daylight hours warm, night hours dark. */}
        {[
          ["is-night", 18, 30],
          ["is-day", 6, 18],
        ].map(([name, from, to]) => (
          <path
            key={name}
            className={`yr-clock-rim ${name}`}
            d={sectorPath(c, c, inner + length + 8, inner + length + 13, (Number(from) * step) % TAU, Number(to) * step)}
          />
        ))}
        {[0.5, 1].map((fraction) => (
          <circle key={fraction} className="yr-clock-guide" cx={c} cy={c} r={inner + length * fraction} />
        ))}
        {Array.from({ length: 24 }, (_, hour) => {
          let radius = inner;
          const from = hour * step + 0.035;
          const to = (hour + 1) * step - 0.035;
          return (
            <g
              key={hour}
              className={`yr-clock-hour${shown === hour ? " is-hot" : ""}`}
              onPointerEnter={() => setHot(hour)}
            >
              <path className="yr-clock-hit" d={sectorPath(c, c, inner - 10, inner + length + 6, from, to)} />
              {clock.byKind.map(({ kind, hours }) => {
                const span = (hours[hour] / max) * length * grow;
                if (span <= 0.01) return null;
                const path = sectorPath(c, c, radius, radius + span, from, to);
                radius += span;
                return <path key={kind} d={path} style={{ fill: KIND_COLOR[kind] }} />;
              })}
            </g>
          );
        })}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => {
          const [x, y] = polar(c, c, inner + length + 32, hour * step);
          return (
            <text
              key={hour}
              className={`yr-clock-label${hour % 6 === 0 ? " is-major" : ""}`}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {hour === 0 ? "12a" : hour === 12 ? "12p" : hour < 12 ? `${hour}a` : `${hour - 12}p`}
            </text>
          );
        })}
      </svg>
      <div className="yr-clock-centre" aria-live="polite">
        {shown !== null ? (
          <>
            <strong className="num">{formatNumber(clock.total[shown], 1)}h</strong>
            <span>
              {hourLabel(shown)}–{hourLabel((shown + 1) % 24)}
            </span>
          </>
        ) : (
          <span>No start times</span>
        )}
      </div>
    </div>
  );
}

/** Chapter five, right: the week's rhythm, Monday first. */
export function Weekdays({ weekdays }: { weekdays: WeekdayEntry[] }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.4);
  const max = Math.max(0.0001, ...weekdays.map((day) => day.hours));
  const top = weekdays.reduce((best, day) => (day.hours > best.hours ? day : best), weekdays[0]);
  return (
    <div className={`yr-week${inView ? " is-in" : ""}`} ref={ref}>
      <ol>
        {weekdays.map((day) => (
          <li
            key={day.day}
            className={day === top && day.hours > 0 ? "is-top" : undefined}
            style={{ "--h": (day.hours / max).toFixed(3), "--i": day.day } as React.CSSProperties}
          >
            <span className="yr-week-value num">{formatNumber(day.hours, 0)}h</span>
            <span className="yr-week-bar" />
            <span className="yr-week-label">{day.label}</span>
            <span className="sr-only">
              {`${day.label}: ${formatNumber(day.hours, 1)} hours over ${day.count} activities`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// -------------------------------------------------------------- stream --

/** Chapter six: the year's sports as a streamgraph of weekly hours. */
export function Seasons({ stream, year }: { stream: WeeklyStream; year: number }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(1100);
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const wipe = useTween(inView, 2200, { ease: easeInOut });
  const [hot, setHot] = useState<number | null>(null);
  const height = width < 600 ? 250 : 340;
  const top = 26;
  const bottom = 30;
  const plot = height - top - bottom;

  // Biggest sport in the middle, the rest alternating outward.
  const ordered = useMemo(() => {
    const out: WeeklyStream["series"] = [];
    stream.series.forEach((entry, index) => (index % 2 ? out.push(entry) : out.unshift(entry)));
    return out;
  }, [stream.series]);

  const layers = useMemo(() => {
    // A light 3-week smoothing reads as seasons rather than individual weeks.
    const smooth = (values: number[]) =>
      values.map((_, index) => {
        const window = [values[index - 1], values[index], values[index + 1]].filter(
          (value): value is number => value !== undefined,
        );
        return (values[index] * 2 + window.reduce((a, b) => a + b, 0)) / (window.length + 2);
      });
    return streamLayers(ordered.map((entry) => smooth(entry.values)));
  }, [ordered]);

  const extent = Math.max(
    0.0001,
    ...layers.flatMap((layer) => [...layer.upper.map(Math.abs), ...layer.lower.map(Math.abs)]),
  );
  const x = (week: number) => (week / (STREAM_WEEKS - 1)) * width;
  const y = (value: number) => top + plot / 2 + (value / extent) * (plot / 2);

  const paths = layers.map((layer) => {
    const upper = layer.upper.map((value, week): [number, number] => [x(week), y(value)]);
    const lower = layer.lower
      .map((value, week): [number, number] => [x(week), y(value)])
      .reverse();
    return `${smoothPath(upper)}${smoothPath(lower, false)}Z`;
  });

  const peak = stream.peak;
  const months = Array.from({ length: 12 }, (_, month) => (month / 12) * width);
  const weekAt = (clientX: number, box: DOMRect) =>
    Math.max(0, Math.min(STREAM_WEEKS - 1, Math.round(((clientX - box.left) / box.width) * (STREAM_WEEKS - 1))));

  return (
    <div className="yr-stream" ref={ref}>
      <div className="yr-stream-legend">
        {stream.series.map((entry) => (
          <span key={entry.kind}>
            <i style={{ background: KIND_COLOR[entry.kind] }} />
            {KIND_NAMES[entry.kind]}
            <b className="num">
              {entry.total >= 1 ? `${formatNumber(entry.total, 0)}h` : `${Math.round(entry.total * 60)}m`}
            </b>
          </span>
        ))}
      </div>
      <div
        className="yr-stream-plot"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label="Weekly hours by sport. Arrow keys move between weeks."
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") setHot(Math.min(STREAM_WEEKS - 1, (hot ?? -1) + 1));
          else if (event.key === "ArrowLeft") setHot(Math.max(0, (hot ?? STREAM_WEEKS) - 1));
          else if (event.key === "Escape") setHot(null);
          else return;
          event.preventDefault();
        }}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          aria-hidden="true"
          onPointerMove={(event) => setHot(weekAt(event.clientX, event.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setHot(null)}
        >
          <defs>
            <clipPath id="yr-stream-wipe">
              <rect x={0} y={0} width={width * wipe} height={height} />
            </clipPath>
          </defs>
          {months.map((mx, month) => (
            <g key={month} className="yr-stream-month">
              <line x1={mx} x2={mx} y1={top - 8} y2={height - bottom + 4} />
              <text x={mx + 4} y={height - 10}>
                {width < 600 ? MONTH_NAMES[month][0] : MONTH_NAMES[month].slice(0, 3)}
              </text>
            </g>
          ))}
          <g clipPath="url(#yr-stream-wipe)">
            {paths.map((d, index) => (
              <path
                key={ordered[index].kind}
                d={d}
                className="yr-stream-layer"
                style={{ fill: KIND_COLOR[ordered[index].kind] }}
              />
            ))}
          </g>
          {peak && wipe > 0.95 && hot === null && (
            <g className="yr-stream-peak">
              <line x1={x(peak.week)} x2={x(peak.week)} y1={top - 6} y2={y(-stream.totals[peak.week] / 2)} />
              <circle cx={x(peak.week)} cy={top - 6} r={3} />
              <text
                x={x(peak.week) + (x(peak.week) > width * 0.75 ? -8 : 8)}
                y={top - 2}
                textAnchor={x(peak.week) > width * 0.75 ? "end" : "start"}
              >
                Peak week · {formatNumber(peak.hours, 1)}h
              </text>
            </g>
          )}
          {hot !== null && (
            <line className="yr-stream-cursor" x1={x(hot)} x2={x(hot)} y1={top - 8} y2={height - bottom + 4} />
          )}
        </svg>
        {hot !== null && (
          <div
            className="yr-tip"
            style={{
              left: Math.min(Math.max(x(hot), 90), width - 90),
            }}
            aria-live="polite"
          >
            <span className="yr-mini-label">Week of {shortDate(weekStart(year, hot))}</span>
            <strong className="num">{formatNumber(stream.totals[hot], 1)}h</strong>
            {stream.series
              .filter((entry) => entry.values[hot] > 0)
              .map((entry) => (
                <span key={entry.kind} className="yr-tip-row">
                  <i style={{ background: KIND_COLOR[entry.kind] }} />
                  {KIND_NAMES[entry.kind as SportKind]}
                  <b className="num">{formatNumber(entry.values[hot], 1)}h</b>
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
