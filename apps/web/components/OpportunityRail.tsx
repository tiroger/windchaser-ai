"use client";

import { formatDelta, formatDuration } from "@/lib/geo";
import type { Evaluation, Segment } from "@/lib/types";

export interface RankedRow {
  segment: Segment;
  evaluation: Evaluation;
  hourIndex: number;
  whenIso: string;
}

/** Sequential ramp on the open-window hue; grey means a gate rejected it. */
export function statusColour(score: number, gated: boolean): string {
  if (gated) return "var(--ink-3)";
  if (score >= 0.62) return "var(--data-open)";
  if (score >= 0.42) return "var(--data-wind)";
  return "var(--ink-3)";
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
        const target =
          row.segment.best_moving_time_s ?? row.segment.pr_elapsed_time;
        const delta = target ? row.evaluation.predicted_time_s - target : null;

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
            <span className="card-title">
              <span
                className="status-dot"
                style={{ background: statusColour(row.evaluation.score, gated) }}
              />
              <span className="card-name">{row.segment.name}</span>
            </span>

            <span className="card-meta">
              {gated ? (
                <span style={{ color: "var(--alert)" }}>
                  {row.evaluation.gates[0].detail}
                </span>
              ) : (
                <>
                  <span className="mono">
                    {when.toLocaleDateString("en-US", { weekday: "short" })}{" "}
                    {when.toLocaleTimeString("en-US", { hour: "numeric" })}
                  </span>
                  <span className="sep">·</span>
                  <span className="mono">
                    {formatDuration(row.evaluation.predicted_time_s)}
                  </span>
                  {delta !== null && (
                    <>
                      <span className="sep">·</span>
                      <span
                        className="mono"
                        style={{
                          color: delta < 0 ? "var(--open)" : "var(--ink-3)",
                        }}
                      >
                        {formatDelta(delta)}
                      </span>
                    </>
                  )}
                  {row.segment.calibrated_power_w ? (
                    <span className="tag">fitted</span>
                  ) : null}
                </>
              )}
            </span>

            <span className="card-figure">
              <span
                className="value"
                style={{ color: gated ? "var(--ink-3)" : "var(--ink)" }}
              >
                {row.evaluation.p_beat === null
                  ? "—"
                  : `${Math.round(row.evaluation.p_beat * 100)}%`}
              </span>
              <span className="caption">chance</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
