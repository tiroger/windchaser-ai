"use client";

import { useMemo } from "react";

/**
 * Sequential ramp: one hue, increasing in strength with the score. Built by
 * mixing the open-window token into the surface, so it tracks the theme.
 */
function heatColour(score: number | null): string {
  if (score === null || score <= 0) return "var(--surface-2)";
  const step = Math.min(5, Math.floor(score * 6));
  const mix = [12, 26, 42, 60, 80, 100][step];
  return `color-mix(in srgb, var(--data-open) ${mix}%, var(--surface-2))`;
}

export default function Scrubber({
  times,
  scores,
  hourIndex,
  onChange,
  timezone,
}: {
  times: string[];
  scores: Array<number | null>;
  hourIndex: number;
  onChange: (index: number) => void;
  timezone: string;
}) {
  const current = times[hourIndex] ? new Date(times[hourIndex]) : null;

  const dayBoundaries = useMemo(() => {
    const marks: Array<{ index: number; label: string }> = [];
    let lastDay = "";
    times.forEach((t, i) => {
      const d = new Date(t);
      const key = d.toDateString();
      if (key !== lastDay) {
        marks.push({
          index: i,
          label: d.toLocaleDateString("en-US", { weekday: "short" }),
        });
        lastDay = key;
      }
    });
    return marks;
  }, [times]);

  return (
    <div className="scrubber">
      <div className="scrubber-head">
        <span className="label">Forecast window</span>
        <span className="when">
          {current
            ? current.toLocaleString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
                hour: "numeric",
              })
            : "—"}
        </span>
        <span className="mono label">{timezone}</span>
      </div>

      <div className="scrubber-track">
        <div
          className="heat"
          style={{ gridTemplateColumns: `repeat(${times.length}, 1fr)` }}
          aria-hidden="true"
        >
          {scores.map((s, i) => (
            <div
              key={i}
              className="heat-cell"
              style={{
                background: heatColour(s),
                outline: i === hourIndex ? "2px solid var(--accent)" : "none",
                outlineOffset: "-2px",
              }}
            />
          ))}
        </div>
      </div>

      <div
        className="daymarks"
        style={{ gridTemplateColumns: `repeat(${times.length}, 1fr)` }}
        aria-hidden="true"
      >
        {dayBoundaries.map((m) => (
          <span
            key={m.index}
            className="daymark"
            style={{ gridColumnStart: m.index + 1, gridColumnEnd: "span 24" }}
          >
            {m.label}
          </span>
        ))}
      </div>

      <label className="sr-only" htmlFor="hour-range">
        Forecast hour
      </label>
      <input
        id="hour-range"
        type="range"
        min={0}
        max={Math.max(0, times.length - 1)}
        value={hourIndex}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
