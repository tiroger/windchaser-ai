"use client";

import { formatDelta, formatDuration } from "@/lib/geo";
import type { Evaluation, Segment } from "@/lib/types";

export interface RankedRow {
  segment: Segment;
  evaluation: Evaluation;
  hourIndex: number;
  whenIso: string;
}

function stripeColour(score: number, gated: boolean): string {
  if (gated) return "var(--ink-3)";
  if (score >= 0.62) return "var(--data-open)";
  if (score >= 0.45) return "#4FA88C";
  if (score >= 0.28) return "var(--data-wind)";
  return "#3E5F7E";
}

export default function OpportunityRail({
  rows,
  selectedId,
  onSelect,
  onJumpToHour,
}: {
  rows: RankedRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onJumpToHour: (hour: number) => void;
}) {
  if (rows.length === 0) {
    return <p className="empty">No segments in this region yet.</p>;
  }

  return (
    <div className="rail-list">
      {rows.map((row) => {
        const gated = row.evaluation.gates.length > 0;
        const when = new Date(row.whenIso);
        const pr = row.segment.pr_elapsed_time;
        const delta = pr ? row.evaluation.predicted_time_s - pr : null;

        return (
          <button
            key={row.segment.id}
            className="card"
            aria-pressed={row.segment.id === selectedId}
            onClick={() => {
              onSelect(row.segment.id);
              onJumpToHour(row.hourIndex);
            }}
          >
            <span
              className="stripe"
              style={{ background: stripeColour(row.evaluation.score, gated) }}
            />
            <span className="card-main">
              <span className="card-name">{row.segment.name}</span>
              <span className="card-meta">
                <span>
                  {when.toLocaleDateString("en-US", { weekday: "short" })}{" "}
                  {when.toLocaleTimeString("en-US", { hour: "numeric" })}
                </span>
                <span>{(row.segment.distance_m / 1000).toFixed(1)} km</span>
                {row.segment.source === "starred" && (
                  <span className="badge starred">starred</span>
                )}
              </span>
              <span className="card-meta">
                {gated ? (
                  <span style={{ color: "var(--alert)" }}>
                    {row.evaluation.gates[0].detail}
                  </span>
                ) : (
                  <>
                    <span>{formatDuration(row.evaluation.predicted_time_s)}</span>
                    {delta !== null && (
                      <span
                        style={{
                          color: delta < 0 ? "var(--open)" : "var(--ink-3)",
                        }}
                      >
                        {formatDelta(delta)} vs PR
                      </span>
                    )}
                  </>
                )}
              </span>
            </span>
            <span className="card-score">
              <span
                className="value"
                style={{
                  color: gated ? "var(--ink-3)" : "var(--ink)",
                }}
              >
                {row.evaluation.p_beat === null
                  ? "—"
                  : `${Math.round(row.evaluation.p_beat * 100)}%`}
              </span>
              <span className="label">beat PR</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
