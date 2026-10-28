"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  formatCalendarDate,
  formatNumber,
  getActivityKind,
  type Activity,
} from "@/lib/training/activity-types";

import SportIcon, { sportTone } from "./SportIcon";

const RouteMap = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading">Loading map…</div>,
});

/**
 * Every GPS activity in a list beside a map of the one selected. Polylines are
 * fetched one route at a time as they are picked, so the page carries a list
 * of names rather than thousands of tracks.
 */
export default function RouteExplorer({ activities }: { activities: Activity[] }) {
  const routes = useMemo(() => activities.filter((activity) => activity.hasRoute), [activities]);
  const [selectedId, setSelectedId] = useState(routes[0]?.id ?? "");
  // Polylines by activity ID; null marks a route that is unavailable or hidden.
  const [polylines, setPolylines] = useState<Record<string, string | null>>({});
  const selected = routes.find((activity) => activity.id === selectedId) ?? routes[0];
  const routeId = selected?.id;

  useEffect(() => {
    if (!routeId || routeId in polylines) return;
    let cancelled = false;
    fetch(`/api/training/routes/${encodeURIComponent(routeId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Route unavailable");
        return ((await response.json()) as { polyline: string }).polyline;
      })
      .catch(() => null)
      .then((polyline) => {
        if (!cancelled) setPolylines((current) => ({ ...current, [routeId]: polyline }));
      });
    return () => {
      cancelled = true;
    };
  }, [polylines, routeId]);

  if (!selected) {
    return (
      <section className="panel">
        <h2 className="t-card-title">No routes yet</h2>
        <p className="t-note">Route maps appear for activities recorded with GPS.</p>
      </section>
    );
  }

  const polyline = polylines[selected.id];
  return (
    <section className="t-grid t-grid-wide">
      <article className="panel">
        <div className="t-card-head">
          <div>
            <span className="label">GPS route</span>
            <h2 className="t-card-title">{selected.name}</h2>
          </div>
          <Link className="t-link" href={`/training/activities/${selected.id}`}>
            Full analysis →
          </Link>
        </div>
        {polyline ? (
          <RouteMap routes={[{ id: selected.id, polyline }]} variant="route" height={400} />
        ) : (
          <div className="t-map is-loading" style={{ height: 400 }}>
            {polyline === null
              ? "This route stays within the hidden area around home."
              : "Loading route…"}
          </div>
        )}
        <div className="t-figures">
          <span>
            <strong className="num">{formatNumber(selected.distance, 1)}</strong>
            <small>miles</small>
          </span>
          <span>
            <strong className="num">{formatNumber(selected.total_elevation_gain)}</strong>
            <small>ft climbed</small>
          </span>
          <span>
            <strong className="num">{formatNumber(selected.average_speed, 1)}</strong>
            <small>mph average</small>
          </span>
        </div>
        <p className="t-note">
          The first and last 500 m of every route are hidden to keep home private.
        </p>
      </article>
      <article className="panel">
        <span className="label">Your mapped activities</span>
        <h2 className="t-card-title">{formatNumber(routes.length)} routes</h2>
        <div className="t-list t-scroll-list">
          {routes.map((activity) => (
            <button
              className="t-row"
              aria-pressed={activity.id === selected.id}
              key={activity.id}
              onClick={() => setSelectedId(activity.id)}
              type="button"
            >
              <span className={`t-icon-chip is-small ${sportTone(getActivityKind(activity.type))}`}>
                <SportIcon type={activity.type} />
              </span>
              <span className="t-row-text">
                <strong>{activity.name}</strong>
                <small>{formatCalendarDate(activity.date)}</small>
              </span>
              <span className="t-row-figure num">{formatNumber(activity.distance, 1)} mi</span>
            </button>
          ))}
        </div>
      </article>
    </section>
  );
}
