"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  formatCalendarDate,
  formatHours,
  formatNumber,
  getActivityKind,
  sportLabel,
  type Activity,
} from "@/lib/training/activity-types";
import type { PerformanceSummary } from "@/lib/training/metrics/performance";

import SportIcon, { sportTone } from "./SportIcon";

/**
 * The activity log: searchable, sortable, each row a link to the activity's
 * own page. Collapsed to ten rows on the overview, complete on Activities.
 */
export default function ActivityTable({
  activities,
  loads,
  expanded = false,
}: {
  activities: Activity[];
  loads?: PerformanceSummary["loads"];
  expanded?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sortNewest, setSortNewest] = useState(true);
  const [showAll, setShowAll] = useState(expanded);
  const rows = useMemo(() => {
    const needle = query.toLowerCase();
    return activities
      .filter((activity) =>
        `${activity.name} ${sportLabel(activity.type)}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => (sortNewest ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)));
  }, [activities, query, sortNewest]);
  const visible = showAll ? rows : rows.slice(0, 10);

  return (
    <section className="panel t-table-card">
      <div className="t-card-head">
        <div>
          <span className="label">Your history</span>
          <h2 className="t-card-title">Activity log</h2>
        </div>
        <div className="t-table-actions">
          <label className="t-search">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4.5 4.5" strokeLinecap="round" />
            </svg>
            <input
              aria-label="Search activities"
              placeholder="Search activities"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="chip"
            type="button"
            onClick={() => setSortNewest((value) => !value)}
            aria-label={sortNewest ? "Sorted newest first; sort oldest first" : "Sorted oldest first; sort newest first"}
          >
            {sortNewest ? "Newest first ↓" : "Oldest first ↑"}
          </button>
        </div>
      </div>
      <div className="t-table-scroll">
        <table className="t-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Date</th>
              <th>Type</th>
              <th className="is-num">Distance</th>
              <th className="is-num">Time</th>
              <th className="is-num">Elevation</th>
              {loads && (
                <th className="is-num" title="Training load: TSS from power, or heart-rate based">
                  Load
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((activity) => {
              const kind = getActivityKind(activity.type);
              const load = loads?.[activity.id];
              return (
                <tr key={activity.id}>
                  <td>
                    <Link className="t-activity-link" href={`/training/activities/${activity.id}`}>
                      <span className={`t-icon-chip is-small ${sportTone(kind)}`}>
                        <SportIcon kind={kind} />
                      </span>
                      <span>{activity.name}</span>
                    </Link>
                  </td>
                  <td>{formatCalendarDate(activity.date)}</td>
                  <td>
                    <span className="tag">{sportLabel(activity.type)}</span>
                  </td>
                  <td className="is-num">
                    {activity.distance > 0 ? `${formatNumber(activity.distance, 1)} mi` : "—"}
                  </td>
                  <td className="is-num">{formatHours(activity.moving_time)}</td>
                  <td className="is-num">
                    {activity.total_elevation_gain > 0
                      ? `${formatNumber(activity.total_elevation_gain)} ft`
                      : "—"}
                  </td>
                  {loads && (
                    <td className="is-num" title={load ? `From ${load.source}` : undefined}>
                      {load ? Math.round(load.tss) : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="t-empty">No activities match.</div>}
        {rows.length > 10 && (
          <button className="t-more" onClick={() => setShowAll((value) => !value)} type="button">
            {showAll
              ? "Show fewer activities"
              : `Showing 10 of ${formatNumber(rows.length)} activities`}
            <span>{showAll ? "Collapse ↑" : "Show all →"}</span>
          </button>
        )}
      </div>
    </section>
  );
}
