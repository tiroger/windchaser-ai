"use client";

import { useEffect, useRef } from "react";

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
  const list = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<number, HTMLButtonElement>());

  /**
   * Bring the selected row into view.
   *
   * Scrolls the list element itself rather than calling scrollIntoView, which
   * also scrolls every scrollable ancestor: selecting a segment on the map
   * could then scroll the page and move the map out from under the pointer
   * that just clicked it. Nothing moves when the row is already visible, so a
   * click on a row in this list stays still, and no note of where the
   * selection came from is needed to get that.
   */
  useEffect(() => {
    if (selectedId === null) return;
    const container = list.current;
    const card = cards.current.get(selectedId);
    if (!container || !card) return;

    // Below 980px the list drops its max-height, so the page scrolls rather
    // than the list, and the map sits below the rail instead of beside it.
    // There the row is not hidden inside a container, it is simply elsewhere
    // on the page, and pulling the page up to it would drag the map off screen
    // immediately after it was tapped. Leave that case alone.
    if (container.scrollHeight <= container.clientHeight) return;

    const listBox = container.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const margin = 8;
    const above = cardBox.top - listBox.top - margin;
    const below = cardBox.bottom - listBox.bottom + margin;

    const delta = above < 0 ? above : below > 0 ? below : 0;
    if (delta === 0) return;

    container.scrollBy({
      top: delta,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [selectedId]);

  // Hooks run before this: an early return above them would change the number
  // of hooks between renders as soon as a region has no segments.
  if (rows.length === 0) {
    return <p className="empty">No segments in this region yet.</p>;
  }

  return (
    <div className="rail-list" ref={list}>
      {rows.map((row) => {
        const gated = row.evaluation.gates.length > 0;
        const when = new Date(row.whenIso);
        const target =
          row.segment.best_moving_time_s ?? row.segment.pr_elapsed_time;
        const delta = target ? row.evaluation.predicted_time_s - target : null;

        return (
          <button
            key={row.segment.id}
            ref={(el) => {
              if (el) cards.current.set(row.segment.id, el);
              else cards.current.delete(row.segment.id);
            }}
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
