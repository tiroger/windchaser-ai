"use client";

import { compassLabel, formatDelta, formatDuration } from "@/lib/geo";
import { breakdown } from "@/lib/physics";
import type { Evaluation, Segment } from "@/lib/types";

export default function SegmentDetail({
  segment,
  evaluation,
}: {
  segment: Segment;
  evaluation: Evaluation;
}) {
  const pr = segment.pr_elapsed_time;
  const delta = pr ? evaluation.predicted_time_s - pr : null;
  const bars = breakdown(evaluation);
  const gated = evaluation.gates.length > 0;

  return (
    <div className="detail">
      <div className="panel">
        <h3>{segment.name}</h3>
        {gated && (
          <div className="gate-note" role="status">
            <strong>Window rejected.</strong>
            <span>
              {evaluation.gates.map((g) => g.detail).join(" · ")}. Scoring is
              skipped when a gate fails.
            </span>
          </div>
        )}
        <div className="hero-number">
          <span
            className="big"
            style={{ color: gated ? "var(--ink-3)" : "var(--ink)" }}
          >
            {formatDuration(evaluation.predicted_time_s)}
          </span>
          <span style={{ color: "var(--ink-2)", fontSize: "0.85rem" }}>
            predicted
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Your PR</span>
          <span className="v">{pr ? formatDuration(pr) : "none recorded"}</span>
        </div>
        {delta !== null && (
          <div className="stat-row">
            <span className="k">Difference</span>
            <span
              className="v"
              style={{ color: delta < 0 ? "var(--open)" : "var(--ink-2)" }}
            >
              {formatDelta(delta)}
            </span>
          </div>
        )}
        <div className="stat-row">
          <span className="k">Chance of beating it</span>
          <span className="v">
            {evaluation.p_beat === null
              ? "—"
              : `${Math.round(evaluation.p_beat * 100)}%`}
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Uncertainty (1σ)</span>
          <span className="v">±{Math.round(evaluation.sigma_s)}s</span>
        </div>
        <div className="stat-row">
          <span className="k">Wind effect vs still air</span>
          <span
            className="v"
            style={{
              color:
                evaluation.delta_vs_still_air_s < 0
                  ? "var(--open)"
                  : "var(--ink-2)",
            }}
          >
            {formatDelta(evaluation.delta_vs_still_air_s)}
          </span>
        </div>
      </div>

      <div className="panel">
        <h3>Conditions</h3>
        <div className="stat-row">
          <span className="k">Wind</span>
          <span className="v">
            {evaluation.weather.wind_speed_ms.toFixed(1)} m/s from{" "}
            {compassLabel(evaluation.weather.wind_from_deg)}
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Gusts</span>
          <span className="v">{evaluation.weather.gust_ms.toFixed(1)} m/s</span>
        </div>
        <div className="stat-row">
          <span className="k">Net tailwind on route</span>
          <span
            className="v"
            style={{
              color:
                evaluation.effective_tailwind_ms > 0.4
                  ? "var(--open)"
                  : evaluation.effective_tailwind_ms < -0.4
                    ? "var(--warn)"
                    : "var(--ink-2)",
            }}
          >
            {evaluation.effective_tailwind_ms >= 0 ? "+" : "−"}
            {Math.abs(evaluation.effective_tailwind_ms).toFixed(1)} m/s
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Mean crosswind</span>
          <span className="v">
            {evaluation.mean_crosswind_ms.toFixed(1)} m/s
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Temperature</span>
          <span className="v">
            {evaluation.weather.temperature_c.toFixed(0)}°C
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Rain chance</span>
          <span className="v">
            {evaluation.weather.precip_prob.toFixed(0)}%
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Air density</span>
          <span className="v">
            {evaluation.weather.air_density.toFixed(3)} kg/m³
          </span>
        </div>
      </div>

      <div className="panel">
        <h3>Why this score</h3>
        {bars.map((b) => {
          const magnitude = Math.min(1, Math.abs(b.contribution) / 0.7);
          return (
            <div key={b.key} style={{ marginBottom: "0.55rem" }}>
              <div className="bar-row">
                <span className="bar-label">{b.label}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: "0.75rem",
                    textAlign: "right",
                    color: b.positive ? "var(--open)" : "var(--ink-2)",
                  }}
                >
                  {b.contribution >= 0 ? "+" : "−"}
                  {Math.abs(b.contribution).toFixed(2)}
                </span>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${magnitude * 100}%`,
                    left: 0,
                    background: b.positive
                      ? "var(--data-open)"
                      : "var(--data-effort)",
                  }}
                />
              </div>
            </div>
          );
        })}
        <p
          style={{
            color: "var(--ink-3)",
            fontSize: "0.72rem",
            marginTop: "0.7rem",
            marginBottom: 0,
          }}
        >
          Forecast uncertainty is not a term here. It widens the predicted
          interval, which lowers the chance of beating your PR.
        </p>
      </div>

      <div className="panel">
        <h3>Wind along the route</h3>
        <SectionStrip evaluation={evaluation} />
        <p
          style={{
            color: "var(--ink-3)",
            fontSize: "0.72rem",
            marginTop: "0.6rem",
            marginBottom: 0,
          }}
        >
          {evaluation.sections.length} sections, each scored on its own bearing.
          Times are summed, never averaged as wind.
        </p>
      </div>
    </div>
  );
}

/** Per-section tailwind, drawn along the segment's length. */
function SectionStrip({ evaluation }: { evaluation: Evaluation }) {
  const max = Math.max(
    2,
    ...evaluation.sections.map((s) => Math.abs(s.tailwind_ms)),
  );
  const total = evaluation.sections.reduce((d, s) => d + s.distance_m, 0);

  const bars = evaluation.sections.map((s) => ({
    x: (s.offset_m / total) * 100,
    width: (s.distance_m / total) * 100,
    tailwind: s.tailwind_ms,
  }));

  return (
    <svg
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      style={{ width: "100%", height: 72, display: "block" }}
      role="img"
      aria-label={`Tailwind varies from ${Math.min(
        ...evaluation.sections.map((s) => s.tailwind_ms),
      ).toFixed(1)} to ${Math.max(
        ...evaluation.sections.map((s) => s.tailwind_ms),
      ).toFixed(1)} metres per second along the route`}
    >
      <line x1="0" y1="20" x2="100" y2="20" stroke="var(--line)" strokeWidth="0.4" />
      {bars.map((b, i) => {
        const h = (Math.abs(b.tailwind) / max) * 18;
        const positive = b.tailwind >= 0;
        return (
          <rect
            key={i}
            x={b.x}
            y={positive ? 20 - h : 20}
            width={Math.max(0.4, b.width - 0.15)}
            height={h}
            fill={positive ? "var(--data-open)" : "var(--data-effort)"}
            opacity={0.9}
          />
        );
      })}
      <text x="0.5" y="6" fontSize="3.4" fill="var(--ink-3)" fontFamily="var(--font-mono), monospace">
        tailwind
      </text>
      <text x="0.5" y="38" fontSize="3.4" fill="var(--ink-3)" fontFamily="var(--font-mono), monospace">
        headwind
      </text>
    </svg>
  );
}
