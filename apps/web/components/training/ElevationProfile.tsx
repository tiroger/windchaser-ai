"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { useTheme } from "@/components/ThemeToggle";
import { formatNumber } from "@/lib/training/activity-types";
import { gradeColor, summarizeRange } from "@/lib/training/metrics/route-profile";

const PAD = { left: 52, right: 14, top: 26, bottom: 24 };

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? raw;
}

function nearestIndex(distance: number[], value: number): number {
  let low = 0;
  let high = distance.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (distance[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low > 0 && value - distance[low - 1] < distance[low] - value ? low - 1 : low;
}

const signed = (value: number) => `${value >= 0 ? "" : "−"}${Math.abs(value).toFixed(1)}%`;

/**
 * Elevation against distance with the area beneath coloured by gradient,
 * VeloViewer style. Hover reads out a point; dragging measures a section.
 *
 * Drawn as SVG rather than a chart library: the gradient fill is hundreds of
 * coloured polygons, and pointer capture for drag-to-measure is simpler on an
 * element than through a chart's event model. Text and rules take the theme
 * from CSS; the gradient hues come from the scale's variant for this theme.
 */
export default function ElevationProfile({
  distance,
  altitude,
  grades,
  hoverIndex,
  onHover,
  selection,
  onSelect,
  height = 210,
}: {
  distance: number[];
  altitude: number[];
  grades: number[];
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  selection: [number, number] | null;
  onSelect: (range: [number, number] | null) => void;
  height?: number;
}) {
  const [theme] = useTheme();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  const total = distance[distance.length - 1] ?? 0;
  const minAltitude = Math.min(...altitude);
  const maxAltitude = Math.max(...altitude);
  const floor = minAltitude - (maxAltitude - minAltitude) * 0.06;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const base = PAD.top + plotHeight;
  const x = (miles: number) => PAD.left + (total ? (miles / total) * plotWidth : 0);
  const y = (feet: number) => PAD.top + ((maxAltitude - feet) / Math.max(maxAltitude - floor, 1)) * plotHeight;

  // Consecutive segments of the same colour are drawn as one polygon.
  const bands = useMemo(() => {
    const result: Array<{ color: string; path: string }> = [];
    let start = 0;
    for (let index = 1; index <= distance.length; index++) {
      const color = gradeColor(grades[start], theme);
      if (index < distance.length && gradeColor(grades[index], theme) === color && index - start < 400) continue;
      const end = Math.min(index, distance.length - 1);
      let path = `M${x(distance[start]).toFixed(1)},${base}`;
      for (let point = start; point <= end; point++) {
        path += `L${x(distance[point]).toFixed(1)},${y(altitude[point]).toFixed(1)}`;
      }
      path += `L${x(distance[end]).toFixed(1)},${base}Z`;
      result.push({ color, path });
      start = end;
    }
    return result;
    // x and y are derived from the values listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distance, altitude, grades, width, height, theme]);

  const outline = useMemo(
    () => distance.map((miles, index) => `${index ? "L" : "M"}${x(miles).toFixed(1)},${y(altitude[index]).toFixed(1)}`).join(""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [distance, altitude, width, height],
  );

  const step = niceStep(total, Math.max(4, Math.floor(plotWidth / 90)));
  const ticks: number[] = [];
  for (let miles = 0; miles <= total + 1e-9; miles += step) ticks.push(miles);

  const indexAt = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const miles = ((event.clientX - box.left) / box.width) * total;
    return nearestIndex(distance, Math.min(Math.max(miles, 0), total));
  };

  const hover = hoverIndex !== null && hoverIndex < distance.length ? hoverIndex : null;
  const range = selection ? summarizeRange(distance, altitude, selection[0], selection[1]) : null;
  const [selA, selB] = selection ? [Math.min(...selection), Math.max(...selection)] : [0, 0];

  return (
    <div className="t-elevation" ref={frame}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Elevation profile: ${formatNumber(total, 1)} miles, from ${formatNumber(minAltitude)} to ${formatNumber(maxAltitude)} feet`}
      >
        <line x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} className="t-profile-axis" />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top - 4} y2={base} className="t-profile-axis" />
        {ticks.map((miles) => (
          <g key={miles}>
            <line x1={x(miles)} x2={x(miles)} y1={PAD.top} y2={base} className="t-profile-grid" />
            <text x={x(miles)} y={base + 15} className="t-profile-label" textAnchor="middle">
              {formatNumber(miles)} mi
            </text>
          </g>
        ))}
        <text x={PAD.left - 6} y={y(maxAltitude) + 4} className="t-profile-label strong" textAnchor="end">
          {formatNumber(maxAltitude)} ft
        </text>
        <text x={PAD.left - 6} y={y(minAltitude) + 4} className="t-profile-label strong" textAnchor="end">
          {formatNumber(minAltitude)} ft
        </text>
        {bands.map((band, index) => (
          <path key={index} d={band.path} fill={band.color} opacity={0.88} />
        ))}
        <path d={outline} className="t-profile-line" />
        {selection && (
          <>
            <rect x={x(distance[selA])} y={PAD.top} width={Math.max(1, x(distance[selB]) - x(distance[selA]))} height={plotHeight} className="t-profile-selection" />
            {range && (
              <text x={(x(distance[selA]) + x(distance[selB])) / 2} y={PAD.top - 9} className="t-profile-callout" textAnchor="middle">
                {signed(range.grade)} · {formatNumber(range.distance, 1)} mi · {formatNumber(range.gain)} ft ↑ · {formatNumber(range.loss)} ft ↓
              </text>
            )}
          </>
        )}
        {hover !== null && (
          <>
            <line x1={x(distance[hover])} x2={x(distance[hover])} y1={PAD.top} y2={base} className="t-profile-cursor" />
            <circle cx={x(distance[hover])} cy={y(altitude[hover])} r={4} className="t-profile-dot" />
            {!selection && (
              <text
                x={Math.min(Math.max(x(distance[hover]), PAD.left + 90), width - PAD.right - 90)}
                y={PAD.top - 9}
                className="t-profile-callout"
                textAnchor="middle"
              >
                {formatNumber(distance[hover], 1)} mi · {formatNumber(altitude[hover])} ft · {signed(grades[hover])}
              </text>
            )}
          </>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          style={{ cursor: "crosshair", touchAction: "none" }}
          onPointerMove={(event) => {
            const index = indexAt(event);
            onHover(index);
            if (anchor.current !== null) onSelect([anchor.current, index]);
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            anchor.current = indexAt(event);
            onSelect(null);
          }}
          onPointerUp={(event) => {
            const start = anchor.current;
            anchor.current = null;
            const end = indexAt(event);
            if (start === null || Math.abs(distance[end] - distance[start]) < total / 200) onSelect(null);
            else onSelect([start, end]);
          }}
          onPointerLeave={() => anchor.current === null && onHover(null)}
        />
      </svg>
    </div>
  );
}
