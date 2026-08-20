"use client";

import { useMemo, useState } from "react";

import type { Segment } from "@/lib/types";
import type { Theme } from "@/components/ThemeToggle";

/**
 * The segment's shape, drawn the way a rider reads a climb: elevation along the
 * distance, coloured by how steep each part of it is.
 *
 * This is not decoration. Gradient is what the model spends most of its effort
 * on -- speed is solved section by section against the real profile, and the
 * rider curve carries a gradient term of its own -- but until now the interface
 * showed a single average, which describes a rolling segment badly. A segment
 * averaging 4% made of a flat kilometre and a 9% wall is a different ride from
 * one at a steady 4%, and only one of them is worth attacking into a headwind.
 */

/**
 * Bands rather than a continuous scale, because riders think in bands: a wall,
 * a drag, a false flat. Boundaries follow the convention road cycling already
 * uses, so the colours mean what someone would expect them to mean.
 */
const BANDS = [
  { from: -Infinity, label: "descent" },
  { from: 0, label: "0-3%" },
  { from: 0.03, label: "3-6%" },
  { from: 0.06, label: "6-9%" },
  { from: 0.09, label: "9-12%" },
  { from: 0.12, label: "12%+" },
] as const;

const RAMP = {
  dark: ["#3E5F7E", "#1FAE72", "#B9A21F", "#D2822B", "#CC4B4B", "#8E3D8E"],
  light: ["#7C93A8", "#128857", "#8A7412", "#B4600F", "#B4272C", "#7A2E7A"],
} as const;

const HEIGHT = 132;
const PAD = { top: 14, right: 12, bottom: 20, left: 40 };
/** Enough to show the shape, few enough that each bar stays a visible width. */
const BINS = 96;

interface Bin {
  startM: number;
  endM: number;
  altitude: number;
  grade: number;
}

function bandIndex(grade: number): number {
  let index = 0;
  for (let i = 0; i < BANDS.length; i++) if (grade >= BANDS[i].from) index = i;
  return index;
}

/** Resample an irregular profile onto even distance bins, with local gradient. */
function toBins(distance: number[], altitude: number[]): Bin[] {
  const total = distance[distance.length - 1] - distance[0];
  if (!(total > 0)) return [];
  const start = distance[0];
  const step = total / BINS;

  const heightAt = (target: number): number => {
    if (target <= distance[0]) return altitude[0];
    if (target >= distance[distance.length - 1]) return altitude[altitude.length - 1];
    let lo = 0;
    let hi = distance.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (distance[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = distance[hi] - distance[lo];
    if (span <= 0) return altitude[lo];
    return altitude[lo] + ((altitude[hi] - altitude[lo]) * (target - distance[lo])) / span;
  };

  const bins: Bin[] = [];
  for (let i = 0; i < BINS; i++) {
    const from = start + i * step;
    const to = from + step;
    const rise = heightAt(to) - heightAt(from);
    bins.push({
      startM: from - start,
      endM: to - start,
      altitude: heightAt(to),
      grade: rise / step,
    });
  }
  return bins;
}

export default function GradientProfile({
  segment,
  theme,
}: {
  segment: Segment;
  theme: Theme;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const profile = segment.elevation_profile;
    const distance = profile?.distance_m ?? [];
    const altitude = profile?.altitude_m ?? [];
    if (distance.length < 2 || distance.length !== altitude.length) return null;

    const bins = toBins(distance, altitude);
    if (bins.length === 0) return null;

    const lows = Math.min(...altitude);
    const highs = Math.max(...altitude);
    // A flat segment has no range to scale against, and dividing by it would
    // put every bar at the same height or at infinity.
    const span = Math.max(highs - lows, 1);
    const totalM = bins[bins.length - 1].endM;
    const gain = bins.reduce((acc, b) => acc + Math.max(0, b.grade) * (b.endM - b.startM), 0);
    const steepest = bins.reduce((worst, b) => (b.grade > worst ? b.grade : worst), -Infinity);

    return { bins, lows, highs, span, totalM, gain, steepest };
  }, [segment.elevation_profile]);

  if (!model) {
    return (
      <p className="profile-empty">
        No elevation profile for {segment.name} yet. The worker collects one
        segment&rsquo;s history per day, so this fills in on its own.
      </p>
    );
  }

  const { bins, lows, span, totalM, gain, steepest } = model;
  const ramp = RAMP[theme];
  const width = 1000;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const x = (metres: number) => PAD.left + (metres / totalM) * plotW;
  const y = (altitude: number) => PAD.top + plotH - ((altitude - lows) / span) * plotH;

  const active = hover === null ? null : bins[hover];

  return (
    <figure className="profile">
      <figcaption className="profile-head">
        <span className="profile-name">{segment.name}</span>
        <span className="profile-stats">
          <span className="mono">{(totalM / 1000).toFixed(2)} km</span>
          <span className="sep">·</span>
          <span className="mono">{gain.toFixed(0)} m up</span>
          <span className="sep">·</span>
          <span className="mono">
            {(segment.average_grade ?? 0).toFixed(1)}% avg
          </span>
          <span className="sep">·</span>
          <span className="mono">{(steepest * 100).toFixed(1)}% max</span>
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="profile-svg"
        role="img"
        aria-label={
          `Elevation profile of ${segment.name}: ${(totalM / 1000).toFixed(2)} kilometres, ` +
          `${gain.toFixed(0)} metres of climbing, ${(segment.average_grade ?? 0).toFixed(1)} percent ` +
          `average and ${(steepest * 100).toFixed(1)} percent at its steepest.`
        }
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const metres = ((ratio * width - PAD.left) / plotW) * totalM;
          const index = Math.round((metres / totalM) * (bins.length - 1));
          setHover(Math.max(0, Math.min(bins.length - 1, index)));
        }}
      >
        {[0, 0.5, 1].map((fraction) => {
          const altitude = lows + span * fraction;
          return (
            <g key={fraction}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(altitude)}
                y2={y(altitude)}
                className="profile-grid"
              />
              <text x={PAD.left - 6} y={y(altitude) + 3} className="profile-tick">
                {altitude.toFixed(0)}
              </text>
            </g>
          );
        })}

        {bins.map((bin, i) => (
          <rect
            key={i}
            x={x(bin.startM)}
            width={Math.max(x(bin.endM) - x(bin.startM) + 0.6, 0.6)}
            y={y(bin.altitude)}
            height={Math.max(PAD.top + plotH - y(bin.altitude), 0)}
            fill={ramp[bandIndex(bin.grade)]}
            opacity={hover === null || hover === i ? 0.92 : 0.66}
          />
        ))}

        {active && (
          <line
            x1={x(active.endM)}
            x2={x(active.endM)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="profile-cursor"
          />
        )}

        <text x={PAD.left} y={HEIGHT - 6} textAnchor="start" className="profile-tick">
          0
        </text>
        <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="profile-tick">
          {(totalM / 1000).toFixed(1)} km
        </text>
      </svg>

      <div className="profile-foot">
        <div className="profile-legend" aria-hidden="true">
          {BANDS.map((band, i) => (
            <span key={band.label} className="profile-band">
              <span className="profile-swatch" style={{ background: ramp[i] }} />
              {band.label}
            </span>
          ))}
        </div>
        <span className="profile-readout mono">
          {active
            ? `${(active.endM / 1000).toFixed(2)} km · ${active.altitude.toFixed(0)} m · ${(
                active.grade * 100
              ).toFixed(1)}%`
            : "hover for gradient"}
        </span>
      </div>
    </figure>
  );
}
