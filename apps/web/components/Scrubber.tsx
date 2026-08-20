"use client";

import { useMemo } from "react";

/** Sequential ramp: one hue, light to dark, for a magnitude encoding. */
function heatColour(score: number | null): string {
  if (score === null) return "var(--surface)";
  if (score <= 0) return "#232A33";
  const steps = [
    "#26333C",
    "#2A4A4A",
    "#2E6152",
    "#2E7B5C",
    "#249465",
    "#1FAE72",
  ];
  return steps[Math.min(steps.length - 1, Math.floor(score * steps.length))];
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
        <span className="eyebrow">Forecast window</span>
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
        <span className="mono" style={{ color: "var(--ink-3)", fontSize: "0.7rem" }}>
          {timezone}
        </span>
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
